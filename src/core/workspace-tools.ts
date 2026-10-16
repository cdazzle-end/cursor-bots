import { spawn, type ChildProcess } from "node:child_process";
import * as dns from "node:dns";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import * as zlib from "node:zlib";
import { blockedAddress, PathGuard, realPrefix, resolveFrom } from "./guard.ts";
import type { Harness } from "./harness.ts";
import type { RunState } from "./runner.ts";
import type { Id } from "./types.ts";
import type { BoundTool, ToolOutput } from "../runtimes/types.ts";

/**
 * The harness's own computer tools (shell, files, search, web fetch) for
 * runtimes that don't bring any (a plain model API). They run in this process,
 * so every approval and protected-path check is enforced directly instead of
 * through Cursor's hooks:
 *
 * - Every path argument is resolved against the workspace (never this
 *   process's cwd) and must stay inside it after symlinks are followed; the
 *   gateway's own files (state, tokens, settings, hooks, the manual) are
 *   refused by either spelling.
 * - Walks (list_dir, find_files, grep) never enter symlinked folders and check
 *   where every file really is before reading it.
 * - shell is refused outright when it names the gateway (even with approvals
 *   off or "Always allow"), then goes through the same approval gate as the
 *   Cursor hook. It runs in its own process group, which is killed on timeout
 *   or when the turn is stopped. Output is scrubbed of every secret value.
 * - web_fetch only reaches public addresses: every resolved address is
 *   checked, and the connection uses the address that was checked.
 */

export interface WorkspaceToolsOptions {
  /** Let web_fetch reach loopback addresses (tests serve pages from 127.0.0.1). Private and link-local addresses stay blocked. */
  allowLoopback?: boolean;
  /** Resolve a host name for web_fetch (tests); defaults to the system resolver. */
  resolveHost?: (host: string) => Promise<string[]>;
  /** How often running work checks whether its turn was stopped (ms, default 100). */
  pollMs?: number;
  /** web_fetch's overall time limit including redirects (ms, default 30 s). */
  fetchTimeoutMs?: number;
  /** How long grep may search before it's stopped (ms, default 30 s). */
  grepTimeoutMs?: number;
}

type Args = Record<string, unknown>;
interface Ctx {
  h: Harness;
  state: RunState;
  guard: PathGuard;
  opts: WorkspaceToolsOptions;
}

interface ToolSpec {
  name: string;
  description: string;
  properties: Record<string, unknown>;
  required?: string[];
  readOnly?: boolean;
  destructive?: boolean;
  run(args: Args, c: Ctx): Promise<string | ToolOutput> | string | ToolOutput;
}

/** What the model gets back from a tool (about 10k tokens at most). */
const OUTPUT_CAP = 40_000;
const READ_MAX_BYTES = 10 * 1024 * 1024;
const READ_DEFAULT_LINES = 2000;
const READ_MAX_LINES = 5000;
const LINE_CAP = 2000;
/** Longest part of a matching line grep shows. */
const GREP_LINE_CAP = 300;
const WRITE_MAX_CHARS = 5 * 1024 * 1024;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const SHELL_DEFAULT_SECONDS = 120;
const SHELL_MAX_SECONDS = 900;
/** Shell output kept in memory: the start and the end (the middle of a huge log is dropped). */
const CAPTURE_HEAD = 100_000;
const CAPTURE_TAIL = 100_000;
const SHOW_HEAD = 15_000;
const SHOW_TAIL = 25_000;
const LIST_MAX_ENTRIES = 500;
const FIND_MAX_RESULTS = 500;
const WALK_MAX_ENTRIES = 100_000;
const GREP_MAX_FILES = 20_000;
const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024;
const GREP_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const GREP_TIMEOUT_MS = 30_000;
const FETCH_MAX_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
/** Folders walks list but don't enter unless you point the tool at them. */
const WALK_SKIP = new Set([".git", "node_modules", ".browser"]);
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
/** A FIFO opened without it would block this whole process until someone writes to it. */
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;
const FOREGROUND = ["user", "approval", "system"];

const GATEWAY_MSG =
  "Bots can't call the Cursor Bots gateway or read its files directly. Use your harness tools (send_message, request_approval, memory_update, request_secret, run_with_secrets, routine_*).";

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const fail = (text: string): ToolOutput => ({ text, isError: true });
const clampInt = (v: unknown, def: number, min: number, max: number): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : def;
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function capText(text: string, max: number, note: string): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n${note}`;
}

// ------------------------------------------------------------------ paths

interface Target {
  /** As written, resolved against the workspace. */
  abs: string;
  /** Where it really leads (symlinks followed, also through links to files that don't exist yet). */
  real: string;
  /** Workspace-relative, for messages. */
  rel: string;
}

function protectedMsg(shown: string): string {
  return `${shown} belongs to the Cursor Bots gateway (its state, tokens, secrets, settings, approval hooks or manual) and is off-limits. Use your harness tools instead (memory_update, request_secret, run_with_secrets, request_approval, routine_*).`;
}

function outsideMsg(c: Ctx, shown: string, abs: string): string {
  const viaLink = c.guard.inWorkspace(abs, abs);
  return (
    `${shown} ${viaLink ? "leads outside the shared workspace through a symlink" : "is outside the shared workspace"}. ` +
    `Your file and shell tools only work inside the workspace (${c.guard.workspace}); use paths relative to it, like bots/${c.state.bot.handle}/notes.md. ` +
    `For anything beyond it, use your harness tools (send_message, attach_file, request_approval, run_with_secrets).`
  );
}

/** Check a path argument: inside the workspace by both spellings, and not the gateway's. */
function checkPath(c: Ctx, raw: unknown, opts: { name?: string; fallback?: string } = {}): Target | ToolOutput {
  const given = str(raw).trim() || opts.fallback;
  if (!given) return fail(`${opts.name ?? "path"} is required.`);
  if (given.includes("\0")) return fail("Paths can't contain NUL characters.");
  const abs = resolveFrom(c.guard.workspace, given);
  const real = realPrefix(abs);
  if (c.h.insideProtected(given, { alsoProcessCwd: false }) || c.guard.isProtected(abs, real)) return fail(protectedMsg(given));
  if (!c.guard.inWorkspace(abs, real)) return fail(outsideMsg(c, given, abs));
  return { abs, real, rel: c.guard.rel(abs) };
}

const isOutput = (x: Target | ToolOutput): x is ToolOutput => "text" in x;

function fsMessage(err: any, rel: string): string {
  switch (err?.code) {
    case "ENOENT":
      return `${rel} doesn't exist.`;
    case "EISDIR":
      return `${rel} is a folder.`;
    case "ENOTDIR":
      return `A part of ${rel} isn't a folder.`;
    case "EACCES":
    case "EPERM":
      return `Permission denied: ${rel}.`;
    case "ELOOP":
      return `${rel} is a symlink that loops or leads nowhere.`;
    case "ENOTREG":
    case "ENXIO":
      return `${rel} isn't a regular file.`;
    default:
      return `${rel}: ${err?.message ?? err}`;
  }
}

/**
 * Open the real path of a checked target; the last component is never
 * followed (it was resolved already), and a FIFO or device never blocks.
 * Callers check fstat before reading.
 */
