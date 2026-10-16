import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import type { BoundTool, McpServerSpec, ToolOutput } from "../runtimes/types.ts";
import { oneLine, truncate } from "./util.ts";

/**
 * A small Model Context Protocol client, hand-rolled like the server side in
 * src/server/mcp.ts. Transports: stdio (newline-delimited JSON-RPC), Streamable
 * HTTP (JSON or SSE answers, Mcp-Session-Id), and the older HTTP+SSE transport
 * (GET an event stream, POST to the endpoint it names).
 *
 * Specs arrive with secrets already expanded, so nothing here logs a spec, and
 * every error or tool result has the spec's env, header and URL credentials
 * removed before anyone sees it.
 */

/** What we ask for. The server may answer with another version; we accept it. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
const CLIENT_VERSION = "0.1.0";

export interface McpTimeouts {
  /** Start the server (spawn or connect) and finish initialize. npx downloads are slow. */
  startMs: number;
  /** Each tools/list page. */
  listMs: number;
  /** One tools/call. */
  callMs: number;
  /** After a server timed out while starting, skip it this long, so each turn doesn't stall on it again. */
  retryMs: number;
}

export const MCP_TIMEOUTS: McpTimeouts = { startMs: 60_000, listMs: 30_000, callMs: 300_000, retryMs: 120_000 };

/** The most text one tool result may hand the model. */
const MAX_TEXT = 200_000;
const MAX_DESCRIPTION = 4000;
/** One stdio message may be large (screenshots), but not unbounded. */
const MAX_LINE = 64 * 1024 * 1024;
const STDERR_TAIL = 2048;

export interface McpHubOptions {
  /** Reported to servers as clientInfo.name. */
  clientName: string;
  /** Working directory for stdio servers (the workspace). */
  cwd: string;
  /** Environment for stdio servers (credentials the gateway keeps for itself removed). */
  env: () => NodeJS.ProcessEnv;
  /** Applied to tool output before it goes to the model (removes secret values). */
  scrub?: (text: string) => string;
  /** A server failed to start or answer; the hub keeps going without it. */
  onError?: (server: string, message: string) => void;
  /** Override the default timeouts (tests). */
  timeouts?: Partial<McpTimeouts>;
}

/** A connector tool. `mcp` says which server and which of its tools it is (the model only sees `name`). */
export interface McpBoundTool extends BoundTool {
  mcp: { server: string; tool: string };
}

/** A connector problem, phrased for people. `headline` leaves out details (stderr) that change between attempts. */
export class McpError extends Error {
  headline: string;
  status?: number;
  rpcCode?: number;
  timedOut: boolean;
  constructor(headline: string, opts: { detail?: string; status?: number; rpcCode?: number; timedOut?: boolean } = {}) {
    const detail = opts.detail?.trim();
    super(detail ? `${headline}: ${detail}` : headline);
    this.name = "McpError";
    this.headline = headline;
    this.status = opts.status;
    this.rpcCode = opts.rpcCode;
    this.timedOut = opts.timedOut ?? false;
  }
}

type Json = Record<string, any>;

interface McpToolDef {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown };
}

/**
 * MCP client for runtimes without their own: connects to a bot's connectors
 * (stdio, Streamable HTTP or SSE) and exposes their tools as harness tools.
 */
export class McpHub {
  private opts: McpHubOptions;
  private timeouts: McpTimeouts;
  private entries = new Map<string, Entry>();
  /** Every connection not yet closed, including ones still starting. */
  private live = new Set<McpConnection>();
  /** Last problem reported per server, so a broken server isn't announced on every turn. */
  private reported = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private closing?: Promise<void>;

  constructor(opts: McpHubOptions) {
    this.opts = opts;
    this.timeouts = { ...MCP_TIMEOUTS, ...opts.timeouts };
  }

  /** Connect to (or reuse) these servers and return their tools. Servers no longer listed are closed. */
  async tools(servers: Record<string, McpServerSpec>): Promise<BoundTool[]> {
    const run = this.queue.then(() => this.reconcile(servers));
    this.queue = run.catch(() => {});
    return run;
  }

  async close(): Promise<void> {
    this.closing ??= (async () => {
      const conns = [...this.live];
      this.live.clear();
      this.entries.clear();
      await Promise.all(conns.map((c) => c.close()));
    })();
    return this.closing;
  }

  private async reconcile(servers: Record<string, McpServerSpec>): Promise<McpBoundTool[]> {
    if (this.closing) return [];
    const names = Object.keys(servers).sort();
    const wanted = new Set(names);
    await Promise.all([...this.entries.keys()].filter((n) => !wanted.has(n)).map((n) => this.drop(n)));
    for (const n of [...this.reported.keys()]) if (!wanted.has(n)) this.reported.delete(n);
    await Promise.all(names.map((n) => this.ensure(n, servers[n]!)));
    if (this.closing) return [];

    const taken = new Set<string>();
    const out: McpBoundTool[] = [];
    for (const server of names) {
      const e = this.entries.get(server);
      if (!e?.conn || !e.tools) continue;
      for (const def of e.tools) out.push(this.bind(server, e, e.conn, def, taken));
    }
    return out;
  }

