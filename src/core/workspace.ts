import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_AGENTS_MD, HARNESS_MANUAL } from "./manual.ts";
import type { HomePaths } from "./paths.ts";
import { readJson, writeFileAtomic } from "./util.ts";

const GATE_SCRIPT_BODY = `
// Installed by Cursor Bots. Cursor runs this hook at three points:
//   prompt: before each prompt a bot submits, to tell the gateway which bot
//           owns this Cursor conversation (only the prompt's first lines are sent).
//   shell:  before every shell command, to ask the gateway whether it needs your approval.
//   tool:   before file tools, to keep bots out of the gateway's own state
//           (tokens, secrets, settings). This check runs locally.
// If the gateway isn't running (e.g. you opened this folder in the Cursor IDE
// yourself) everything is allowed, so it never gets in your way. The gateway
// rewrites this file before every bot turn, so edits to it don't stick.
import fs from "node:fs";
import path from "node:path";

const mode = ["prompt", "shell", "tool"].includes(process.argv[2]) ? process.argv[2] : "shell";
const pass = mode === "prompt" ? { continue: true } : { permission: "allow" };
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch {}
const done = (out) => { process.stdout.write(JSON.stringify(out)); process.exit(0); };

if (mode === "tool") {
  // Resolve symlinks on the longest existing prefix, so a link inside the
  // workspace can't lead into protected state (new files resolve via their parent,
  // and a link to a file that doesn't exist yet resolves to where that file would be).
  const real = (p) => {
    const rest = [];
    let cur = p;
    for (let i = 0; i < 128; i++) {
      try { return path.join(fs.realpathSync(cur), ...rest); } catch {}
      try {
        if (fs.lstatSync(cur).isSymbolicLink()) { cur = path.resolve(path.dirname(cur), fs.readlinkSync(cur)); continue; }
      } catch {}
      const parent = path.dirname(cur);
      if (parent === cur) break;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
    return p;
  };
  const roots = [...new Set((cfg.protect ?? []).flatMap((p) => [path.resolve(p), real(path.resolve(p))]))];
  const cwd = input.cwd || (input.workspace_roots ?? [])[0] || process.cwd();
  // The workspace as configured and as it really is (the home folder may sit behind a symlink).
  const wsGiven = path.resolve(cfg.workspace || cwd);
  const wss = [...new Set([wsGiven, real(wsGiven)])];
  // "a is b or below b" (careful with "/", whose children don't start with "//").
  const under = (a, b) => a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
  const inWs = (p) => wss.some((w) => under(p, w));
  // A process's starting environment can hold a provider key the gateway read from a variable.
  const procEnv = (p) => {
    const s = p.split("/");
    return s[1] === "proc" && s[s.length - 1] === "environ" && (s.length === 4 || (s.length === 6 && s[3] === "task"));
  };
  const inside = (abs) => roots.some((r) => under(abs, r)) || procEnv(abs);
  // Search and listing tools walk directories: a target that contains protected state
  // outside the workspace (e.g. a link to the home folder) is as bad as one inside it.
  const tool = String(input.tool_name ?? "");
  const walks = /^(Grep|Glob|List|LS)$/.test(tool);
  const contains = (abs) => roots.some((r) => !inWs(r) && r !== abs && under(r, abs));
  // Grep runs ripgrep with --follow, so a symlink anywhere under the searched folder can lead
  // into the gateway's state. Look for one (skipping what .cursorignore hides from ripgrep too).
  const leakingLink = (dir) => {
    const stack = [dir];
    let seen = 0;
    while (stack.length) {
      let entries;
      const d = stack.pop();
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (++seen > 200000) return "(too many files to check)";
        const p = path.join(d, e.name);
        if (e.isSymbolicLink()) {
          // Resolve the link's own target (it may not exist yet), then any links along that path.
          let r;
          try { r = real(path.resolve(path.dirname(p), fs.readlinkSync(p))); } catch { r = real(p); }
          if (inside(r) || contains(r)) return p;
        } else if (e.isDirectory() && e.name !== "node_modules" && e.name !== ".browser") {
          stack.push(p);
        }
      }
    }
    return undefined;
  };
  const hits = [];
  const visit = (v) => {
    if (typeof v === "string") {
      if (v && v.length < 4096 && !v.includes("\\n")) {
        const abs = path.resolve(cwd, v);
        const r = real(abs);
        if (inside(abs) || inside(r) || (walks && (contains(abs) || contains(r) || under(abs, "/proc") || under(r, "/proc")))) hits.push(v);
      }
    } else if (v && typeof v === "object") {
      for (const x of Object.values(v)) visit(x);
    }
  };
  visit(input.tool_input);
  if (!hits.length && tool === "Grep") {
    const ti = input.tool_input ?? {};
    const target = [ti.path, ti.file_path, ti.target_directory, ti.directory].find((x) => typeof x === "string" && x);
    const dir = path.resolve(cwd, target ?? ".");
    let isDir = false;
    try { isDir = fs.statSync(dir).isDirectory(); } catch {}
    const link = isDir ? leakingLink(dir) : undefined;
    if (link) hits.push(link);
  }
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
export interface GateConfig {
  url: string;
  token: string;
  timeoutMs: number;
  protect: string[];
  /** The bots' workspace (protected paths inside it don't block searching it). */
  workspace: string;
}

function gateScript(cfg: GateConfig): string {
  return `#!/usr/bin/env node\nconst cfg = ${JSON.stringify(cfg)};\n${GATE_SCRIPT_BODY}`;
}