function openRead(t: Target): number {
  return fs.openSync(t.real, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
}

function writeNoFollow(file: string, data: string): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | NOFOLLOW | NONBLOCK, 0o644);
  try {
    if (!fs.fstatSync(fd).isFile()) throw Object.assign(new Error("not a regular file"), { code: "ENOTREG" });
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

function readFd(fd: number, size: number): Buffer {
  const buf = Buffer.alloc(size);
  let off = 0;
  while (off < size) {
    const n = fs.readSync(fd, buf, off, size - off, off);
    if (n <= 0) break;
    off += n;
  }
  return buf.subarray(0, off);
}

function imageType(head: Buffer): string | undefined {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return undefined;
}

function looksBinary(head: Buffer): boolean {
  return head.subarray(0, 8000).includes(0);
}

/** Read a checked text file (refusing folders, binaries and huge files): the text, or the reason it can't be read. */
function readText(t: Target): string | ToolOutput {
  let fd: number;
  try {
    fd = openRead(t);
  } catch (err) {
    return fail(fsMessage(err, t.rel));
  }
  try {
    const st = fs.fstatSync(fd);
    if (st.isDirectory()) return fail(`${t.rel} is a folder. Use list_dir to see what's in it.`);
    if (!st.isFile()) return fail(`${t.rel} isn't a regular file.`);
    if (st.size > READ_MAX_BYTES) return fail(`${t.rel} is too large to work on whole (${fmtBytes(st.size)}, limit ${fmtBytes(READ_MAX_BYTES)}). Use grep to find the part you need, or the shell (e.g. sed -n '100,200p').`);
    const buf = readFd(fd, st.size);
    if (imageType(buf) || looksBinary(buf)) return fail(`${t.rel} is a binary file (${fmtBytes(st.size)}), not text.`);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

// ------------------------------------------------------------------ walking

interface Entry {
  abs: string;
  real: string;
  /** Relative to the walk's root, with "/" separators (what globs match). */
  rel: string;
  name: string;
  depth: number;
  type: "dir" | "file" | "link" | "other";
  /** Gateway-managed: shown at most, never entered or read. */
  off?: boolean;
  /** A folder walks don't enter by default (.git, node_modules, .browser). */
  skipped?: boolean;
}

/**
 * Depth-first walk in name order. Symlinked folders are never entered, so the
 * walk can't leave the folder it started in; links are reported as "link"
 * entries with `real` set to where they lead. `visit` returns false to stop.
 */
async function walk(
  guard: PathGuard,
  root: Target,
  opts: { maxDepth: number; maxEntries: number },
  visit: (e: Entry) => boolean | void,
): Promise<{ truncated: boolean }> {
  let count = 0;
  let stop = false;
  let truncated = false;
  const dive = async (dirAbs: string, dirReal: string, relBase: string, depth: number): Promise<void> => {
    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(dirReal, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of dirents) {
      if (stop) return;
      if (++count > opts.maxEntries) {
        truncated = true;
        stop = true;
        return;
      }
      const abs = path.join(dirAbs, d.name);
      const link = d.isSymbolicLink();
      const real = link ? realPrefix(path.join(dirReal, d.name)) : path.join(dirReal, d.name);
      const type: Entry["type"] = link ? "link" : d.isDirectory() ? "dir" : d.isFile() ? "file" : "other";
      const rel = relBase ? `${relBase}/${d.name}` : d.name;
      const off = guard.isProtected(abs, real) || guard.isProtected(path.join(dirReal, d.name), real);
      const skipped = type === "dir" && WALK_SKIP.has(d.name);
      const e: Entry = { abs, real, rel, name: d.name, depth, type, off, skipped };
      if (visit(e) === false) {
        stop = true;
        return;
      }
      if (type === "dir" && !off && !skipped && depth < opts.maxDepth) await dive(abs, real, rel, depth + 1);
    }
  };
  await dive(root.abs, root.real, "", 1);
  return { truncated };
}

// ------------------------------------------------------------------ globs

type GlobTok = { t: "star" } | { t: "one" } | { t: "lit"; c: string } | { t: "set"; neg: boolean; chars: string; ranges: Array<[string, string]> };
const GLOBSTAR = "**";
type GlobSeg = GlobTok[] | typeof GLOBSTAR;

function expandBraces(p: string, out: string[], depth = 0): void {
  const open = p.indexOf("{");
  if (open < 0 || depth > 8 || out.length >= 64) {
    out.push(p);
    return;
  }
  let level = 0;
  let close = -1;
  for (let i = open; i < p.length; i++) {
    if (p[i] === "{") level++;
    else if (p[i] === "}" && --level === 0) {
      close = i;
      break;
    }
  }
  if (close < 0) {
    out.push(p);
    return;
  }
  const inner = p.slice(open + 1, close);
  const alts: string[] = [];
  let lvl = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "{") lvl++;
    else if (inner[i] === "}") lvl--;
    else if (inner[i] === "," && lvl === 0) {
      alts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  alts.push(inner.slice(start));
  for (const a of alts) {
    if (out.length >= 64) return;
    expandBraces(p.slice(0, open) + a + p.slice(close + 1), out, depth + 1);
  }
}

function globTokens(seg: string): GlobTok[] {
  const toks: GlobTok[] = [];
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (c === "*") {
      if (toks.at(-1)?.t !== "star") toks.push({ t: "star" });
    } else if (c === "?") {
      toks.push({ t: "one" });
    } else if (c === "[") {
      const end = seg.indexOf("]", i + 2);
      if (end < 0) {
        toks.push({ t: "lit", c });
        continue;
      }
      let body = seg.slice(i + 1, end);
      let neg = false;
      if (body[0] === "!" || body[0] === "^") {
        neg = true;
        body = body.slice(1);
      }
      const ranges: Array<[string, string]> = [];
      let chars = "";
      for (let j = 0; j < body.length; j++) {
        if (body[j + 1] === "-" && j + 2 < body.length) {
          ranges.push([body[j]!, body[j + 2]!]);
          j += 2;
        } else {
          chars += body[j];
        }
      }
      toks.push({ t: "set", neg, chars, ranges });
      i = end;
    } else if (c === "\\" && i + 1 < seg.length) {
      toks.push({ t: "lit", c: seg[++i]! });
    } else {
      toks.push({ t: "lit", c });
    }
  }
  return toks;
}

function tokMatches(tok: GlobTok, ch: string): boolean {
  if (tok.t === "one") return true;
  if (tok.t === "lit") return tok.c === ch;
  if (tok.t === "set") {
    const hit = tok.chars.includes(ch) || tok.ranges.some(([a, b]) => ch >= a && ch <= b);
    return hit !== tok.neg;
  }
  return false;
}

/** Wildcard match of one path segment without backtracking blow-ups (O(n·m) at worst). */
function segMatches(toks: GlobTok[], s: string): boolean {
  let ti = 0;
  let si = 0;
  let starTi = -1;
  let starSi = 0;
  while (si < s.length) {
    const tok = toks[ti];
    if (tok && tok.t === "star") {
      starTi = ti++;
      starSi = si;
    } else if (tok && tokMatches(tok, s[si]!)) {
      ti++;
      si++;
    } else if (starTi >= 0) {
      ti = starTi + 1;
      si = ++starSi;
    } else {
      return false;
    }
  }
  while (toks[ti]?.t === "star") ti++;
  return ti === toks.length;
}

function segsMatch(pats: GlobSeg[], parts: string[]): boolean {
  const memo = new Map<number, boolean>();
  const go = (pi: number, si: number): boolean => {
    const key = pi * (parts.length + 1) + si;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let r: boolean;
    const p = pats[pi];
    if (p === undefined) r = si === parts.length;
    else if (p === GLOBSTAR) r = go(pi + 1, si) || (si < parts.length && go(pi, si + 1));
    else r = si < parts.length && segMatches(p, parts[si]!) && go(pi + 1, si + 1);
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

/**
 * Compile a glob (case-insensitive): `*` within a name, `**` across folders,
 * `?`, `[abc]`, `{a,b}`. Without a "/" it matches the name at any depth;
 * with one it matches the whole path from the search folder.
 */
export function compileGlob(glob: string): (rel: string) => boolean {
  const variants: string[] = [];
  expandBraces(glob.trim().replace(/^(\.\/)+/, "").replace(/^\/+/, ""), variants);
  const matchers = variants.map((v) => {
    const segs = v.toLowerCase().split("/").filter(Boolean);
    const pats: GlobSeg[] = [];
    for (const s of segs) {
      if (s === GLOBSTAR) {
        if (pats.at(-1) !== GLOBSTAR) pats.push(GLOBSTAR);
      } else {
        pats.push(globTokens(s));
      }
    }
    if (!pats.length) return () => true;
    if (segs.length === 1) {
      const only = pats[0]!;
      return (rel: string) => only === GLOBSTAR || segMatches(only, rel.toLowerCase().split("/").at(-1) ?? "");
    }
    return (rel: string) => segsMatch(pats, rel.toLowerCase().split("/"));
  });
  return (rel) => matchers.some((m) => m(rel));
}

// ------------------------------------------------------------------ shell

/** Process groups of running commands, killed if the gateway exits while they run. */
const liveGroups = new Set<number>();
let exitHookInstalled = false;
function trackGroup(pid: number | undefined): void {
  if (!pid || process.platform === "win32") return;
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => {
      for (const g of liveGroups) {
        try {
          process.kill(-g, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    });
  }
  liveGroups.add(pid);
}

function killGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, sig);
    else child.kill(sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      // Already gone.
    }
  }
}

/** Keeps the start and the end of a command's output. */
class Capture {
  head = "";
  tail = "";
  total = 0;

  add(chunk: string): void {
    let s = chunk;
    this.total += s.length;
    if (this.head.length < CAPTURE_HEAD) {
      const room = CAPTURE_HEAD - this.head.length;
      this.head += s.slice(0, room);
      s = s.slice(room);
    }
    if (s) {
      this.tail += s;
      if (this.tail.length > CAPTURE_TAIL * 2) this.tail = this.tail.slice(-CAPTURE_TAIL);
    }
  }

  /** Scrubbed before cutting, so a secret value is never shown half-replaced. */
  render(scrub: (text: string) => string): string {
    const tail = this.tail.slice(-CAPTURE_TAIL);
    const omitted = (n: number) => `\n…[${n} characters of output omitted]…\n`;
    if (this.total <= this.head.length + tail.length) {
      const all = scrub(this.head + tail);
      if (all.length <= SHOW_HEAD + SHOW_TAIL) return all;
      return all.slice(0, SHOW_HEAD) + omitted(all.length - SHOW_HEAD - SHOW_TAIL) + all.slice(-SHOW_TAIL);
    }
    return scrub(this.head).slice(0, SHOW_HEAD) + omitted(this.total - SHOW_HEAD - SHOW_TAIL) + scrub(tail).slice(-SHOW_TAIL);
  }
}

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  out: Capture;
  killed?: "timeout" | "stopped";
  error?: string;
}

function execute(command: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, cancelled: () => boolean, pollMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const out = new Capture();
    let child: ChildProcess;
    try {
      // A new process group (session), so a timeout or a stop kills everything the command started.
      child = spawn("bash", ["-lc", command], { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    } catch (err: any) {
      resolve({ code: -1, signal: null, out, error: String(err?.message ?? err) });
      return;
    }
    trackGroup(child.pid);
    let killed: RunResult["killed"];
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let error: string | undefined;
    let done = false;
    let grace: NodeJS.Timeout | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      if (grace) clearTimeout(grace);
      if (child.pid) liveGroups.delete(child.pid);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ code: exit?.code ?? null, signal: exit?.signal ?? null, out, killed, error });
    };
    // Something outside the group (or a background job) may keep the pipes open: don't wait on it forever.
    const soon = () => {
      grace ??= setTimeout(finish, 1000);
    };
    const kill = (why: "timeout" | "stopped") => {
      if (done || killed) return;
      if (exit) return finish();
      killed = why;
      killGroup(child, "SIGKILL");
      soon();
    };
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => out.add(d));
    child.stderr!.on("data", (d: string) => out.add(d));
    const timer = setTimeout(() => kill("timeout"), timeoutMs);
    const poll = setInterval(() => {
      if (cancelled()) kill("stopped");
    }, pollMs);
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      if (child.pid) liveGroups.delete(child.pid);
      soon();
    });
    child.on("close", (code, signal) => {
      exit ??= { code, signal };
      finish();
    });
    child.on("error", (err) => {
      error = err.message;
      finish();
    });
  });
}