  /** Bring one server to a usable state (or leave it out, reporting why). Never throws. */
  private async ensure(server: string, spec: McpServerSpec): Promise<void> {
    const key = specKey(spec);
    let e = this.entries.get(server);
    if (e && e.key !== key) {
      await this.drop(server);
      e = undefined;
    }
    if (!e) {
      e = { key, spec, secrets: [] };
      this.entries.set(server, e);
    }
    if (e.conn?.dead) {
      // It died (mid-call, or the session expired): start it again.
      await this.closeConn(e.conn);
      e.conn = undefined;
      e.tools = undefined;
    }
    if (!e.conn) {
      if (e.retryAt && Date.now() < e.retryAt) return;
      e.retryAt = undefined;
      const conn = new McpConnection(spec, this.opts);
      this.live.add(conn);
      try {
        await conn.start(this.timeouts.startMs);
      } catch (err) {
        e.secrets = conn.secrets;
        await this.closeConn(conn);
        if (this.entries.get(server) !== e) return;
        const problem = asMcpError(err);
        if (problem.timedOut) e.retryAt = Date.now() + this.timeouts.retryMs;
        this.report(server, e, problem);
        return;
      }
      if (this.closing || this.entries.get(server) !== e) {
        await this.closeConn(conn);
        return;
      }
      e.conn = conn;
      e.secrets = conn.secrets;
    }
    if (e.conn.stale || !e.tools) {
      const conn = e.conn;
      try {
        e.tools = await conn.listTools(this.timeouts.listMs);
      } catch (err) {
        if (conn.dead) {
          await this.closeConn(conn);
          if (e.conn === conn) {
            e.conn = undefined;
            e.tools = undefined;
          }
        }
        // A failed refresh keeps the tools we already had; it's retried next turn.
        this.report(server, e, asMcpError(err));
        return;
      }
    }
    this.reported.delete(server);
  }

  private async drop(server: string): Promise<void> {
    const e = this.entries.get(server);
    this.entries.delete(server);
    if (e?.conn) await this.closeConn(e.conn);
  }

  private async closeConn(conn: McpConnection): Promise<void> {
    this.live.delete(conn);
    await conn.close();
  }

  private report(server: string, e: Entry, err: McpError): void {
    const headline = this.clean(err.headline, e.secrets);
    if (this.reported.get(server) === headline) return;
    this.reported.set(server, headline);
    try {
      this.opts.onError?.(server, this.clean(err.message, e.secrets));
    } catch {
      // A failing notice must not break the turn.
    }
  }

  /** Remove the connector's own credentials, then every stored secret. */
  private clean(text: string, secrets: string[]): string {
    let out = text;
    for (const v of secrets) out = out.split(v).join("[redacted]");
    if (!this.opts.scrub) return out;
    try {
      return this.opts.scrub(out);
    } catch {
      return "[output withheld: removing secrets from it failed]";
    }
  }

  private bind(server: string, e: Entry, conn: McpConnection, def: McpToolDef, taken: Set<string>): McpBoundTool {
    const name = mcpToolName(server, def.name, taken);
    taken.add(name);
    const ann = def.annotations && typeof def.annotations === "object" ? def.annotations : {};
    return {
      name,
      description: toolDescription(server, def),
      inputSchema: toolInputSchema(def.inputSchema),
      readOnly: typeof ann.readOnlyHint === "boolean" ? ann.readOnlyHint : undefined,
      destructive: typeof ann.destructiveHint === "boolean" ? ann.destructiveHint : undefined,
      mcp: { server, tool: def.name },
      execute: async (args, ctx) => {
        try {
          const params = args && typeof args === "object" && !Array.isArray(args) ? args : {};
          const result = await conn.callTool(def.name, params, this.timeouts.callMs, ctx?.signal);
          const out = toToolOutput(result);
          out.text = this.clean(out.text, e.secrets);
          return out;
        } catch (err) {
          const problem = asMcpError(err);
          const after = conn.dead ? "\n(The connector stopped; it will be restarted on the next turn.)" : "";
          return { text: this.clean(`Connector "${server}", tool "${def.name}" failed: ${problem.message}${after}`, e.secrets), isError: true };
        }
      },
    };
  }
}

interface Entry {
  /** Hash of the spec: a changed spec means a restart. */
  key: string;
  spec: McpServerSpec;
  conn?: McpConnection;
  tools?: McpToolDef[];
  /** Credentials to strip from anything this server says. */
  secrets: string[];
  /** Set after a start timed out: don't try again before this. */
  retryAt?: number;
}

/**
 * The model-facing name of a connector tool: `<server>__<tool>`, limited to
 * ^[a-zA-Z0-9_-]{1,64}$. A name that is too long or already taken gets a short
 * hash of the real names, so it stays the same from turn to turn.
 */
export function mcpToolName(server: string, tool: string, taken: Set<string>): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  const plain = `${clean(server)}__${clean(tool)}`;
  if (plain.length <= 64 && !taken.has(plain)) return plain;
  const tag = createHash("sha256").update(`${server}\u0000${tool}`).digest("hex").slice(0, 6);
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? `_${tag}` : `_${tag}${n}`;
    const name = plain.slice(0, 64 - suffix.length) + suffix;
    if (!taken.has(name)) return name;
  }
}

