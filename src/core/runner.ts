import * as fs from "node:fs";
import type { Harness } from "./harness.ts";
import { buildPrompt } from "./prompt.ts";
import type { ActivityItem, Attachment, Bot, Id, Message, WakeEvent } from "./types.ts";
import { hash, isImageMime, newId, oneLine, resolveInside } from "./util.ts";
import type { BotStatus } from "./events.ts";
import type { RunOutcome, RuntimeRun, RuntimeSession } from "../runtimes/types.ts";
import { McpHub } from "./mcp-client.ts";
import { buildTools } from "./tools.ts";
import { buildWorkspaceTools } from "./workspace-tools.ts";

/** State of the turn a bot is currently taking. Tools read and write it. */
export interface RunState {
  runId: Id;
  wake: WakeEvent;
  bot: Bot;
  run?: RuntimeRun;
  text: string;
  /** Files the bot attached to its reply with attach_file. */
  attachments: Attachment[];
  activity: Map<string, ActivityItem>;
  cancelled: boolean;
  startedAt: number;
}

const MAX_UNSEEN = 30;
const MAX_INLINE_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IDENTITY_REFRESH_TURNS = 12;

/**
 * One runner per bot. A bot works on one thing at a time (Grok Bot: "one
 * computer-use task per screen"), so wakes queue up here and run in priority
 * order: your messages first, then other bots and approvals, then routines.
 */
export class BotRunner {
  readonly botId: Id;
  private h: Harness;
  queue: WakeEvent[] = [];
  current?: RunState;
  private session?: RuntimeSession;
  private sessionRuntime?: string;
  private identityHash?: string;
  private turnsSinceIdentity = 0;
  private needIdentity = true;
  private pumping = false;
  private lastError?: string;
  private waiters = new Map<Id, (r: { ok: boolean; error?: string; message?: Message }) => void>();
  /** Messages already handed to the bot by steering; they're left out of later <context>. */
  private delivered = new Set<Id>();
  private shuttingDown = false;
  /** Connector client for runtimes without their own MCP support (opened on first use). */
  private mcp?: McpHub;

  constructor(h: Harness, botId: Id) {
    this.h = h;
    this.botId = botId;
  }

  status(): BotStatus {
    if (this.current) {
      return { state: "working", convId: this.current.wake.convId, queued: this.queue.length, since: this.current.startedAt };
    }
    return { state: this.lastError ? "error" : "idle", queued: this.queue.length, detail: this.lastError };
  }

  private emitStatus(): void {
    this.h.bus.emit({ type: "bot.status", botId: this.botId, status: this.status() });
  }

  /** Resolve when the given wake has been processed (used by routines and tests). */
  whenDone(wakeId: Id): Promise<{ ok: boolean; error?: string; message?: Message }> {
    return new Promise((resolve) => this.waiters.set(wakeId, resolve));
  }

  private resolve(id: Id, r: { ok: boolean; error?: string; message?: Message }): void {
    this.waiters.get(id)?.(r);
    this.waiters.delete(id);
  }

  async enqueue(ev: WakeEvent): Promise<void> {
    if (this.shuttingDown || this.h.isStale(ev)) return this.resolve(ev.id, { ok: false, error: "stopped" });
    // A new message from you in the conversation the bot is working on goes
    // straight into the running turn (Grok Bot: your message "can redirect
    // the current turn"). Messages with files or /skills wait for their own
    // turn, because steering only carries text.
    const cur = this.current;
    const steerable =
      ev.source === "user" && !ev.attachments?.length && !this.h.expandSkillRefs(ev.text, cur?.bot ?? this.h.store.bots.get(this.botId)!).length;
    // While the gateway restores its saved queue, just collect; it starts the queue (in priority order) at the end.
    if (this.h.restoringQueue) {
      this.queue.push(ev);
      return;
    }
    if (cur?.run?.steer && steerable && ev.convId === cur.wake.convId && !cur.cancelled) {
      const ok = await cur.run.steer(`Message from ${this.h.store.settings.user.name} while you work:\n${ev.text}`);
      if (ok) {
        if (ev.messageId) this.delivered.add(ev.messageId);
        return this.resolve(ev.id, { ok: true });
      }
      // The turn ended (or was stopped) before it took the message.
      if (cur.cancelled || this.h.isStale(ev)) return this.resolve(ev.id, { ok: false, error: "stopped" });
    }
    this.queue.push(ev);
    this.h.persistQueue();
    this.emitStatus();
    void this.pump();
  }

  /** Drop queued work for a conversation and cancel the running turn if it replies there. */
  stop(convId?: Id): Promise<boolean> {
    return this.stopWhere((w) => !convId || w.convId === convId);
  }

