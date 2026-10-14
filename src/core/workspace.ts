import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_AGENTS_MD, HARNESS_MANUAL } from "./manual.ts";
import type { HomePaths } from "./paths.ts";
import { readJson, writeFileAtomic, writeJson } from "./util.ts";

const GATE_SCRIPT = `#!/usr/bin/env node
// Installed by Cursor Bots. Cursor runs this hook in two places:
//   prompt: before each prompt a bot submits, to tell the gateway which bot
//           owns this Cursor conversation (it sends only the prompt's first line).
//   shell:  before every shell command a bot runs, to ask the gateway whether the
//           command needs your approval.
// If the gateway isn't running (e.g. you opened this folder in the Cursor IDE
// yourself) it lets everything through, so it never gets in your way.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] === "prompt" ? "prompt" : "shell";
const pass = mode === "prompt" ? { continue: true } : { permission: "allow" };
const here = path.dirname(fileURLToPath(import.meta.url));
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch {}
let cfg;
try { cfg = JSON.parse(fs.readFileSync(path.join(here, "cursor-bots-gate.json"), "utf8")); } catch {}
const done = (out) => { process.stdout.write(JSON.stringify(out)); process.exit(0); };
if (!cfg) done(pass);
const body = mode === "prompt"
  ? { conversation_id: input.conversation_id, prompt: String(input.prompt ?? "").slice(0, 400) }
  : input;
try {
  const res = await fetch(cfg.url + "/api/gate/" + mode, {
    method: "POST",
    headers: { "content-type": "application/json", "x-gate-token": cfg.token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(mode === "prompt" ? 5000 : (cfg.timeoutMs ?? 60000)),
  });
  done(res.ok ? await res.json() : pass);
} catch {
  done(pass);
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
  const ours = (h: Record<string, unknown>) => String(h.command ?? "").includes("cursor-bots-gate.mjs");
  const shell = (cfg.hooks.beforeShellExecution ?? []).filter((h) => !ours(h));
  shell.unshift({ command: "node .cursor/hooks/cursor-bots-gate.mjs shell", timeout: Math.ceil(gate.timeoutMs / 1000) + 10 });
  cfg.hooks.beforeShellExecution = shell;
  const prompt = (cfg.hooks.beforeSubmitPrompt ?? []).filter((h) => !ours(h));
  prompt.unshift({ command: "node .cursor/hooks/cursor-bots-gate.mjs prompt", timeout: 10 });
  cfg.hooks.beforeSubmitPrompt = prompt;
  writeJson(paths.hooksJson, cfg);
}

export function ensureBotFolder(paths: HomePaths, handle: string): string {
  const dir = path.join(paths.workspace, "bots", handle);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