/** A JSON-schema object for the tool's arguments: `type: "object"`, no `$schema`, otherwise as the server sent it. */
export function toolInputSchema(schema: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = schema && typeof schema === "object" && !Array.isArray(schema) ? { ...(schema as Record<string, unknown>) } : {};
  delete out.$schema;
  out.type = "object";
  if (!out.properties || typeof out.properties !== "object" || Array.isArray(out.properties)) out.properties = {};
  return out;
}

function toolDescription(server: string, def: McpToolDef): string {
  const text = (typeof def.description === "string" && def.description.trim()) || (typeof def.title === "string" && def.title.trim()) || def.name;
  return truncate(`[${server}] ${text}`, MAX_DESCRIPTION);
}

/** Turn a tools/call result into what the model gets. */
export function toToolOutput(result: unknown): ToolOutput {
  const r: Json = result && typeof result === "object" ? (result as Json) : {};
  const texts: string[] = [];
  const images: Array<{ data: string; mimeType: string }> = [];
  const content: unknown[] = Array.isArray(r.content) ? r.content : [];
  const note = (what: string, mime: string, data: unknown) => {
    const size = typeof data === "string" && data ? `${Math.max(1, Math.round((data.length * 3) / 4 / 1024))} KB` : "";
    const about = [mime, size].filter(Boolean).join(", ");
    return `[${what}${about ? ` (${about})` : ""} not shown]`;
  };
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const part = raw as Json;
    const mime = typeof part.mimeType === "string" ? part.mimeType : "";
    switch (part.type) {
      case "text":
        if (typeof part.text === "string") texts.push(part.text);
        break;
      case "image":
        if (typeof part.data === "string" && part.data) images.push({ data: part.data, mimeType: mime || "image/png" });
        else texts.push("[an image without data]");
        break;
      case "resource": {
        const res: Json = part.resource && typeof part.resource === "object" ? part.resource : {};
        const rmime = typeof res.mimeType === "string" ? res.mimeType : "";
        const uri = typeof res.uri === "string" ? res.uri : "";
        if (typeof res.text === "string") texts.push(res.text);
        else if (typeof res.blob === "string" && /^image\/(png|jpe?g|gif|webp)$/i.test(rmime)) images.push({ data: res.blob, mimeType: rmime });
        else texts.push(note(uri ? `resource ${uri}` : "resource", rmime, res.blob));
        break;
      }
      case "resource_link": {
        const label = typeof part.name === "string" && part.name ? part.name : "";
        const uri = typeof part.uri === "string" ? part.uri : "";
        texts.push(`[resource link${label ? ` "${label}"` : ""}: ${uri}]`);
        break;
      }
      case "audio":
        texts.push(note("audio", mime, part.data));
        break;
      default:
        texts.push(note(`${typeof part.type === "string" ? part.type : "unknown"} content`, mime, undefined));
    }
  }
  if (!texts.length && r.structuredContent !== undefined) texts.push(JSON.stringify(r.structuredContent));
  // Servers on the 2024-10-07 protocol answered with `toolResult`.
  if (!content.length && !texts.length && r.toolResult !== undefined) texts.push(typeof r.toolResult === "string" ? r.toolResult : JSON.stringify(r.toolResult));
  let text = texts.join("\n");
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n[… ${text.length - MAX_TEXT} more characters cut]`;
  if (!text) text = images.length ? `[${images.length} image${images.length === 1 ? "" : "s"}]` : "(no output)";
  const out: ToolOutput = { text };
  if (images.length) out.images = images;
  if (r.isError === true) out.isError = true;
  return out;
}

// --------------------------------------------------------------- connection

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(err: McpError): void;
  timer: NodeJS.Timeout;
  abort: AbortController;
  signal?: AbortSignal;
  onStop?: () => void;
}

interface TransportHandlers {
  message(msg: unknown): void;
  closed(reason: McpError): void;
}

interface Transport {
  /**
   * Send one JSON-RPC message. Resolves true when the exchange is over, so a
   * request with no answer by then will never get one.
   */
  send(msg: Json, signal?: AbortSignal): Promise<boolean>;
  /** Learned from initialize; HTTP sends it with every later request. */
  protocolVersion?: string;
  /** Extra context for errors (the end of a stdio server's stderr). */
  detail?(): string | undefined;
  close(): Promise<void>;
}

/** One running server: the JSON-RPC session over one transport. */
class McpConnection {
  /** Set once the transport is gone; every later request fails with it. */
  dead?: McpError;
  /** The tool list needs (re)loading. */
  stale = true;
  /** Values to strip from errors and results (the spec's credentials). */
  secrets: string[];
  private spec: McpServerSpec;
  private opts: McpHubOptions;
  private transport?: Transport;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private generation = 0;
  private closing?: Promise<void>;

  constructor(spec: McpServerSpec, opts: McpHubOptions) {
    this.spec = spec;
    this.opts = opts;
    this.secrets = [];
  }

  async start(ms: number): Promise<void> {
    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new McpError(`no answer within ${seconds(ms)}; it may still be downloading or starting`, { detail: this.transport?.detail?.(), timedOut: true })),
        ms,
      );
    });
    const handshake = this.handshake(abort.signal, ms);
    handshake.catch(() => {});
    try {
      await Promise.race([handshake, timeout]);
    } catch (err) {
      abort.abort();
      await this.close();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async listTools(ms: number): Promise<McpToolDef[]> {
    this.stale = false;
    const out: McpToolDef[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      let res: any;
      try {
        res = await this.request("tools/list", cursor ? { cursor } : {}, ms);
      } catch (err) {
        // A server without tools may not know the method at all.
        if (err instanceof McpError && err.rpcCode === -32601) return out;
        this.stale = true;
        throw err;
      }
      for (const t of Array.isArray(res?.tools) ? res.tools : []) {
        if (!t || typeof t !== "object" || typeof t.name !== "string" || !t.name || names.has(t.name)) continue;
        names.add(t.name);
        out.push(t as McpToolDef);
      }
      const next = res?.nextCursor;
      if (typeof next !== "string" || !next || cursors.has(next)) break;
      cursors.add(next);
      cursor = next;
    }
    return out;
  }

  callTool(name: string, args: Record<string, unknown>, ms: number, signal?: AbortSignal): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args }, ms, signal);
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      const t = this.transport;
      this.generation++; // whatever the transport says from now on is ignored
      this.dead ??= new McpError("the connector was closed");
      for (const id of [...this.pending.keys()]) this.settle(id, undefined, this.dead);
      await t?.close().catch(() => {});
    })();
    return this.closing;
  }

  private async handshake(signal: AbortSignal, ms: number): Promise<void> {
    const spec = this.spec;
    const type = spec.type ?? (spec.url ? "http" : "stdio");
    if (type === "stdio") {
      const env = this.opts.env();
      this.secrets = secretValues(spec, env);
      this.use(new StdioTransport(spec, this.opts.cwd, env, this.handlers()));
      await this.initialize(ms);
      return;
    }
    this.secrets = secretValues(spec);
    const url = parseUrl(spec.url);
    const headers = spec.headers ?? {};
    if (type === "sse") {
      this.use(await SseTransport.open(url, headers, this.handlers(), signal));
      await this.initialize(ms);
      return;
    }
    this.use(new HttpTransport(url, headers, this.handlers()));
    try {
      await this.initialize(ms);
      return;
    } catch (err) {
      // Servers on the older HTTP+SSE transport turn the POST away with a 4xx; the spec says to try a GET next.
      if (!(err instanceof McpError) || ![400, 404, 405].includes(err.status ?? 0) || signal.aborted) throw err;
      const old = this.transport;
      let sse: SseTransport;
      try {
        sse = await SseTransport.open(url, headers, this.handlers(), signal);
      } catch {
        throw err;
      }
      void old?.close().catch(() => {});
      this.use(sse);
    }
    await this.initialize(ms);
  }

  private use(t: Transport): void {
    if (this.closing) {
      void t.close().catch(() => {});
      throw this.dead ?? new McpError("the connector was closed");
    }
    this.transport = t;
  }

  /** Callbacks for a new transport; an older transport's callbacks go nowhere. */
  private handlers(): TransportHandlers {
    const gen = ++this.generation;
    return {
      message: (msg) => {
        if (gen === this.generation) this.onMessage(msg);
      },
      closed: (reason) => {
        if (gen === this.generation) this.onClosed(reason);
      },
    };
  }

  private async initialize(ms: number): Promise<void> {
    const res: any = await this.request(
      "initialize",
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: this.opts.clientName, version: CLIENT_VERSION } },
      // start() has the real deadline (with a better message); this one only frees the request afterwards.
      ms + 1000,
    );
    const version = typeof res?.protocolVersion === "string" && res.protocolVersion ? res.protocolVersion : MCP_PROTOCOL_VERSION;
    if (this.transport) this.transport.protocolVersion = version;
    // Lenient: a server that turns the notification away may still work.
    await this.notify("notifications/initialized").catch(() => {});
  }

  private request(method: string, params: Json, ms: number, signal?: AbortSignal): Promise<any> {
    const t = this.transport;
    if (this.dead || !t) return Promise.reject(this.dead ?? new McpError("not connected"));
    if (signal?.aborted) return Promise.reject(new McpError("the turn was stopped"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const abort = new AbortController();
      // Give up on the request and tell the server, which may stop the work (a timeout, or the turn was stopped).
      const giveUp = (reason: string, err: McpError) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onStop);
        abort.abort();
        if (method !== "initialize") void this.notify("notifications/cancelled", { requestId: id, reason }).catch(() => {});
        reject(err);
      };
      const timer = setTimeout(() => giveUp("timed out", new McpError(`${method} got no answer within ${seconds(ms)}`, { timedOut: true })), ms);
      timer.unref?.();
      const onStop = () => giveUp("the user stopped the turn", new McpError("the turn was stopped"));
      signal?.addEventListener("abort", onStop, { once: true });
      this.pending.set(id, { method, resolve, reject, timer, abort, signal, onStop });
      t.send({ jsonrpc: "2.0", id, method, params }, abort.signal).then(
        (over) => {
          if (over) this.settle(id, undefined, new McpError(`the server ended its response to ${method} without an answer`));
        },
        (err) => this.settle(id, undefined, asMcpError(err)),
      );
    });
  }

  private async notify(method: string, params?: Json): Promise<void> {
    const t = this.transport;
    if (this.dead || !t) return;
    await t.send(params ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", method });
  }

  private settle(id: number, result: unknown, error?: McpError): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (p.onStop) p.signal?.removeEventListener("abort", p.onStop);
    if (error) p.reject(error);
    else p.resolve(result);
  }

  private onMessage(raw: unknown): void {
    if (Array.isArray(raw)) {
      for (const m of raw) this.onMessage(m);
      return;
    }
    if (!raw || typeof raw !== "object") return;
    const m = raw as Json;
    if (typeof m.method === "string") {
      if (m.id === undefined || m.id === null) {
        if (m.method === "notifications/tools/list_changed") this.stale = true;
        return;
      }
      // We offer no client features (sampling, roots, elicitation), so only ping gets a real answer.
      const reply =
        m.method === "ping"
          ? { jsonrpc: "2.0", id: m.id, result: {} }
          : { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
      void this.transport?.send(reply).catch(() => {});
      return;
    }
    if (!("result" in m) && !("error" in m)) return;
    const id = typeof m.id === "number" ? m.id : Number(m.id);
    const p = this.pending.get(id);
    if (!p) return;
    if (m.error !== undefined && m.error !== null) {
      const code = Number(m.error?.code);
      const message = typeof m.error?.message === "string" ? m.error.message : "";
      const known = Number.isFinite(code);
      this.settle(id, undefined, new McpError(`${p.method} failed${known ? ` (error ${code})` : ""}`, { detail: oneLine(message, 500), rpcCode: known ? code : undefined }));
    } else this.settle(id, m.result);
  }

  private onClosed(reason: McpError): void {
    this.dead ??= reason;
    for (const id of [...this.pending.keys()]) this.settle(id, undefined, reason);
  }
}

// --------------------------------------------------------------- transports

/** A server we spawn, speaking newline-delimited JSON-RPC on stdin/stdout. */
class StdioTransport implements Transport {
  protocolVersion?: string;
  private child: ChildProcess;
  private handlers: TransportHandlers;
  /** Its own process group, so close() also stops what it started (npx → node). */
  private group: boolean;
  private stderr = "";
  private lines: Lines;
  private ended?: McpError;
  private exitInfo?: { code: number | null; signal: NodeJS.Signals | null };
  private exited: Promise<void>;
  private closedByUs = false;
  private closing?: Promise<void>;

  constructor(spec: McpServerSpec, defaultCwd: string, env: NodeJS.ProcessEnv, handlers: TransportHandlers) {
    this.handlers = handlers;
    const command = spec.command?.trim();
    if (!command) throw new McpError("no command is configured");
    const cwd = spec.cwd ?? defaultCwd;
    if (!fs.existsSync(cwd)) throw new McpError("its working directory does not exist");
    this.group = process.platform !== "win32";
    this.lines = new Lines((line) => this.onLine(line));
    this.child = spawn(command, (spec.args ?? []).map(String), {
      cwd,
      env: { ...env, ...(spec.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      detached: this.group,
      windowsHide: true,
    });
    let markExited = () => {};
    this.exited = new Promise<void>((resolve) => (markExited = resolve));
    const child = this.child;
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      this.lines.push(chunk);
      if (this.lines.pending > MAX_LINE) {
        this.end(new McpError("the server sent a message over 64 MB"));
        this.kill("SIGKILL");
      }
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => this.noteStderr(chunk));
    for (const s of [child.stdin, child.stdout, child.stderr]) s?.on("error", () => {});
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (child.pid === undefined) markExited();
      const why = err.code === "ENOENT" ? " (command not found)" : err.code === "EACCES" ? " (permission denied)" : err.code ? ` (${err.code})` : "";
      this.end(new McpError(`could not start "${oneLine(command, 80)}"${why}`));
    });
    child.on("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      markExited();
      // Normally "close" follows once its output is read; if something it started keeps the pipes open, stop waiting.
      setTimeout(() => this.end(this.exitError()), 2000).unref();
    });
    child.on("close", () => this.end(this.exitError()));
  }

  async send(msg: Json): Promise<boolean> {
    if (this.ended) throw this.ended;
    const stdin = this.child.stdin;
    if (!stdin || !stdin.writable) throw new McpError("the server is not running");
    stdin.write(JSON.stringify(msg) + "\n");
    return false;
  }

  detail(): string | undefined {
    const tail = this.stderr.trim();
    return tail ? (this.stderr.length >= STDERR_TAIL ? `…${tail}` : tail) : undefined;
  }

  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    this.closedByUs = true;
    const running = () => this.child.pid !== undefined && this.child.exitCode === null && this.child.signalCode === null;
    try {
      this.child.stdin?.end();
    } catch {
      // already gone
    }
    // Closing stdin is the polite way to stop a stdio server; then SIGTERM, then SIGKILL.
    if (running()) await within(this.exited, 300);
    this.kill("SIGTERM");
    if (running()) await within(this.exited, 2000);
    this.kill("SIGKILL");
    if (running()) await within(this.exited, 1000);
    this.end(new McpError("the connector was closed"));
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
  }

  private kill(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    try {
      if (this.group) process.kill(-pid, signal);
      else if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill(signal);
    } catch {
      // nothing left in the group
    }
  }

  private onLine(line: string): void {
    const text = line.trim();
    if (!text) return;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      // Some servers log to stdout; keep it for error messages instead of failing.
      this.noteStderr(`(stdout) ${text.slice(0, 300)}\n`);
      return;
    }
    this.handlers.message(msg);
  }

  private noteStderr(chunk: string): void {
    this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL);
  }

  private exitError(): McpError {
    if (this.closedByUs) return new McpError("the connector was closed");
    const e = this.exitInfo;
    const how = !e ? "stopped" : e.signal ? `was stopped (${e.signal})` : `exited (code ${e.code})`;
    return new McpError(`the server ${how}`, { detail: this.detail() });
  }

  private end(reason: McpError): void {
    if (this.ended) return;
    this.ended = reason;
    this.lines.flush();
    // Don't leave anything it started behind.
    if (!this.closedByUs) this.kill("SIGKILL");
    this.handlers.closed(reason);
  }
}

/** Streamable HTTP: POST each message; the answer is JSON or an SSE stream. */
class HttpTransport implements Transport {
  protocolVersion?: string;
  private url: URL;
  private headers: Record<string, string>;
  private handlers: TransportHandlers;
  private sessionId?: string;
  private inflight = new Set<AbortController>();
  private ended?: McpError;
  private closing?: Promise<void>;

  constructor(url: URL, headers: Record<string, string>, handlers: TransportHandlers) {
    this.url = url;
    this.headers = headers;
    this.handlers = handlers;
  }

  async send(msg: Json, signal?: AbortSignal): Promise<boolean> {
    if (this.ended) throw this.ended;
    const isRequest = typeof msg.method === "string" && msg.id !== undefined;
    const ctrl = track(this.inflight, signal);
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: buildHeaders(this.headers, {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
          ...(this.protocolVersion ? { "mcp-protocol-version": this.protocolVersion } : {}),
        }),
        body: JSON.stringify(msg),
        signal: ctrl.signal,
      });
      const sid = res.headers.get("mcp-session-id");
      if (sid && !this.sessionId) this.sessionId = sid;
      if (res.status === 404 && this.sessionId && msg.method !== "initialize") {
        await discard(res);
        // The session is already gone on the server: nothing to DELETE on close.
        this.sessionId = undefined;
        throw this.end(new McpError("the server ended the session"));
      }
      if (!res.ok) throw await httpError(res);
      if (!isRequest || res.status === 202 || !res.body) {
        await discard(res);
        return true;
      }
      if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
        await readSse(res.body, (ev) => {
          if (ev.event !== "message") return false;
          const parsed = parseJson(ev.data);
          if (parsed === undefined) return false;
          this.handlers.message(parsed);
          return answers(parsed, msg.id);
        });
        return true;
      }
      const text = await res.text();
      if (text.trim()) {
        const parsed = parseJson(text);
        if (parsed === undefined) throw new McpError("the server's answer is not JSON");
        this.handlers.message(parsed);
      }
      return true;
    } catch (err) {
      if (err instanceof McpError) throw err;
      if (ctrl.signal.aborted) throw this.cancelled();
      // The server is unreachable or the connection broke: start over next time.
      throw this.end(new McpError("cannot reach the server", { detail: networkDetail(err) }));
    } finally {
      this.inflight.delete(ctrl);
    }
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.end(new McpError("the connector was closed"));
      for (const c of this.inflight) c.abort();
      if (!this.sessionId) return;
      try {
        const res = await fetch(this.url, {
          method: "DELETE",
          headers: buildHeaders(this.headers, {
            "mcp-session-id": this.sessionId,
            ...(this.protocolVersion ? { "mcp-protocol-version": this.protocolVersion } : {}),
          }),
          signal: AbortSignal.timeout(2000),
        });
        await discard(res);
      } catch {
        // Best effort: the server drops idle sessions anyway.
      }
    })();
    return this.closing;
  }

  private cancelled(): McpError {
    return this.ended ?? new McpError("the request was cancelled");
  }

  private end(reason: McpError): McpError {
    if (!this.ended) {
      this.ended = reason;
      this.handlers.closed(reason);
    }
    return this.ended;
  }
}

/** The older HTTP+SSE transport (2024-11-05): GET an event stream, POST to the endpoint it announces. */
class SseTransport implements Transport {
  protocolVersion?: string;
  private url: URL;
  private headers: Record<string, string>;
  private handlers: TransportHandlers;
  private endpoint?: URL;
  private stream = new AbortController();
  private inflight = new Set<AbortController>();
  private ended?: McpError;
  private ready?: { resolve(): void; reject(err: McpError): void };

  private constructor(url: URL, headers: Record<string, string>, handlers: TransportHandlers) {
    this.url = url;
    this.headers = headers;
    this.handlers = handlers;
  }

  /** Connect and wait for the "endpoint" event. */
  static async open(url: URL, headers: Record<string, string>, handlers: TransportHandlers, signal: AbortSignal): Promise<SseTransport> {
    if (signal.aborted) throw new McpError("the connector was closed");
    const t = new SseTransport(url, headers, handlers);
    const onAbort = () => t.end(new McpError("the connector was closed"));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await t.connect();
      return t;
    } catch (err) {
      t.end(asMcpError(err));
      throw err;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async connect(): Promise<void> {
    let res: Response;
    try {
      res = await fetch(this.url, { method: "GET", headers: buildHeaders(this.headers, { accept: "text/event-stream" }), signal: this.stream.signal });
    } catch (err) {
      throw this.ended ?? new McpError("cannot reach the server", { detail: networkDetail(err) });
    }
    if (!res.ok) throw await httpError(res);
    if (!(res.headers.get("content-type") ?? "").includes("text/event-stream") || !res.body) {
      await discard(res);
      throw new McpError("the server did not open an event stream");
    }
    const ready = new Promise<void>((resolve, reject) => (this.ready = { resolve, reject }));
    readSse(res.body, (ev) => this.onEvent(ev)).then(
      () => this.end(new McpError("the server closed its event stream")),
      (err) => this.end(new McpError("the event stream broke", { detail: networkDetail(err) })),
    );
    await ready;
  }

  async send(msg: Json, signal?: AbortSignal): Promise<boolean> {
    if (this.ended) throw this.ended;
    if (!this.endpoint) throw new McpError("not connected");
    const ctrl = track(this.inflight, signal);
    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: buildHeaders(this.headers, { "content-type": "application/json" }),
        body: JSON.stringify(msg),
        signal: ctrl.signal,
      });
      if (!res.ok) throw await httpError(res);
      // Answers come on the event stream; a few servers also put them in the POST response.
      if ((res.headers.get("content-type") ?? "").includes("application/json")) {
        const parsed = parseJson(await res.text());
        if (parsed && typeof parsed === "object") this.handlers.message(parsed);
      } else await discard(res);
      return false;
    } catch (err) {
      if (err instanceof McpError) throw err;
      if (ctrl.signal.aborted) throw this.cancelled();
      throw new McpError("cannot reach the server", { detail: networkDetail(err) });
    } finally {
      this.inflight.delete(ctrl);
    }
  }

  async close(): Promise<void> {
    this.end(new McpError("the connector was closed"));
  }

  private onEvent(ev: SseEvent): boolean {
    if (ev.event === "endpoint") {
      if (this.endpoint) return false;
      let u: URL;
      try {
        u = new URL(ev.data.trim(), this.url);
      } catch {
        this.end(new McpError("the server announced an invalid message endpoint"));
        return true;
      }
      // The endpoint gets the connector's headers (often a token): only send them where we connected.
      if (u.origin !== this.url.origin) {
        this.end(new McpError("the server's message endpoint is on another host"));
        return true;
      }
      this.endpoint = u;
      this.ready?.resolve();
      return false;
    }
    if (ev.event === "message") {
      const parsed = parseJson(ev.data);
      if (parsed !== undefined) this.handlers.message(parsed);
    }
    return false;
  }

  private cancelled(): McpError {
    return this.ended ?? new McpError("the request was cancelled");
  }

  private end(reason: McpError): void {
    if (this.ended) return;
    this.ended = reason;
    this.stream.abort();
    for (const c of this.inflight) c.abort();
    this.ready?.reject(reason);
    this.handlers.closed(reason);
  }
}

// --------------------------------------------------------------- helpers

/** Splits streamed text into lines (\n, \r\n or \r) without rescanning what it has already seen. */
class Lines {
  private onLine: (line: string) => void;
  private parts: string[] = [];
  private size = 0;
  /** The last chunk ended in \r: a \n starting the next one belongs to the same break. */
  private cr = false;

  constructor(onLine: (line: string) => void) {
    this.onLine = onLine;
  }

  get pending(): number {
    return this.size;
  }

  push(chunk: string): void {
    let start = this.cr && chunk.startsWith("\n") ? 1 : 0;
    this.cr = false;
    const re = /\r\n|\r|\n/g;
    re.lastIndex = start;
    let m: RegExpExecArray | null;
    while ((m = re.exec(chunk))) {
      this.emit(chunk.slice(start, m.index));
      start = m.index + m[0].length;
      if (m[0] === "\r" && start === chunk.length) this.cr = true;
    }
    if (start < chunk.length) {
      this.parts.push(chunk.slice(start));
      this.size += chunk.length - start;
    }
  }

  flush(): void {
    if (this.parts.length) this.emit("");
  }

  private emit(tail: string): void {
    const line = this.parts.length ? this.parts.join("") + tail : tail;
    this.parts = [];
    this.size = 0;
    this.onLine(line);
  }
}

interface SseEvent {
  event: string;
  data: string;
}

/** Read a text/event-stream body until it ends, or until `onEvent` returns true. */
async function readSse(body: ReadableStream<Uint8Array>, onEvent: (ev: SseEvent) => boolean): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let event = "";
  let data: string[] = [];
  let stop = false;
  const lines = new Lines((line) => {
    if (stop) return;
    if (line === "") {
      if (data.length) stop = onEvent({ event: event || "message", data: data.join("\n") });
      event = "";
      data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? "" : line.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  });
  try {
    while (!stop) {
      const { value, done } = await reader.read();
      if (done) {
        lines.push(decoder.decode());
        lines.flush();
        if (!stop && data.length) onEvent({ event: event || "message", data: data.join("\n") });
        break;
      }
      lines.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    if (stop) await reader.cancel().catch(() => {});
    else reader.releaseLock();
  }
}

/** Does this message (or batch) carry the answer to request `id`? */
function answers(msg: unknown, id: unknown): boolean {
  const one = (m: any) => m && typeof m === "object" && typeof m.method !== "string" && m.id === id && ("result" in m || "error" in m);
  return Array.isArray(msg) ? msg.some(one) : one(msg);
}

function buildHeaders(user: Record<string, string>, own: Record<string, string>): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(user)) {
    try {
      h.set(k, String(v));
    } catch {
      // Never echo the value: it is usually a credential.
      throw new McpError(`the header "${oneLine(k, 60)}" is not valid`);
    }
  }
  for (const [k, v] of Object.entries(own)) h.set(k, v);
  return h;
}

/** An abort controller for one request, also aborted by `signal`, tracked so close() can cancel it. */
function track(set: Set<AbortController>, signal?: AbortSignal): AbortController {
  const ctrl = new AbortController();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  set.add(ctrl);
  return ctrl;
}

async function httpError(res: Response): Promise<McpError> {
  let body = "";
  try {
    body = (await res.text()).slice(0, 4000);
  } catch {
    // no body
  }
  let detail = "";
  const parsed = parseJson(body) as any;
  if (parsed && typeof parsed === "object") {
    const m = parsed.error?.message ?? parsed.error_description ?? parsed.message ?? (typeof parsed.error === "string" ? parsed.error : undefined);
    if (typeof m === "string") detail = m;
  } else if (!(res.headers.get("content-type") ?? "").includes("html")) detail = body;
  const hint = res.status === 401 || res.status === 403 ? " (check the connector's token or headers)" : "";
  return new McpError(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}${hint}`, { detail: oneLine(detail, 300) || undefined, status: res.status });
}

