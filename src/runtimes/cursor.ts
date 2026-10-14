import * as fs from "node:fs";
import * as path from "node:path";
import type {
  InteractionUpdate,
  LocalAgentStore,
  McpServerConfig,
  Run,
  SDKAgent,
  SDKCustomTool,
  SDKCustomToolResult,
  SDKMessage,
} from "@cursor/sdk";
import type { ModelChoice } from "../core/types.ts";
import type {
  AgentRuntime,
  BoundTool,
  McpServerSpec,
  RunOutcome,
  RuntimeModel,
  RuntimeRun,
  RuntimeSession,
  SendInput,
  SessionSpec,
} from "./types.ts";

type Sdk = typeof import("@cursor/sdk");

export interface CursorRuntimeOptions {
  apiKey?: string;
  /** Directory for the SDK's JSONL agent store (conversation checkpoints). */
  storeDir: string;
  /** Scratch directory for one-shot routing prompts (kept empty on purpose). */
  scratchDir: string;
  /** Read live so settings changes apply to the next session that opens. */
  settings: () => { defaultModel: ModelChoice; autoReview: boolean; sandbox: boolean };
}

/**
 * Bots run on the Cursor SDK's *local* runtime: the agent loop runs inside
 * this process, files come from the shared workspace on disk, and inference
 * goes through Cursor's hosted models. Each bot is one durable SDK agent
 * (`agent-<uuid>`) whose conversation checkpoints live in a JSONL store, so a
 * bot keeps its context across restarts via Agent.resume().
 */
export class CursorRuntime implements AgentRuntime {
  readonly id = "cursor";
  readonly label = "Cursor SDK (local agent loop, Cursor-hosted models)";
  private sdk?: Sdk;
  private store?: LocalAgentStore;
  private opts: CursorRuntimeOptions;

  constructor(opts: CursorRuntimeOptions) {
    this.opts = opts;
  }

  private apiKey(): string | undefined {
    return this.opts.apiKey || process.env.CURSOR_API_KEY || undefined;
  }

  available(): { ok: boolean; reason?: string } {
    if (this.apiKey()) return { ok: true };
    const stored = path.join(process.env.HOME ?? "", ".cursor", "sdk", "auth.json");
    if (fs.existsSync(stored)) return { ok: true };
    return { ok: false, reason: "No CURSOR_API_KEY set (create one at cursor.com/dashboard → API Keys)." };
  }

  private async load(): Promise<{ sdk: Sdk; store: LocalAgentStore }> {
    if (!this.sdk) {
      this.sdk = await import("@cursor/sdk");
      fs.mkdirSync(this.opts.storeDir, { recursive: true });
      this.store = new this.sdk.JsonlLocalAgentStore(this.opts.storeDir);
    }
    return { sdk: this.sdk, store: this.store! };
  }

  private localOptions(cwd: string, store: LocalAgentStore) {
    return {
      cwd,
      store,
      // "project" loads the workspace's .cursor/ (skills, rules, hooks, mcp.json) and AGENTS.md.
      settingSources: ["project" as const],
      autoReview: this.opts.settings().autoReview,
      sandboxOptions: { enabled: this.opts.settings().sandbox },
    };
  }

  async open(spec: SessionSpec): Promise<RuntimeSession> {
    const { sdk, store } = await this.load();
    const apiKey = this.apiKey();
    const model = spec.model ?? this.opts.settings().defaultModel;
    let agent: SDKAgent | undefined;
    if (spec.agentId) {
      try {
        agent = await sdk.Agent.resume(spec.agentId, { apiKey, model, local: this.localOptions(spec.cwd, store) });
      } catch (err) {
        if (!(err instanceof sdk.AgentNotFoundError)) throw err;
        // The checkpoint store was wiped; the bot keeps its memory and starts a fresh context.
      }
    }
    if (!agent) {
      agent = await sdk.Agent.create({
        apiKey,
        name: `${spec.name} (Cursor Bots)`,
        model,
        local: this.localOptions(spec.cwd, store),
      });
    }
    return new CursorSession(agent, model);
  }

  async complete(prompt: string, opts?: { model?: ModelChoice }): Promise<string> {
    const { sdk } = await this.load();
    fs.mkdirSync(this.opts.scratchDir, { recursive: true });
    const scratchStore = new sdk.JsonlLocalAgentStore(path.join(this.opts.scratchDir, ".store"));
    const agent = await sdk.Agent.create({
      apiKey: this.apiKey(),
      name: "cursor-bots-router",
      model: opts?.model ?? this.opts.settings().defaultModel,
      tools: [],
      local: { cwd: this.opts.scratchDir, store: scratchStore, settingSources: [] },
    });
    try {
      const run = await agent.send(prompt);
      const result = await run.wait();
      return result.result ?? "";
    } finally {
      agent.close();
      sdk.Agent.delete(agent.agentId, { cwd: this.opts.scratchDir, store: scratchStore }).catch(() => {});
    }
  }