  /** Drop queued wakes matching `match` and cancel the running turn if it matches. */
  async stopWhere(match: (w: WakeEvent) => boolean): Promise<boolean> {
    const dropped = this.queue.filter(match);
    this.queue = this.queue.filter((q) => !match(q));
    for (const d of dropped) this.resolve(d.id, { ok: false, error: "stopped" });
    let stopped = dropped.length > 0;
    const cur = this.current;
    if (cur && !cur.cancelled && match(cur.wake)) {
      cur.cancelled = true;
      stopped = true;
      // A tool waiting inline on an approval card returns now instead of holding the turn open.
      this.h.approvals.releaseStopped();
      try {
        await cur.run?.cancel();
      } catch {
        // Already finished.
      }
    }
    this.h.persistQueue();
    this.emitStatus();
    return stopped;
  }

  /** Start processing the queue (after a restore). */
  kick(): void {
    this.emitStatus();
    void this.pump();
  }

  /**
   * First step of a gateway shutdown, done for every bot before any cancel is
   * awaited: start nothing new, and treat the running turn as cancelled so a
   * turn that ends meanwhile posts nothing (it's restored as interrupted).
   */
  freeze(): void {
    this.shuttingDown = true;
    if (this.current) this.current.cancelled = true;
  }

  /** Gateway shutdown: cancel the running turn but keep the queue, so it's restored on restart. */
  async shutdown(): Promise<void> {
    this.freeze();
    const cur = this.current;
    if (cur) await cur.run?.cancel().catch(() => {});
    await this.session?.close().catch(() => {});
    this.session = undefined;
    await this.closeMcp();
  }

  async dispose(): Promise<void> {
    await this.stop();
    await this.session?.close().catch(() => {});
    this.session = undefined;
    await this.closeMcp();
  }

  /** Forget the runtime session (e.g. after the bot's runtime or model changed). */
  async resetSession(): Promise<void> {
    await this.session?.close().catch(() => {});
    this.session = undefined;
    this.needIdentity = true;
    await this.closeMcp();
  }

  private async closeMcp(): Promise<void> {
    const hub = this.mcp;
    this.mcp = undefined;
    await hub?.close().catch(() => {});
  }

  private mcpHub(): McpHub {
    if (!this.mcp) {
      const h = this.h;
      this.mcp = new McpHub({
        clientName: `cursor-bots/${h.store.bots.get(this.botId)?.handle ?? this.botId}`,
        cwd: h.store.paths.workspace,
        env: () => h.childEnv(),
        scrub: (text) => h.scrubSecrets(text),
        onError: (server, message) => {
          const dm = h.store.dmFor(this.botId);
          if (dm) h.postNotice(dm.id, `Connector "${server}" isn't working: ${message}`);
        },
      });
    }
    return this.mcp;
  }