export interface GatedCommand {
  command: string;
  /** Workspace-relative folder to run in (default: the workspace root). */
  cwd?: string;
  timeoutSeconds?: number;
  /** Extra environment on top of the sanitized child environment (e.g. secrets for run_with_secrets). */
  env?: Record<string, string>;
  pollMs?: number;
}

/**
 * Run a shell command for a bot's turn the way the Cursor hook would allow
 * it: refused if it names the gateway or runs from its files (before any
 * approval rule, so "off" and "Always allow" don't open it), then the
 * approval gate, then bash in its own process group with the sanitized
 * environment. Shared by the shell and run_with_secrets tools.
 */
export async function runGatedCommand(h: Harness, state: RunState, input: GatedCommand): Promise<ToolOutput> {
  const command = input.command.trim();
  if (!command) return fail("command is required.");
  if (h.touchesHarness(command)) return fail(GATEWAY_MSG);
  const guard = new PathGuard(h.store.paths.workspace, h.protectedPaths());
  let cwd = guard.workspaceReal;
  const rawCwd = (input.cwd ?? "").trim();
  if (rawCwd) {
    if (rawCwd.includes("\0")) return fail("cwd can't contain NUL characters.");
    const abs = resolveFrom(guard.workspace, rawCwd);
    const real = realPrefix(abs);
    if (h.insideProtected(rawCwd, { alsoProcessCwd: false }) || guard.isProtected(abs, real)) return fail(GATEWAY_MSG);
    if (!guard.inWorkspace(abs, real)) {
      return fail(outsideMsg({ h, state, guard, opts: {} }, `The folder ${rawCwd}`, abs));
    }
    try {
      if (!fs.statSync(real).isDirectory()) return fail(`cwd ${rawCwd} isn't a folder.`);
    } catch {
      return fail(`cwd ${rawCwd} doesn't exist.`);
    }
    cwd = real;
  }
  const gate = await h.approvals.gate({
    botId: state.bot.id,
    convId: h.visibleConvFor(state.wake),
    kind: "shell",
    subject: command,
    origin: FOREGROUND.includes(state.wake.source) ? "foreground" : "background",
    waitSeconds: h.store.settings.approvals.inlineWaitSeconds,
    resume: h.resumeFor(state.wake),
    active: () => !state.cancelled,
  });
  if (gate.permission === "deny") return { text: gate.message, isError: gate.reason !== "pending" };
  if (state.cancelled) return fail("This turn was stopped, so the command didn't run.");
  const seconds = clampInt(input.timeoutSeconds, SHELL_DEFAULT_SECONDS, 1, SHELL_MAX_SECONDS);
  const r = await execute(command, cwd, h.childEnv(input.env ?? {}), seconds * 1000, () => state.cancelled, input.pollMs ?? 100);
  const text = r.out.render((t) => h.scrubSecrets(t));
  let status = `exit ${r.code ?? (r.signal ? `signal ${r.signal}` : "unknown")}`;
  if (r.killed === "timeout") status += ` (killed after ${seconds}s: timed out; pass a larger timeout_seconds, or run it in the background with output to a file)`;
  else if (r.killed === "stopped") status += " (killed: the turn was stopped)";
  if (r.error) status += ` (couldn't run bash: ${r.error})`;
  return { text: `${status}\n${text || "(no output)"}`, isError: r.code !== 0 };
}

// ------------------------------------------------------------------ grep worker

