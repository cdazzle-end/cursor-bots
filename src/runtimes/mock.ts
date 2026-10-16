import { randomUUID } from "node:crypto";
import type {
  AgentRuntime,
  BoundTool,
  RunOutcome,
  RuntimeProvides,
  RuntimeRun,
  RuntimeSession,
  SendInput,
  SessionSpec,
} from "./types.ts";

/**
 * A scripted stand-in brain used for tests and for trying the app without a
 * Cursor API key. It understands a few natural phrases plus explicit
 * directives, so every harness feature (tools, handoffs, groups, approvals)
 * can be exercised deterministically:
 *
 *   [[tool send_message {"to":"@critic","text":"Review this"}]]
 *   [[reply Final text]]   [[silent]]   [[sleep 500]]   [[error Boom]]
 */
export class MockRuntime implements AgentRuntime {
  readonly id = "mock";
  readonly label = "Demo brain (scripted, no API key needed)";
  /** Delay between streamed chunks; tests set this to 0. */
  chunkDelayMs: number;
  readonly sessions = new Map<string, MockSession>();
  /** Tests can pretend to be a bare model API, so the harness supplies tools, rules and MCP. */
  readonly provides?: RuntimeProvides;

  constructor(opts: { chunkDelayMs?: number; provides?: RuntimeProvides } = {}) {
    this.chunkDelayMs = opts.chunkDelayMs ?? 25;
    this.provides = opts.provides;
  }

  available() {
    return { ok: true };
  }

  async open(spec: SessionSpec): Promise<RuntimeSession> {
    const id = spec.agentId?.startsWith("mock-") ? spec.agentId : `mock-${randomUUID()}`;
    let s = this.sessions.get(id);
    if (!s) {
      s = new MockSession(id, spec.name, this);
      this.sessions.set(id, s);
    }
    return s;
  }

  async complete(prompt: string): Promise<string> {
    // Routing prompt: pick the candidate whose name or label words appear in the message.
    const message = /<message>([\s\S]*?)<\/message>/.exec(prompt)?.[1]?.toLowerCase() ?? "";
    const candidates = [...prompt.matchAll(/^- @([\w-]+)(?: — (.*))?$/gm)].map((m) => ({ handle: m[1]!, label: (m[2] ?? "").toLowerCase() }));
    let best = candidates[0]?.handle ?? "";
    let bestScore = 0;
    for (const c of candidates) {
      let score = message.includes(c.handle) ? 5 : 0;
      for (const w of c.label.split(/\W+/)) if (w.length > 3 && message.includes(w)) score++;
      if (score > bestScore) {
        bestScore = score;
        best = c.handle;
      }
    }
    return best;
  }
}

export class MockSession implements RuntimeSession {
  readonly agentId: string;
  readonly name: string;
  private rt: MockRuntime;
  /** Every prompt this session received (tests inspect it). */
  readonly prompts: string[] = [];
  /** The system prompt sent with each prompt (only for runtimes without project context). */
  readonly systems: Array<string | undefined> = [];
  /** Tool names offered with each prompt. */
  readonly toolNames: string[][] = [];
  /** How many images came with each prompt. */
  readonly imageCounts: number[] = [];

  constructor(agentId: string, name: string, rt: MockRuntime) {
    this.agentId = agentId;
    this.name = name;
    this.rt = rt;
  }

  async send(input: SendInput): Promise<RuntimeRun> {
    this.prompts.push(input.text);
    this.systems.push(input.system);
    this.toolNames.push(input.tools.map((t) => t.name));
    this.imageCounts.push(input.images?.length ?? 0);
    return new MockRun(this, input, this.rt.chunkDelayMs);
  }

  async close(): Promise<void> {}
}

class MockRun implements RuntimeRun {
  readonly id = `mockrun-${randomUUID()}`;
  private cancelled = false;
  private steered: string[] = [];
  private done: Promise<RunOutcome>;
  private session: MockSession;
  private input: SendInput;
  private delay: number;

  constructor(session: MockSession, input: SendInput, delay: number) {
    this.session = session;
    this.input = input;
    this.delay = delay;
    this.done = this.execute();
  }

  async steer(text: string): Promise<boolean> {
    this.steered.push(text);
    return true;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }

  wait(): Promise<RunOutcome> {
    return this.done;
  }