  private next(): WakeEvent | undefined {
    if (!this.queue.length) return undefined;
    this.queue.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
    const first = this.queue.shift()!;
    if (first.source !== "user") return first;
    // Several quick messages from you in one conversation become one turn.
    const same = this.queue.filter((q) => q.source === "user" && q.convId === first.convId);
    if (!same.length) return first;
    this.queue = this.queue.filter((q) => !same.includes(q));
    const all = [first, ...same];
    const direct = all.some((w) => w.addressed === "you" || !w.allowSilence);
    const merged: WakeEvent = {
      ...first,
      // If any of the merged messages addressed the bot directly, it must answer.
      allowSilence: direct ? false : first.allowSilence,
      addressed: all.some((w) => w.addressed === "you") ? "you" : first.addressed,
      text: [first.text, ...same.map((s) => s.text)].filter(Boolean).join("\n\n"),
      attachments: [...(first.attachments ?? []), ...same.flatMap((s) => s.attachments ?? [])],
      messageId: same[same.length - 1]!.messageId ?? first.messageId,
      alsoMessageIds: [first.messageId, ...same.map((x) => x.messageId)].filter((x): x is Id => Boolean(x)),
    };
    for (const s of same) {
      const w = this.waiters.get(s.id);
      if (w) {
        this.waiters.delete(s.id);
        const prev = this.waiters.get(merged.id);
        this.waiters.set(merged.id, (r) => {
          prev?.(r);
          w(r);
        });
      }
    }
    return merged;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.current && !this.shuttingDown) {
        const ev = this.next();
        if (!ev) break;
        if (this.h.isStale(ev)) {
          this.resolve(ev.id, { ok: false, error: "stopped" });
          this.h.persistQueue();
          continue;
        }
        try {
          await this.execute(ev);
        } catch (err) {
          // Never let one bad turn take the gateway down; report it where the bot was working.
          this.current = undefined;
          this.lastError = String((err as Error)?.message ?? err);
          this.h.postNotice(ev.convId, `Something went wrong delivering a reply: ${this.lastError}`);
          this.waiters.get(ev.id)?.({ ok: false, error: this.lastError });
          this.waiters.delete(ev.id);
          this.emitStatus();
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async ensureSession(bot: Bot): Promise<RuntimeSession> {
    const runtime = this.h.runtimeFor(bot);
    if (this.session && this.sessionRuntime === runtime.id) return this.session;
    if (this.session) await this.resetSession();
    const resumeId = bot.agentRuntime === runtime.id ? bot.agentId : undefined;
    this.session = await runtime.open({
      botId: bot.id,
      agentId: resumeId,
      name: bot.name,
      cwd: this.h.store.paths.workspace,
      model: this.h.modelFor(bot, runtime),
    });
    this.sessionRuntime = runtime.id;
    if (bot.agentId !== this.session.agentId || bot.agentRuntime !== runtime.id) {
      if (bot.agentId !== this.session.agentId) this.needIdentity = true;
      bot.agentId = this.session.agentId;
      bot.agentRuntime = runtime.id;
      this.h.store.saveBots();
    }
    return this.session;
  }

  private identityFingerprint(bot: Bot): string {
    const s = this.h.store;
    const roster = [...s.bots.values()].map((b) => `${b.id}:${b.name}:${b.handle}:${b.label}:${b.about}`).join("|");
    const groups = s
      .conversationsFor(bot.id)
      .filter((c) => c.kind === "group")
      .map((c) => `${c.id}:${c.title}:${c.members.join(",")}:${c.lead}:${c.purpose}`)
      .join("|");
    return hash([bot.name, bot.label, bot.about, bot.disabledSkills.join(","), s.readMemory(bot.id), roster, groups, s.settings.user.name].join("\n"));
  }

  private async execute(wake: WakeEvent): Promise<void> {
    const h = this.h;
    const store = h.store;
    const bot = store.bots.get(this.botId);
    const conv = store.conversations.get(wake.convId);
    const finish = (r: { ok: boolean; error?: string; message?: Message }) => this.resolve(wake.id, r);
    if (!bot || !conv) return finish({ ok: false, error: "bot or conversation no longer exists" });

    // Every turn in a chain counts against one shared budget, however the chain branches.
    const turns = h.chargeChainTurn(wake, conv.id);
    if (turns === undefined) return finish({ ok: false, error: "chain run limit reached" });

    const state: RunState = {
      runId: newId("run"),
      wake: { ...wake, chain: { ...wake.chain, runs: turns } },
      bot,
      text: "",
      attachments: [],
      activity: new Map(),
      cancelled: false,
      startedAt: Date.now(),
    };
    this.current = state;
    this.lastError = undefined;
    this.h.persistQueue();
    this.emitStatus();
    h.bus.emit({ type: "run.started", botId: bot.id, convId: conv.id, runId: state.runId, source: wake.source });

    let outcome: RunOutcome;
    try {
      // Re-install the approval hooks if anything changed them since the last turn.
      h.healWorkspace(bot.id);
      const session = await this.ensureSession(bot);

      // Messages in this conversation the bot hasn't seen (other bots, earlier turns).
      const seen = store.lastSeen(bot.id, conv.id);
      const unseen = store
        .messages(conv.id)
        .filter(
          (m) =>
            m.ts > seen &&
            m.id !== wake.messageId &&
            !wake.alsoMessageIds?.includes(m.id) &&
            !this.delivered.has(m.id) &&
            !(m.author.kind === "bot" && m.author.id === bot.id) &&
            m.kind !== "activity",
        )
        .slice(-MAX_UNSEEN);

      // Images you attached go to the model directly; other files are referenced by path.
      const images: Array<{ data: string; mimeType: string }> = [];
      const inlined = new Set<string>();
      for (const a of wake.attachments ?? []) {
        if (images.length >= MAX_INLINE_IMAGES || !isImageMime(a.mime) || a.size > MAX_IMAGE_BYTES) continue;
        try {
          images.push({ data: fs.readFileSync(resolveInside(store.paths.workspace, a.path)).toString("base64"), mimeType: a.mime });
          inlined.add(a.path);
        } catch {
          // Missing file: the path is still listed in the prompt.
        }
      }

      const fp = this.identityFingerprint(bot);
      const includeIdentity = this.needIdentity || fp !== this.identityHash || this.turnsSinceIdentity >= IDENTITY_REFRESH_TURNS;
      if (includeIdentity) {
        this.identityHash = fp;
        this.turnsSinceIdentity = 0;
        this.needIdentity = false;
      } else {
        this.turnsSinceIdentity++;
      }

      const prompt = buildPrompt({
        bot,
        wake: state.wake,
        conv,
        store,
        timezone: h.timezone(),
        includeIdentity,
        unseen,
        inlinedImages: inlined,
        statusOf: (id) => h.statusLabel(id),
        skills: wake.source === "user" ? h.expandSkillRefs(wake.text, bot) : h.routineSkill(wake),
        incomingKind: h.incomingKind(wake, conv),
        addressed: h.addressedHint(wake),
        routineName: wake.routineId ? store.routines.get(wake.routineId)?.name : undefined,
      });
      const newest = store.messages(conv.id).at(-1);

      // A plain model API brings no tools, rules or MCP client of its own: the harness supplies them.
      const runtime = h.runtimeFor(bot);
      const provides = runtime.provides ?? { workspaceTools: true, projectContext: true, mcp: true };
      const tools = buildTools(h, bot.id, () => this.current);
      if (!provides.workspaceTools) tools.push(...buildWorkspaceTools(h, bot.id, () => this.current));
      if (!provides.mcp) tools.push(...(await this.mcpHub().tools(h.mcpServersFor(bot))));

      const run = await session.send({
        system: provides.projectContext ? undefined : h.systemPromptFor(bot, runtime),
        text: prompt,
        images: images.length ? images : undefined,
        tools,
        mcpServers: provides.mcp ? h.mcpServersFor(bot) : {},
        model: h.modelFor(bot, runtime),
        onEvent: (ev) => {
          if (ev.type === "text") {
            state.text += ev.text;
            h.bus.emit({ type: "run.delta", botId: bot.id, convId: conv.id, runId: state.runId, text: ev.text });
          } else if (ev.type === "thinking") {
            h.bus.emit({ type: "run.thinking", botId: bot.id, convId: conv.id, runId: state.runId, text: ev.text });
          } else if (ev.type === "tool") {
            const item: ActivityItem = { callId: ev.callId, name: ev.name, status: ev.status, summary: summarizeTool(ev.name, ev.args) };
            const prev = state.activity.get(ev.callId);
            if (prev && prev.summary && !item.summary) item.summary = prev.summary;
            state.activity.set(ev.callId, item);
            h.bus.emit({ type: "run.tool", botId: bot.id, convId: conv.id, runId: state.runId, item });
          } else if (ev.type === "status") {
            h.bus.emit({ type: "run.status", botId: bot.id, convId: conv.id, runId: state.runId, status: ev.status });
          } else if (ev.type === "summary") {
            // The runtime compacted its context; re-send identity and memory next turn.
            this.needIdentity = true;
          }
        },
      });
      state.run = run;
      // Only now has the model got this context; a send that throws leaves it unseen for next time.
      if (newest) {
        store.markSeen(bot.id, conv.id, newest.ts);
        for (const id of this.delivered) {
          const m = store.findMessage(conv.id, id);
          if (m && m.ts <= newest.ts) this.delivered.delete(id);
        }
      }
      if (state.cancelled) await run.cancel().catch(() => {});
      outcome = await run.wait();
    } catch (err: any) {
      outcome = { status: "error", text: "", error: describeError(err) };
    }
    // If the turn failed, the model may never have seen the full identity block.
    if (outcome.status === "error") this.needIdentity = true;

    let posted: Message | undefined;
    try {
      posted = h.finishRun(state, conv.id, outcome);
    } finally {
      if (outcome.status === "error") this.lastError = outcome.error;
      this.current = undefined;
      h.persistQueue();
      h.bus.emit({ type: "run.finished", botId: bot.id, convId: conv.id, runId: state.runId, status: outcome.status, error: outcome.error });
      this.emitStatus();
      finish({ ok: outcome.status === "finished", error: outcome.error, message: posted });
    }
  }
}

function describeError(err: any): string {
  const msg = String(err?.message ?? err ?? "unknown error");
  const help = err?.helpUrl ? ` (${err.helpUrl})` : "";
  const req = err?.requestId ? ` [request ${err.requestId}]` : "";
  return `${msg}${help}${req}`;
}

/** A one-line, human-readable description of a tool call for the activity list. */
export function summarizeTool(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, any>;
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof a[k] === "string" && a[k]) return a[k] as string;
    return undefined;
  };
  const s =
    pick("command", "cmd") ??
    pick("path", "filePath", "file_path", "targetFile", "target_file") ??
    pick("pattern", "query", "searchTerm", "glob", "globPattern") ??
    pick("url") ??
    pick("toolName", "tool_name", "name") ??
    pick("to", "action", "title", "description") ??
    "";
  if (a.toolName && a.providerIdentifier) return oneLine(`${a.providerIdentifier}.${a.toolName}`, 120);
  return oneLine(s, 140);
}
