import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_AGENTS_MD, HARNESS_MANUAL } from "./manual.ts";
import type { HomePaths } from "./paths.ts";
import { readJson, writeFileAtomic, writeJson } from "./util.ts";

const GATE_SCRIPT = `#!/usr/bin/env node
// Installed by Cursor Bots. Cursor runs this hook at three points:
//   prompt: before each prompt a bot submits, to tell the gateway which bot
//           owns this Cursor conversation (only the prompt's first lines are sent).
//   shell:  before every shell command, to ask the gateway whether it needs your approval.
//   tool:   before file tools, to keep bots out of the gateway's own state
//           (tokens, secrets, settings). This check runs locally.
// If the gateway isn't running (e.g. you opened this folder in the Cursor IDE
// yourself) everything is allowed, so it never gets in your way.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mode = ["prompt", "shell", "tool"].includes(process.argv[2]) ? process.argv[2] : "shell";
const pass = mode === "prompt" ? { continue: true } : { permission: "allow" };
const here = path.dirname(fileURLToPath(import.meta.url));
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch {}
let cfg;
try { cfg = JSON.parse(fs.readFileSync(path.join(here, "cursor-bots-gate.json"), "utf8")); } catch {}
const done = (out) => { process.stdout.write(JSON.stringify(out)); process.exit(0); };
if (!cfg) done(pass);

if (mode === "tool") {
  const roots = (cfg.protect ?? []).map((p) => path.resolve(p));
  const cwd = input.cwd || (input.workspace_roots ?? [])[0] || process.cwd();
  const hits = [];
  const visit = (v) => {
    if (typeof v === "string") {
      if (v.length < 4096 && !v.includes("\\n") && /[\\/\\\\]/.test(v)) {
        const abs = path.resolve(cwd, v);
        if (roots.some((r) => abs === r || abs.startsWith(r + path.sep))) hits.push(v);
      }
    } else if (v && typeof v === "object") {
      for (const x of Object.values(v)) visit(x);
    }
  };
  visit(input.tool_input);
  if (hits.length) {
    done({
      permission: "deny",
      user_message: "Blocked: a bot tried to touch Cursor Bots' own state files.",
      agent_message: "That path belongs to the Cursor Bots gateway (tokens, secrets, settings) and is off-limits. Use your harness tools instead (memory_update, request_secret, run_with_secrets, routine_*).",
    });
  }
  done(pass);
}

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
export function prepareWorkspace(paths: HomePaths, gate: { url: string; token: string; timeoutMs: number; protect: string[] }): void {
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
  const tool = (cfg.hooks.preToolUse ?? []).filter((h) => !ours(h));
  tool.unshift({ command: "node .cursor/hooks/cursor-bots-gate.mjs tool", matcher: "Read|Write|Edit|Delete|Grep|Glob|LS", timeout: 10 });
  cfg.hooks.preToolUse = tool;
  writeJson(paths.hooksJson, cfg);
}

export function ensureBotFolder(paths: HomePaths, handle: string): string {
  const dir = path.join(paths.workspace, "bots", handle);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