  private async pause(ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end && !this.cancelled) await new Promise((r) => setTimeout(r, Math.min(20, end - Date.now())));
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const tool: BoundTool | undefined = this.input.tools.find((t) => t.name === name);
    const callId = randomUUID();
    if (!tool) return `(no tool named ${name})`;
    this.input.onEvent({ type: "tool", callId, name, status: "running", args });
    const res = await tool.execute(args);
    this.input.onEvent({ type: "tool", callId, name, status: res.isError ? "error" : "completed", args, result: res.text });
    return res.text;
  }

  private async execute(): Promise<RunOutcome> {
    const started = Date.now();
    const prompt = this.input.text;
    const incoming = /<incoming([^>]*)>([\s\S]*?)<\/incoming>/.exec(prompt);
    const attrs = incoming?.[1] ?? "";
    const body = (incoming?.[2] ?? prompt).trim();
    const from = /from="([^"]*)"/.exec(attrs)?.[1] ?? "someone";
    const kind = /kind="([^"]*)"/.exec(attrs)?.[1] ?? "message";
    const allowSilence = /<reply-instructions>[\s\S]*NO_REPLY/.test(prompt);
    let reply: string | undefined;
    const toolResults: string[] = [];

    const directive = /\[\[(\w+)(?:\s+([\s\S]*?))?\]\]/g;
    let sawDirective = false;
    for (const m of body.matchAll(directive)) {
      sawDirective = true;
      const [, op, arg = ""] = m;
      if (this.cancelled) break;
      if (op === "tool") {
        const sp = arg.indexOf(" ");
        const name = sp < 0 ? arg : arg.slice(0, sp);
        const json = sp < 0 ? "{}" : arg.slice(sp + 1);
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(json);
        } catch {
          toolResults.push(`bad JSON for ${name}`);
          continue;
        }
        toolResults.push(await this.callTool(name, args));
      } else if (op === "reply") {
        reply = arg;
      } else if (op === "bounce") {
        // Mention the given teammate and ask them to bounce back to us (loop tests).
        const me = /<you name="[^"]*" handle="@([^"]+)"/.exec(prompt)?.[1] ?? "me";
        reply = `[[bounce ${me}]] over to @${arg.trim()}`;
      } else if (op === "silent") {
        reply = "NO_REPLY";
      } else if (op === "sleep") {
        await this.pause(Number(arg) || 0);
      } else if (op === "error") {
        return { status: "error", text: "", error: arg || "scripted failure", durationMs: Date.now() - started };
      }
    }

    if (!sawDirective) {
      const plain = body.replace(/^\[attachment\].*$/gm, "").trim();
      const remember = /^(?:please\s+)?remember(?:\s+that)?[:,]?\s+([\s\S]+)/i.exec(plain);
      const ask = /\b(?:ask|tell|message)\s+@([\w-]+)\s+(?:to\s+)?([\s\S]+)/i.exec(plain);
      if (remember) {
        toolResults.push(await this.callTool("memory_update", { action: "add", section: "Lasting rules", text: remember[1]!.trim() }));
        reply = `Got it. I saved that to my memory: “${remember[1]!.trim()}”.`;
      } else if (ask) {
        const res = await this.callTool("send_message", { to: `@${ask[1]}`, text: ask[2]!.trim() });
        reply = `I handed that to @${ask[1]}. ${res}`;
      } else if (kind === "handoff") {
        reply = `(${this.session.name}) Done. Here's my take on “${oneLine(plain, 80)}”: looks good from my side.`;
      } else if (kind === "handoff_reply") {
        reply = `(${this.session.name}) Update from my teammate: ${oneLine(plain, 160)}`;
      } else if (allowSilence && kind === "group_message" && !/addressed="you"/.test(attrs)) {
        reply = "NO_REPLY";
      } else {
        reply =
          `Hi ${from.replace(/^@/, "")}! I'm ${this.session.name}, running on the demo brain (no CURSOR_API_KEY yet), so I can't really think. ` +
          `I received: “${oneLine(plain, 160)}”.`;
      }
    }

    if (this.steered.length) reply = `${reply ?? ""}\n\n(Also noted while working: ${this.steered.join(" / ")})`.trim();
    if (reply === undefined) reply = toolResults.length ? `Done. ${toolResults.join(" ")}` : "Done.";
    if (this.cancelled) return { status: "cancelled", text: "", durationMs: Date.now() - started };

    if (reply !== "NO_REPLY") {
      for (const chunk of reply.match(/.{1,24}/gs) ?? []) {
        if (this.cancelled) return { status: "cancelled", text: "", durationMs: Date.now() - started };
        this.input.onEvent({ type: "text", text: chunk });
        if (this.delay) await this.pause(this.delay);
      }
    }
    return {
      status: "finished",
      text: reply,
      durationMs: Date.now() - started,
      model: "mock",
      usage: { inputTokens: Math.ceil(prompt.length / 4), outputTokens: Math.ceil(reply.length / 4), totalTokens: Math.ceil((prompt.length + reply.length) / 4) },
    };
  }
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
