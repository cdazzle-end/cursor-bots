import { memoryForPrompt } from "./memory.ts";
import type { Store } from "./store.ts";
import type { Attachment, Bot, Conversation, Id, Message, WakeEvent } from "./types.ts";
import { formatLocalTime, slugify, truncate } from "./util.ts";

/**
 * Every turn a bot takes starts from one message the harness composes:
 *
 *   <harness>            who you are, your memory, your team, the time
 *   <context>            messages in this conversation you haven't seen yet
 *   <incoming>           what woke you (user message, handoff, routine...)
 *   <reply-instructions> where your final message will be posted
 *
 * The runtime keeps the conversation history itself; the harness only adds
 * what the runtime can't know (other conversations, memory, the roster).
 */

export function groupTag(c: Conversation): string {
  return `#${slugify(c.title ?? "group")}`;
}

export function authorName(store: Store, m: Message): string {
  if (m.author.kind === "user") return store.settings.user.name;
  if (m.author.kind === "system") return "System";
  const b = store.bots.get(m.author.id);
  return b ? `@${b.handle}` : "@(deleted bot)";
}

function attachmentLine(a: Attachment, inlined: boolean): string {
  const kb = a.size >= 1024 * 1024 ? `${(a.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(a.size / 1024))} KB`;
  return `[attachment] ${a.path} (${a.mime}, ${kb})${inlined ? " — included as an image" : ""}`;
}

export function renderMessage(store: Store, m: Message, timezone: string, max = 1200): string {
  const time = formatLocalTime(m.ts, timezone).replace(/^\w+, /, "");
  const lines = [`[${time}] ${authorName(store, m)}: ${truncate(m.text, max)}`];
  for (const a of m.attachments ?? []) lines.push("  " + attachmentLine(a, false));
  return lines.join("\n");
}

export function conversationLabel(store: Store, c: Conversation, forBot: Id): string {
  if (c.kind === "dm") return `your chat with ${store.settings.user.name}`;
  if (c.kind === "group") return `the group ${groupTag(c)} ("${c.title ?? "Group"}")`;
  const other = c.members.find((id) => id !== forBot);
  const ob = other ? store.bots.get(other) : undefined;
  return `your direct thread with @${ob?.handle ?? "bot"}`;
}

export interface PromptParts {
  bot: Bot;
  wake: WakeEvent;
  conv: Conversation;
  store: Store;
  timezone: string;
  includeIdentity: boolean;
  unseen: Message[];
  /** Attachments sent inline as images (so we can say so). */
  inlinedImages: Set<string>;
  statusOf: (botId: Id) => string;
  /** Expanded /skill references from the user's message. */
  skills?: Array<{ name: string; content: string }>;
  incomingKind: string;
  addressed?: "you" | "everyone" | "group";
  routineName?: string;
}

export function buildPrompt(p: PromptParts): string {
  const { bot, wake, conv, store } = p;
  const user = store.settings.user;
  const now = formatLocalTime(Date.now(), p.timezone);
  const out: string[] = [];

  out.push("<harness>");
  if (p.includeIdentity) {
    out.push(`<you name="${bot.name}" handle="@${bot.handle}">`);
    if (bot.label) out.push(`Label: ${bot.label}`);
    out.push(`Job: ${bot.about?.trim() || "Not described yet. Ask the user what you should own, then save it to memory."}`);
    if (bot.createdBy !== "user") {
      const creator = store.bots.get(bot.createdBy);
      out.push(`You are a helper bot created by @${creator?.handle ?? "another bot"}.`);
    }
    if (bot.disabledSkills.length) out.push(`Skills you must not use: ${bot.disabledSkills.join(", ")}`);
    out.push("</you>");
    const mem = memoryForPrompt(store.readMemory(bot.id), store.settings.limits.memoryCharsPerTurn);
    out.push(`<memory${mem.truncated ? ' truncated="true (use memory_read for all of it)"' : ""}>`);
    out.push(mem.text || "(empty — nothing saved yet)");
    out.push("</memory>");
    out.push(`<team user="${user.name}${user.label ? ` (${user.label})` : ""}">`);
    const others = [...store.bots.values()].filter((b) => b.id !== bot.id);
    if (!others.length) out.push("You are the only bot so far.");
    for (const b of others) {
      out.push(`- @${b.handle} "${b.name}"${b.label ? ` — ${b.label}` : ""}${b.about ? ` — ${truncate(b.about.replace(/\s+/g, " "), 140)}` : ""} [${p.statusOf(b.id)}]`);
    }
    const groups = store.conversationsFor(bot.id).filter((c) => c.kind === "group");
    for (const g of groups) {
      const members = g.members.map((id) => `@${store.bots.get(id)?.handle ?? "?"}`).join(", ");
      const lead = g.lead ? store.bots.get(g.lead) : undefined;
      out.push(`- Group ${groupTag(g)} "${g.title}": ${members}${lead ? `; lead @${lead.handle}` : ""}${g.purpose ? `; purpose: ${truncate(g.purpose, 160)}` : ""}`);
    }
    out.push("</team>");
  } else {
    out.push(`<you name="${bot.name}" handle="@${bot.handle}">Identity, memory and team are unchanged since your last turn.</you>`);
  }
  out.push(`<now>${now}</now>`);
  out.push("</harness>");
  out.push("");

  if (p.unseen.length) {
    out.push(`<context conversation="${conversationLabel(store, conv, bot.id)}">`);
    out.push("Messages here since you last looked (oldest first):");
    for (const m of p.unseen) out.push(renderMessage(store, m, p.timezone, 800));
    out.push("</context>");
    out.push("");
  }

  for (const s of p.skills ?? []) {
    out.push(`<skill name="${s.name}">`);
    out.push(`The user referenced this skill. Follow it for this request.`);
    out.push(s.content.trim());
    out.push("</skill>");
    out.push("");
  }

  const from =
    wake.source === "user"
      ? user.name
      : wake.fromBotId
        ? `@${store.bots.get(wake.fromBotId)?.handle ?? "bot"}`
        : wake.source;
  const attrs = [`from="${from}"`, `kind="${p.incomingKind}"`, `via="${conversationLabel(store, conv, bot.id)}"`];
  if (p.addressed) attrs.push(`addressed="${p.addressed}"`);
  if (p.routineName) attrs.push(`routine="${p.routineName}"`);
  out.push(`<incoming ${attrs.join(" ")}>`);
  out.push(wake.text.trim() || "(no text)");
  for (const a of wake.attachments ?? []) out.push(attachmentLine(a, p.inlinedImages.has(a.path)));
  out.push("</incoming>");
  out.push("");

  out.push("<reply-instructions>");
  if (wake.replyTo) {
    const requester = store.bots.get(wake.replyTo.botId);
    out.push(`Your final message is posted in ${conversationLabel(store, conv, bot.id)} and delivered to @${requester?.handle ?? "the requester"} as your reply. Put the result in it.`);
  } else {
    out.push(`Your final message is posted in ${conversationLabel(store, conv, bot.id)}.`);
  }
  if (wake.allowSilence) out.push("If this doesn't need anything from you, answer exactly NO_REPLY and nothing will be posted.");
  if (wake.source === "routine" || wake.source === "webhook") out.push("This is a background routine run; the user may not be watching.");
  out.push("</reply-instructions>");
  return out.join("\n");
}