/**
 * Runs in a worker thread so a pathological pattern can't freeze the gateway:
 * it's terminated on timeout or stop. It only reads files the main thread has
 * already checked (by their real paths, never following a final symlink).
 */
const GREP_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const { files, pattern, flags, maxResults, maxLine } = workerData;
const re = new RegExp(pattern, flags);
const lines = [];
let searched = 0, binary = 0, hitCap = false;
const FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
for (const f of files) {
  if (hitCap) break;
  let buf;
  try {
    const fd = fs.openSync(f.real, FLAGS);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > f.max) continue;
      buf = fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
  } catch { continue; }
  if (buf.subarray(0, 8000).includes(0)) { binary++; continue; }
  searched++;
  const text = buf.toString("utf8").split("\\n");
  for (let i = 0; i < text.length; i++) {
    const line = text[i].endsWith("\\r") ? text[i].slice(0, -1) : text[i];
    if (re.test(line)) {
      lines.push(f.rel + ":" + (i + 1) + ":" + (line.length > maxLine ? line.slice(0, maxLine) + "…" : line));
      if (lines.length >= maxResults) { hitCap = true; break; }
    }
  }
}
parentPort.postMessage({ lines, searched, binary, hitCap });
`;

type GrepResult = { lines: string[]; searched: number; binary: number; hitCap: boolean };

function runGrepWorker(data: Record<string, unknown>, cancelled: () => boolean, pollMs: number, timeoutMs: number): Promise<GrepResult | { error: string }> {
  return new Promise((resolve) => {
    let done = false;
    const worker = new Worker(GREP_WORKER, { eval: true, workerData: data, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    const end = (r: GrepResult | { error: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      void worker.terminate();
      resolve(r);
    };
    const timer = setTimeout(
      () => end({ error: `The search took longer than ${Math.round(timeoutMs / 1000)} s and was stopped. Use a simpler pattern or narrow it with path or glob.` }),
      timeoutMs,
    );
    const poll = setInterval(() => {
      if (cancelled()) end({ error: "The turn was stopped." });
    }, pollMs);
    worker.on("message", (m: GrepResult) => end(m));
    worker.on("error", (err: Error) => end({ error: `The search failed: ${err.message}` }));
    worker.on("exit", () => end({ error: "The search stopped unexpectedly." }));
  });
}

// ------------------------------------------------------------------ web fetch

interface Fetched {
  status: number;
  statusText: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
  location?: string;
}

class Refused extends Error {}

function refusal(host: string, why: string): string {
  const what = why === "loopback" ? "this computer (loopback)" : `a ${why} address`;
  return `web_fetch only reaches public internet addresses, and ${host} is ${what}. It can't reach this computer, the local network or cloud metadata services.`;
}

async function resolveChecked(c: Ctx, hostname: string): Promise<dns.LookupAddress[]> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const list: dns.LookupAddress[] = net.isIP(host)
    ? [{ address: host, family: net.isIP(host) }]
    : c.opts.resolveHost
      ? (await c.opts.resolveHost(host)).map((a) => ({ address: a, family: net.isIP(a) }))
      : await dns.promises.lookup(host, { all: true, verbatim: true });
  if (!list.length) throw new Error(`${host} didn't resolve to any address`);
  // Every address counts: a name that resolves to one public and one private address is refused.
  for (const a of list) {
    const why = blockedAddress(a.address, { allowLoopback: c.opts.allowLoopback });
    if (why) throw new Refused(refusal(`${host}${a.address === host ? "" : ` (${a.address})`}`, why));
  }
  return list;
}

/** DNS for the connection itself, so the address that was checked is the one connected to. */
function checkedLookup(c: Ctx): net.LookupFunction {
  return (hostname, options, callback) => {
    resolveChecked(c, hostname).then(
      (addrs) => {
        const fam = options.family === 4 || options.family === 6 ? addrs.filter((a) => a.family === options.family) : addrs;
        const use = fam.length ? fam : addrs;
        if (options.all) callback(null, use);
        else callback(null, use[0]!.address, use[0]!.family);
      },
      (err) => callback(err, "", 0),
    );
  };
}

function httpGet(c: Ctx, url: URL, deadline: number): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    let settled = false;
    let req: http.ClientRequest | undefined;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      fn();
    };
    const limitS = Math.round((c.opts.fetchTimeoutMs ?? FETCH_TIMEOUT_MS) / 1000);
    const timer = setTimeout(() => req?.destroy(new Error(`timed out after ${limitS} s`)), Math.max(1, deadline - Date.now()));
    const poll = setInterval(() => {
      if (c.state.cancelled) req?.destroy(new Error("the turn was stopped"));
    }, c.opts.pollMs ?? 100);
    const options: https.RequestOptions = {
      protocol: url.protocol,
      hostname: host,
      port: url.port ? Number(url.port) : undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      agent: false,
      // The connection goes to the address this lookup checked (no second, unchecked DNS answer).
      lookup: checkedLookup(c),
      ...(url.protocol === "https:" && !net.isIP(host) ? { servername: host } : {}),
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; CursorBots-web_fetch/1.0)",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.9,*/*;q=0.5",
        "accept-encoding": "gzip, deflate, br",
        "accept-language": "en;q=0.9, *;q=0.5",
      },
    };
    const onResponse = (res: http.IncomingMessage) => {
      const status = res.statusCode ?? 0;
      const location = typeof res.headers.location === "string" ? res.headers.location : undefined;
      const base = { status, statusText: res.statusMessage ?? "", headers: res.headers };
      if (status >= 300 && status < 400 && location) {
        res.resume();
        settle(() => resolve({ ...base, body: Buffer.alloc(0), truncated: false, location }));
        req?.destroy();
        return;
      }
      const enc = String(res.headers["content-encoding"] ?? "").toLowerCase().trim();
      let stream: NodeJS.ReadableStream = res;
      if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
      else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
      else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      const done = () => settle(() => resolve({ ...base, body: Buffer.concat(chunks), truncated }));
      const onError = (err: Error) => {
        if (size) {
          truncated = true;
          done();
        } else {
          settle(() => reject(err));
        }
      };
      // Counted after decompression, so a small compressed bomb can't fill memory.
      stream.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        const d = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        const room = FETCH_MAX_BYTES - size;
        if (d.length >= room) {
          chunks.push(d.subarray(0, room));
          size += room;
          truncated = d.length > room;
          done();
          req?.destroy();
          return;
        }
        chunks.push(d);
        size += d.length;
      });
      stream.on("end", done);
      stream.on("error", onError);
      if (stream !== res) res.on("error", onError);
    };
    try {
      req = url.protocol === "https:" ? https.request(options, onResponse) : http.request(options, onResponse);
    } catch (err) {
      settle(() => reject(err));
      return;
    }
    req.on("error", (err) => settle(() => reject(err)));
    req.end();
  });
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", sbquo: "‚", bdquo: "„", laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™", middot: "·",
  bull: "•", times: "×", divide: "÷", minus: "−", euro: "€", pound: "£", yen: "¥", cent: "¢", deg: "°", plusmn: "±",
  para: "¶", sect: "§", shy: "", zwj: "", zwnj: "", lrm: "", rlm: "", thinsp: " ", ensp: " ", emsp: " ", larr: "←",
  rarr: "→", uarr: "↑", darr: "↓", harr: "↔", frac12: "½", frac14: "¼", frac34: "¾", iexcl: "¡", iquest: "¿", szlig: "ß",
  aacute: "á", agrave: "à", acirc: "â", auml: "ä", atilde: "ã", aring: "å", eacute: "é", egrave: "è", ecirc: "ê", euml: "ë",
  iacute: "í", igrave: "ì", icirc: "î", iuml: "ï", oacute: "ó", ograve: "ò", ocirc: "ô", ouml: "ö", otilde: "õ", oslash: "ø",
  uacute: "ú", ugrave: "ù", ucirc: "û", uuml: "ü", ntilde: "ñ", ccedil: "ç", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", Eacute: "É",
  hearts: "♥", check: "✓", star: "☆", hyphen: "‐", dash: "‐",
};

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "�";
    }
    return NAMED_ENTITIES[e] ?? NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

