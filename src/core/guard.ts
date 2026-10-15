import * as fs from "node:fs";
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

/** Follow symlinks on the longest existing prefix of a path (new files resolve through their parent). */
export function realPrefix(p: string): string {
  const rest: string[] = [];
  let cur = p;
  for (let i = 0; i < 64; i++) {
    try {
      return path.join(fs.realpathSync(cur), ...rest);
    } catch {
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
