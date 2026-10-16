import * as http from "node:http";
import type { AddressInfo, Socket } from "node:net";

/**
 * A scripted OpenAI-compatible server for the runtime tests. Each request is
 * recorded (method, path, headers, parsed JSON body) and answered by the next
 * queued handler (or the fallback). SSE replies are written in small pieces,
 * with CRLF line ends and ":" comment lines when asked, to exercise the
 * client's stream parsing.
 */

export interface Recorded {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

export type Handler = (req: Recorded, res: http.ServerResponse) => void | Promise<void>;

export class FakeOpenAI {
  url = "";
  readonly requests: Recorded[] = [];
  /** The most requests to /chat/completions seen open at once. */
  maxInFlight = 0;
  /** Chat requests the client closed before the reply finished. */
  aborted = 0;
  fallback?: Handler;
  private queue: Handler[] = [];
  private open = new Set<object>();
  /** Bumped by reset(), so connections left over from an earlier test don't count. */
  private generation = 0;
  private server?: http.Server;
  private sockets = new Set<Socket>();

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.server.on("connection", (s) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
    return this;
  }

  /** Queue handlers for the next requests, in order. */
  push(...handlers: Handler[]): void {
    this.queue.push(...handlers);
  }

  /** Requests to /chat/completions currently open. */
  get inFlight(): number {
    return this.open.size;
  }

  get pending(): number {
    return this.queue.length;
  }

  chats(): Recorded[] {
    return this.requests.filter((r) => r.path.endsWith("/chat/completions"));
  }

  reset(): void {
    this.requests.length = 0;
    this.queue.length = 0;
    this.open.clear();
    this.generation++;
    this.maxInFlight = 0;
    this.aborted = 0;
    this.fallback = undefined;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: any;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const rec: Recorded = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body };
    this.requests.push(rec);
    const chat = rec.path.split("?")[0]!.endsWith("/chat/completions");
    if (chat) {
      const gen = this.generation;
      const token = {};
      this.open.add(token);
      this.maxInFlight = Math.max(this.maxInFlight, this.open.size);
      res.on("close", () => {
        this.open.delete(token);
        if (gen === this.generation && !res.writableFinished) this.aborted++;
      });
    }
    const h = this.queue.shift() ?? this.fallback;
    try {
      if (!h) json(res, 500, { error: { message: `no scripted reply for ${rec.method} ${rec.path}` } });
      else await h(rec, res);
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: { message: String(err) } });
      else res.destroy();
    }
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }
}

export function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const tick = () => new Promise<void>((r) => setImmediate(r));

export interface SseOptions {
  /** Write the stream in pieces of this many characters (default 7), so lines and JSON split across reads. */
  split?: number;
  crlf?: boolean;
  /** Add ": keep-alive" comment lines. */
  comments?: boolean;
  /** Send "data: [DONE]" at the end (default true). */
  done?: boolean;
  headers?: Record<string, string>;
  /** Stop after this many characters and reset the connection (a mid-stream failure). */
  resetAfter?: number;
  /** Called after each piece is written; return a promise to pause the stream there. */
  onPiece?: (i: number, written: string) => void | Promise<void>;
}

export function sseText(chunks: Array<object | string>, opts: SseOptions = {}): string {
  const nl = opts.crlf ? "\r\n" : "\n";
  let out = opts.comments ? `: OPENROUTER PROCESSING${nl}${nl}` : "";
  for (const c of chunks) {
    if (opts.comments) out += `: keep-alive${nl}`;
    out += `data: ${typeof c === "string" ? c : JSON.stringify(c)}${nl}${nl}`;
  }
  if (opts.done !== false) out += `data: [DONE]${nl}${nl}`;
  return out;
}

/** Answer with an SSE stream of these chunks. */
export async function sse(res: http.ServerResponse, chunks: Array<object | string>, opts: SseOptions = {}): Promise<void> {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...opts.headers });
  const text = sseText(chunks, opts);
  const size = Math.max(1, opts.split ?? 7);
  let written = "";
  for (let i = 0, n = 0; i < text.length; i += size, n++) {
    if (opts.resetAfter !== undefined && i >= opts.resetAfter) {
      res.socket?.destroy();
      return;
    }
    const piece = text.slice(i, i + size);
    res.write(piece);
    written += piece;
    await opts.onPiece?.(n, written);
    await tick();
  }
  res.end();
}

/** Keep the request open until the client goes away; resolves then. */
export function hold(res: http.ServerResponse, firstChunks: Array<object> = []): Promise<void> {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const c of firstChunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  return new Promise((r) => res.on("close", () => r()));
}

// ---------------------------------------------------------------- chunk builders

export function delta(d: object, model = "test-model-2024"): object {
  return { id: "chatcmpl-1", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: d, finish_reason: null }] };
}

export function finish(reason: string, model = "test-model-2024"): object {
  return { id: "chatcmpl-1", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: reason }] };
}

export function usage(prompt: number, completion: number): object {
  return { id: "chatcmpl-1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } };
}

/** A streamed text reply: word by word, then stop (and a usage chunk if given). */
export function textReply(text: string, o: { usage?: [number, number]; model?: string } = {}): object[] {
  const out: object[] = [delta({ role: "assistant", content: "" }, o.model)];
  for (const piece of text.match(/\S+\s*|\s+/g) ?? []) out.push(delta({ content: piece }, o.model));
  out.push(finish("stop", o.model));
  if (o.usage) out.push(usage(o.usage[0], o.usage[1]));
  return out;
}

/** Streamed tool calls: id and name first, the arguments in fragments of `size` characters. */
export function toolCallReply(calls: Array<{ id?: string; name: string; args: string }>, o: { size?: number; text?: string; finish?: string } = {}): object[] {
  const out: object[] = [delta({ role: "assistant", content: o.text ?? null })];
  calls.forEach((c, index) => out.push(delta({ tool_calls: [{ index, id: c.id, type: "function", function: { name: c.name, arguments: "" } }] })));
  const size = o.size ?? 4;
  const longest = Math.max(...calls.map((c) => c.args.length));
  // Interleave the fragments of parallel calls, as servers do.
  for (let at = 0; at < longest; at += size) {
    calls.forEach((c, index) => {
      const part = c.args.slice(at, at + size);
      if (part) out.push(delta({ tool_calls: [{ index, function: { arguments: part } }] }));
    });
  }
  out.push(finish(o.finish ?? "tool_calls"));
  return out;
}

/** A whole (non-streamed) chat completion. */
export function completion(content: string, o: { usage?: [number, number]; model?: string } = {}): object {
  return {
    id: "chatcmpl-x",
    object: "chat.completion",
    model: o.model ?? "test-model-2024",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: o.usage ? { prompt_tokens: o.usage[0], completion_tokens: o.usage[1], total_tokens: o.usage[0] + o.usage[1] } : undefined,
  };
}
