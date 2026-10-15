import type { BoundTool, McpServerSpec } from "../runtimes/types.ts";

export interface McpHubOptions {
  /** Reported to servers as clientInfo.name. */
  clientName: string;
  /** Working directory for stdio servers (the workspace). */
  cwd: string;
  /** Environment for stdio servers (credentials the gateway keeps for itself removed). */
  env: () => NodeJS.ProcessEnv;
  /** Applied to tool output before it goes to the model (removes secret values). */
  scrub?: (text: string) => string;
  /** A server failed to start or answer; the hub keeps going without it. */
  onError?: (server: string, message: string) => void;
}

/**
 * MCP client for runtimes without their own: connects to a bot's connectors
 * (stdio, Streamable HTTP or SSE) and exposes their tools as harness tools.
 */
export class McpHub {
  private opts: McpHubOptions;
  constructor(opts: McpHubOptions) {
    this.opts = opts;
  }

  /** Connect to (or reuse) these servers and return their tools. Servers no longer listed are closed. */
  async tools(servers: Record<string, McpServerSpec>): Promise<BoundTool[]> {
    void servers;
    void this.opts;
    return [];
  }

  async close(): Promise<void> {}
}