const RAW_TEXT_TAGS = new Set(["script", "style", "noscript", "template", "svg", "math", "iframe", "object", "embed", "canvas", "select", "textarea", "title"]);
const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "header", "footer", "main", "nav", "aside", "ul", "ol", "dl", "dt", "dd", "table", "thead",
  "tbody", "tfoot", "tr", "caption", "form", "fieldset", "legend", "figure", "figcaption", "blockquote", "address", "details",
  "summary", "body", "html",
]);
const HREF_RE = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const ALT_RE = /\salt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

function attr(tag: string, re: RegExp): string {
  const m = re.exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
}

/**
 * HTML to readable text: headings, list items, links as [text](url), images
 * by their alt text; scripts, styles and other non-text content dropped. One
 * linear pass (no regex over the whole page), so a hostile page can't make it
 * slow.
 */
export function htmlToText(html: string, base?: URL): string {
  const lower = html.toLowerCase();
  const out: string[] = [];
  const pres: string[] = [];
  const anchors: Array<{ at: number; href: string }> = [];
  let title = "";
  let pre = 0;
  const text = (s: string) => {
    if (!s) return;
    const t = decodeEntities(s);
    if (pre) {
      pres.push(t);
      out.push(`\u0001${pres.length - 1}\u0001`);
    } else {
      out.push(t.replace(/\s+/g, " "));
    }
  };
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      text(html.slice(i));
      break;
    }
    if (lt > i) text(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const e = html.indexOf("-->", lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(lt, lt + 64));
    if (!m) {
      // "<!DOCTYPE", "<?xml" and other declarations are skipped; a bare "<" is text.
      if (html[lt + 1] === "!" || html[lt + 1] === "?") {
        const e = html.indexOf(">", lt + 2);
        i = e < 0 ? n : e + 1;
      } else {
        text("<");
        i = lt + 1;
      }
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) break;
    const closing = m[1] === "/";
    const name = m[2]!.toLowerCase();
    const tag = html.slice(lt, gt + 1);
    i = gt + 1;
    if (!closing && RAW_TEXT_TAGS.has(name)) {
      if (tag.endsWith("/>")) continue;
      const end = lower.indexOf(`</${name}`, i);
      if (name === "title" && !title && end > 0) title = decodeEntities(html.slice(i, end).replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
      if (end < 0) {
        i = n;
        break;
      }
      const close = html.indexOf(">", end);
      i = close < 0 ? n : close + 1;
      continue;
    }
    if (/^h[1-6]$/.test(name)) {
      out.push(closing ? "\n\n" : `\n\n${"#".repeat(Number(name[1]))} `);
    } else if (name === "br") {
      out.push("\n");
    } else if (name === "hr") {
      out.push("\n\n---\n\n");
    } else if (name === "li") {
      if (!closing) out.push("\n- ");
    } else if (name === "p") {
      out.push("\n\n");
    } else if (name === "pre") {
      pre = closing ? Math.max(0, pre - 1) : pre + 1;
      out.push("\n\n");
    } else if (name === "td" || name === "th") {
      if (closing) out.push(" | ");
    } else if (name === "a") {
      if (!closing) {
        let href = attr(tag, HREF_RE).trim();
        if (/^(javascript|data|vbscript):/i.test(href) || href.startsWith("#")) href = "";
        if (href) {
          try {
            href = new URL(decodeEntities(href), base).href;
          } catch {
            href = "";
          }
        }
        anchors.push({ at: out.length, href });
        out.push("");
      } else {
        const a = anchors.pop();
        if (a?.href) {
          const inner = out.slice(a.at + 1).join("").trim();
          if (inner && inner !== a.href) {
            out[a.at] = "[";
            out.push(`](${a.href})`);
          }
        }
      }
    } else if (name === "img") {
      const alt = decodeEntities(attr(tag, ALT_RE)).trim();
      if (alt) out.push(` [image: ${alt}] `);
    } else if (BLOCK_TAGS.has(name)) {
      out.push("\n");
    }
  }
  const body = out
    .join("")
    .split("\n")
    .map((l) => l.trim().replace(/^\|\s*/, "").replace(/\s*\|$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\u0001(\d+)\u0001/g, (_, k: string) => pres[Number(k)] ?? "")
    .trim();
  return title ? `Title: ${title}\n\n${body}` : body;
}

function charsetOf(contentType: string, body: Buffer, html: boolean): string {
  const fromHeader = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType)?.[1];
  if (fromHeader) return fromHeader;
  if (html) {
    const head = body.subarray(0, 2048).toString("latin1");
    const meta = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
    if (meta) return meta;
  }
  return "utf-8";
}

function decodeBody(body: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

function isTextual(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    /^application\/(json|xml|javascript|ecmascript|x-javascript|yaml|x-yaml|toml|csv|x-ndjson|ld\+json|rss\+xml|atom\+xml|x-www-form-urlencoded)$/.test(mime) ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml")
  );
}

function renderFetched(c: Ctx, url: URL, from: string | undefined, res: Fetched): ToolOutput {
  const type = String(res.headers["content-type"] ?? "");
  const mime = type.split(";")[0]!.trim().toLowerCase();
  const head = [
    `URL: ${url.href}${from ? ` (redirected from ${from})` : ""}`,
    `Status: ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`,
    ...(type ? [`Content-Type: ${type}`] : []),
  ].join("\n");
  const isError = res.status >= 400;
  const cut = res.truncated ? `\n(Only the first ${fmtBytes(FETCH_MAX_BYTES)} of the response was read.)` : "";
  const img = imageType(res.body.subarray(0, 16));
  if (img && (mime.startsWith("image/") || !mime)) {
    if (res.truncated) return { text: `${head}\n\nAn image larger than ${fmtBytes(FETCH_MAX_BYTES)}; it wasn't downloaded. Save it with the shell (curl -L -o <file> <url>) if you need it.`, isError };
    return { text: `${head}\n\nAn image (${img}, ${fmtBytes(res.body.length)}); it's attached.`, images: [{ data: res.body.toString("base64"), mimeType: img }], isError };
  }
  const sniff = res.body.subarray(0, 1024).toString("latin1");
  const html = mime === "text/html" || mime === "application/xhtml+xml" || (!mime && /^\s*(<!doctype html|<html|<head|<body)/i.test(sniff));
  let body: string;
  if (html) {
    body = htmlToText(decodeBody(res.body, charsetOf(type, res.body, true)), url);
  } else if (isTextual(mime) || (!mime && !looksBinary(res.body))) {
    body = decodeBody(res.body, charsetOf(type, res.body, false));
  } else {
    return {
      text: `${head}\n\nThis is ${mime || "binary"} content (${fmtBytes(res.body.length)}${res.truncated ? "+" : ""}), which web_fetch can't show as text. Save it with the shell (curl -L -o <file> <url>) and use a suitable tool on the file.`,
      isError,
    };
  }
  const text = `${head}\n\n${c.h.scrubSecrets(body).trim() || "(empty page)"}`;
  return { text: capText(text, OUTPUT_CAP, `…(the page was cut at ${OUTPUT_CAP} characters)`) + cut, isError };
}

