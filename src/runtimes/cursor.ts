import * as fs from "node:fs";
import * as os from "node:os";
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

export type Sdk = typeof import("@cursor/sdk");

/** An agent store the runtime opened and closes on dispose. */
export type OpenedStore = LocalAgentStore & { dispose?(): Promise<void> };

export interface CursorRuntimeOptions {
  apiKey?: string;
  /** State root of the SDK's SQLite agent store (index.db plus checkpoint blobs). */
  storeDir: string;
  /** Scratch directory for one-shot routing prompts (kept empty on purpose). */
  scratchDir: string;
  /** Read live so settings changes apply to the next session that opens. */
  settings: () => { defaultModel: ModelChoice; autoReview: boolean; sandbox: boolean };
  /** Load the SDK module. Tests inject a fake; normally it's a dynamic import. */
  loadSdk?: () => Promise<Sdk>;
  /** Open an agent store. Tests inject a fake; normally the SDK's SQLite store. */
  openStore?: (o: { workspaceRef: string; stateRoot: string }) => Promise<OpenedStore>;
}

/**
 * Where Cursor credentials come from: CURSOR_API_KEY, or a login the SDK
 * stored in ~/.cursor/sdk/auth.json. "expired" is a stored login the SDK
 * would no longer use.
 */
export function cursorCredentials(apiKey?: string): "key" | "login" | "expired" | undefined {
  if (apiKey || process.env.CURSOR_API_KEY) return "key";
  try {
    // The same checks the SDK applies before it uses a stored login.
    const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".cursor", "sdk", "auth.json"), "utf8"));
    const backend = (process.env.CURSOR_BACKEND_URL ?? "https://api2.cursor.sh").replace(/\/+$/, "");
    const valid =
      auth?.version === 1 &&
      typeof auth.apiKey === "string" &&
      auth.apiKey &&
      typeof auth.backendUrl === "string" &&
      typeof auth.createdAtMs === "number" &&
      (auth.apiKeyExpiresAtMs === undefined || typeof auth.apiKeyExpiresAtMs === "number");
    if (!valid || auth.backendUrl !== backend) return undefined;
    return auth.apiKeyExpiresAtMs !== undefined && auth.apiKeyExpiresAtMs <= Date.now() ? "expired" : "login";
  } catch {
    return undefined;
  }
}

async function openSqliteStore(o: { workspaceRef: string; stateRoot: string }): Promise<OpenedStore> {
  const { SqliteLocalAgentStore } = await import("@cursor/sdk/sqlite");
  return SqliteLocalAgentStore.open(o);
}

