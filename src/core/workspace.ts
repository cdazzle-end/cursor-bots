import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_AGENTS_MD, HARNESS_MANUAL } from "./manual.ts";
import type { HomePaths } from "./paths.ts";
import { readJson, writeFileAtomic, writeJson } from "./util.ts";

const GATE_SCRIPT = `#!/usr/bin/env node
// Installed by Cursor Bots. Cursor runs this before every shell command a bot
// makes (beforeShellExecution hook). It asks the Cursor Bots gateway whether
// the command needs your approval. If the gateway isn't running (e.g. you
// opened this folder in the Cursor IDE yourself) it allows the command.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch {}
let cfg;
try { cfg = JSON.parse(fs.readFileSync(path.join(here, "cursor-bots-gate.json"), "utf8")); } catch {}
const allow = () => process.stdout.write(JSON.stringify({ permission: "allow" }));
if (!cfg) { allow(); process.exit(0); }
try {
  const res = await fetch(cfg.url + "/api/gate/shell", {
    method: "POST",
    headers: { "content-type": "application/json", "x-gate-token": cfg.token },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 60000),
  });
  if (!res.ok) { allow(); process.exit(0); }
  process.stdout.write(JSON.stringify(await res.json()));
} catch {
  allow();
}
`;

/**
 * Prepare the shared workspace ("the computer"): house rules, the harness
 * manual as an always-on Cursor rule, the approval hook, and folders.
 */
export function prepareWorkspace(paths: HomePaths, gate: { url: string; token: string; timeoutMs: number }): void {
  for (const dir of [paths.workspace, paths.skills, paths.uploads, paths.hooksDir, paths.rulesDir, path.join(paths.workspace, "bots")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const agentsMd = path.join(paths.workspace, "AGENTS.md");
  if (!fs.existsSync(agentsMd)) writeFileAtomic(agentsMd, DEFAULT_AGENTS_MD);
  writeFileAtomic(path.join(paths.rulesDir, "cursor-bots.mdc"), HARNESS_MANUAL);

  const gateFile = path.join(paths.hooksDir, "cursor-bots-gate.mjs");
  writeFileAtomic(gateFile, GATE_SCRIPT);
  fs.chmodSync(gateFile, 0o755);
  writeJson(path.join(paths.hooksDir, "cursor-bots-gate.json"), gate);

  // Merge our hook into hooks.json without clobbering hooks you added yourself.
  const cfg = readJson<{ version?: number; hooks?: Record<string, Array<Record<string, unknown>>> }>(paths.hooksJson, {});
  cfg.version = cfg.version ?? 1;
  cfg.hooks = cfg.hooks ?? {};
  const command = `node .cursor/hooks/cursor-bots-gate.mjs`;
  const list = (cfg.hooks.beforeShellExecution ?? []).filter((h) => h.command !== command);
  list.unshift({ command, timeout: Math.ceil(gate.timeoutMs / 1000) + 10 });
  cfg.hooks.beforeShellExecution = list;
  writeJson(paths.hooksJson, cfg);
}

export function ensureBotFolder(paths: HomePaths, handle: string): string {
  const dir = path.join(paths.workspace, "bots", handle);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
