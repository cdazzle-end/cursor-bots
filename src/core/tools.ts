import { spawn } from "node:child_process";
import type { Harness } from "./harness.ts";
import { addMemory, removeMemory, replaceMemory } from "./memory.ts";
import { groupTag, renderMessage } from "./prompt.ts";
import type { RunState } from "./runner.ts";
import { describeCron } from "./scheduler.ts";
import { SecretVault } from "./secrets.ts";
import type { Attachment, Id } from "./types.ts";
import { oneLine, resolveInside, truncate } from "./util.ts";
import type { BoundTool, ToolOutput } from "../runtimes/types.ts";

/**
 * The harness tools a bot can call, exposed to the Cursor agent as in-process
 * custom tools (the SDK serves them as the `custom-user-tools` MCP server).
 * These are what turn a single coding agent into a teammate: talking to
 * others, remembering, saving skills, scheduling itself, asking for approval.
 */

type Args = Record<string, unknown>;
type Ctx = { h: Harness; botId: Id; state: RunState };

interface ToolSpec {
  name: string;
  description: string;
  properties: Record<string, unknown>;
  required?: string[];
  readOnly?: boolean;
  destructive?: boolean;
  run(args: Args, ctx: Ctx): Promise<string | ToolOutput> | string | ToolOutput;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : typeof v === "string" && v ? [v] : []);

function attachmentsFrom(h: Harness, paths: string[]): Attachment[] {
  return paths.map((p) => h.attachmentFor(p));
}

