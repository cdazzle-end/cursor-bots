/**
 * Bot memory is a small Markdown file per bot (state/memory/<botId>.md).
 * Grok Bot keeps "stable preferences, important facts, and summaries of prior
 * work"; we keep the same three things plus lasting rules, as sections:
 *
 *   ## Lasting rules   – boundaries the user asked the bot to always follow
 *   ## Preferences     – how the user likes things done
 *   ## Facts           – durable facts about the job, people, systems
 *   ## Work log        – one-line summaries of finished work (newest last)
 *
 * The harness injects this file into every turn, so it survives the runtime
 * compacting or even losing its conversation context.
 */

export const MEMORY_SECTIONS = ["Lasting rules", "Preferences", "Facts", "Work log"] as const;

export function emptyMemory(botName: string): string {
  return `# ${botName}'s memory\n\n` + MEMORY_SECTIONS.map((s) => `## ${s}\n`).join("\n");
}

interface Parsed {
  head: string[];
  sections: Array<{ title: string; lines: string[] }>;
}

function parse(md: string): Parsed {
  const head: string[] = [];
  const sections: Parsed["sections"] = [];
  for (const line of md.split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      sections.push({ title: m[1]!, lines: [] });
    } else if (sections.length) {
      sections[sections.length - 1]!.lines.push(line);
    } else {
      head.push(line);
    }
  }
  return { head, sections };
}

function render(p: Parsed): string {
  const parts = [p.head.join("\n").trimEnd()];
  for (const s of p.sections) {
    const body = s.lines.join("\n").replace(/^\n+|\n+$/g, "");
    parts.push(`## ${s.title}\n${body ? body + "\n" : ""}`);
  }
  return parts.filter(Boolean).join("\n\n").trimEnd() + "\n";
}

function normalizeSection(section: string | undefined): string {
  if (!section) return "Facts";
  const s = section.trim().toLowerCase();
  if (/rule|boundar|never|always/.test(s)) return "Lasting rules";
  if (/pref|style|like/.test(s)) return "Preferences";
  if (/log|summar|history|done|work/.test(s)) return "Work log";
  if (/fact|know|context|info/.test(s)) return "Facts";
  return section.trim();
}

export function addMemory(md: string, botName: string, section: string | undefined, text: string, now = new Date()): string {
  const p = parse(md.trim() ? md : emptyMemory(botName));
  const title = normalizeSection(section);
  let sec = p.sections.find((s) => s.title.toLowerCase() === title.toLowerCase());
  if (!sec) {
    sec = { title, lines: [] };
    p.sections.push(sec);
  }
  const clean = text.replace(/\s+/g, " ").trim().replace(/^[-*]\s+/, "");
  const entry = title === "Work log" ? `- ${now.toISOString().slice(0, 10)}: ${clean}` : `- ${clean}`;
  // Skip exact duplicates so repeated "remember" calls don't bloat memory.
  if (!sec.lines.some((l) => l.trim() === entry)) {
    while (sec.lines.length && !sec.lines[sec.lines.length - 1]!.trim()) sec.lines.pop();
    sec.lines.push(entry);
  }
  return render(p);
}

export function removeMemory(md: string, match: string): { md: string; removed: number } {
  const needle = match.toLowerCase().trim();
  if (!needle) return { md, removed: 0 };
  let removed = 0;
  const out = md
    .split("\n")
    .filter((line) => {
      if (/^#/.test(line)) return true;
      if (line.toLowerCase().includes(needle)) {
        removed++;
        return false;
      }
      return true;
    })
    .join("\n");
  return { md: out, removed };
}

export function replaceMemory(md: string, match: string, replacement: string): { md: string; replaced: boolean } {
  const needle = match.toLowerCase().trim();
  const lines = md.split("\n");
  const idx = lines.findIndex((l) => !/^#/.test(l) && l.toLowerCase().includes(needle));
  if (idx < 0 || !needle) return { md, replaced: false };
  const bullet = /^\s*[-*]\s+/.test(lines[idx]!) ? lines[idx]!.match(/^\s*[-*]\s+/)![0] : "- ";
  lines[idx] = bullet + replacement.replace(/\s+/g, " ").trim().replace(/^[-*]\s+/, "");
  return { md: lines.join("\n"), replaced: true };
}

/** Memory as injected into a prompt: oldest work-log lines go first when over budget. */
export function memoryForPrompt(md: string, maxChars: number): { text: string; truncated: boolean } {
  if (md.length <= maxChars) return { text: md.trim(), truncated: false };
  const p = parse(md);
  const log = p.sections.find((s) => s.title === "Work log");
  let text = render(p);
  while (log && log.lines.some((l) => l.trim()) && text.length > maxChars) {
    const i = log.lines.findIndex((l) => l.trim());
    log.lines.splice(i, 1);
    text = render(p);
  }
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return { text: text.trim(), truncated: true };
}