async function webFetch(c: Ctx, raw: string): Promise<ToolOutput> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return fail(`"${raw}" isn't a valid URL. Pass a full http:// or https:// address.`);
  }
  const first = url.href;
  const deadline = Date.now() + (c.opts.fetchTimeoutMs ?? FETCH_TIMEOUT_MS);
  for (let hop = 0; ; hop++) {
    // Checked again after every redirect.
    if (url.protocol !== "http:" && url.protocol !== "https:") return fail(`web_fetch only fetches http:// and https:// URLs, not ${url.protocol}`);
    if (url.username || url.password) return fail("URLs with a user name or password aren't supported. For authenticated requests use run_with_secrets.");
    if (c.h.touchesHarness(url.href) || c.h.touchesHarness(raw)) return fail(GATEWAY_MSG);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host)) {
      const why = blockedAddress(host, { allowLoopback: c.opts.allowLoopback });
      if (why) return fail(refusal(host, why));
    }
    let res: Fetched;
    try {
      res = await httpGet(c, url, deadline);
    } catch (err: any) {
      if (err instanceof Refused) return fail(err.message);
      return fail(`Couldn't fetch ${url.href}: ${err?.message ?? err}`);
    }
    if (res.location && [301, 302, 303, 307, 308].includes(res.status)) {
      if (hop >= MAX_REDIRECTS) return fail(`Too many redirects (more than ${MAX_REDIRECTS}); the last one pointed from ${url.href} to ${res.location}.`);
      try {
        url = new URL(res.location, url);
      } catch {
        return fail(`${url.href} redirected to an invalid address: ${res.location}`);
      }
      continue;
    }
    return renderFetched(c, url, url.href !== first ? first : undefined, res);
  }
}

// ------------------------------------------------------------------ the tools

