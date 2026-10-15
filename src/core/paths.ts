import * as os from "node:os";
import * as path from "node:path";

/**
 * On-disk layout of a Cursor Bots home. Everything a bot "is" lives here, so
 * copying this folder moves your whole team (see docs/ARCHITECTURE.md).
 */
export interface HomePaths {
  home: string;
  config: string;
  state: string;
  bots: string;
  conversations: string;
  messages: string;
  routines: string;
  approvals: string;
  secretsMeta: string;
  secretsVault: string;
  secretKey: string;
  secretRequests: string;
  connectors: string;
  memory: string;
  seen: string;
  cursorStore: string;
  /** Conversation transcripts of bots on OpenAI-compatible providers (one JSONL per agent). */
  agents: string;
  /** API keys for model providers, in their own vault so bots can't reach them through secrets tools. */
  providerKeysVault: string;
  providerKeysMeta: string;
  logs: string;
  /** The shared "computer": cwd for every bot. */
  workspace: string;
  skills: string;
  uploads: string;
  hooksDir: string;
  hooksJson: string;
  rulesDir: string;
}

export function defaultHome(): string {
  return process.env.CURSOR_BOTS_HOME || path.join(os.homedir(), ".cursor-bots");
}

export function homePaths(home: string): HomePaths {
  const abs = path.resolve(home);
  const state = path.join(abs, "state");
  const workspace = path.join(abs, "workspace");
  return {
    home: abs,
    config: path.join(abs, "settings.json"),
    state,
    bots: path.join(state, "bots.json"),
    conversations: path.join(state, "conversations.json"),
    messages: path.join(state, "messages"),
    routines: path.join(state, "routines.json"),
    approvals: path.join(state, "approvals.json"),
    secretsMeta: path.join(state, "secrets.json"),
    secretsVault: path.join(state, "secrets.vault"),
    secretKey: path.join(state, "secret.key"),
    secretRequests: path.join(state, "secret-requests.json"),
    connectors: path.join(abs, "connectors.json"),
    memory: path.join(state, "memory"),
    seen: path.join(state, "seen.json"),
    cursorStore: path.join(abs, "cursor-store"),
    agents: path.join(state, "agents"),
    providerKeysVault: path.join(state, "provider-keys.vault"),
    providerKeysMeta: path.join(state, "provider-keys.json"),
    logs: path.join(abs, "logs"),
    workspace,
    skills: path.join(workspace, ".cursor", "skills"),
    uploads: path.join(workspace, "uploads"),
    hooksDir: path.join(workspace, ".cursor", "hooks"),
    hooksJson: path.join(workspace, ".cursor", "hooks.json"),
    rulesDir: path.join(workspace, ".cursor", "rules"),
  };
}
