import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Path checks shared by the shell gate, the harness's own workspace tools and
 * anything else that must keep bots out of the gateway's state. Every check
 * looks at the path as written and at where it really leads (symlinks
 * followed), because a link inside the workspace can point anywhere.
 */

/** "a is b or below b" (careful with "/", whose children don't start with "//"). */
export function isUnder(a: string, b: string): boolean {
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/**
 * Follow symlinks on the longest existing prefix of a path (new files resolve
 * through their parent). A symlink whose target doesn't exist yet is followed
 * too, to where a new file written through it would land.
 */
export function realPrefix(p: string): string {
  const rest: string[] = [];
  let cur = path.resolve(p);
  for (let i = 0; i < 128; i++) {
    try {
      return path.join(fs.realpathSync(cur), ...rest);
    } catch {
      try {
        if (fs.lstatSync(cur).isSymbolicLink()) {
          cur = path.resolve(path.dirname(cur), fs.readlinkSync(cur));
          continue;
        }
      } catch {
        // Not there at all: try the parent.
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
  return p;
}

/** Spell a user-typed path out: file:// URLs, a leading ~, $HOME or ${HOME}. */
export function expandUserPath(target: string): string {
  let t = target.trim();
  if (t.startsWith("file://")) {
    try {
      t = fileURLToPath(t);
    } catch {
      // Not a usable URL; check it as written.
    }
  }
  return t.replace(/^~(?=$|[\\/])/, os.homedir()).replace(/^(\$\{HOME\}|\$HOME)(?=$|[\\/])/, os.homedir());
}

/** Both spellings of a path: as given and with symlinks followed. */
export function spellings(p: string): string[] {
  const abs = path.resolve(p);
  return [...new Set([abs, realPrefix(abs)])];
}

/**
 * True if `target` (resolved against each of `bases`) is one of `roots` or
 * inside one, by either spelling.
 */
export function insideAny(target: string, roots: string[], bases: string[]): boolean {
  const t = expandUserPath(target);
  const candidates = (path.isAbsolute(t) ? [bases[0]!] : bases).flatMap((b) => spellings(path.resolve(b, t)));
  const all = roots.flatMap(spellings);
  return candidates.some((c) => all.some((r) => isUnder(c, r)));
}

/** True if `target` (absolute) contains one of `roots` (e.g. searching a folder that holds the gateway's state). */
export function containsAny(target: string, roots: string[]): boolean {
  const ts = spellings(target);
  const all = roots.flatMap(spellings);
  return ts.some((t) => all.some((r) => r !== t && isUnder(r, t)));
}

/** Resolve a path a bot typed against a base folder (never this process's cwd), with ~, $HOME and file:// spelled out. */
export function resolveFrom(base: string, target: string): string {
  return path.resolve(base, expandUserPath(target));
}

/**
 * The checks one tool call needs, with the workspace and the protected roots
 * resolved once, so walking thousands of files costs no extra realpath calls
 * for the roots. Pass `real` when you already know where a path leads.
 */
export class PathGuard {
  readonly workspace: string;
  readonly workspaceReal: string;
  private workspaces: string[];
  private roots: string[];

  constructor(workspace: string, protectedRoots: string[]) {
    this.workspace = path.resolve(workspace);
    this.workspaceReal = realPrefix(this.workspace);
    this.workspaces = spellings(this.workspace);
    this.roots = [...new Set(protectedRoots.flatMap(spellings))];
  }

  /** The path as written or where it leads is protected (or inside something protected). */
  isProtected(abs: string, real: string = realPrefix(abs)): boolean {
    return [abs, real].some((c) => this.roots.some((r) => isUnder(c, r)));
  }

  /** The path as written and where it leads both stay inside the workspace (either spelling of it). */
  inWorkspace(abs: string, real: string = realPrefix(abs)): boolean {
    return [abs, real].every((c) => this.workspaces.some((w) => isUnder(c, w)));
  }

  /** Workspace-relative spelling for messages and listings ("." for the root). */
  rel(abs: string): string {
    for (const w of this.workspaces) if (isUnder(abs, w)) return path.relative(w, abs) || ".";
    return abs;
  }
}

// ------------------------------------------------------------------ network addresses

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
}

const V4_BLOCKED: Array<[string, number, string]> = [
  ["0.0.0.0", 8, "this-network"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "shared (carrier NAT)"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local"],
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "reserved"],
  ["192.0.2.0", 24, "documentation"],
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"],
];

function v4Blocked(ip: string): string | undefined {
  const n = v4ToInt(ip);
  for (const [base, bits, kind] of V4_BLOCKED) {
    const size = 2 ** (32 - bits);
    const start = v4ToInt(base);
    if (n >= start && n < start + size) return kind;
  }
  return undefined;
}

/** Parse an IPv6 address into eight 16-bit groups (an embedded IPv4 tail is allowed). */
function v6Groups(ip: string): number[] | undefined {
  let s = ip.toLowerCase().replace(/%.*$/, "");
  let tail: number[] = [];
  const embedded = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (embedded) {
    if (!net.isIPv4(embedded[2]!)) return undefined;
    const n = v4ToInt(embedded[2]!);
    tail = [Math.floor(n / 65536), n % 65536];
    // Keep a "::" before the IPv4 part, drop a single ":".
    s = embedded[1]!.endsWith("::") ? embedded[1]! : embedded[1]!.slice(0, -1);
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string) => (part ? part.split(":").map((g) => parseInt(g, 16)) : []);
  const head = parse(halves[0]!);
  const back = halves.length === 2 ? parse(halves[1]!) : [];
  const want = 8 - tail.length;
  let groups: number[];
  if (halves.length === 2) {
    const fill = want - head.length - back.length;
    if (fill < 0) return undefined;
    groups = [...head, ...new Array<number>(fill).fill(0), ...back];
  } else {
    groups = head;
  }
  groups = [...groups, ...tail];
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return undefined;
  return groups;
}

function v4FromGroups(hi: number, lo: number): string {
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

/**
 * Why an address must not be fetched by a bot (loopback, private, link-local,
 * unique-local, multicast, reserved, or an IPv6 form wrapping one of those),
 * or undefined if it's an ordinary public address. Loopback can be let through
 * for tests.
 */
export function blockedAddress(ip: string, opts: { allowLoopback?: boolean } = {}): string | undefined {
  const allow = (kind: string | undefined) => (kind === "loopback" && opts.allowLoopback ? undefined : kind);
  if (net.isIPv4(ip)) return allow(v4Blocked(ip));
  if (!net.isIPv6(ip.replace(/%.*$/, ""))) return "not an IP address";
  const g = v6Groups(ip);
  if (!g) return "unparseable IPv6 address";
  const zeroHead = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroHead(8)) return "unspecified";
  if (zeroHead(7) && g[7] === 1) return allow("loopback");
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) wrap an IPv4 address.
  if ((zeroHead(5) && g[5] === 0xffff) || zeroHead(6) || (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))) {
    return allow(v4Blocked(v4FromGroups(g[6]!, g[7]!)));
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return "local NAT64";
  if (g[0] === 0x2002) return allow(v4Blocked(v4FromGroups(g[1]!, g[2]!))); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return "Teredo tunnel";
  if (g[0] === 0x2001 && g[1] === 0xdb8) return "documentation";
  if (g[0] === 0x100 && zeroHead(4)) return "discard";
  if ((g[0]! & 0xfe00) === 0xfc00) return "unique-local";
  if ((g[0]! & 0xffc0) === 0xfe80) return "link-local";
  if ((g[0]! & 0xffc0) === 0xfec0) return "site-local";
  if ((g[0]! & 0xff00) === 0xff00) return "multicast";
  return undefined;
}