/** The SDK cannot abort setup/send, so stop waiting and clean up anything returned later. */
async function routingStep<T>(start: () => Promise<T>, signal?: AbortSignal, onLate?: (value: T) => void): Promise<T> {
  const cancelled = () => new DOMException("Cursor routing cancelled.", "AbortError");
  if (signal?.aborted) throw cancelled();
  if (!signal) return start();
  const pending = start().then((value) => {
    if (signal.aborted) {
      onLate?.(value);
      throw cancelled();
    }
    return value;
  });
  let onAbort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(cancelled());
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, stopped]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Bots run on the Cursor SDK's *local* runtime: the agent loop runs inside
 * this process, files come from the shared workspace on disk, and inference
 * goes through Cursor's hosted models. Each bot is one durable SDK agent
 * (`agent-<uuid>`) whose conversation checkpoints live in the SDK's SQLite
 * store, so a bot keeps its context across restarts via Agent.resume().
 * (The SDK's JSONL store rewrites its whole file for every streamed event,
 * which gets slower with every turn, so it isn't used.)
 */
export class CursorRuntime implements AgentRuntime {
  readonly id = "cursor";
  readonly label = "Cursor SDK (local agent loop, Cursor-hosted models)";
  private sdk?: Sdk;
  /** One store per state root, opened once and shared by every session on it. */
  private stores = new Map<string, Promise<OpenedStore>>();
  private opts: CursorRuntimeOptions;

  constructor(opts: CursorRuntimeOptions) {
    this.opts = opts;
    // An exported but empty CURSOR_API_KEY stops the SDK from using a stored login.
    if (process.env.CURSOR_API_KEY === "") delete process.env.CURSOR_API_KEY;
  }

  private apiKey(): string | undefined {
    return this.opts.apiKey || process.env.CURSOR_API_KEY || undefined;
  }

  available(): { ok: boolean; reason?: string } {
    const creds = cursorCredentials(this.opts.apiKey);
    if (creds === "key" || creds === "login") return { ok: true };
    if (creds === "expired") return { ok: false, reason: "Your stored Cursor login has expired: log in again or set CURSOR_API_KEY." };
    return { ok: false, reason: "No Cursor credentials: set CURSOR_API_KEY (create one at cursor.com/dashboard → API Keys)." };
  }

  private async load(): Promise<Sdk> {
    if (!this.sdk) this.sdk = this.opts.loadSdk ? await this.opts.loadSdk() : await import("@cursor/sdk");
    return this.sdk;
  }

  private storeFor(workspaceRef: string, stateRoot: string): Promise<OpenedStore> {
    let store = this.stores.get(stateRoot);
    if (!store) {
      fs.mkdirSync(stateRoot, { recursive: true });
      store = (this.opts.openStore ?? openSqliteStore)({ workspaceRef, stateRoot });
      // A failed open is retried on the next session instead of sticking.
      store.catch(() => this.stores.delete(stateRoot));
      this.stores.set(stateRoot, store);
    }
    return store;
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
    const sdk = await this.load();
    const store = await this.storeFor(spec.cwd, this.opts.storeDir);
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

  async complete(prompt: string, opts?: { model?: ModelChoice; signal?: AbortSignal }): Promise<string> {
    const signal = opts?.signal;
    const sdk = await routingStep(() => this.load(), signal);
    const scratchStore = await routingStep(() => {
      fs.mkdirSync(this.opts.scratchDir, { recursive: true });
      return this.storeFor(this.opts.scratchDir, path.join(this.opts.scratchDir, ".store"));
    }, signal);
    const cleanup = (agent: SDKAgent) => {
      try {
        agent.close();
      } finally {
        sdk.Agent.delete(agent.agentId, { cwd: this.opts.scratchDir, store: scratchStore }).catch(() => {});
      }
    };
    const agent = await routingStep(() => sdk.Agent.create({
      apiKey: this.apiKey(),
      name: "cursor-bots-router",
      model: opts?.model ?? this.opts.settings().defaultModel,
      tools: [],
      local: { cwd: this.opts.scratchDir, store: scratchStore, settingSources: [] },
    }), signal, cleanup);
    try {
      const cancel = (run: Run) => { run.cancel().catch(() => {}); };
      const run = await routingStep(() => agent.send(prompt), signal, cancel);
      const onAbort = () => cancel(run);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await routingStep(() => run.wait(), signal);
        return result.result ?? "";
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    } finally {
      cleanup(agent);
    }
  }

  async listModels(): Promise<RuntimeModel[]> {
    const sdk = await this.load();
    const models = await sdk.Cursor.models.list({ apiKey: this.apiKey() });
    return models.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      description: m.description,
      parameters: m.parameters,
    }));
  }

  async dispose(): Promise<void> {
    const stores = [...this.stores.values()];
    this.stores.clear();
    for (const store of stores) await (await store.catch(() => undefined))?.dispose?.().catch(() => {});
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
    // Tool lifecycle and compaction come from the normalized stream; text deltas come from onDelta.
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
      // A failed run's text may be cut off part way: only a finished run's is a reply.
      text: result.status === "finished" ? (result.result ?? "") : "",
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
  }
}

function forwardMessage(ev: SDKMessage, onEvent: SendInput["onEvent"]): void {
  if (ev.type === "tool_call") {
    onEvent({ type: "tool", callId: ev.call_id, name: ev.name, status: ev.status, args: ev.args, result: ev.result });
  } else if (ev.type === "status") {
    onEvent({ type: "status", status: ev.status });
  } else if (ev.type === "task") {
    // The SDK keeps summary updates out of onDelta; in a local run the stream's
    // "task" message is the compaction summary.
    onEvent({ type: "summary" });
  }
}
