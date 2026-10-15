import * as fs from "node:fs";
import * as path from "node:path";
import { slugify, writeFileAtomic } from "./util.ts";

/**
 * Skills are Agent Skills (agentskills.io): a folder with SKILL.md and optional
 * scripts/, references/, assets/. They live in the shared workspace at
 * .cursor/skills/, which the Cursor SDK discovers natively (settingSources:
 * ["project"]), so every bot sees one shared library, like Grok Bot's
 * "private skills". The same folders work in Claude Code, Codex, Hermes and
 * OpenClaw, which all read SKILL.md.
 */
export interface SkillInfo {
  name: string;
  description: string;
  /** Path relative to the workspace. */
  path: string;
  manualOnly: boolean;
  createdBy?: string;
  updatedAt: number;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
/** Keys save() writes itself; any other key in an existing SKILL.md is kept as written. */
const MANAGED_KEYS = new Set(["name", "description", "disable-model-invocation", "created-by"]);

interface FrontmatterEntry {
  key: string;
  /** Column-0 comments and blank lines just above the key (they describe it). */
  lead: string[];
  /** The key line plus its value lines (indented lines, "- item" lists at column 0), verbatim. */
  lines: string[];
}

/** Split frontmatter into top-level entries. Comments after the last key form the tail. */
function frontmatterEntries(block: string): { entries: FrontmatterEntry[]; tail: string[] } {
  const entries: FrontmatterEntry[] = [];
  let pending: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):/.exec(line);
    if (kv) {
      entries.push({ key: kv[1]!, lead: pending, lines: [line] });
      pending = [];
    } else if (/^#/.test(line) || !line.trim()) {
      pending.push(line);
    } else if (entries.length) {
      // A value line: comments or blanks in between belong to the value too.
      entries.at(-1)!.lines.push(...pending, line);
      pending = [];
    } else {
      pending.push(line);
    }
  }
  return { entries, tail: pending };
}

export function parseFrontmatter(md: string): { data: Record<string, string>; body: string } {
  const m = FRONTMATTER.exec(md);
  if (!m) return { data: {}, body: md };
  const data: Record<string, string> = {};
  for (const { key, lines } of frontmatterEntries(m[1]!).entries) {
    const first = /^[A-Za-z0-9_-]+:\s*(.*)$/.exec(lines[0]!)![1]!.trim();
    const rest = lines.slice(1).map((l) => l.trim());
    const block = /^([>|])[-+]?$/.exec(first);
    if (block) {
      // YAML block scalar: ">" folds lines into one, "|" keeps them.
      data[key] = (block[1] === ">" ? rest.filter(Boolean).join(" ") : rest.join("\n")).trim();
    } else {
      // Plain values may wrap onto indented lines; list items and nested metadata are kept as text, comments dropped.
      const more = rest.filter((l) => l && !l.startsWith("#")).map((l) => l.replace(/^-\s+/, ""));
      data[key] = [unquote(first), ...more].join(" ").trim();
    }
  }
  return { data, body: md.slice(m[0].length) };
}

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return String(JSON.parse(v));
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

function quote(v: string): string {
  return JSON.stringify(v.replace(/\s+/g, " ").trim());
}

export class SkillLibrary {
  readonly root: string;
  readonly workspace: string;
  constructor(workspace: string, root: string) {
    this.workspace = workspace;
    this.root = root;
    fs.mkdirSync(root, { recursive: true });
  }

  list(): SkillInfo[] {
    const out: SkillInfo[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 4) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const sub = path.join(dir, e.name);
        const file = path.join(sub, "SKILL.md");
        if (fs.existsSync(file)) {
          const md = fs.readFileSync(file, "utf8");
          const { data } = parseFrontmatter(md);
          out.push({
            name: data.name || e.name,
            description: data.description || "",
            path: path.relative(this.workspace, file),
            manualOnly: data["disable-model-invocation"] === "true",
            createdBy: data["created-by"],
            updatedAt: fs.statSync(file).mtimeMs,
          });
        } else {
          walk(sub, depth + 1);
        }
      }
    };
    walk(this.root, 0);
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  find(name: string): SkillInfo | undefined {
    const n = name.replace(/^\//, "").toLowerCase();
    return this.list().find((s) => s.name.toLowerCase() === n);
  }

  read(name: string): { info: SkillInfo; content: string } | undefined {
    const info = this.find(name);
    if (!info) return undefined;
    return { info, content: fs.readFileSync(path.join(this.workspace, info.path), "utf8") };
  }

  save(input: { name: string; description: string; body: string; createdBy?: string; manualOnly?: boolean }): SkillInfo {
    const name = slugify(input.name).slice(0, 64);
    if (!input.description.trim()) throw new Error("A skill needs a description that says when to use it.");
    const existing = this.find(name);
    const dir = existing ? path.dirname(path.join(this.workspace, existing.path)) : path.join(this.root, name);
    let body = input.body.trim();
    // Accept a full SKILL.md (with frontmatter) as the body too.
    if (body.startsWith("---")) body = parseFrontmatter(body).body.trim();
    const lines = ["---", `name: ${name}`, `description: ${quote(input.description)}`];
    if (input.manualOnly) lines.push("disable-model-invocation: true");
    if (input.createdBy) lines.push(`created-by: ${quote(input.createdBy)}`);
    // Keep the keys this library doesn't manage (license, allowed-tools, metadata, ...) and every comment.
    if (existing) {
      const old = FRONTMATTER.exec(fs.readFileSync(path.join(this.workspace, existing.path), "utf8"));
      const { entries, tail } = old ? frontmatterEntries(old[1]!) : { entries: [], tail: [] };
      const comments = (l: string[]) => l.filter((x) => x.trim());
      for (const e of entries) {
        if (!MANAGED_KEYS.has(e.key)) {
          lines.push(...comments(e.lead), ...trimTrailingBlank(e.lines));
        } else if (comments(e.lead).length) {
          // A comment above a key we rewrite goes back above that key.
          const at = lines.findIndex((l) => l.startsWith(`${e.key}:`));
          if (at > 0) lines.splice(at, 0, ...comments(e.lead));
        }
      }
      lines.push(...comments(tail));
    }
    lines.push("---", "", body.startsWith("#") ? body : `# ${input.name.trim()}\n\n${body}`, "");
    writeFileAtomic(path.join(dir, "SKILL.md"), lines.join("\n"));
    return this.find(name)!;
  }

  delete(name: string): boolean {
    const info = this.find(name);
    if (!info) return false;
    const dir = path.dirname(path.join(this.workspace, info.path));
    if (!path.resolve(dir).startsWith(path.resolve(this.root) + path.sep)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }
}

function trimTrailingBlank(lines: string[]): string[] {
  let end = lines.length;
  while (end > 1 && !lines[end - 1]!.trim()) end--;
  return lines.slice(0, end);
}