const TOOLS: ToolSpec[] = [
  {
    name: "send_message",
    description:
      "Send a message to another bot (a handoff: it wakes, works, and its reply comes back to you as a new turn), to a group chat you're in (#group-name; @mention members to wake them), or to the user (@user, posted in your own chat with them). Don't use this to answer the conversation you're already in; your final message does that.",
    properties: {
      to: { type: "string", description: 'Recipient: "@handle" of a bot, "#group-name", or "@user".' },
      text: { type: "string", description: "The message. For handoffs, state the outcome you need, the inputs, and what not to do." },
      attachments: { type: "array", items: { type: "string" }, description: "Workspace-relative file paths to attach." },
      expect_reply: { type: "boolean", description: "For bot handoffs: deliver the bot's answer back to you (default true)." },
    },
    required: ["to", "text"],
    run(args, { h, state }) {
      const to = str(args.to).trim();
      const text = str(args.text).trim();
      if (!to || !text) return { text: "Both 'to' and 'text' are required.", isError: true };
      const attachments = attachmentsFrom(h, strList(args.attachments));
      const store = h.store;
      const lower = to.toLowerCase().replace(/^@/, "");
      if (["user", "me", "boss", store.settings.user.name.toLowerCase()].includes(lower)) {
        const dm = store.dmFor(state.bot.id)!;
        h.postMessage({ convId: dm.id, author: { kind: "bot", id: state.bot.id }, kind: "message", text, attachments: attachments.length ? attachments : undefined, meta: { via: "send_message" } });
        return dm.id === state.wake.convId ? "Posted in your chat with the user." : "Posted in your own chat with the user.";
      }
      if (to.startsWith("#")) {
        const group = h.findConversationRef(to, state.bot.id);
        if (!group || group.kind !== "group") {
          const mine = store.conversationsFor(state.bot.id).filter((c) => c.kind === "group").map(groupTag);
          return { text: `You're not in a group called ${to}. Your groups: ${mine.join(", ") || "none"}.`, isError: true };
        }
        const mentions = h.parseMentions(text, group.members).ids;
        const msg = h.postMessage({
          convId: group.id,
          author: { kind: "bot", id: state.bot.id },
          kind: "message",
          text,
          attachments: attachments.length ? attachments : undefined,
          mentions: mentions.length ? mentions : undefined,
          meta: { via: "send_message" },
        });
        h.routeBotMentions(group, msg, state);
        const woke = mentions.filter((m) => m !== state.bot.id).map((m) => "@" + store.bots.get(m)?.handle);
        return `Posted in ${groupTag(group)}.${woke.length ? ` Woke ${woke.join(", ")}.` : " Nobody was @mentioned, so no bot was woken."}`;
      }
      const target = store.botByHandle(lower);
      if (!target) {
        const handles = [...store.bots.values()].filter((b) => b.id !== state.bot.id).map((b) => "@" + b.handle);
        return { text: `No bot called ${to}. Teammates: ${handles.join(", ") || "none"}. Use create_bot if the job needs a new owner.`, isError: true };
      }
      try {
        const expect = args.expect_reply !== false;
        h.handoff(state, target, text, attachments, expect);
        return `Handed off to @${target.handle}. ${expect ? "Their reply will come back to you as a new turn; end this turn now instead of waiting." : "No reply requested."}`;
      } catch (err: any) {
        return { text: err.message, isError: true };
      }
    },
  },
  {
    name: "list_team",
    description: "List your teammates (bots), what each does and whether they're busy, plus the groups you're in.",
    properties: {},
    readOnly: true,
    run(_args, { h, state }) {
      const s = h.store;
      const lines = [`User: ${s.settings.user.name}${s.settings.user.label ? ` (${s.settings.user.label})` : ""}`, "Bots:"];
      for (const b of s.bots.values()) {
        lines.push(`- @${b.handle} "${b.name}"${b.id === state.bot.id ? " (you)" : ""}${b.label ? ` — ${b.label}` : ""}${b.about ? ` — ${oneLine(b.about, 200)}` : ""} [${h.statusLabel(b.id)}]`);
      }
      const groups = s.conversationsFor(state.bot.id).filter((c) => c.kind === "group");
      lines.push("Your groups:");
      for (const g of groups) lines.push(`- ${groupTag(g)} "${g.title}": ${g.members.map((m) => "@" + s.bots.get(m)?.handle).join(", ")}${g.lead ? ` (lead @${s.bots.get(g.lead)?.handle})` : ""}`);
      if (!groups.length) lines.push("- none");
      return lines.join("\n");
    },
  },
  {
    name: "read_conversation",
    description: "Read recent messages from one of your conversations: your chat with the user (\"@user\"), a group (\"#group-name\"), or your thread with another bot (\"@handle\").",
    properties: {
      conversation: { type: "string", description: '"@user", "#group-name", or "@bot-handle".' },
      limit: { type: "number", description: "How many recent messages (default 20, max 100)." },
    },
    required: ["conversation"],
    readOnly: true,
    run(args, { h, state }) {
      const conv = h.findConversationRef(str(args.conversation), state.bot.id);
      if (!conv) return { text: `No conversation "${str(args.conversation)}" that you're part of.`, isError: true };
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
      const msgs = h.store.messages(conv.id).filter((m) => m.kind !== "activity").slice(-limit);
      if (!msgs.length) return "No messages yet.";
      return msgs.map((m) => renderMessage(h.store, m, h.timezone(), 2000)).join("\n");
    },
  },
  {
    name: "search_messages",
    description: "Search past messages in your conversations (exact phrase, case-insensitive). Use it to recall earlier work before redoing it.",
    properties: { query: { type: "string" }, limit: { type: "number", description: "Max results (default 15)." } },
    required: ["query"],
    readOnly: true,
    run(args, { h, state }) {
      const results = h.search(str(args.query), { botId: state.bot.id, limit: Math.min(50, Number(args.limit) || 15) });
      if (!results.length) return "No matches.";
      return results.map((r) => `${h.conversationTitle(r.conversation)} — ${renderMessage(h.store, r.message, h.timezone(), 400)}`).join("\n");
    },
  },
  {
    name: "attach_file",
    description: "Attach a workspace file to your reply so it shows up as a card (images render inline). Call once per file.",
    properties: { path: { type: "string", description: "Workspace-relative path." } },
    required: ["path"],
    run(args, { h, state }) {
      try {
        const a = h.attachmentFor(str(args.path));
        if (!state.attachments.some((x) => x.path === a.path)) state.attachments.push(a);
        return `Attached ${a.path} (${a.mime}). It will appear with your reply.`;
      } catch (err: any) {
        return { text: err.message, isError: true };
      }
    },
  },
  {
    name: "memory_read",
    description: "Read your whole memory file (lasting rules, preferences, facts, work log).",
    properties: {},
    readOnly: true,
    run(_args, { h, state }) {
      return h.store.readMemory(state.bot.id) || "(empty)";
    },
  },
  {
    name: "memory_update",
    description:
      "Change your persistent memory. Save lasting rules and preferences the user states, durable facts you learn, and a one-line work log entry after significant work. Actions: add (needs section + text), remove (lines containing match), replace (line containing match → text), rewrite (whole file → content).",
    properties: {
      action: { type: "string", enum: ["add", "remove", "replace", "rewrite"] },
      section: { type: "string", enum: ["Lasting rules", "Preferences", "Facts", "Work log"] },
      text: { type: "string" },
      match: { type: "string" },
      content: { type: "string" },
    },
    required: ["action"],
    run(args, { h, state }) {
      const s = h.store;
      const md = s.readMemory(state.bot.id);
      const action = str(args.action);
      let next = md;
      let note = "";
      if (action === "add") {
        if (!str(args.text).trim()) return { text: "add needs text", isError: true };
        next = addMemory(md, state.bot.name, str(args.section) || undefined, str(args.text));
        note = `Saved to ${str(args.section) || "Facts"}.`;
      } else if (action === "remove") {
        const r = removeMemory(md, str(args.match));
        next = r.md;
        note = `Removed ${r.removed} line(s).`;
      } else if (action === "replace") {
        const r = replaceMemory(md, str(args.match), str(args.text));
        if (!r.replaced) return { text: `No memory line contains "${str(args.match)}".`, isError: true };
        next = r.md;
        note = "Replaced.";
      } else if (action === "rewrite") {
        if (!str(args.content).trim()) return { text: "rewrite needs content", isError: true };
        next = str(args.content);
        note = "Memory rewritten.";
      } else {
        return { text: `Unknown action ${action}`, isError: true };
      }
      s.writeMemory(state.bot.id, next);
      h.bus.emit({ type: "bot.updated", bot: h.describeBot(state.bot) });
      return note;
    },
  },
  {
    name: "skill_list",
    description: "List saved skills (reusable how-tos shared by all bots, in .cursor/skills/).",
    properties: {},
    readOnly: true,
    run(_args, { h, state }) {
      const list = h.skills.list().filter((s) => !state.bot.disabledSkills.includes(s.name));
      if (!list.length) return "No skills saved yet.";
      return list.map((s) => `- ${s.name}: ${s.description} (${s.path})`).join("\n");
    },
  },
  {
    name: "skill_read",
    description: "Read a saved skill's SKILL.md.",
    properties: { name: { type: "string" } },
    required: ["name"],
    readOnly: true,
    run(args, { h }) {
      const s = h.skills.read(str(args.name));
      return s ? s.content : { text: `No skill named ${str(args.name)}.`, isError: true };
    },
  },
  {
    name: "skill_save",
    description:
      "Save (or update) a reusable skill all bots can use. Include: when to use it, required inputs and access, the steps, how to validate the result, what to return, and what needs approval.",
    properties: {
      name: { type: "string", description: "Short kebab-case name, e.g. weekly-account-health." },
      description: { type: "string", description: "One sentence: what it does and when to use it." },
      instructions: { type: "string", description: "The Markdown body of SKILL.md." },
      manual_only: { type: "boolean", description: "Only use when explicitly invoked with /name." },
    },
    required: ["name", "description", "instructions"],
    run(args, { h, state }) {
      try {
        const info = h.skills.save({
          name: str(args.name),
          description: str(args.description),
          body: str(args.instructions),
          createdBy: `@${state.bot.handle}`,
          manualOnly: args.manual_only === true,
        });
        h.bus.emit({ type: "skills.updated" });
        return `Saved skill "${info.name}" at ${info.path}. The user can reference it with /${info.name}.`;
      } catch (err: any) {
        return { text: err.message, isError: true };
      }
    },
  },
  {
    name: "routine_list",
    description: "List your routines with their schedules, state and recent runs.",
    properties: {},
    readOnly: true,
    run(_args, { h, state }) {
      const list = h.scheduler.list(state.bot.id);
      if (!list.length) return "You have no routines.";
      return list
        .map((r) => {
          const d = h.scheduler.describe(r);
          const last = r.history.at(-1);
          return `- ${r.id} "${r.name}": ${d.when} (${d.timezoneResolved})${r.enabled ? "" : " [PAUSED]"}${d.nextRunAt ? `, next ${new Date(d.nextRunAt).toISOString()}` : ""}${last ? `, last run ${last.status}` : ""}\n  Instruction: ${oneLine(r.instruction, 300)}`;
        })
        .join("\n");
    },
  },
  {
    name: "routine_create",
    description:
      "Create a routine you own: an instruction you'll run on a schedule (five-field cron in the user's time zone, at least 5 minutes apart) and/or when a webhook is called. Confirm schedule, inputs, output, approval boundary and missing-source behavior with the user first. A new routine waits for its next scheduled time.",
    properties: {
      name: { type: "string" },
      instruction: { type: "string", description: "What to do on each run, including what to do if a source is unavailable." },
      cron: { type: "string", description: 'e.g. "0 8 * * 1-5" = weekdays 8:00.' },
      timezone: { type: "string", description: "IANA zone; omit to use the user's." },
      post_to: { type: "string", description: '"here" (this conversation, default), "@user", or "#group-name".' },
      skill: { type: "string", description: "Skill to follow on each run." },
      webhook: { type: "boolean", description: "Also allow starting it with an HTTP POST." },
    },
    required: ["name", "instruction"],
    run(args, { h, state }) {
      const postRef = str(args.post_to) || "here";
      const target = postRef === "here" ? h.store.conversations.get(state.wake.convId) : h.findConversationRef(postRef, state.bot.id);
      try {
        const r = h.scheduler.create({
          botId: state.bot.id,
          name: str(args.name),
          instruction: str(args.instruction),
          cron: str(args.cron) || undefined,
          timezone: str(args.timezone) || undefined,
          postTo: target && target.kind !== "botdm" ? target.id : h.store.dmFor(state.bot.id)?.id,
          skill: str(args.skill) || undefined,
          webhook: args.webhook === true,
        });
        const d = h.scheduler.describe(r);
        return `Created routine ${r.id} "${r.name}": ${d.when} (${d.timezoneResolved}).${d.nextRunAt ? ` First run ${new Date(d.nextRunAt).toISOString()}.` : ""}${r.webhookKey ? " Webhook enabled; the user can copy the URL and key from your routine details." : ""}`;
      } catch (err: any) {
        return { text: err.message, isError: true };
      }
    },
  },
  {
    name: "routine_update",
    description: "Edit one of your routines (name, instruction, cron, timezone, skill) or pause/resume it (enabled).",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      instruction: { type: "string" },
      cron: { type: "string" },
      timezone: { type: "string" },
      skill: { type: "string" },
      enabled: { type: "boolean" },
      webhook: { type: "boolean" },
    },
    required: ["id"],
    run(args, { h, state }) {
      const r = h.store.routines.get(str(args.id));
      if (!r || r.botId !== state.bot.id) return { text: "You don't own a routine with that id.", isError: true };
      try {
        const patch: Parameters<typeof h.scheduler.update>[1] = {};
        for (const k of ["name", "instruction", "cron", "timezone", "skill"] as const) if (typeof args[k] === "string") patch[k] = args[k] as string;
        if (typeof args.enabled === "boolean") patch.enabled = args.enabled;
        if (typeof args.webhook === "boolean") patch.webhook = args.webhook;
        const u = h.scheduler.update(r.id, patch);
        return `Updated "${u.name}": ${u.cron ? describeCron(u.cron) : "no schedule"}${u.enabled ? "" : " (paused)"}.`;
      } catch (err: any) {
        return { text: err.message, isError: true };
      }
    },
  },
  {
    name: "routine_delete",
    description: "Delete one of your routines. This stops future runs and can't be undone; only do it when the user asked.",
    properties: { id: { type: "string" } },
    required: ["id"],
    destructive: true,
    run(args, { h, state }) {
      const r = h.store.routines.get(str(args.id));
      if (!r || r.botId !== state.bot.id) return { text: "You don't own a routine with that id.", isError: true };
      h.scheduler.delete(r.id);
      return `Deleted routine "${r.name}".`;
    },
  },
  {
    name: "request_approval",
    description:
      "Ask the user to approve a consequential action before you do it (sending or posting outside this app, purchasing, deleting data, publishing, changing production systems). Returns approved, denied, or pending. If pending, end your turn; you'll be woken with the decision.",
    properties: {
      action: { type: "string", description: "Short imperative title, e.g. \"Send the follow-up email to 12 customers\"." },
      details: { type: "string", description: "Exactly what will happen: targets, content, and effects." },
    },
    required: ["action"],
    async run(args, { h, state }) {
      const origin = ["user", "approval", "system"].includes(state.wake.source) ? "foreground" : "background";
      const res = await h.approvals.gate({
        botId: state.bot.id,
        convId: h.visibleConvFor(state.wake),
        kind: "action",
        subject: str(args.action).trim(),
        details: str(args.details) || undefined,
        origin,
        waitSeconds: h.store.settings.approvals.inlineWaitSeconds * 2,
        resume: h.resumeFor(state.wake),
      });
      if (res.permission === "allow") return "Approved. Go ahead with exactly what you described.";
      return res.reason === "pending" ? res.message : { text: res.message, isError: true };
    },
  },
  {
    name: "request_secret",
    description:
      "Ask the user for a credential (API key, token, password) through a secure card. The value is stored encrypted and never shown to you or written into the chat. End your turn after asking; you'll be woken when it's saved.",
    properties: {
      name: { type: "string", description: "UPPER_SNAKE_CASE environment variable name, e.g. NOTION_API_KEY." },
      description: { type: "string", description: "What it's for and where the user can get it." },
    },
    required: ["name"],
    run(args, { h, state }) {
      const name = str(args.name).trim().toUpperCase();
      if (!SecretVault.validName(name)) return { text: "Use an UPPER_SNAKE_CASE name that doesn't start with CURSOR_.", isError: true };
      if (h.vault.has(name)) return `${name} is already stored. Use run_with_secrets with ["${name}"].`;
      h.requestSecret(state.bot.id, h.visibleConvFor(state.wake), name, str(args.description) || undefined, h.resumeFor(state.wake));
      return `Asked the user to enter ${name} in a secure card. End your turn now; you'll be woken when it's saved.`;
    },
  },
  {
    name: "list_secrets",
    description: "List the names (never values) of secrets the user has stored.",
    properties: {},
    readOnly: true,
    run(_args, { h }) {
      const list = h.vault.list();
      return list.length ? list.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ""}`).join("\n") : "No secrets stored.";
    },
  },
  {
    name: "run_with_secrets",
    description:
      "Run a shell command in the workspace with stored secrets injected as environment variables (e.g. curl -H \"Authorization: Bearer $NOTION_API_KEY\" ...). Secret values are scrubbed from the output. Subject to the same approval rules as other shell commands.",
    properties: {
      command: { type: "string" },
      secrets: { type: "array", items: { type: "string" }, description: "Secret names to inject." },
      cwd: { type: "string", description: "Workspace-relative directory (default: workspace root)." },
      timeout_seconds: { type: "number", description: "Default 120, max 900." },
    },
    required: ["command", "secrets"],
    async run(args, { h, state }) {
      const command = str(args.command).trim();
      const names = strList(args.secrets).map((n) => n.toUpperCase());
      const missing = names.filter((n) => !h.vault.has(n));
      if (missing.length) return { text: `Not stored: ${missing.join(", ")}. Use request_secret first.`, isError: true };
      if (h.touchesHarness(command)) return { text: "Bots can't call the Cursor Bots gateway or read its files directly.", isError: true };
      const origin = ["user", "approval", "system"].includes(state.wake.source) ? "foreground" : "background";
      const gate = await h.approvals.gate({
        botId: state.bot.id,
        convId: h.visibleConvFor(state.wake),
        kind: "shell",
        subject: command,
        origin,
        waitSeconds: h.store.settings.approvals.inlineWaitSeconds,
        resume: h.resumeFor(state.wake),
      });
      if (gate.permission === "deny") return { text: gate.message, isError: gate.reason !== "pending" };
      let cwd = h.store.paths.workspace;
      try {
        if (str(args.cwd)) cwd = resolveInside(h.store.paths.workspace, str(args.cwd));
      } catch (err: any) {
        return { text: err.message, isError: true };
      }
      const timeout = Math.min(900, Math.max(1, Number(args.timeout_seconds) || 120)) * 1000;
      const env = { ...process.env, ...h.vault.resolve(names) };
      const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
        const child = spawn("bash", ["-lc", command], { cwd, env });
        let buf = "";
        const add = (d: Buffer) => {
          if (buf.length < 200_000) buf += d.toString("utf8");
        };
        child.stdout.on("data", add);
        child.stderr.on("data", add);
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          buf += `\n[killed after ${timeout / 1000}s]`;
        }, timeout);
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code, text: buf });
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          resolve({ code: -1, text: String(err) });
        });
      });
      const scrubbed = h.vault.scrub(out.text, names);
      return { text: `exit ${out.code}\n${truncate(scrubbed, 40_000)}`, isError: out.code !== 0 };
    },
  },
  {
    name: "create_bot",
    description:
      "Create a new focused helper bot when a job deserves its own long-lived owner (its own goal, tools, approval boundary or schedule). Prefer existing teammates; keep the roster small. Optionally hand it a first task.",
    properties: {
      name: { type: "string" },
      label: { type: "string", description: "Short label shown next to the name." },
      job: { type: "string", description: "Its job in operational terms, including what it must never do without approval." },
      first_task: { type: "string", description: "Optional first handoff; its reply comes back to you." },
    },
    required: ["name", "job"],
    run(args, { h, state }) {
      try {
        const bot = h.createBot({ name: str(args.name), label: str(args.label) || undefined, about: str(args.job), createdBy: state.bot.id });
        let extra = "";
        if (str(args.first_task).trim()) {
          h.handoff(state, bot, str(args.first_task).trim(), [], true);
          extra = " Handed it the first task; its reply will come back to you.";
        }
        return `Created @${bot.handle} "${bot.name}".${extra}`;
      } catch (err: any) {
        return { text: err.message, isError: true };
      }
    },
  },
  {
    name: "set_notifications",
    description: "Turn your desktop/phone notifications for the user on or off (they asked you to).",
    properties: { enabled: { type: "boolean" } },
    required: ["enabled"],
    run(args, { h, state }) {
      h.updateBot(state.bot.id, { notifications: args.enabled === true });
      return `Notifications ${args.enabled === true ? "on" : "off"}.`;
    },
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);

/** Bind the harness tools to one bot. `current` returns the turn in progress. */
export function buildTools(h: Harness, botId: Id, current: () => RunState | undefined): BoundTool[] {
  return TOOLS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    readOnly: spec.readOnly,
    destructive: spec.destructive,
    inputSchema: { type: "object", properties: spec.properties, required: spec.required ?? [], additionalProperties: false },
    async execute(args: Record<string, unknown>): Promise<ToolOutput> {
      const state = current();
      if (!state) return { text: "This bot has no turn in progress.", isError: true };
      try {
        const res = await spec.run(args ?? {}, { h, botId, state });
        return typeof res === "string" ? { text: res } : res;
      } catch (err: any) {
        return { text: `Tool ${spec.name} failed: ${err?.message ?? err}`, isError: true };
      }
    },
  }));
}
