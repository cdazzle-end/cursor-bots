import { randomUUID } from "node:crypto";
import type { Harness } from "../core/harness.ts";
import { groupTag, renderMessage } from "../core/prompt.ts";
import type { Message } from "../core/types.ts";
import { oneLine } from "../core/util.ts";

/**
 * "Team MCP": a Model Context Protocol endpoint (Streamable HTTP, JSON
 * responses) that lets agents outside this app — Claude Code, the Cursor IDE,
 * Hermes, OpenClaw, anything that speaks MCP — work with your bots on your
 * behalf: list the team, message a bot or group and wait for the answer, read
 * a chat, create a bot.
 *
 *   POST /mcp   Authorization: Bearer <state/mcp.token>
 */

const PROTOCOL = "2025-06-18";

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, any>, client: string): Promise<string>;
}

export function mcpTools(h: Harness): Tool[] {
  const resolve = (ref: string) => {
    const r = String(ref ?? "").trim();
    if (r.startsWith("#")) {
      const g = [...h.store.conversations.values()].find((c) => c.kind === "group" && (groupTag(c) === r.toLowerCase() || c.title?.toLowerCase() === r.slice(1).toLowerCase()));
      return g;
    }
    const bot = h.store.botByHandle(r);
    return bot ? h.store.dmFor(bot.id) : undefined;
  };
  return [
    {
      name: "list_bots",
      description: "List the user's Cursor Bots team: each bot's @handle, name, job and whether it's busy, plus group chats (#name).",
      inputSchema: { type: "object", properties: {} },
      async run() {
        const lines = [...h.store.bots.values()].map((b) => `@${b.handle} "${b.name}"${b.label ? ` — ${b.label}` : ""}${b.about ? ` — ${oneLine(b.about, 200)}` : ""} [${h.statusLabel(b.id)}]`);
        const groups = [...h.store.conversations.values()].filter((c) => c.kind === "group").map((g) => `${groupTag(g)} "${g.title}": ${g.members.map((m) => "@" + h.store.bots.get(m)?.handle).join(", ")}`);
        return [`Bots:`, ...(lines.length ? lines : ["(none yet)"]), "Groups:", ...(groups.length ? groups : ["(none)"])].join("\n");
      },
    },
    {
      name: "message_bot",
      description:
        "Send a message to one bot (\"@handle\") or a group (\"#group-name\", @mention members to address them) as the user, and wait for the reply. Bots are persistent teammates with memory and their own computer; give them outcomes, not keystrokes.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: '"@handle" or "#group-name"' },
          text: { type: "string" },
          wait_seconds: { type: "number", description: "How long to wait for the reply (default 180, max 900). 0 = don't wait." },
        },
        required: ["to", "text"],
      },
      async run(args, client) {
        const message = required(args, "text");
        const conv = resolve(args.to);
        if (!conv) return `No bot or group called ${args.to}. Call list_bots first.`;
        const wait = Math.min(900, Math.max(0, Number(args.wait_seconds ?? 180)));
        const sent = await h.postUserMessage(conv.id, { text: `${message}\n\n(sent via ${client})` });
        if (!wait) return `Sent to ${h.conversationTitle(conv)}. Read replies later with read_chat.`;
        const reply = await waitForReply(h, conv.id, sent.ts, wait * 1000);
        if (!reply.length) return `Sent. No reply within ${wait}s; the bot may still be working. Check later with read_chat("${args.to}").`;
        return reply.map((m) => renderMessage(h.store, m, h.timezone(), 20_000)).join("\n\n");
      },
    },
    {
      name: "read_chat",
      description: "Read recent messages from a bot's chat (\"@handle\") or a group (\"#group-name\").",
      inputSchema: {
        type: "object",
        properties: { chat: { type: "string" }, limit: { type: "number", description: "Default 20, max 100." } },
        required: ["chat"],
      },
      async run(args) {
        const conv = resolve(args.chat);
        if (!conv) return `No bot or group called ${args.chat}.`;
        const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
        const msgs = h.store.messages(conv.id).filter((m) => m.kind !== "activity").slice(-limit);
        return msgs.length ? msgs.map((m) => renderMessage(h.store, m, h.timezone(), 4000)).join("\n") : "No messages yet.";
      },
    },
    {
      name: "create_bot",
      description: "Create a new bot with a focused job (operational terms, including what it must never do without approval).",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, label: { type: "string" }, job: { type: "string" } },
        required: ["name", "job"],
      },
      async run(args) {
        const b = h.createBot({ name: required(args, "name"), label: args.label ? String(args.label) : undefined, about: required(args, "job") });
        return `Created @${b.handle}. Message it with message_bot("@${b.handle}", ...).`;
      },
    },
  ];
}

