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

export function parseFrontmatter(md: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { data: {}, body: md };
  const data: Record<string, string> = {};
  let currentKey: string | undefined;
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      currentKey = kv[1]!;
      data[currentKey] = unquote(kv[2]!.trim());
    } else if (currentKey && /^\s+/.test(line)) {
      // Folded continuation lines and nested metadata are kept as text.
      data[currentKey] = `${data[currentKey]} ${line.trim()}`.trim();
    }
  }
  return { data, body: md.slice(m[0].length) };
}

function unquote(v: string): string {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
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