/** Write a file only when its content differs (keeps the per-turn heal cheap). */
function writeIfChanged(file: string, content: string, onlyIfChanged: boolean): void {
  if (onlyIfChanged) {
    try {
      if (fs.readFileSync(file, "utf8") === content) return;
    } catch {
      // Missing: write it.
    }
  }
  writeFileAtomic(file, content);
}

export function prepareWorkspace(paths: HomePaths, gate: GateConfig, opts: { onlyIfChanged?: boolean } = {}): void {
  const quick = opts.onlyIfChanged ?? false;
  for (const dir of [paths.workspace, paths.skills, paths.uploads, paths.hooksDir, paths.rulesDir, path.join(paths.workspace, "bots")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const agentsMd = path.join(paths.workspace, "AGENTS.md");
  if (!fs.existsSync(agentsMd)) writeFileAtomic(agentsMd, DEFAULT_AGENTS_MD);
  // Browser profiles hold thousands of files; keep them out of Cursor's workspace scans and search.
  // (The gate skips the same folders when it checks a search for symlinks, so these two lines must stay.)
  const ignore = path.join(paths.workspace, ".cursorignore");
  let ignoreText = "";
  try {
    ignoreText = fs.readFileSync(ignore, "utf8");
  } catch {
    ignoreText = "# Managed by Cursor Bots; add your own patterns below.\n";
  }
  const lines = ignoreText.split(/\r?\n/);
  const missing = [".browser/", "**/node_modules/"].filter((l) => !lines.includes(l));
  if (missing.length) writeFileAtomic(ignore, `${ignoreText.replace(/\n*$/, "\n")}${missing.join("\n")}\n`);
  writeIfChanged(path.join(paths.rulesDir, "cursor-bots.mdc"), HARNESS_MANUAL, quick);
  ensureSearchIgnore(paths.workspace);
  // If a search ever does wander into the gateway's own folders, ripgrep skips everything there.
  for (const dir of [paths.state, paths.cursorStore, paths.logs, paths.hooksDir]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      writeIfChanged(path.join(dir, ".ignore"), "*\n", quick);
    } catch {
      // Best effort.
    }
  }

  const gateFile = path.join(paths.hooksDir, "cursor-bots-gate.mjs");
  writeIfChanged(gateFile, gateScript(gate), quick);
  try {
    fs.chmodSync(gateFile, 0o755);
  } catch {
    // Not fatal: Cursor runs it with `node`.
  }
  // Older versions kept the gate's config (including its token) in a separate file.
  fs.rmSync(path.join(paths.hooksDir, "cursor-bots-gate.json"), { force: true });

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
  // The SDK's file tools are Read, Write, Delete, Grep, List and ReadLints ("Read" also matches ReadLints).
  tool.unshift({ command: "node .cursor/hooks/cursor-bots-gate.mjs tool", matcher: "Read|Write|Edit|Delete|Grep|Glob|List|LS", timeout: 10 });
  cfg.hooks.preToolUse = tool;
  writeIfChanged(paths.hooksJson, JSON.stringify(cfg, null, 2) + "\n", quick);
}

const IGNORE_START = "# >>> Cursor Bots (managed): keep the gateway's keys and tokens out of searches";
const IGNORE_END = "# <<< Cursor Bots";
/** The gateway's secret files by name, so a search can't reach them through a symlink in the workspace. */
export const SEARCH_IGNORED = [
  "ui.token",
  "gate.token",
  "mcp.token",
  "secret.key",
  "secrets.vault",
  "provider-keys.vault",
  "provider-keys.json",
  "connectors.json",
  "cursor-store/",
];

/**
 * Cursor's Grep and List tools run ripgrep with --follow, so a symlink inside
 * the workspace can lead a search into the gateway's state. ripgrep always
 * honors .rgignore, matched against the path as walked, so naming the secret
 * files keeps them out wherever the link points. Lines you add outside the
 * managed block are kept.
 */
function ensureSearchIgnore(workspace: string): void {
  const file = path.join(workspace, ".rgignore");
  let current = "";
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {
    // Missing: create it.
  }
  const block = [IGNORE_START, ...SEARCH_IGNORED, IGNORE_END].join("\n");
  if (current.includes(block)) return;
  const start = current.indexOf(IGNORE_START);
  const end = current.indexOf(IGNORE_END);
  const rest = start >= 0 && end > start ? current.slice(0, start) + current.slice(end + IGNORE_END.length) : current;
  const others = rest.trim();
  writeFileAtomic(file, `${block}\n${others ? `\n${others}\n` : ""}`);
}

export function ensureBotFolder(paths: HomePaths, handle: string): string {
  const dir = path.join(paths.workspace, "bots", handle);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