const SPECS: ToolSpec[] = [
  {
    name: "shell",
    description:
      "Run a bash command in the shared workspace and get its exit code and output (stdout and stderr together). There's no terminal and no input, so use non-interactive flags. Default timeout 120 s (timeout_seconds up to 900); start servers and long jobs in the background with output to a file. Some commands (pushing, publishing, recursive deletes, sudo, …) need the user's approval: if the result says approval is pending, end your turn and wait to be woken.",
    properties: {
      command: { type: "string", description: "The bash command line." },
      cwd: { type: "string", description: "Folder to run in, relative to the workspace root (default: the root)." },
      timeout_seconds: { type: "number", description: "Default 120, max 900." },
    },
    required: ["command"],
    run(args, c) {
      return runGatedCommand(c.h, c.state, {
        command: str(args.command),
        cwd: str(args.cwd) || undefined,
        timeoutSeconds: Number(args.timeout_seconds) || undefined,
        pollMs: c.opts.pollMs,
      });
    },
  },
  {
    name: "read_file",
    description:
      "Read a text file from the workspace, with line numbers. Long files come in pages: offset is the first line (1-based), limit the number of lines (default 2000). PNG, JPEG, GIF and WebP images come back as images. Binary files are refused.",
    properties: {
      path: { type: "string", description: "Workspace-relative path." },
      offset: { type: "number", description: "First line to read (1-based, default 1)." },
      limit: { type: "number", description: "How many lines (default 2000, max 5000)." },
    },
    required: ["path"],
    readOnly: true,
    run(args, c) {
      const t = checkPath(c, args.path);
      if (isOutput(t)) return t;
      let fd: number;
      try {
        fd = openRead(t);
      } catch (err) {
        return fail(fsMessage(err, t.rel));
      }
      try {
        const st = fs.fstatSync(fd);
        if (st.isDirectory()) return fail(`${t.rel} is a folder. Use list_dir to see what's in it.`);
        if (!st.isFile()) return fail(`${t.rel} isn't a regular file.`);
        const head = readFd(fd, Math.min(st.size, 8192));
        const img = imageType(head);
        if (img) {
          if (st.size > IMAGE_MAX_BYTES) return fail(`${t.rel} is an image too large to view (${fmtBytes(st.size)}, limit ${fmtBytes(IMAGE_MAX_BYTES)}).`);
          return { text: `${t.rel} is an image (${img}, ${fmtBytes(st.size)}); it's attached.`, images: [{ data: readFd(fd, st.size).toString("base64"), mimeType: img }] };
        }
        if (looksBinary(head)) {
          return fail(`${t.rel} is a binary file (${fmtBytes(st.size)}); read_file only reads text. If you must inspect it, use the shell (e.g. file, or xxd | head).`);
        }
        if (st.size > READ_MAX_BYTES) {
          return fail(`${t.rel} is too large to read (${fmtBytes(st.size)}, limit ${fmtBytes(READ_MAX_BYTES)}). Use grep to find the part you need, or the shell (e.g. sed -n '100,200p').`);
        }
        const lines = readFd(fd, st.size).toString("utf8").split("\n");
        if (lines.at(-1) === "") lines.pop();
        const total = lines.length;
        if (!total) return `${t.rel} is empty.`;
        const start = clampInt(args.offset, 1, 1, Number.MAX_SAFE_INTEGER);
        if (start > total) return fail(`${t.rel} has only ${total} line${total === 1 ? "" : "s"}.`);
        const limit = clampInt(args.limit, READ_DEFAULT_LINES, 1, READ_MAX_LINES);
        const rows: string[] = [];
        let chars = 0;
        let end = start - 1;
        for (let i = start - 1; i < Math.min(total, start - 1 + limit); i++) {
          let line = lines[i]!.replace(/\r$/, "");
          // Scrubbed before cutting, so a secret across the cut isn't left half there (the whole page is scrubbed again below).
          if (line.length > LINE_CAP) line = c.h.scrubSecrets(line);
          if (line.length > LINE_CAP) line = `${line.slice(0, LINE_CAP)}… (${line.length - LINE_CAP} more characters)`;
          const row = `${String(i + 1).padStart(6)}\t${line}`;
          if (rows.length && chars + row.length > OUTPUT_CAP) break;
          rows.push(row);
          chars += row.length + 1;
          end = i + 1;
        }
        const more = end < total ? `\n… ${total - end} more line${total - end === 1 ? "" : "s"}; call read_file with offset ${end + 1} to continue.` : "";
        return c.h.scrubSecrets(`${t.rel} (lines ${start}-${end} of ${total})\n${rows.join("\n")}${more}`);
      } finally {
        fs.closeSync(fd);
      }
    },
  },
  {
    name: "write_file",
    description:
      "Create a file or replace its whole content; missing parent folders are created. To change part of an existing file, use edit_file instead. Paths are relative to the workspace root.",
    properties: {
      path: { type: "string", description: "Workspace-relative path." },
      content: { type: "string", description: "The complete new content." },
    },
    required: ["path", "content"],
    run(args, c) {
      const t = checkPath(c, args.path);
      if (isOutput(t)) return t;
      if (typeof args.content !== "string") return fail("content must be a string (the whole file).");
      if (args.content.length > WRITE_MAX_CHARS) return fail(`That's too much to write at once (${fmtBytes(args.content.length)}, limit ${fmtBytes(WRITE_MAX_CHARS)}).`);
      let existed = false;
      try {
        const st = fs.lstatSync(t.real);
        if (st.isDirectory()) return fail(`${t.rel} is a folder.`);
        if (!st.isFile()) return fail(`${t.rel} isn't a regular file.`);
        existed = true;
      } catch {
        // A new file.
      }
      try {
        fs.mkdirSync(path.dirname(t.real), { recursive: true });
        writeNoFollow(t.real, args.content);
      } catch (err) {
        return fail(fsMessage(err, t.rel));
      }
      const lines = args.content ? args.content.split("\n").length - (args.content.endsWith("\n") ? 1 : 0) : 0;
      return `${existed ? "Replaced" : "Created"} ${t.rel} (${lines} line${lines === 1 ? "" : "s"}, ${fmtBytes(Buffer.byteLength(args.content))}).`;
    },
  },
  {
    name: "edit_file",
    description:
      "Replace an exact piece of text in a file. old_string must match the file exactly (spaces, indentation and line breaks included) and appear exactly once, unless replace_all is true. Read the file first and copy the text you want to change, with enough surrounding lines to make it unique.",
    properties: {
      path: { type: "string", description: "Workspace-relative path." },
      old_string: { type: "string", description: "The exact text to replace." },
      new_string: { type: "string", description: "The replacement (may be empty to delete the text)." },
      replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
    },
    required: ["path", "old_string", "new_string"],
    run(args, c) {
      const t = checkPath(c, args.path);
      if (isOutput(t)) return t;
      if (typeof args.old_string !== "string" || !args.old_string) return fail("old_string is required and can't be empty. To create a file or replace all of it, use write_file.");
      if (typeof args.new_string !== "string") return fail("new_string must be a string (use an empty string to delete the text).");
      let oldS = args.old_string;
      let newS = args.new_string;
      if (oldS === newS) return fail("old_string and new_string are the same, so there's nothing to change.");
      const text = readText(t);
      if (typeof text !== "string") return text;
      const count = (needle: string) => {
        let n = 0;
        for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) n++;
        return n;
      };
      let n = count(oldS);
      // The file uses Windows line endings but the model wrote "\n": match it the file's way.
      if (!n && text.includes("\r\n") && oldS.includes("\n") && !oldS.includes("\r\n")) {
        const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");
        if (count(crlf(oldS))) {
          oldS = crlf(oldS);
          newS = crlf(newS);
          n = count(oldS);
        }
      }
      if (!n) {
        return fail(
          `old_string wasn't found in ${t.rel}. It must match the file exactly, including spaces, indentation and line breaks. Read the part you want to change with read_file and copy it without the line numbers.`,
        );
      }
      if (n > 1 && args.replace_all !== true) {
        return fail(`old_string appears ${n} times in ${t.rel}. Include more surrounding lines so it matches exactly once, or set replace_all to true to change every occurrence.`);
      }
      const first = text.indexOf(oldS);
      const next = args.replace_all === true ? text.split(oldS).join(newS) : text.slice(0, first) + newS + text.slice(first + oldS.length);
      if (next.length > WRITE_MAX_CHARS) return fail(`The result would be too large (${fmtBytes(next.length)}).`);
      try {
        writeNoFollow(t.real, next);
      } catch (err) {
        return fail(fsMessage(err, t.rel));
      }
      const line = text.slice(0, first).split("\n").length;
      return `Edited ${t.rel}: replaced ${n === 1 ? "1 occurrence" : `${n} occurrences`} (first at line ${line}).`;
    },
  },
  {
    name: "delete_file",
    description: "Delete a file, a symlink (the link itself, not what it points to) or an empty folder in the workspace. Only delete what you made or were asked to remove.",
    properties: { path: { type: "string", description: "Workspace-relative path." } },
    required: ["path"],
    destructive: true,
    run(args, c) {
      const t = checkPath(c, args.path);
      if (isOutput(t)) return t;
      // Remove the entry itself: resolve the folders it's in, never the last component.
      const entry = path.join(realPrefix(path.dirname(t.abs)), path.basename(t.abs));
      if (entry === c.guard.workspaceReal || t.abs === c.guard.workspace) return fail("That's the workspace itself; it can't be deleted.");
      if (c.guard.isProtected(entry, entry) || !c.guard.inWorkspace(t.abs, entry)) return fail(protectedMsg(str(args.path)));
      let st: fs.Stats;
      try {
        st = fs.lstatSync(entry);
      } catch (err) {
        return fail(fsMessage(err, t.rel));
      }
      try {
        if (st.isDirectory()) {
          fs.rmdirSync(entry);
          return `Deleted the empty folder ${t.rel}.`;
        }
        fs.unlinkSync(entry);
      } catch (err: any) {
        if (err?.code === "ENOTEMPTY" || err?.code === "EEXIST") {
          return fail(`${t.rel} is a folder with files in it. delete_file removes files and empty folders only; to remove a whole folder use the shell (rm -r), which may need the user's approval.`);
        }
        return fail(fsMessage(err, t.rel));
      }
      return `Deleted ${t.rel}${st.isSymbolicLink() ? " (the link itself; what it pointed to is untouched)" : ""}.`;
    },
  },
  {
    name: "list_dir",
    description:
      "List a folder in the workspace (default: the root), with file sizes, as paths you can pass to the other tools. depth is how many levels to show (default 2, max 10). Symlinked folders are shown but not entered; .git, node_modules and .browser are shown but not expanded unless you list them directly.",
    properties: {
      path: { type: "string", description: "Workspace-relative folder (default: the workspace root)." },
      depth: { type: "number", description: "Levels to show (default 2, max 10)." },
    },
    readOnly: true,
    async run(args, c) {
      const t = checkPath(c, args.path, { fallback: "." });
      if (isOutput(t)) return t;
      let st: fs.Stats;
      try {
        st = fs.statSync(t.real);
      } catch (err) {
        return fail(fsMessage(err, t.rel));
      }
      const show = (rel: string) => (t.rel === "." ? rel : `${t.rel}/${rel}`);
      if (!st.isDirectory()) return `${t.rel}  ${fmtBytes(st.size)}`;
      const depth = clampInt(args.depth, 2, 1, 10);
      const lines: string[] = [];
      const { truncated } = await walk(c.guard, t, { maxDepth: depth, maxEntries: LIST_MAX_ENTRIES }, (e) => {
        const p = show(e.rel);
        if (e.off) lines.push(`${p}${e.type === "dir" ? "/" : ""}  (managed by the gateway; off-limits)`);
        else if (e.type === "dir") lines.push(`${p}/${e.skipped ? "  (not expanded)" : ""}`);
        else if (e.type === "link") {
          let to = "";
          try {
            to = fs.readlinkSync(e.abs);
          } catch {
            // Unreadable link.
          }
          const inside = c.guard.inWorkspace(e.abs, e.real);
          lines.push(`${p} -> ${to || "?"}  (symlink${inside ? "" : " leading outside the workspace"}; not followed)`);
        } else if (e.type === "file") {
          let size = "";
          try {
            size = fmtBytes(fs.lstatSync(e.real).size);
          } catch {
            // Vanished meanwhile.
          }
          lines.push(`${p}${size ? `  ${size}` : ""}`);
        } else lines.push(`${p}  (special file)`);
      });
      if (!lines.length) return `${t.rel === "." ? "The workspace" : t.rel} is empty.`;
      const header = `${t.rel === "." ? "Workspace root" : `${t.rel}/`} (depth ${depth}):`;
      const more = truncated ? `\n… stopped after ${LIST_MAX_ENTRIES} entries; list a subfolder or use a smaller depth.` : "";
      return capText(`${header}\n${lines.join("\n")}${more}`, OUTPUT_CAP, "…(listing cut)");
    },
  },
  {
    name: "find_files",
    description:
      "Find files and folders whose path matches a glob: * within a name, ** across folders, ?, [abc] and {a,b}. A pattern without / matches names at any depth (e.g. *.md); one with / matches the path from the search folder (e.g. src/**/*.ts). Symlinked folders aren't entered; .git, node_modules and .browser are skipped.",
    properties: {
      pattern: { type: "string", description: "Glob pattern, e.g. **/*.png or report-*.md." },
      path: { type: "string", description: "Workspace-relative folder to search (default: the workspace root)." },
    },
    required: ["pattern"],
    readOnly: true,
    async run(args, c) {
      const pattern = str(args.pattern).trim();
      if (!pattern) return fail("pattern is required, e.g. *.md or src/**/*.ts.");
      const t = checkPath(c, args.path, { fallback: "." });
      if (isOutput(t)) return t;
      try {
        if (!fs.statSync(t.real).isDirectory()) return fail(`${t.rel} isn't a folder.`);
      } catch (err) {
        return fail(fsMessage(err, t.rel));
      }
      const match = compileGlob(pattern);
      const found: string[] = [];
      let more = false;
      const { truncated } = await walk(c.guard, t, { maxDepth: 64, maxEntries: WALK_MAX_ENTRIES }, (e) => {
        if (e.off || e.skipped || !match(e.rel)) return;
        if (found.length >= FIND_MAX_RESULTS) {
          more = true;
          return false;
        }
        const p = t.rel === "." ? e.rel : `${t.rel}/${e.rel}`;
        found.push(`${p}${e.type === "dir" ? "/" : e.type === "link" ? "  (symlink)" : ""}`);
      });
      if (!found.length) return `Nothing matches ${pattern} under ${t.rel === "." ? "the workspace" : t.rel}.${truncated ? ` (Stopped after ${WALK_MAX_ENTRIES} entries.)` : ""}`;
      const note = more ? `\n… more than ${FIND_MAX_RESULTS} matches; narrow the pattern or the folder.` : truncated ? `\n… stopped after looking at ${WALK_MAX_ENTRIES} entries.` : "";
      return capText(found.join("\n") + note, OUTPUT_CAP, "…(list cut)");
    },
  },
  {
    name: "grep",
    description:
      "Search file contents in the workspace with a regular expression (JavaScript syntax) and get path:line:text for each matching line. Narrow it with path (a folder or a file) and glob (e.g. *.ts or docs/**/*.md). Binary files and files over 2 MB are skipped, as are .git, node_modules and .browser; symlinked folders aren't entered.",
    properties: {
      pattern: { type: "string", description: "Regular expression, e.g. TODO|FIXME or function\\s+main." },
      path: { type: "string", description: "Workspace-relative folder or file (default: the workspace root)." },
      glob: { type: "string", description: "Only search files matching this glob." },
      case_insensitive: { type: "boolean" },
      max_results: { type: "number", description: "Default 100, max 1000." },
    },
    required: ["pattern"],
    readOnly: true,
    async run(args, c) {
      const pattern = str(args.pattern);
      if (!pattern) return fail("pattern is required.");
      const flags = args.case_insensitive === true ? "i" : "";
      let source = pattern;
      let literal = false;
      try {
        new RegExp(source, flags);
      } catch {
        source = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        literal = true;
      }
      const t = checkPath(c, args.path, { fallback: "." });
      if (isOutput(t)) return t;
      let st: fs.Stats;
      try {
        st = fs.statSync(t.real);
      } catch (err) {
        return fail(fsMessage(err, t.rel));
      }
      const files: Array<{ real: string; rel: string; max: number }> = [];
      let tooBig = 0;
      let total = 0;
      let capped = false;
      const consider = (real: string, rel: string, size: number) => {
        if (size > GREP_MAX_FILE_BYTES) {
          tooBig++;
          return true;
        }
        if (files.length >= GREP_MAX_FILES || total + size > GREP_MAX_TOTAL_BYTES) {
          capped = true;
          return false;
        }
        total += size;
        files.push({ real, rel, max: GREP_MAX_FILE_BYTES });
        return true;
      };
      if (st.isDirectory()) {
        const match = args.glob ? compileGlob(str(args.glob)) : undefined;
        const { truncated } = await walk(c.guard, t, { maxDepth: 64, maxEntries: WALK_MAX_ENTRIES }, (e) => {
          if (e.off || (e.type !== "file" && e.type !== "link")) return;
          if (match && !match(e.rel)) return;
          // Where the file really is, checked before it's read: links must stay in the workspace and out of the gateway's files.
          if (e.type === "link" && (!c.guard.inWorkspace(e.abs, e.real) || c.guard.isProtected(e.real, e.real))) return;
          let fst: fs.Stats;
          try {
            fst = fs.statSync(e.real);
          } catch {
            return;
          }
          if (!fst.isFile()) return;
          return consider(e.real, t.rel === "." ? e.rel : `${t.rel}/${e.rel}`, fst.size);
        });
        if (truncated) capped = true;
      } else if (st.isFile()) {
        consider(t.real, t.rel, st.size);
      } else {
        return fail(`${t.rel} isn't a file or folder.`);
      }
      const maxResults = clampInt(args.max_results, 100, 1, 1000);
      if (!files.length) return `No files to search under ${t.rel === "." ? "the workspace" : t.rel}${args.glob ? ` matching ${str(args.glob)}` : ""}.`;
      const r = await runGrepWorker(
        // Lines come back longer than shown, so secrets are scrubbed before the cut (one half of a secret isn't caught).
        { files, pattern: source, flags, maxResults, maxLine: GREP_LINE_CAP + 4096 },
        () => c.state.cancelled,
        c.opts.pollMs ?? 100,
        c.opts.grepTimeoutMs ?? GREP_TIMEOUT_MS,
      );
      if ("error" in r) return fail(r.error);
      const notes: string[] = [];
      if (literal) notes.push("(The pattern isn't a valid regular expression, so it was searched as plain text.)");
      if (r.hitCap) notes.push(`(Stopped at ${maxResults} matches; narrow the search or raise max_results.)`);
      if (capped) notes.push("(Not every file was searched: the folder is very large. Narrow it with path or glob.)");
      if (tooBig) notes.push(`(${tooBig} file${tooBig === 1 ? "" : "s"} over ${fmtBytes(GREP_MAX_FILE_BYTES)} skipped.)`);
      if (!r.lines.length) return [`No matches in ${r.searched} file${r.searched === 1 ? "" : "s"}.`, ...notes].join("\n");
      const shown = c.h
        .scrubSecrets(r.lines.join("\n"))
        .split("\n")
        .map((l) => (l.length > GREP_LINE_CAP ? `${l.slice(0, GREP_LINE_CAP)}…` : l));
      return capText([...shown, ...notes].join("\n"), OUTPUT_CAP, "…(results cut; narrow the search)");
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch a public web page or file over http(s) with GET and get it back as readable text (HTML is converted, with links as [text](url); JSON and plain text come back as they are; images come back as images). Reads up to 2 MB and returns about 40,000 characters. It can't reach this computer, the local network or pages that need a login.",
    properties: { url: { type: "string", description: "Full http:// or https:// URL." } },
    required: ["url"],
    readOnly: true,
    run(args, c) {
      const url = str(args.url).trim();
      if (!url) return fail("url is required.");
      return webFetch(c, url);
    },
  },
];

export const WORKSPACE_TOOL_NAMES = SPECS.map((s) => s.name);

/**
 * Bind the workspace tools to one bot. `current` returns the turn in progress;
 * `options` is for tests (loopback fetches, fake DNS, faster polling).
 */
export function buildWorkspaceTools(h: Harness, botId: Id, current: () => RunState | undefined, options: WorkspaceToolsOptions = {}): BoundTool[] {
  return SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    readOnly: spec.readOnly,
    destructive: spec.destructive,
    inputSchema: { type: "object", properties: spec.properties, required: spec.required ?? [], additionalProperties: false },
    async execute(args: Record<string, unknown>): Promise<ToolOutput> {
      const state = current();
      if (!state || state.bot.id !== botId) return { text: "This bot has no turn in progress.", isError: true };
      if (state.cancelled) return { text: "This turn was stopped.", isError: true };
      try {
        const guard = new PathGuard(h.store.paths.workspace, h.protectedPaths());
        const res = await spec.run(args ?? {}, { h, state, guard, opts: options });
        return typeof res === "string" ? { text: res } : res;
      } catch (err: any) {
        return { text: `Tool ${spec.name} failed: ${err?.message ?? err}`, isError: true };
      }
    },
  }));
}