  async listModels(): Promise<RuntimeModel[]> {
    const { sdk } = await this.load();
    const models = await sdk.Cursor.models.list({ apiKey: this.apiKey() });
    return models.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      description: m.description,
      parameters: m.parameters,
    }));
  }
}

class CursorSession implements RuntimeSession {
  private agent: SDKAgent;
  private model: ModelChoice;
  constructor(agent: SDKAgent, model: ModelChoice) {
    this.agent = agent;
    this.model = model;
  }

  get agentId(): string {
    return this.agent.agentId;
  }

  async send(input: SendInput): Promise<RuntimeRun> {
    const model = input.model ?? this.model;
    const send = (force: boolean) =>
      this.agent.send(
        { text: input.text, images: input.images?.map((i) => ({ data: i.data, mimeType: i.mimeType })) },
        {
          model,
          mcpServers: toSdkMcp(input.mcpServers),
          local: { customTools: toSdkTools(input.tools), force },
          onDelta: ({ update }) => forwardDelta(update, input.onEvent),
        },
      );
    let run: Run;
    try {
      run = await send(false);
    } catch (err) {
      // A run left "active" by a crashed process blocks follow-ups; expire it and retry once.
      if (!String((err as Error)?.message ?? err).match(/busy|active run/i)) throw err;
      run = await send(true);
    }
    return new CursorRun(run, input.onEvent);
  }

  async close(): Promise<void> {
    this.agent.close();
  }
}

class CursorRun implements RuntimeRun {
  private run: Run;
  private streamDone: Promise<void>;
  constructor(run: Run, onEvent: SendInput["onEvent"]) {
    this.run = run;
    // Tool lifecycle comes from the normalized stream; text deltas come from onDelta.
    this.streamDone = (async () => {
      try {
        if (!run.supports("stream")) return;
        for await (const ev of run.stream()) forwardMessage(ev, onEvent);
      } catch {
        // Stream errors surface through wait().
      }
    })();
  }

  get id(): string {
    return this.run.id;
  }

  async steer(text: string): Promise<boolean> {
    if (!this.run.steer) return false;
    try {
      return (await this.run.steer(text)) === "complete_delivered";
    } catch {
      return false;
    }
  }

  async cancel(): Promise<void> {
    await this.run.cancel();
  }

  async wait(): Promise<RunOutcome> {
    const result = await this.run.wait();
    await this.streamDone;
    return {
      status: result.status,
      text: result.result ?? "",
      error: result.error?.message,
      requestId: result.requestId,
      model: result.model?.id,
      durationMs: result.durationMs,
      usage: result.usage
        ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, totalTokens: result.usage.totalTokens }
        : undefined,
    };
  }
}

function toSdkTools(tools: BoundTool[]): Record<string, SDKCustomTool> {
  const out: Record<string, SDKCustomTool> = {};
  for (const t of tools) {
    out[t.name] = {
      description: t.description,
      inputSchema: t.inputSchema as SDKCustomTool["inputSchema"],
      annotations: { title: t.name, readOnlyHint: t.readOnly, destructiveHint: t.destructive },
      execute: async (args): Promise<SDKCustomToolResult> => {
        const res = await t.execute(args as Record<string, unknown>);
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType?: string }> = [
          { type: "text", text: res.text },
        ];
        for (const img of res.images ?? []) content.push({ type: "image", data: img.data, mimeType: img.mimeType });
        return { content, isError: res.isError };
      },
    };
  }
  return out;
}

function toSdkMcp(servers: Record<string, McpServerSpec>): Record<string, McpServerConfig> | undefined {
  const entries = Object.entries(servers);
  if (!entries.length) return undefined;
  const out: Record<string, McpServerConfig> = {};
  for (const [name, s] of entries) {
    if (s.url) {
      out[name] = { type: s.type === "sse" ? "sse" : "http", url: s.url, headers: s.headers };
    } else if (s.command) {
      out[name] = { type: "stdio", command: s.command, args: s.args, env: s.env, cwd: s.cwd };
    }
  }
  return out;
}

function forwardDelta(update: InteractionUpdate, onEvent: SendInput["onEvent"]): void {
  switch (update.type) {
    case "text-delta":
      onEvent({ type: "text", text: update.text });
      break;
    case "thinking-delta":
      onEvent({ type: "thinking", text: update.text });
      break;
    case "summary-completed":
      onEvent({ type: "summary" });
      break;
  }
}

function forwardMessage(ev: SDKMessage, onEvent: SendInput["onEvent"]): void {
  if (ev.type === "tool_call") {
    onEvent({ type: "tool", callId: ev.call_id, name: ev.name, status: ev.status, args: ev.args, result: ev.result });
  } else if (ev.type === "status") {
    onEvent({ type: "status", status: ev.status });
  }
}