/** A required text argument. Clients don't always check the schema, and "undefined" must never reach a bot. */
function required(args: Record<string, any>, name: string): string {
  const v = args?.[name];
  if (typeof v !== "string" || !v.trim()) throw new Error(`${name} is required (a non-empty string).`);
  return v;
}

/** Resolve with the bot replies posted after `afterTs`, once the bots in that chat go quiet. */
function waitForReply(h: Harness, convId: string, afterTs: number, timeoutMs: number): Promise<Message[]> {
  return new Promise((resolve) => {
    const conv = h.store.conversations.get(convId)!;
    const collect = () => h.store.messages(convId).filter((m) => m.ts > afterTs && m.author.kind === "bot" && ["message", "error", "approval", "secret_request"].includes(m.kind));
    const busy = () => conv.members.some((id) => {
      const s = h.runner(id).status();
      return (s.state === "working" && s.convId === convId) || h.runner(id).queue.some((q) => q.convId === convId);
    });
    let settleTimer: NodeJS.Timeout | undefined;
    const finish = () => {
      off();
      clearTimeout(timer);
      clearTimeout(settleTimer);
      resolve(collect());
    };
    const check = () => {
      clearTimeout(settleTimer);
      // Give chained replies (group mentions, handoffs) a moment to start before deciding we're done.
      if (collect().length && !busy()) settleTimer = setTimeout(() => (!busy() ? finish() : undefined), 1500);
    };
    const off = h.bus.on((ev) => {
      if (ev.type === "message.created" || ev.type === "run.finished" || ev.type === "bot.status") check();
    });
    const timer = setTimeout(finish, timeoutMs);
    check();
  });
}

const sessions = new Map<string, string>();

/** MCP session ids map to the client's self-reported name ("claude-code", "cursor", …). */
export function mcpClientName(sessionId: string | undefined): string | undefined {
  return sessionId ? sessions.get(sessionId) : undefined;
}

export async function handleMcp(
  h: Harness,
  body: any,
  clientName: () => string,
): Promise<{ status: number; json?: unknown; sessionId?: string }> {
  let sessionId: string | undefined;
  const tools = mcpTools(h);
  const handle = async (msg: any): Promise<unknown | undefined> => {
    const id = msg?.id;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "Invalid request");
    // Notifications get no response.
    if (id === undefined || id === null) return undefined;
    switch (msg.method) {
      case "initialize": {
        sessionId = randomUUID();
        const name = String(msg.params?.clientInfo?.name ?? "").slice(0, 60);
        if (name) sessions.set(sessionId, name);
        if (sessions.size > 500) sessions.delete(sessions.keys().next().value!);
        return reply({
          protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "cursor-bots", version: "0.1.0" },
          instructions: "Work with the user's persistent AI teammates (Cursor Bots). Call list_bots, then message_bot.",
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      case "tools/call": {
        const tool = tools.find((t) => t.name === msg.params?.name);
        if (!tool) return fail(-32602, `Unknown tool ${msg.params?.name}`);
        try {
          const text = await tool.run(msg.params?.arguments ?? {}, clientName());
          return reply({ content: [{ type: "text", text }] });
        } catch (err: any) {
          return reply({ content: [{ type: "text", text: String(err?.message ?? err) }], isError: true });
        }
      }
      default:
        return fail(-32601, `Method not found: ${msg.method}`);
    }
  };
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(handle))).filter((x) => x !== undefined);
    return out.length ? { status: 200, json: out, sessionId } : { status: 202 };
  }
  const out = await handle(body);
  return out === undefined ? { status: 202 } : { status: 200, json: out, sessionId };
}
