import * as fs from "node:fs";
import * as path from "node:path";
import { homePaths, type HomePaths } from "./paths.ts";
import { mergeSettings } from "./settings.ts";
import type {
  Approval,
  Bot,
  ConnectorConfig,
  Conversation,
  Id,
  Message,
  Routine,
  SecretRequest,
  Settings,
} from "./types.ts";
import { readJson, writeFileAtomic, writeJson } from "./util.ts";

/**
 * File-backed state. Small collections live in JSON files that are rewritten
 * atomically; message history is append-only JSONL, one file per conversation.
 * The whole thing is single-process: the gateway owns the files.
 */
export class Store {
  readonly paths: HomePaths;
  settings: Settings;
  readonly bots = new Map<Id, Bot>();
  readonly conversations = new Map<Id, Conversation>();
  readonly routines = new Map<Id, Routine>();
  readonly approvals = new Map<Id, Approval>();
  readonly secretRequests = new Map<Id, SecretRequest>();
  connectors: Record<string, ConnectorConfig> = {};
  /** seen[botId][convId] = timestamp of the newest message the bot has seen there. */
  seen: Record<Id, Record<Id, number>> = {};
  private messageCache = new Map<Id, Message[]>();

  constructor(home: string) {
    this.paths = homePaths(home);
    for (const dir of [this.paths.home, this.paths.state, this.paths.messages, this.paths.memory, this.paths.logs]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.settings = mergeSettings(readJson<Partial<Settings> | undefined>(this.paths.config, undefined));
    for (const b of readJson<Bot[]>(this.paths.bots, [])) this.bots.set(b.id, b);
    for (const c of readJson<Conversation[]>(this.paths.conversations, [])) this.conversations.set(c.id, c);
    for (const r of readJson<Routine[]>(this.paths.routines, [])) this.routines.set(r.id, r);
    for (const a of readJson<Approval[]>(this.paths.approvals, [])) this.approvals.set(a.id, a);
    for (const s of readJson<SecretRequest[]>(this.paths.secretRequests, [])) this.secretRequests.set(s.id, s);
    this.connectors = readJson<Record<string, ConnectorConfig>>(this.paths.connectors, {});
    this.seen = readJson<Record<Id, Record<Id, number>>>(this.paths.seen, {});
  }

  saveSettings(): void {
    writeJson(this.paths.config, this.settings);
  }
  saveBots(): void {
    writeJson(this.paths.bots, [...this.bots.values()]);
  }
  saveConversations(): void {
    writeJson(this.paths.conversations, [...this.conversations.values()]);
  }
  saveRoutines(): void {
    writeJson(this.paths.routines, [...this.routines.values()]);
  }
  saveApprovals(): void {
    // Keep the file bounded: decided approvals older than 30 days are dropped.
    const cutoff = Date.now() - 30 * 86400_000;
    for (const [id, a] of this.approvals) {
      if (a.status !== "pending" && (a.decidedAt ?? a.createdAt) < cutoff) this.approvals.delete(id);
    }
    writeJson(this.paths.approvals, [...this.approvals.values()]);
  }
  saveSecretRequests(): void {
    writeJson(this.paths.secretRequests, [...this.secretRequests.values()]);
  }
  saveConnectors(): void {
    writeJson(this.paths.connectors, this.connectors);
  }
  saveSeen(): void {
    writeJson(this.paths.seen, this.seen);
  }

  // ---------------------------------------------------------------- messages

  private messageFile(convId: Id): string {
    return path.join(this.paths.messages, `${convId}.jsonl`);
  }

  messages(convId: Id): Message[] {
    let list = this.messageCache.get(convId);
    if (list) return list;
    list = [];
    try {
      const raw = fs.readFileSync(this.messageFile(convId), "utf8");
      // Start the next append on a fresh line, or it would fuse with a torn tail and be lost too.
      if (raw.length && !raw.endsWith("\n")) fs.appendFileSync(this.messageFile(convId), "\n");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          list.push(JSON.parse(line) as Message);
        } catch {
          // A torn last line after a crash is skipped rather than fatal.
        }
      }
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
    this.messageCache.set(convId, list);
    return list;
  }

  appendMessage(msg: Message): void {
    this.messages(msg.convId).push(msg);
    fs.appendFileSync(this.messageFile(msg.convId), JSON.stringify(msg) + "\n");
  }

  findMessage(convId: Id, id: Id): Message | undefined {
    return this.messages(convId).find((m) => m.id === id);
  }

  /** Rare in-place edit (e.g. attaching a final status to a card). Rewrites the conversation file. */
  updateMessage(convId: Id, id: Id, patch: Partial<Message>): Message | undefined {
    const list = this.messages(convId);
    const idx = list.findIndex((m) => m.id === id);
    if (idx < 0) return undefined;
    list[idx] = { ...list[idx]!, ...patch, id, convId };
    writeFileAtomic(this.messageFile(convId), list.map((m) => JSON.stringify(m)).join("\n") + "\n");
    return list[idx];
  }

  deleteConversationMessages(convId: Id): void {
    this.messageCache.delete(convId);
    fs.rmSync(this.messageFile(convId), { force: true });
  }

  // ------------------------------------------------------------------ memory

  memoryFile(botId: Id): string {
    return path.join(this.paths.memory, `${botId}.md`);
  }

  readMemory(botId: Id): string {
    try {
      return fs.readFileSync(this.memoryFile(botId), "utf8");
    } catch {
      return "";
    }
  }

  writeMemory(botId: Id, content: string): void {
    writeFileAtomic(this.memoryFile(botId), content.endsWith("\n") || !content ? content : content + "\n");
  }

  // ------------------------------------------------------------------ helpers

  botByHandle(handle: string): Bot | undefined {
    const h = handle.toLowerCase().replace(/^@/, "");
    for (const b of this.bots.values()) if (b.handle === h) return b;
    for (const b of this.bots.values()) if (b.name.toLowerCase() === h) return b;
    return undefined;
  }

  dmFor(botId: Id): Conversation | undefined {
    for (const c of this.conversations.values()) {
      if (c.kind === "dm" && c.members[0] === botId) return c;
    }
    return undefined;
  }

  botDmBetween(a: Id, b: Id): Conversation | undefined {
    for (const c of this.conversations.values()) {
      if (c.kind === "botdm" && c.members.includes(a) && c.members.includes(b)) return c;
    }
    return undefined;
  }

  conversationsFor(botId: Id): Conversation[] {
    return [...this.conversations.values()].filter((c) => c.members.includes(botId));
  }

  markSeen(botId: Id, convId: Id, ts: number): void {
    const forBot = (this.seen[botId] ??= {});
    if ((forBot[convId] ?? 0) < ts) {
      forBot[convId] = ts;
      this.saveSeen();
    }
  }

  lastSeen(botId: Id, convId: Id): number {
    return this.seen[botId]?.[convId] ?? 0;
  }
}
