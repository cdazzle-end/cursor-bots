import type { ModelChoice, ProviderConfig, ProviderModel } from "../core/types.ts";
import type { AgentRuntime, RuntimeModel, RuntimeProvides, RuntimeSession, SessionSpec } from "./types.ts";

export interface OpenAICompatOptions {
  /** Live provider config: read on every request, so edits apply at once. */
  provider: () => ProviderConfig;
  /** The provider's API key (undefined: none stored). Read on every request. */
  apiKey: () => string | undefined;
  /** Transcripts live at <transcriptDir>/<agentId>.jsonl (the harness passes state/agents). */
  transcriptDir: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** Injectable backoff sleep for tests; resolves early when the signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Attribution headers some providers ask for (HTTP-Referer / X-Title). */
  appName?: string;
  appUrl?: string;
}

/** A bot brain on any OpenAI-compatible chat API (Featherless, OpenRouter, xAI, Ollama, ...). */
export class OpenAICompatRuntime implements AgentRuntime {
  readonly provides: RuntimeProvides = { workspaceTools: false, projectContext: false, mcp: false };
  private opts: OpenAICompatOptions;

  constructor(opts: OpenAICompatOptions) {
    this.opts = opts;
  }

  get id(): string {
    return this.opts.provider().id;
  }

  get label(): string {
    return this.opts.provider().label;
  }

  available(): { ok: boolean; reason?: string } {
    return { ok: false, reason: "Not implemented yet." };
  }

  async open(spec: SessionSpec): Promise<RuntimeSession> {
    void spec;
    throw new Error("Not implemented yet.");
  }

  async complete(prompt: string, opts?: { model?: ModelChoice }): Promise<string> {
    void prompt;
    void opts;
    throw new Error("Not implemented yet.");
  }

  async listModels(): Promise<RuntimeModel[]> {
    return [];
  }

  /** Read the provider's model catalogue (GET {baseUrl}/models), optionally filtered by a search term. */
  async fetchModels(opts: { search?: string } = {}): Promise<ProviderModel[]> {
    void opts;
    return [];
  }

  /** Look one model up (GET {baseUrl}/models/{id}) to fill in its context window and abilities. */
  async lookupModel(id: string): Promise<ProviderModel | undefined> {
    void id;
    return undefined;
  }

  async dispose(): Promise<void> {}
}
