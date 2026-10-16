#!/usr/bin/env node
// A scripted MCP server over stdio, for test/mcp-client.test.ts.
//
// FAKE_MCP_MODE:  (unset)     a working server
//                 fail-start  complain on stderr (FAKE_STDERR, or a line quoting FAKE_TOKEN) and exit 2 before answering
//                 hang        read stdin but never answer, and ignore stdin closing
//                 linger      a working server that ignores stdin closing (SIGTERM stops it), so it is slow to close
//                 grandchild  also start a long-running child process (to check the process group is killed)
// FAKE_PID_FILE:  write this process's pid there at startup.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as readline from "node:readline";

const mode = process.env.FAKE_MCP_MODE ?? "";
if (process.env.FAKE_PID_FILE) fs.writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
if (mode === "fail-start") {
  process.stderr.write(process.env.FAKE_STDERR ?? `fatal: the token ${process.env.FAKE_TOKEN ?? ""} was rejected\n`);
  process.exit(2);
}

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const state = { initialized: false, clientInfo: null, requestedVersion: null, grown: false };
const grandchild = mode === "grandchild" ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }) : undefined;

const tools = () => [
  {
    name: "echo",
    description: "Echo the text back.",
    inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    annotations: { readOnlyHint: true },
  },
  { name: "fail", description: "Always fails.", inputSchema: { type: "object", properties: {} } },
  { name: "picture", description: "Returns an image and other kinds of content.", inputSchema: { type: "object" } },
  { name: "info", description: "Reports how the server was started." },
  { name: "leak", description: "Prints secrets.", inputSchema: { type: "object", properties: {} } },
  { name: "crash", description: "Exits in the middle of the call.", annotations: { destructiveHint: true } },
  { name: "slow", description: "Answers after `ms` milliseconds; never without it.", inputSchema: { type: "object", properties: { ms: { type: "number" } } } },
  { name: "grow", description: "Adds a tool and tells the client." },
  { name: "ask_client", description: "Sends the client a ping and a request it doesn't support." },
  { name: "structured", description: "Returns only structured content." },
  { name: "weird.name/with spaces!" },
  { name: "t".repeat(70), description: "A name that is too long." },
  ...(state.grown ? [{ name: "late", description: "Added by grow." }] : []),
  // A duplicate the client should ignore.
  { name: "echo", description: "A duplicate." },
];

const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const text = (t) => ({ content: [{ type: "text", text: t }] });

const waiting = new Map();
let nextId = 1;
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = `srv-${nextId++}`;
    waiting.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });

async function call(name, args) {
  switch (name) {
    case "echo":
      return text(String(args.text ?? ""));
    case "fail":
      return { content: [{ type: "text", text: "it broke" }], isError: true };
    case "picture":
      return {
        content: [
          { type: "text", text: "a picture" },
          { type: "image", data: PNG, mimeType: "image/png" },
          { type: "resource", resource: { uri: "file:///notes.txt", mimeType: "text/plain", text: "resource body" } },
          { type: "audio", data: "AAAA", mimeType: "audio/wav" },
          { type: "resource_link", uri: "file:///big.bin", name: "big" },
        ],
      };
    case "info":
      return text(
        JSON.stringify({
          pid: process.pid,
          cwd: process.cwd(),
          fakeVar: process.env.FAKE_VAR ?? null,
          fromHub: process.env.FROM_HUB ?? null,
          clientInfo: state.clientInfo,
          requestedVersion: state.requestedVersion,
          initialized: state.initialized,
          grandchild: grandchild?.pid ?? null,
          cancelled: state.cancelled ?? [],
        }),
      );
    case "leak":
      // With `pad`: that many characters, then the API_TOKEN variable, as text or (with `error`) as a JSON-RPC error.
      if (typeof args.pad === "number") {
        const t = `${"x".repeat(args.pad)} token=${process.env.API_TOKEN ?? ""}`;
        if (args.error) throw Object.assign(new Error(t), { code: -32000 });
        return text(t);
      }
      return text("the key is s3cr3t-value and the header is hdr-secret-123");
    case "crash":
      process.stderr.write("boom: the server fell over\n");
      setTimeout(() => process.exit(3), 10);
      return undefined;
    case "slow":
      if (typeof args.ms === "number") {
        await new Promise((r) => setTimeout(r, args.ms));
        return text("done");
      }
      return new Promise(() => {});
    case "grow":
      state.grown = true;
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      return text("grown");
    case "ask_client": {
      const pong = await ask("ping");
      const other = await ask("sampling/createMessage", { messages: [], maxTokens: 10 });
      return text(JSON.stringify({ pong, other }));
    }
    case "structured":
      return { content: [], structuredContent: { answer: 42 } };
    default:
      if (name === "weird.name/with spaces!" || name === "t".repeat(70)) return text(`called ${name}`);
      return null;
  }
}

// Some servers log to stdout; the client must skip lines that aren't JSON.
process.stdout.write("starting up (this line is not JSON)\n");

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (mode === "hang") return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === undefined) {
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
    return;
  }
  if (msg.id === undefined) {
    if (msg.method === "notifications/initialized") state.initialized = true;
    if (msg.method === "notifications/cancelled") (state.cancelled ??= []).push(msg.params);
    return;
  }
  switch (msg.method) {
    case "initialize":
      state.clientInfo = msg.params.clientInfo;
      state.requestedVersion = msg.params.protocolVersion;
      process.stderr.write("fake server starting\n");
      // An older version than the client asked for: the client should accept it.
      return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fake", version: "1.0.0" } } });
    case "tools/list": {
      const all = tools();
      const start = Number(msg.params?.cursor ?? 0);
      const next = start + 4 < all.length ? String(start + 4) : undefined;
      return send({ jsonrpc: "2.0", id: msg.id, result: { tools: all.slice(start, start + 4), ...(next ? { nextCursor: next } : {}) } });
    }
    case "tools/call": {
      let out;
      try {
        out = await call(msg.params.name, msg.params.arguments ?? {});
      } catch (err) {
        return send({ jsonrpc: "2.0", id: msg.id, error: { code: err.code ?? -32603, message: String(err.message) } });
      }
      if (out === undefined) return;
      if (out === null) return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `Unknown tool: ${msg.params.name}` } });
      return send({ jsonrpc: "2.0", id: msg.id, result: out });
    }
    default:
      return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }
});
rl.on("close", () => {
  if (mode !== "hang" && mode !== "linger") process.exit(0);
});
if (mode === "hang" || mode === "linger") setInterval(() => {}, 1000);
