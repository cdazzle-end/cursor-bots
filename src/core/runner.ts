import * as fs from "node:fs";
import type { Harness } from "./harness.ts";
import { buildPrompt } from "./prompt.ts";
import type { ActivityItem, Attachment, Bot, Id, Message, WakeEvent } from "./types.ts";
import { hash, isImageMime, newId, oneLine, resolveInside } from "./util.ts";
import type { BotStatus } from "./events.ts";
import type { RunOutcome, RuntimeRun, RuntimeSession } from "../runtimes/types.ts";
import { buildTools } from "./tools.ts";

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

  async enqueue(ev: WakeEvent): Promise<void> {
    // A new message from you in the conversation the bot is working on goes
    // straight into the running turn (Grok Bot: your message "can redirect
    // the current turn").
    const cur = this.current;
    if (cur?.run?.steer && ev.source === "user" && ev.convId === cur.wake.convId && !cur.cancelled) {
      const ok = await cur.run.steer(`Message from ${this.h.store.settings.user.name} while you work:\n${ev.text}`);
      if (ok) {
        if (ev.messageId) {
          const m = this.h.store.findMessage(ev.convId, ev.messageId);
          if (m) this.h.store.markSeen(this.botId, ev.convId, m.ts);
        }
        this.waiters.get(ev.id)?.({ ok: true });
        this.waiters.delete(ev.id);
        return;
      }
    }
    this.queue.push(ev);
    this.h.persistQueue();
    this.emitStatus();
    void this.pump();
  }

  /** Drop queued work for a conversation and cancel the running turn if it replies there. */
  async stop(convId?: Id): Promise<boolean> {
    const before = this.queue.length;
    const dropped = this.queue.filter((q) => !convId || q.convId === convId);
    this.queue = this.queue.filter((q) => convId && q.convId !== convId);
    for (const d of dropped) {
      this.waiters.get(d.id)?.({ ok: false, error: "stopped" });
      this.waiters.delete(d.id);
    }
    let stopped = before !== this.queue.length;
    const cur = this.current;
    if (cur && (!convId || cur.wake.convId === convId)) {
      cur.cancelled = true;
      stopped = true;
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

  async dispose(): Promise<void> {
    await this.stop();
    await this.session?.close().catch(() => {});
    this.session = undefined;
  }

  /** Forget the runtime session (e.g. after the bot's runtime or model changed). */
  async resetSession(): Promise<void> {
    await this.session?.close().catch(() => {});
    this.session = undefined;
    this.needIdentity = true;
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
    const merged: WakeEvent = {
      ...first,
      text: [first.text, ...same.map((s) => s.text)].filter(Boolean).join("\n\n"),
      attachments: [...(first.attachments ?? []), ...same.flatMap((s) => s.attachments ?? [])],
      messageId: same[same.length - 1]!.messageId ?? first.messageId,
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
      while (!this.current) {
        const ev = this.next();
        if (!ev) break;
        this.h.persistQueue();
        await this.execute(ev);
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
      model: bot.model ?? this.h.store.settings.defaultModel,
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
    const finish = (r: { ok: boolean; error?: string; message?: Message }) => {
      this.waiters.get(wake.id)?.(r);
      this.waiters.delete(wake.id);
    };
    if (!bot || !conv) return finish({ ok: false, error: "bot or conversation no longer exists" });

    const limits = store.settings.limits;
    if (wake.chain.runs >= limits.maxChainRuns) {
      h.postNotice(conv.id, `Stopped a chain of bot-to-bot work after ${limits.maxChainRuns} turns to prevent a loop. Send a message to continue.`);
      return finish({ ok: false, error: "chain run limit reached" });
    }

    const state: RunState = {
      runId: newId("run"),
      wake: { ...wake, chain: { ...wake.chain, runs: wake.chain.runs + 1 } },
      bot,
      text: "",
      attachments: [],
      activity: new Map(),
      cancelled: false,
      startedAt: Date.now(),
    };
    this.current = state;
    this.lastError = undefined;
    this.emitStatus();
    h.bus.emit({ type: "run.started", botId: bot.id, convId: conv.id, runId: state.runId, source: wake.source });

    let outcome: RunOutcome;
    try {
      const session = await this.ensureSession(bot);

      // Messages in this conversation the bot hasn't seen (other bots, earlier turns).
      const seen = store.lastSeen(bot.id, conv.id);
      const unseen = store
        .messages(conv.id)
        .filter((m) => m.ts > seen && m.id !== wake.messageId && !(m.author.kind === "bot" && m.author.id === bot.id) && m.kind !== "activity")
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
      if (newest) store.markSeen(bot.id, conv.id, newest.ts);

      const run = await session.send({
        text: prompt,
        images: images.length ? images : undefined,
        tools: buildTools(h, bot.id, () => this.current),
        mcpServers: h.mcpServersFor(bot),
        model: bot.model,
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
          } else if (ev.type === "summary") {
            // The runtime compacted its context; re-send identity and memory next turn.
            this.needIdentity = true;
          }
        },
      });
      state.run = run;
      if (state.cancelled) await run.cancel().catch(() => {});
      outcome = await run.wait();
    } catch (err: any) {
      outcome = { status: "error", text: "", error: describeError(err) };
    }

    let posted: Message | undefined;
    try {
      posted = h.finishRun(state, conv.id, outcome);
    } finally {
      if (outcome.status === "error") this.lastError = outcome.error;
      this.current = undefined;
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