async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {});
}

/** The cause's code (ECONNREFUSED, ENOTFOUND, …); fetch's own messages are vague, and URLs may hold tokens. */
function networkDetail(err: unknown): string | undefined {
  const e = err as any;
  const code = e?.cause?.code ?? e?.code;
  if (typeof code === "string") return code;
  const name = e?.cause?.name ?? e?.name;
  return typeof name === "string" && name !== "TypeError" && name !== "Error" ? name : undefined;
}

function parseUrl(raw: string | undefined): URL {
  if (!raw?.trim()) throw new McpError("no URL is configured");
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new McpError("its URL is not valid");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new McpError("its URL must start with http:// or https://");
  return u;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asMcpError(err: unknown): McpError {
  if (err instanceof McpError) return err;
  return new McpError(oneLine(String((err as any)?.message ?? err ?? "unknown error"), 300));
}

function seconds(ms: number): string {
  return ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    p.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** A stable hash of the spec: same servers in a different key order are the same server. */
function specKey(spec: McpServerSpec): string {
  return createHash("sha256").update(stableJson(spec)).digest("hex");
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableJson(x)}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

const SECRETISH = /key|token|secret|passw|auth|cred|cookie|session|private|signature|bearer/i;
const PLAIN_HEADERS = new Set(["accept", "accept-language", "cache-control", "content-type", "mcp-protocol-version", "user-agent"]);

/**
 * Values that must not reach a notice or the model: the connector's header
 * values (and their parts, so "Bearer <token>" also hides a bare token), its
 * env values that look like credentials, URL passwords and token-like query
 * values, and credential-looking variables from the inherited environment.
 */
function secretValues(spec: McpServerSpec, inherited?: NodeJS.ProcessEnv): string[] {
  const out = new Set<string>();
  const add = (v: unknown, min: number) => {
    if (typeof v === "string" && v.trim().length >= min) out.add(v.trim());
  };
  for (const [k, v] of Object.entries(spec.headers ?? {})) {
    if (PLAIN_HEADERS.has(k.toLowerCase())) continue;
    add(v, 6);
    for (const piece of String(v).split(/[\s,;]+/)) add(piece, 8);
  }
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    if (SECRETISH.test(k)) add(v, 4);
    else if (typeof v === "string" && v.length >= 20 && !/[\s/\\]/.test(v)) add(v, 20);
  }
  // Paths (SSH_AUTH_SOCK, XAUTHORITY, …) match the names but aren't secrets.
  if (inherited) for (const [k, v] of Object.entries(inherited)) if (SECRETISH.test(k) && !/^(\/|~|unix:)/.test(v ?? "")) add(v, 8);
  if (spec.url) {
    try {
      const u = new URL(spec.url);
      add(u.password, 4);
      add(decodeURIComponent(u.password), 4);
      for (const [k, v] of u.searchParams) if (SECRETISH.test(k) || v.length >= 16) add(v, 4);
    } catch {
      // not a URL; parseUrl reports it
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}
