import type { ModelChoice, ProviderModel } from "../core/types.ts";

/**
 * A runtime is the "brain" behind a bot: it owns the agent loop, the model,
 * and the bot's long-lived conversation context. The harness owns everything
 * else (identity, memory, messaging, schedules, approvals). Swapping runtimes
 * swaps the agent, not the team.
 */
/**
 * What a runtime brings itself. The Cursor SDK has its own file and shell
 * tools, loads the workspace's rules and skills, and runs MCP servers; a plain
 * model API has none of that, so the harness supplies it (its own workspace
 * tools, a system prompt, and an MCP client). Undefined means "all true".
 */
export interface RuntimeProvides {
  workspaceTools: boolean;
  projectContext: boolean;
  mcp: boolean;
}

export interface AgentRuntime {
  readonly id: string;
  readonly label: string;
  readonly provides?: RuntimeProvides;
  /** Whether this runtime can run right now (e.g. API key present). */
  available(): { ok: boolean; reason?: string };
  /** Open (create or resume) the long-lived agent session for one bot. */
  open(spec: SessionSpec): Promise<RuntimeSession>;
  /** One-shot text completion for small decisions (group routing). Optional. */
  complete?(prompt: string, opts?: { model?: ModelChoice }): Promise<string>;
  listModels?(): Promise<RuntimeModel[]>;
  /** Providers: read the service's model catalogue (optionally filtered). */
  fetchModels?(opts?: { search?: string }): Promise<ProviderModel[]>;
  /** Providers: look one model up to learn its context window and abilities. */
  lookupModel?(id: string): Promise<ProviderModel | undefined>;
  dispose?(): Promise<void>;
}

export interface RuntimeModel {
  id: string;
  displayName: string;
  description?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  vision?: boolean;
  /** The provider says the model supports function calling. */
  toolUse?: boolean;
  concurrencyCost?: number;
  parameters?: Array<{ id: string; displayName?: string; values: Array<{ value: string; displayName?: string }> }>;
}

export interface SessionSpec {
  botId: string;
  /** Existing session to resume. Undefined creates a fresh one. */
  agentId?: string;
  name: string;
  /** The shared workspace every bot works in. */
  cwd: string;
  model?: ModelChoice;
}

export interface McpServerSpec {
  type?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

/** A harness tool bound to one bot. Runtimes expose these to the model. */
export interface BoundTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
  destructive?: boolean;
  execute(args: Record<string, unknown>): Promise<ToolOutput>;
}

export interface ToolOutput {
  text: string;
  isError?: boolean;
  images?: Array<{ data: string; mimeType: string }>;
}

export interface SendInput {
  /** Standing instructions (manual, house rules, skills index) for runtimes without project context. */
  system?: string;
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
  tools: BoundTool[];
  mcpServers: Record<string, McpServerSpec>;
  model?: ModelChoice;
  onEvent: (event: RuntimeEvent) => void;
}

export interface RuntimeSession {
  /** Durable id of the agent session; persisted on the bot so it survives restarts. */
  readonly agentId: string;
  send(input: SendInput): Promise<RuntimeRun>;
  close(): Promise<void>;
}

export interface RuntimeRun {
  readonly id: string;
  /** Inject a message into the running turn. Resolves true if the turn took it. */
  steer?(text: string): Promise<boolean>;
  cancel(): Promise<void>;
  wait(): Promise<RunOutcome>;
}

export interface RunOutcome {
  status: "finished" | "error" | "cancelled";
  text: string;
  error?: string;
  requestId?: string;
  model?: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  durationMs?: number;
}

export type RuntimeEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; callId: string; name: string; status: "running" | "completed" | "error"; args?: unknown; result?: unknown }
  /** The runtime compacted (summarized) its context; the harness re-sends identity next turn. */
  | { type: "summary" }
  | { type: "status"; status: string };
