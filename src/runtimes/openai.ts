import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelChoice, ProviderConfig, ProviderModel, ToolMode } from "../core/types.ts";
import { isLocalHost } from "../core/providers.ts";
import { writeFileAtomic } from "../core/util.ts";
import type {
  AgentRuntime,
  BoundTool,
  RunOutcome,
  RuntimeEvent,
  RuntimeModel,
  RuntimeProvides,
  RuntimeRun,
  RuntimeSession,
  SendInput,
  SessionSpec,
  ToolOutput,
} from "./types.ts";

/*
 * The OpenAI-compatible runtime: a bot brain on any chat-completions API
 * (Featherless, OpenRouter, xAI, Groq, Together, Ollama, LM Studio, vLLM...).
 *
 * A model API only does "messages in, text or tool calls out", so this file
 * runs the agent loop itself:
 *
 *   send() ─► append the user message to the transcript (state/agents/<id>.jsonl)
 *          └► loop: fit the context ─► POST /chat/completions (streamed) ─► run the
 *             tool calls in order ─► append results ─► repeat until a plain answer
 *
 * The harness supplies everything else as tools and a system prompt
 * (SendInput.tools / SendInput.system), so approvals and protected paths are
 * enforced by the tools themselves, not here.
 *
 * Providers differ in small ways that break naive clients (see
 * docs/ARCHITECTURE.md §9): where reasoning arrives, how tool calls stream,
 * which request fields they accept, what their errors look like. The parsing
 * below is deliberately tolerant, and what it learns about a model (text tool
 * calls, a rejected parameter, a smaller context window) is remembered for the
 * life of this runtime instance.
 */

export interface OpenAICompatOptions {
  /** Live provider config: read on every request, so edits apply at once. */
  provider: () => ProviderConfig;
  /** The provider's API key (undefined: none stored). Read on every request. */
  apiKey: () => string | undefined;
  /** Transcripts live at <transcriptDir>/<agentId>.jsonl (the harness passes state/agents). */
  transcriptDir: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** Injectable backoff sleep for tests; resolves early when the signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Attribution headers some providers ask for (HTTP-Referer / X-Title). */
  appName?: string;
  appUrl?: string;
  /** Give up on a request whose response hasn't started after this long (default 3 minutes). */
  firstByteTimeoutMs?: number;
  /** Give up on a reply that sends nothing for this long (default 2 minutes). */
  idleTimeoutMs?: number;
}

// ------------------------------------------------------------------ limits and defaults

const DEFAULT_CONTEXT_WINDOW = 32_768;
const DEFAULT_MAX_OUTPUT = 8192;
const MIN_REPLY_TOKENS = 256;
const CHARS_PER_TOKEN = 3.5;
const MESSAGE_OVERHEAD_TOKENS = 4;
const IMAGE_TOKENS = 1000;
const TOOL_RESULT_MAX_CHARS = 20_000;
const MAX_MODEL_CALLS_PER_TURN = 100;
const COMPLETE_MAX_TOKENS = 1024;
const COMPLETE_TIMEOUT_MS = 120_000;
const MAX_CATALOG = 5000;
const COLD_WAIT_MAX_MS = 10 * 60_000;
const MAX_RETRY_WAIT_MS = 120_000;
/** Above this share of the window at the end of a turn, older history is summarized. */
const END_OF_TURN_COMPACT_AT = 0.6;
/** Prompt plus reply reserve must stay under this share of the window. */
const REQUEST_BUDGET = 0.9;
const SUMMARY_ACK = "Understood. I have the summary of our earlier conversation and will carry on from there.";

// ------------------------------------------------------------------ transcript format

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** One transcript entry: an OpenAI chat message as stored (one JSON object per line). */
export interface TranscriptMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string;
}

type Image = { data: string; mimeType: string };
type WirePart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | WirePart[];
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  [extra: string]: unknown;
}
interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}
/** How tools reach the model on one request. */
type WireMode = "native" | "prompt" | "none";

const ROLES = new Set(["user", "assistant", "tool"]);

function contentToText(c: unknown): string {
  if (typeof c === "string") return c;
  if (c === null || c === undefined) return "";
  if (Array.isArray(c)) {
    let images = 0;
    const texts: string[] = [];
    for (const p of c) {
      if (p?.type === "text" && typeof p.text === "string") texts.push(p.text);
      else if (p?.type === "image_url" || p?.type === "image") images++;
    }
    if (images) texts.push(`[${images} ${images === 1 ? "image" : "images"} attached]`);
    return texts.join("\n\n");
  }
  return String(c);
}

function normalizeStored(v: any): TranscriptMessage | undefined {
  if (!v || typeof v !== "object" || !ROLES.has(v.role)) return undefined;
  const m: TranscriptMessage = { role: v.role, content: contentToText(v.content) };
  if (v.role === "assistant" && Array.isArray(v.tool_calls)) {
    const calls: ChatToolCall[] = [];
    for (const c of v.tool_calls) {
      if (typeof c?.id !== "string" || typeof c?.function?.name !== "string") continue;
      const a = c.function.arguments;
      calls.push({ id: c.id, type: "function", function: { name: c.function.name, arguments: typeof a === "string" ? a : JSON.stringify(a ?? {}) } });
    }
    if (calls.length) m.tool_calls = calls;
  }
  if (v.role === "tool") {
    if (typeof v.tool_call_id !== "string") return undefined;
    m.tool_call_id = v.tool_call_id;
  }
  if (typeof v.name === "string" && v.name) m.name = v.name;
  if (typeof v.reasoning_content === "string" && v.reasoning_content) m.reasoning_content = v.reasoning_content;
  return m;
}

function serialize(m: TranscriptMessage): string {
  const o: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.tool_calls?.length) o.tool_calls = m.tool_calls;
  if (m.tool_call_id) o.tool_call_id = m.tool_call_id;
  if (m.name) o.name = m.name;
  if (m.reasoning_content) o.reasoning_content = m.reasoning_content;
  return JSON.stringify(o);
}

/**
 * Every assistant tool call must be followed by exactly one result, or most
 * servers reject the next request. Drops orphan results and adds a stand-in
 * result for each call that has none (a crash or a stop mid-round).
 */
export function repairToolPairs(list: TranscriptMessage[]): { messages: TranscriptMessage[]; changed: boolean } {
  const out: TranscriptMessage[] = [];
  let changed = false;
  for (let i = 0; i < list.length; i++) {
    const m = list[i]!;
    if (m.role === "tool") {
      changed = true; // a result with no call right before it
      continue;
    }
    out.push(m);
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    const ids = new Set(m.tool_calls.map((c) => c.id));
    const seen = new Set<string>();
    let j = i + 1;
    for (; j < list.length && list[j]!.role === "tool"; j++) {
      const t = list[j]!;
      if (t.tool_call_id && ids.has(t.tool_call_id) && !seen.has(t.tool_call_id)) {
        seen.add(t.tool_call_id);
        out.push(t);
      } else {
        changed = true;
      }
    }
    for (const c of m.tool_calls) {
      if (seen.has(c.id)) continue;
      out.push({ role: "tool", tool_call_id: c.id, name: c.function.name, content: "(No result: the turn ended before this tool finished.)" });
      changed = true;
    }
    i = j - 1;
  }
  return { messages: out, changed };
}

/** A bot's conversation with the model: one JSONL file, appended to, rewritten only after compaction. */
class Transcript {
  readonly file: string;
  messages: TranscriptMessage[] = [];

  constructor(file: string) {
    this.file = file;
  }

  load(): void {
    const raw = fs.readFileSync(this.file, "utf8");
    // Start the next append on a fresh line, or it would fuse with a torn tail and be lost too.
    if (raw.length && !raw.endsWith("\n")) fs.appendFileSync(this.file, "\n");
    const list: TranscriptMessage[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const m = normalizeStored(JSON.parse(line));
        if (m) list.push(m);
      } catch {
        // A torn last line after a crash is skipped rather than fatal.
      }
    }
    const fixed = repairToolPairs(list);
    this.messages = fixed.messages;
    if (fixed.changed) this.rewrite();
  }

  append(m: TranscriptMessage): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, serialize(m) + "\n", { mode: 0o600 });
    this.messages.push(m);
  }

  replace(list: TranscriptMessage[]): void {
    this.messages = list;
    this.rewrite();
  }

  rewrite(): void {
    writeFileAtomic(this.file, this.messages.map((m) => serialize(m) + "\n").join(""));
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      // Not fatal (some filesystems have no modes).
    }
  }

  /** Give every call of a trailing tool round a result (after a stop or an error). */
  closeOpenCalls(text: string): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]!;
      if (m.role === "tool") continue;
      if (m.role !== "assistant" || !m.tool_calls?.length) return;
      const done = new Set(this.messages.slice(i + 1).map((t) => t.tool_call_id));
      for (const c of m.tool_calls) if (!done.has(c.id)) this.append({ role: "tool", tool_call_id: c.id, name: c.function.name, content: text });
      return;
    }
  }
}

// ------------------------------------------------------------------ concurrency

/**
 * A FIFO semaphore counting units, not requests: Featherless plans have a
 * budget of concurrency units and each request reserves its model's cost.
 * One per runtime instance, shared by every session, complete() and summaries.
 */
export class UnitSemaphore {
  private used = 0;
  private capacity: () => number;
  private waiters: Array<{ cost: number; grant: (cost: number) => void; fail: (err: unknown) => void; signal?: AbortSignal; onAbort?: () => void }> = [];

  constructor(capacity: () => number) {
    this.capacity = capacity;
  }

  get inUse(): number {
    return this.used;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  private cap(): number {
    return Math.max(1, Math.floor(this.capacity()) || 1);
  }

  /** Reserve `cost` units (clamped to the capacity); resolves with a release function. */
  async acquire(cost: number, signal?: AbortSignal, onWait?: (info: { used: number; capacity: number; ahead: number }) => void): Promise<() => void> {
    if (signal?.aborted) throw abortError();
    // The capacity is read live: a raised limit lets waiters in now.
    this.pump();
    const want = Math.max(1, Math.round(cost) || 1);
    const cap = this.cap();
    if (!this.waiters.length && this.used + Math.min(want, cap) <= cap) return this.take(Math.min(want, cap));
    onWait?.({ used: this.used, capacity: cap, ahead: this.waiters.length });
    const granted = await new Promise<number>((grant, fail) => {
      const w: (typeof this.waiters)[number] = { cost: want, grant, fail, signal };
      w.onAbort = () => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        fail(abortError());
        this.pump();
      };
      signal?.addEventListener("abort", w.onAbort, { once: true });
      this.waiters.push(w);
    });
    return this.releaser(granted);
  }

  private take(cost: number): () => void {
    this.used += cost;
    return this.releaser(cost);
  }

  private releaser(cost: number): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used -= cost;
      this.pump();
    };
  }

  private pump(): void {
    const cap = this.cap();
    // Strict FIFO: a big request at the front isn't starved by small ones behind it.
    while (this.waiters.length) {
      const w = this.waiters[0]!;
      const cost = Math.min(w.cost, cap);
      if (this.used + cost > cap) break;
      this.waiters.shift();
      if (w.onAbort) w.signal?.removeEventListener("abort", w.onAbort);
      this.used += cost;
      w.grant(cost);
    }
  }
}

// ------------------------------------------------------------------ errors

export type ProviderErrorKind =
  | "auth"
  | "forbidden"
  | "notfound"
  | "billing"
  | "rate"
  | "cold"
  | "unavailable"
  | "transient"
  | "network"
  | "timeout"
  | "context"
  | "tools"
  | "param"
  | "system_role"
  | "fatal";

export class ProviderError extends Error {
  kind: ProviderErrorKind;
  status?: number;
  retryAfterMs?: number;
  /** For "param": the request field the server rejected. */
  param?: string;
  /** The provider's own message, cleaned (no key, one line). */
  detail: string;
  /** Text or thinking had already streamed when this happened, so it isn't retried silently. */
  emitted = false;

  constructor(kind: ProviderErrorKind, message: string, extra: { status?: number; retryAfterMs?: number; param?: string; detail?: string } = {}) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = extra.status;
    this.retryAfterMs = extra.retryAfterMs;
    this.param = extra.param;
    this.detail = extra.detail ?? "";
  }
}

function abortError(): Error {
  const e = new Error("cancelled");
  e.name = "AbortError";
  return e;
}

function isAbortError(e: unknown): boolean {
  return (e as any)?.name === "AbortError";
}

const CONTEXT_RE =
  /context_length_exceeded|exceed_context_size|context length|context window|context size|maximum context|exceeds the available context|larger than the max context|reduce the length|too many tokens|prompt is too long|input is too long|prompt too long|maximum prompt length|max_model_len/;
const TOOLS_RE =
  /does not support tools|doesn'?t support tools|tools? (?:is|are) not supported|tool[_ ]use is not supported|tool calling is not supported|function calling is not supported|does not support function|enable-auto-tool-choice|"auto" tool choice|tool[_ ]choice.{0,40}not supported|tools? not supported|not support tool/;
const COLD_RE = /\bcold\b|not ready|warming|warm(?:ing)? up|loading model|model is loading|is being loaded|still loading|currently loading|not (?:yet )?loaded|model loading/;
const BILLING_RE =
  /insufficient_quota|credit_balance|insufficient (?:credit|balance|fund|quota)|out of credits|no credits|payment required|exceeded your current quota|billing|spend limit/;
const PARAM_RE = /unsupported|not supported|unknown|unrecogni[sz]ed|extra (?:inputs|fields|parameters)|not permitted|not allowed|invalid|unexpected|is not a valid/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The request field an error message complains about (the earliest one named). */
function rejectedParam(text: string, candidates: string[]): string | undefined {
  if (!PARAM_RE.test(text)) return undefined;
  let best: { k: string; i: number } | undefined;
  for (const k of candidates) {
    const m = new RegExp(`(^|[^a-z0-9_])${escapeRe(k.toLowerCase())}($|[^a-z0-9_])`).exec(text);
    if (m && (!best || m.index < best.i)) best = { k, i: m.index };
  }
  return best?.k;
}

/**
 * What an error means for the loop (section F of the provider research):
 * retry, back off, compact, switch tool mode, drop a parameter, or stop.
 * `status` is undefined for error frames inside a stream.
 */
export function classifyError(status: number | undefined, text: string, candidates: string[] = []): { kind: ProviderErrorKind; param?: string } {
  const t = text.toLowerCase();
  const s = status ?? 0;
  if ((!s || [400, 403, 413, 422, 500].includes(s)) && CONTEXT_RE.test(t)) return { kind: "context" };
  if ((!s || [400, 404, 422, 500].includes(s)) && TOOLS_RE.test(t)) return { kind: "tools" };
  if ((s === 400 || s === 422) && /system role|system messages? (?:is |are )?not (?:supported|allowed)/.test(t)) return { kind: "system_role" };
  // Groq: the model produced a malformed tool call; another try usually works.
  if (s === 400 && /tool_use_failed/.test(t)) return { kind: "transient" };
  if (s === 400 || s === 422) {
    const param = rejectedParam(t, candidates);
    if (param === "tools") return { kind: "tools" };
    if (param) return { kind: "param", param };
  }
  if (s === 401) return { kind: "auth" };
  if (s === 402 || ((s === 429 || s === 403 || s === 400) && BILLING_RE.test(t))) return { kind: "billing" };
  if (s === 403) return { kind: "forbidden" };
  if (s === 404) return { kind: "notfound" };
  if (s === 429 || s === 498 || (s !== 400 && /engine_overloaded|rate[_ ]limit|too many requests/.test(t))) return { kind: "rate" };
  if ((s === 400 || s === 503 || s === 409 || s === 425 || !s) && COLD_RE.test(t)) return { kind: "cold" };
  if (s === 503) return { kind: "unavailable" };
  if ([408, 409, 425, 500, 502, 504, 520, 521, 522, 523, 524, 525, 526, 527, 529].includes(s)) return { kind: "transient" };
  return { kind: "fatal" };
}

function parseDuration(v: string): number | undefined {
  const s = v.trim();
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const n = Number(s);
    // An epoch timestamp rather than a delay.
    if (n > 1e9) return Math.max(0, n * 1000 - Date.now());
    return n * 1000;
  }
  let total = 0;
  let matched = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === "ms" ? n : m[2] === "s" ? n * 1000 : m[2] === "m" ? n * 60_000 : n * 3_600_000;
  }
  return matched ? total : undefined;
}

/** How long a server asked us to wait: Retry-After (seconds or a date), retry-after-ms, x-ratelimit-reset-*. */
export function retryAfterMs(h: Headers): number | undefined {
  const ra = h.get("retry-after");
  if (ra) {
    const n = Number(ra);
    if (Number.isFinite(n) && n >= 0) return n * 1000;
    const d = Date.parse(ra);
    if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
  }
  const ms = Number(h.get("retry-after-ms") ?? NaN);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  for (const k of ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens", "x-ratelimit-reset"]) {
    const v = h.get(k);
    const d = v ? parseDuration(v) : undefined;
    if (d !== undefined) return d;
  }
  return undefined;
}

// ------------------------------------------------------------------ streaming

/** Server-sent events, tolerant of split chunks, CRLF, comments and missing blank lines. */
export class SseParser {
  private buf = "";
  private data: string[] = [];
  private event = "";

  push(text: string): Array<{ event: string; data: string }> {
    const out: Array<{ event: string; data: string }> = [];
    const buf = this.buf + text;
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      const ch = buf.charCodeAt(i);
      if (ch !== 10 && ch !== 13) continue;
      // A CR at the very end may be the first half of a CRLF split across chunks.
      if (ch === 13 && i === buf.length - 1) break;
      this.line(buf.slice(start, i), out);
      if (ch === 13 && buf.charCodeAt(i + 1) === 10) i++;
      start = i + 1;
    }
    this.buf = buf.slice(start);
    return out;
  }

  end(): Array<{ event: string; data: string }> {
    const out: Array<{ event: string; data: string }> = [];
    if (this.buf) this.line(this.buf.replace(/\r$/, ""), out);
    this.buf = "";
    this.dispatch(out);
    return out;
  }

  private line(line: string, out: Array<{ event: string; data: string }>): void {
    if (!line) return this.dispatch(out);
    if (line.startsWith(":")) return; // comment / keep-alive
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? "" : line.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
  }

  private dispatch(out: Array<{ event: string; data: string }>): void {
    if (this.data.length) out.push({ event: this.event || "message", data: this.data.join("\n") });
    this.data = [];
    this.event = "";
  }
}

function findFirst(s: string, tags: string[]): { index: number; tag: string } | undefined {
  let best: { index: number; tag: string } | undefined;
  for (const tag of tags) {
    const i = s.indexOf(tag);
    if (i >= 0 && (!best || i < best.index)) best = { index: i, tag };
  }
  return best;
}

/** Length of the longest tail of `s` that could be the start of one of the tags. */
function partialTail(s: string, tags: string[]): number {
  let keep = 0;
  for (const tag of tags) {
    for (let k = Math.min(tag.length - 1, s.length); k > keep; k--) {
      if (s.endsWith(tag.slice(0, k))) {
        keep = k;
        break;
      }
    }
  }
  return keep;
}

const THINK_OPEN = ["<think>", "<thought>"];
const THINK_CLOSE = ["</think>", "</thought>"];

/**
 * Splits streamed content into reply text and reasoning written inline as
 * <think>…</think> (tags may be split across chunks). A lone </think> means
 * the chat template opened the block in the prompt (Qwen3/R1 style): what came
 * before it was reasoning, and `reset` says so.
 */
export class ThinkFilter {
  private inThink: boolean;
  private implicit: boolean;
  private buf = "";
  private implicitText = "";

  /** `startInThink`: the model is known to start its replies inside an unopened think block. */
  constructor(startInThink = false) {
    this.inThink = startInThink;
    this.implicit = startInThink;
  }

  push(chunk: string): { text: string; thinking: string; reset: boolean } {
    let buf = this.buf + chunk;
    let text = "";
    let thinking = "";
    let reset = false;
    for (;;) {
      if (this.inThink) {
        const close = findFirst(buf, THINK_CLOSE);
        if (close) {
          thinking += buf.slice(0, close.index);
          buf = buf.slice(close.index + close.tag.length);
          this.inThink = false;
          this.implicit = false;
          this.implicitText = "";
          continue;
        }
        const keep = partialTail(buf, THINK_CLOSE);
        thinking += buf.slice(0, buf.length - keep);
        buf = buf.slice(buf.length - keep);
        break;
      }
      const open = findFirst(buf, THINK_OPEN);
      const close = findFirst(buf, THINK_CLOSE);
      if (close && (!open || close.index < open.index)) {
        thinking += text + buf.slice(0, close.index);
        text = "";
        reset = true;
        buf = buf.slice(close.index + close.tag.length);
        continue;
      }
      if (open) {
        text += buf.slice(0, open.index);
        buf = buf.slice(open.index + open.tag.length);
        this.inThink = true;
        continue;
      }
      const keep = partialTail(buf, [...THINK_OPEN, ...THINK_CLOSE]);
      text += buf.slice(0, buf.length - keep);
      buf = buf.slice(buf.length - keep);
      break;
    }
    this.buf = buf;
    thinking = thinking.replace(/<think>|<thought>/g, "");
    if (this.implicit) this.implicitText += thinking;
    return { text, thinking, reset };
  }

  /** End of the reply. `toText` is "reasoning" that was the reply after all (an implicit block that never closed). */
  end(): { text: string; thinking: string; toText?: string } {
    const rest = this.buf;
    this.buf = "";
    if (this.inThink && this.implicit) {
      const all = this.implicitText + rest;
      this.implicitText = "";
      this.inThink = false;
      return { text: "", thinking: "", toText: all };
    }
    if (this.inThink) return { text: "", thinking: rest };
    return { text: rest, thinking: "" };
  }
}

/** Tool-call markup models write into their text (Hermes/Qwen, LM Studio, Qwen3-Coder), hidden from the streamed reply. */
const MARKUP: Array<[string, string]> = [
  ["<tool_call>", "</tool_call>"],
  ["[TOOL_REQUEST]", "[END_TOOL_REQUEST]"],
  ["<function=", "</function>"],
  ["<tool_response", "</tool_response>"],
];
const MARKUP_OPEN = MARKUP.map((m) => m[0]);

export class MarkupHider {
  private buf = "";
  private close?: string;

  push(chunk: string): string {
    let buf = this.buf + chunk;
    let out = "";
    for (;;) {
      if (this.close) {
        const i = buf.indexOf(this.close);
        if (i < 0) {
          const keep = partialTail(buf, [this.close]);
          buf = buf.slice(buf.length - keep);
          break;
        }
        buf = buf.slice(i + this.close.length);
        this.close = undefined;
        continue;
      }
      const open = findFirst(buf, MARKUP_OPEN);
      if (open) {
        out += buf.slice(0, open.index);
        buf = buf.slice(open.index + open.tag.length);
        this.close = MARKUP.find((m) => m[0] === open.tag)![1];
        continue;
      }
      const keep = partialTail(buf, MARKUP_OPEN);
      out += buf.slice(0, buf.length - keep);
      buf = buf.slice(buf.length - keep);
      break;
    }
    this.buf = buf;
    return out;
  }

  end(): string {
    const rest = this.close ? "" : this.buf;
    this.reset();
    return rest;
  }

  reset(): void {
    this.buf = "";
    this.close = undefined;
  }
}

// ------------------------------------------------------------------ tool calls in text

export interface TextToolCall {
  name: string;
  /** Arguments as JSON text (validated later). */
  args: string;
  /** Set when the block couldn't be read at all: the message for the model. */
  malformed?: string;
}

function stripFences(s: string): string {
  const m = /^```[\w-]*[ \t]*\n?([\s\S]*?)\n?```$/.exec(s.trim());
  return m ? m[1]!.trim() : s;
}

/** The first balanced {...} in s (string-aware), or undefined. */
function firstJsonObject(s: string): string | undefined {
  const start = s.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return s.slice(start, i + 1);
  }
  return undefined;
}

function excerpt(s: string, max = 200): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function callFromObject(o: any): TextToolCall | undefined {
  if (!o || typeof o !== "object" || Array.isArray(o)) return undefined;
  const fn = o.function && typeof o.function === "object" ? o.function : undefined;
  const name = [o.name, fn?.name, typeof o.function === "string" ? o.function : undefined, o.tool, o.tool_name, o.toolName].find(
    (x) => typeof x === "string" && x.trim(),
  ) as string | undefined;
  if (!name) return undefined;
  const a = o.arguments ?? o.parameters ?? o.args ?? o.input ?? fn?.arguments ?? fn?.parameters ?? {};
  return { name: name.trim(), args: typeof a === "string" ? a : JSON.stringify(a) };
}

function xmlValue(raw: string): unknown {
  const v = raw.replace(/^\n/, "").replace(/\n$/, "");
  const t = v.trim();
  if (/^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\{[\s\S]*\}|\[[\s\S]*\])$/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      // Not JSON after all: keep the text.
    }
  }
  return v;
}

/** <function=name>{json}</function> or <function=name><parameter=x>value</parameter></function> (Qwen3-Coder). */
function parseFunctionBlock(name: string, body: string): TextToolCall[] {
  const params = [...body.matchAll(/<parameter=([^>\s]+)>([\s\S]*?)(?:<\/parameter>|(?=<parameter=)|$)/g)];
  if (params.length) {
    const args: Record<string, unknown> = {};
    for (const p of params) args[p[1]!] = xmlValue(p[2]!);
    return [{ name, args: JSON.stringify(args) }];
  }
  return [{ name, args: stripFences(body.trim()) || "{}" }];
}

function parseCallBody(body: string): TextToolCall[] {
  const inner = /<function=([^>\s]+)>([\s\S]*?)(?:<\/function>|$)/.exec(body);
  if (inner) return parseFunctionBlock(inner[1]!, inner[2]!);
  const s = stripFences(body.trim());
  if (!s) return [];
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    const obj = firstJsonObject(s);
    if (obj) {
      try {
        v = JSON.parse(obj);
      } catch {
        // Broken JSON: handled below.
      }
    }
  }
  if (v === undefined) {
    // The model named a tool but its JSON is broken: let the argument check tell it so.
    const name = /"name"\s*:\s*"([^"]+)"/.exec(s)?.[1];
    return name ? [{ name, args: s }] : [];
  }
  const out: TextToolCall[] = [];
  for (const item of Array.isArray(v) ? v : [v]) {
    const c = callFromObject(item);
    if (c) out.push(c);
  }
  return out;
}

/** A reply that is nothing but a call written as bare JSON ({"name": ..., "arguments": {...}}). */
function parseBareCall(text: string, known: Set<string>): TextToolCall[] | undefined {
  const s = stripFences(text.trim())
    .replace(/^tool_call\s*/i, "")
    .trim();
  if (!s.startsWith("{") && !s.startsWith("[")) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    return undefined;
  }
  const list = Array.isArray(v) ? v : [v];
  if (!list.length) return undefined;
  const calls: TextToolCall[] = [];
  for (const o of list as any[]) {
    const looksLikeCall = o && typeof o === "object" && ("arguments" in o || "parameters" in o || (o.function && typeof o.function === "object"));
    const c = looksLikeCall ? callFromObject(o) : undefined;
    if (!c || !known.has(c.name)) return undefined;
    calls.push(c);
  }
  return calls;
}

/**
 * Tool calls written into the reply text. In prompt mode every block counts
 * (a broken one becomes an error for the model to fix); otherwise only
 * well-formed calls to known tools do, so ordinary prose is never executed.
 */
export function extractToolCalls(text: string, known: Set<string>, promptMode: boolean): { calls: TextToolCall[]; rest: string } {
  const calls: TextToolCall[] = [];
  let rest = "";
  let pos = 0;
  const re = /<tool_call>|\[TOOL_REQUEST\]|<function=([^>\s]+)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const open = m[0];
    const close = open === "<tool_call>" ? "</tool_call>" : open === "[TOOL_REQUEST]" ? "[END_TOOL_REQUEST]" : "</function>";
    const bodyStart = m.index + open.length;
    const end = text.indexOf(close, bodyStart);
    const body = end < 0 ? text.slice(bodyStart) : text.slice(bodyStart, end);
    const blockEnd = end < 0 ? text.length : end + close.length;
    const found = m[1] ? parseFunctionBlock(m[1], body) : parseCallBody(body);
    const usable = found.length > 0 && found.every((c) => known.has(c.name));
    if (usable || promptMode) {
      rest += text.slice(pos, m.index);
      pos = blockEnd;
      if (found.length) calls.push(...found);
      else
        calls.push({
          name: "invalid_tool_call",
          args: "{}",
          malformed: `Couldn't read this tool call: ${excerpt(body) || "(empty)"}. Write each call exactly as <tool_call>{"name": "tool_name", "arguments": {...}}</tool_call>.`,
        });
    }
    re.lastIndex = blockEnd;
  }
  rest += text.slice(pos);
  if (!calls.length) {
    const bare = parseBareCall(text, known);
    if (bare) return { calls: bare, rest: "" };
  }
  return { calls, rest };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Validate a call's arguments: "" is {}, fences are stripped, a doubled object counts once. */
export function parseToolArguments(raw: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (isPlainObject(raw)) return { ok: true, value: raw };
  const text = stripFences(typeof raw === "string" ? raw.trim() : "");
  if (!text) return { ok: true, value: {} };
  let error = "not valid JSON";
  try {
    let v: unknown = JSON.parse(text);
    // Double-encoded ("{\"path\": …}").
    if (typeof v === "string" && v.trim().startsWith("{")) v = JSON.parse(v);
    if (isPlainObject(v)) return { ok: true, value: v };
    return { ok: false, error: "the arguments must be a JSON object" };
  } catch (e) {
    error = (e as Error).message;
  }
  // Some servers resend the whole arguments at the end of the stream: "{…}{…}".
  const first = firstJsonObject(text);
  if (first && first.length < text.length) {
    try {
      const a = JSON.parse(first);
      const tail = text.slice(first.length).trim();
      if (isPlainObject(a) && (!tail || tail === first || JSON.stringify(JSON.parse(tail)) === JSON.stringify(a))) return { ok: true, value: a };
    } catch {
      // Not a repeat.
    }
  }
  return { ok: false, error };
}

// ------------------------------------------------------------------ small helpers

/** Keep the head and tail of long text. */
function headTail(s: string, max: number, note = "cut"): string {
  if (s.length <= max) return s;
  const tail = Math.floor(max * 0.3);
  const head = Math.max(0, max - tail);
  return `${s.slice(0, head)}\n…[${s.length - head - tail} characters ${note}]…\n${s.slice(s.length - tail)}`;
}

/** Cap a tool result for the model, keeping its head and tail. */
export function capToolResult(s: string, max = TOOL_RESULT_MAX_CHARS): string {
  return headTail(s, max);
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** 9 alphanumerics: also valid for Mistral's templates. */
function newCallId(used: Set<string>): string {
  for (;;) {
    const id = [...randomBytes(9)].map((b) => ALNUM[b % 62]).join("");
    if (!used.has(id)) return id;
  }
}

function validImage(i: unknown): i is Image {
  return !!i && typeof (i as Image).data === "string" && !!(i as Image).data && typeof (i as Image).mimeType === "string";
}

function imagePart(img: Image): WirePart {
  return { type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.data}` } };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function safeUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname}`.replace(/\/+$/, "");
  } catch {
    return "(invalid URL)";
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function isSummaryMessage(m: TranscriptMessage | undefined): boolean {
  return !!m && m.role === "user" && m.content.startsWith("<conversation_summary>");
}

function estimateStored(m: TranscriptMessage): number {
  return MESSAGE_OVERHEAD_TOKENS + (m.content.length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0)) / CHARS_PER_TOKEN;
}

/** Rough token count of a request: chars/3.5 plus a few tokens per message (calibrated per model later). */
function estimateRequest(system: string, wire: WireMessage[], tools?: unknown[]): number {
  let chars = system.length;
  let tokens = system ? MESSAGE_OVERHEAD_TOKENS : 0;
  for (const m of wire) {
    tokens += MESSAGE_OVERHEAD_TOKENS;
    if (typeof m.content === "string") chars += m.content.length;
    else for (const p of m.content) p.type === "text" ? (chars += p.text.length) : (tokens += IMAGE_TOKENS);
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
    for (const k of ["reasoning_content", "reasoning"]) if (typeof m[k] === "string") chars += (m[k] as string).length;
  }
  if (tools?.length) chars += JSON.stringify(tools).length;
  return Math.ceil(tokens + chars / CHARS_PER_TOKEN);
}

function cleanSchema(s: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = s && typeof s === "object" ? { ...s } : {};
  delete out.$schema;
  if (!out.type) out.type = "object";
  if (out.type === "object" && !out.properties) out.properties = {};
  return out;
}

function toolSpec(t: BoundTool): { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } } {
  return { type: "function", function: { name: t.name, description: t.description, parameters: cleanSchema(t.inputSchema) } };
}

/** Instructions for models that call tools by writing <tool_call> blocks. */
export function promptToolGuide(tools: BoundTool[]): string {
  const lines = tools.map((t) => `- ${t.name}: ${t.description.trim()}\n  arguments: ${JSON.stringify(cleanSchema(t.inputSchema))}`);
  return [
    "# Calling tools",
    "",
    "You can use the tools listed below. To call one, write a block like this in your reply:",
    "",
    "<tool_call>",
    '{"name": "tool_name", "arguments": {"argument": "value"}}',
    "</tool_call>",
    "",
    "- Write one block per call, with valid JSON (double quotes, no comments). You can make several calls in one reply; they run in order.",
    '- After your calls, stop and wait. The results come back in the next message as <tool_response name="tool_name">…</tool_response>. Never write a tool response yourself.',
    "- When you have what you need, reply normally without any <tool_call> block. That reply is your final answer.",
    "",
    "Tools (their arguments are described as JSON Schema):",
    ...lines,
  ].join("\n");
}

function callAsText(c: ChatToolCall): string {
  let args: unknown = {};
  try {
    args = JSON.parse(c.function.arguments || "{}");
  } catch {
    // Stored arguments are always valid JSON; this is just a guard.
  }
  return `<tool_call>\n${JSON.stringify({ name: c.function.name, arguments: args })}\n</tool_call>`;
}

function toParts(c: string | WirePart[]): WirePart[] {
  return typeof c === "string" ? (c ? [{ type: "text", text: c }] : []) : c;
}

function joinContent(a: string | WirePart[], b: string | WirePart[]): string | WirePart[] {
  if (typeof a === "string" && typeof b === "string") return [a, b].filter(Boolean).join("\n\n");
  return [...toParts(a), ...toParts(b)];
}

/**
 * The transcript as request messages. Native mode sends tool calls and
 * results as such; prompt and none modes render them as text (templates of
 * models without tool support can't take role "tool"). Consecutive user
 * messages are merged, since some templates insist on strict alternation.
 */
function toWire(
  msgs: TranscriptMessage[],
  o: { mode: WireMode; vision: boolean; images: Map<TranscriptMessage, Image[]>; reasoningField?: string; turnStart: number },
): WireMessage[] {
  const out: WireMessage[] = [];
  const textual = o.mode !== "native";
  const addUser = (content: string | WirePart[]) => {
    const last = out[out.length - 1];
    if (last && last.role === "user") last.content = joinContent(last.content, content);
    else out.push({ role: "user", content });
  };
  msgs.forEach((m, i) => {
    if (m.role === "tool") {
      if (textual) addUser(`<tool_response name="${m.name ?? "tool"}">\n${m.content}\n</tool_response>`);
      else out.push({ role: "tool", tool_call_id: m.tool_call_id, content: m.content || "(no output)" });
      return;
    }
    if (m.role === "user") {
      const imgs = o.vision ? o.images.get(m) : undefined;
      addUser(imgs?.length ? [{ type: "text", text: m.content }, ...imgs.map(imagePart)] : m.content);
      return;
    }
    const calls = m.tool_calls ?? [];
    const w: WireMessage = { role: "assistant", content: m.content };
    if (calls.length && textual) w.content = [m.content, ...calls.map(callAsText)].filter(Boolean).join("\n\n");
    else if (calls.length) w.tool_calls = calls.map((c) => ({ id: c.id, type: "function", function: { name: c.function.name, arguments: c.function.arguments } }));
    // Reasoning models do better when their reasoning comes back during a tool loop (this turn only).
    if (!textual && calls.length && o.reasoningField && m.reasoning_content && i > o.turnStart) w[o.reasoningField] = m.reasoning_content;
    const last = out[out.length - 1];
    if (last && last.role === "assistant" && !last.tool_calls && typeof last.content === "string" && typeof w.content === "string") {
      Object.assign(last, w, { content: [last.content, w.content].filter(Boolean).join("\n\n") });
      return;
    }
    out.push(w);
  });
  return out;
}

/** For templates without a system role: put the system text at the start of the first user message. */
function foldSystem(messages: WireMessage[]): WireMessage[] {
  const system = messages.filter((m) => m.role === "system").map((m) => contentToText(m.content));
  if (!system.length) return messages;
  const rest = messages.filter((m) => m.role !== "system").map((m) => ({ ...m }));
  const first = rest.find((m) => m.role === "user");
  const text = system.join("\n\n");
  if (first) first.content = joinContent(text, first.content);
  else rest.unshift({ role: "user", content: text });
  return rest;
}

// ------------------------------------------------------------------ model parameters

const PARAMS: Record<string, { key: string; type: "number" | "int" | "string" }> = {
  temperature: { key: "temperature", type: "number" },
  top_p: { key: "top_p", type: "number" },
  top_k: { key: "top_k", type: "int" },
  min_p: { key: "min_p", type: "number" },
  presence_penalty: { key: "presence_penalty", type: "number" },
  frequency_penalty: { key: "frequency_penalty", type: "number" },
  repetition_penalty: { key: "repetition_penalty", type: "number" },
  seed: { key: "seed", type: "int" },
  reasoning_effort: { key: "reasoning_effort", type: "string" },
};
const MAX_TOKEN_PARAMS = new Set(["max_tokens", "max_completion_tokens", "max_output_tokens"]);
/** Request fields the runtime owns; a model's extra fields can't override them. */
const RESERVED_BODY_KEYS = new Set(["model", "messages", "tools", "stream", "stream_options", "tool_choice", "functions"]);

function paramId(id: string): string {
  return id
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

/** ModelChoice.params as request fields (unknown ids, like Cursor's "fast", are ignored). */
export function mapModelParams(choice?: ModelChoice): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of choice?.params ?? []) {
    const spec = PARAMS[paramId(String(p?.id ?? ""))];
    if (!spec) continue;
    const raw = String(p.value ?? "").trim();
    if (!raw) continue;
    if (spec.type === "string") out[spec.key] = raw;
    else {
      const n = Number(raw);
      if (Number.isFinite(n)) out[spec.key] = spec.type === "int" ? Math.round(n) : n;
    }
  }
  return out;
}

function paramMaxTokens(choice?: ModelChoice): number | undefined {
  for (const p of choice?.params ?? []) {
    if (!MAX_TOKEN_PARAMS.has(paramId(String(p?.id ?? "")))) continue;
    const n = Math.round(Number(p.value));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

// ------------------------------------------------------------------ model catalogue

/** A catalogue entry: a model config plus what the provider says about tool use. */
export interface CatalogModel extends ProviderModel {
  toolUse?: boolean;
}

function posInt(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return undefined;
}

function flag(...vals: unknown[]): boolean | undefined {
  for (const v of vals) if (typeof v === "boolean") return v;
  return undefined;
}

/** Read one /models entry from any of the shapes providers use. */
export function normalizeCatalogModel(x: any): CatalogModel | undefined {
  if (typeof x === "string") return x.trim() ? { id: x.trim() } : undefined;
  if (!x || typeof x !== "object") return undefined;
  const id = ([x.id, x.model, x.name].find((v) => typeof v === "string" && v.trim()) as string | undefined)?.trim();
  if (!id) return undefined;
  const m: CatalogModel = { id };
  const label = [x.display_name, x.displayName, x.name].find((v) => typeof v === "string" && v.trim() && v.trim() !== id) as string | undefined;
  if (label) m.label = label.trim();
  const ctx = posInt(x.context_length, x.max_model_len, x.context_window, x.max_context_length, x.top_provider?.context_length, x.loaded_instances?.[0]?.config?.context_length);
  if (ctx) m.contextWindow = ctx;
  const out = posInt(x.max_completion_tokens, x.top_provider?.max_completion_tokens, x.max_output_tokens);
  if (out) m.maxOutputTokens = out;
  const modalities = [x.architecture?.input_modalities, x.input_modalities, x.modalities?.input].find(Array.isArray) as unknown[] | undefined;
  const vision = flag(x.features?.image_input, x.vision_supported, x.capabilities?.vision, x.vision) ?? (modalities ? modalities.includes("image") : undefined);
  if (vision !== undefined) m.vision = vision;
  const supported = Array.isArray(x.supported_parameters) ? (x.supported_parameters as unknown[]) : undefined;
  const tools =
    flag(x.features?.tool_use, x.capabilities?.function_calling, x.capabilities?.tool_use, x.capabilities?.tools, x.trained_for_tool_use, x.capabilities?.trained_for_tool_use) ??
    (supported ? supported.includes("tools") : undefined);
  if (tools !== undefined) m.toolUse = tools;
  const cost = posInt(x.concurrency_cost);
  if (cost) m.concurrencyCost = cost;
  return m;
}

// ------------------------------------------------------------------ one model call

interface PendingCall {
  index?: number;
  id?: string;
  name: string;
  args: string;
}

interface ChatResult {
  /** Visible reply text (reasoning removed; tool-call markup still in it). */
  text: string;
  reasoning: string;
  reasoningField?: "reasoning_content" | "reasoning";
  calls: PendingCall[];
  finishReason?: string;
  usage?: Usage;
  model?: string;
  id?: string;
  requestId?: string;
  /** The reply had a lone </think>: the model's template opens the think block itself. */
  loneClose: boolean;
}

interface ChatCall {
  modelId: string;
  body: Record<string, unknown>;
  stream: boolean;
  signal: AbortSignal;
  /** Streamed text and thinking go here (none for one-shot calls). */
  emit?: (ev: RuntimeEvent) => void;
  status?: (text: string) => void;
  /** Hide tool-call markup from the streamed text. */
  hideMarkup?: boolean;
  /** Longest total backoff before giving up. */
  maxWaitMs?: number;
  /** Raw token estimate of the prompt, calibrated against the reported usage. */
  estimate?: number;
}

/** Collects one reply from stream chunks (or a whole JSON response) in any of the shapes providers use. */
class ReplyBuilder {
  private think: ThinkFilter;
  private hider?: MarkupHider;
  private emitFn?: (ev: RuntimeEvent) => void;
  private sawVisible = false;
  readonly errorFrom: (err: any) => ProviderError;
  content = "";
  fieldReasoning = "";
  tagReasoning = "";
  reasoningField?: "reasoning_content" | "reasoning";
  calls: PendingCall[] = [];
  finishReason?: string;
  usage?: Usage;
  model?: string;
  id?: string;
  emitted = false;
  sawChoice = false;
  loneClose = false;

  constructor(o: { emit?: (ev: RuntimeEvent) => void; startInThink: boolean; hideMarkup: boolean; errorFrom: (err: any) => ProviderError }) {
    this.emitFn = o.emit;
    this.think = new ThinkFilter(o.startInThink);
    this.hider = o.hideMarkup ? new MarkupHider() : undefined;
    this.errorFrom = o.errorFrom;
  }

  private emit(ev: RuntimeEvent): void {
    if (!this.emitFn) return;
    this.emitted = true;
    try {
      this.emitFn(ev);
    } catch {
      // A listener's failure isn't the model's.
    }
  }

  private thinking(t: string, field: boolean): void {
    if (!t) return;
    if (field) this.fieldReasoning += t;
    else this.tagReasoning += t;
    this.emit({ type: "thinking", text: t });
  }

  private addContent(t: string): void {
    if (!t) return;
    const r = this.think.push(t);
    if (r.reset) {
      // Everything so far was reasoning (the template opened the think block in the prompt).
      this.loneClose = true;
      this.tagReasoning += this.content;
      this.content = "";
      this.sawVisible = false;
      this.hider?.reset();
    }
    this.thinking(r.thinking, false);
    this.visible(r.text);
  }

  private visible(t: string): void {
    if (!this.sawVisible) {
      t = t.replace(/^\s+/, "");
      if (!t) return;
      this.sawVisible = true;
    }
    this.content += t;
    const shown = this.hider ? this.hider.push(t) : t;
    if (shown) this.emit({ type: "text", text: shown });
  }

  private addToolCall(tc: any): void {
    if (!tc || typeof tc !== "object") return;
    const fn = tc.function && typeof tc.function === "object" ? tc.function : {};
    const name = typeof fn.name === "string" ? fn.name : "";
    const id = typeof tc.id === "string" && tc.id ? tc.id : undefined;
    const index = typeof tc.index === "number" ? tc.index : undefined;
    let t: PendingCall | undefined;
    if (index !== undefined) t = this.calls.findLast((c) => c.index === index && (!id || !c.id || c.id === id));
    else if (id) t = this.calls.find((c) => c.id === id);
    // No index and no id: a fragment of the latest call, unless it starts a new one by name.
    else if (!name && this.calls.length) t = this.calls[this.calls.length - 1];
    if (!t) {
      t = { index, id, name: "", args: "" };
      this.calls.push(t);
    }
    if (id && !t.id) t.id = id;
    if (name && !t.name) t.name = name;
    const a = fn.arguments;
    if (typeof a === "string") t.args += a;
    else if (a && typeof a === "object") t.args = JSON.stringify(a);
  }

  chunk(c: any): void {
    if (Array.isArray(c)) c = c[0];
    if (!c || typeof c !== "object") return;
    if (c.error) throw this.errorFrom(c.error);
    const usage = c.usage ?? c.x_groq?.usage;
    if (usage && typeof usage === "object") this.usage = usage; // the last non-null one wins
    if (typeof c.model === "string" && c.model) this.model = c.model;
    if (typeof c.id === "string" && c.id && !this.id) this.id = c.id;
    const choices: any[] = Array.isArray(c.choices) ? c.choices : [];
    const ch = choices.find((x) => (x?.index ?? 0) === 0) ?? choices[0];
    if (!ch) return;
    this.sawChoice = true;
    const d = ch.delta ?? ch.message ?? {};
    if (typeof d.reasoning_content === "string" && d.reasoning_content) {
      this.reasoningField = "reasoning_content";
      this.thinking(d.reasoning_content, true);
    } else if (typeof d.reasoning === "string" && d.reasoning) {
      this.reasoningField ??= "reasoning";
      this.thinking(d.reasoning, true);
    } else if (Array.isArray(d.reasoning_details)) {
      for (const r of d.reasoning_details) this.thinking(typeof r?.text === "string" ? r.text : typeof r?.summary === "string" ? r.summary : "", true);
    }
    if (typeof d.content === "string") this.addContent(d.content);
    else if (Array.isArray(d.content)) {
      // Mistral: [{type:"thinking", thinking:[{type:"text", text}]}, {type:"text", text}]
      for (const p of d.content) {
        if (p?.type === "thinking") {
          const parts = Array.isArray(p.thinking) ? p.thinking : [p.thinking];
          this.thinking(parts.map((x: any) => (typeof x === "string" ? x : typeof x?.text === "string" ? x.text : "")).join(""), true);
        } else if (typeof p?.text === "string") this.addContent(p.text);
      }
    }
    if (Array.isArray(d.tool_calls)) for (const tc of d.tool_calls) this.addToolCall(tc);
    else if (d.function_call && typeof d.function_call === "object") this.addToolCall({ index: 0, function: d.function_call });
    if (ch.finish_reason) {
      if (ch.finish_reason === "error") throw this.errorFrom(ch.error ?? c.error ?? { message: "the reply ended with an error" });
      this.finishReason = ch.finish_reason;
    }
  }

  finish(): void {
    const r = this.think.end();
    this.thinking(r.thinking, false);
    if (r.toText !== undefined) {
      this.tagReasoning = "";
      this.visible(r.toText);
    }
    this.visible(r.text);
    const rest = this.hider?.end();
    if (rest) this.emit({ type: "text", text: rest });
  }

  result(requestId?: string): ChatResult {
    return {
      text: this.content,
      reasoning: [this.fieldReasoning.trim(), this.tagReasoning.trim()].filter(Boolean).join("\n\n"),
      reasoningField: this.reasoningField,
      calls: this.calls.filter((c) => c.name),
      finishReason: this.finishReason,
      usage: this.usage,
      model: this.model,
      id: this.id,
      requestId,
      loneClose: this.loneClose,
    };
  }
}

/** What this runtime instance has learned about one model. */
interface ModelQuirks {
  /** "auto" models that turned out to write tool calls as text. */
  promptTools?: boolean;
  dropped: Set<string>;
  maxTokensKey?: "max_tokens" | "max_completion_tokens";
  maxTokensSwapped?: boolean;
  noSystem?: boolean;
  /** The server rejected reasoning sent back on assistant messages. */
  noReasoningEcho?: boolean;
  implicitThink?: boolean;
  reasoningField?: "reasoning_content" | "reasoning";
  /** Reported prompt tokens / our estimate. */
  ratio?: number;
  /** A smaller context window learned from an overflow error. */
  window?: number;
}

// ------------------------------------------------------------------ the runtime

/** A bot brain on any OpenAI-compatible chat API (Featherless, OpenRouter, xAI, Ollama, ...). */
export class OpenAICompatRuntime implements AgentRuntime {
  readonly provides: RuntimeProvides = { workspaceTools: false, projectContext: false, mcp: false };
  private opts: OpenAICompatOptions;
  private sem: UnitSemaphore;
  private quirks = new Map<string, ModelQuirks>();
  private runs = new Set<OaiRun>();
  private oneShots = new Set<AbortController>();

  constructor(opts: OpenAICompatOptions) {
    this.opts = opts;
    this.sem = new UnitSemaphore(() => Number(this.opts.provider().maxConcurrency) || 1);
  }

  get id(): string {
    return this.opts.provider().id;
  }

  get label(): string {
    return this.opts.provider().label;
  }

  available(): { ok: boolean; reason?: string } {
    const p = this.opts.provider();
    const where = "in Settings → Brain & models → Providers";
    if (!p.enabled) return { ok: false, reason: `${p.label} is switched off: turn it on ${where}.` };
    let url: URL;
    try {
      url = new URL(p.baseUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("scheme");
    } catch {
      return { ok: false, reason: `${p.label} has no valid base URL: set one ${where}.` };
    }
    if (!this.opts.apiKey() && !isLocalHost(url.hostname)) return { ok: false, reason: `${p.label} needs an API key: add it ${where}.` };
    if (!this.defaultModelId()) return { ok: false, reason: `${p.label} has no model yet: add one ${where}.` };
    return { ok: true };
  }

  async open(spec: SessionSpec): Promise<RuntimeSession> {
    fs.mkdirSync(this.opts.transcriptDir, { recursive: true });
    const wanted = spec.agentId;
    if (wanted && /^oai-[A-Za-z0-9-]{8,64}$/.test(wanted)) {
      const t = new Transcript(this.transcriptFile(wanted));
      if (fs.existsSync(t.file)) {
        t.load();
        return new OaiSession(this, wanted, t, spec.model);
      }
    }
    // Nothing to resume: a new id, so the runner knows to send the full identity again.
    const id = `oai-${randomUUID()}`;
    return new OaiSession(this, id, new Transcript(this.transcriptFile(id)), spec.model);
  }

  async complete(prompt: string, opts?: { model?: ModelChoice }): Promise<string> {
    const p = this.opts.provider();
    const avail = this.available();
    if (!avail.ok) throw new Error(avail.reason);
    const modelId = opts?.model?.id || p.routerModel || p.defaultModel || p.models[0]?.id;
    if (!modelId) throw new Error(`${p.label} has no model to answer with.`);
    const ctrl = new AbortController();
    this.oneShots.add(ctrl);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, COMPLETE_TIMEOUT_MS);
    try {
      const messages: WireMessage[] = [{ role: "user", content: String(prompt) }];
      const estimate = estimateRequest("", messages);
      // Small, but with room for a reasoning model to think first.
      const maxTokens = Math.max(MIN_REPLY_TOKENS, Math.min(COMPLETE_MAX_TOKENS, this.windowFor(modelId) - this.scaled(modelId, estimate) - 64));
      const body = this.makeBody({ modelId, messages, stream: false, maxTokens, temperature: 0 });
      const res = await this.chat({ modelId, body, stream: false, signal: ctrl.signal, maxWaitMs: 20_000, estimate });
      return res.text.trim();
    } catch (err) {
      if (timedOut) throw new Error(`${p.label} didn't answer within ${COMPLETE_TIMEOUT_MS / 1000} seconds.`);
      if (isAbortError(err)) throw new Error(`The request to ${p.label} was cancelled.`);
      throw err;
    } finally {
      clearTimeout(timer);
      this.oneShots.delete(ctrl);
    }
  }

  async listModels(): Promise<RuntimeModel[]> {
    const p = this.opts.provider();
    const list: RuntimeModel[] = p.models.map((m) => ({
      id: m.id,
      displayName: m.label || m.id,
      contextWindow: m.contextWindow,
      maxOutputTokens: m.maxOutputTokens,
      vision: m.vision,
      toolUse: m.toolMode === "native" ? true : m.toolMode === "none" ? false : undefined,
      concurrencyCost: m.concurrencyCost,
    }));
    if (p.defaultModel && !list.some((m) => m.id === p.defaultModel)) list.unshift({ id: p.defaultModel, displayName: p.defaultModel });
    return list;
  }

  /** Read the provider's model catalogue (GET {baseUrl}/models), optionally filtered by a search term. */
  async fetchModels(opts: { search?: string } = {}): Promise<ProviderModel[]> {
    const p = this.opts.provider();
    const base = p.baseUrl.replace(/\/+$/, "");
    const url = new URL(`${base}/models`);
    const search = opts.search?.trim();
    // Featherless's full list is paginated; a search is answered in full.
    if (search && url.hostname === "api.featherless.ai") url.searchParams.set("q", search);
    const { status, json } = await this.getJson(url.toString(), "list its models");
    if (status === 404) throw new Error(`${p.label} has no model list at ${safeUrl(base)}/models (HTTP 404). Check the base URL.`);
    const raw: unknown[] = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
    const terms = (search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const out: CatalogModel[] = [];
    for (const x of raw) {
      const m = normalizeCatalogModel(x);
      if (!m) continue;
      const hay = `${m.id} ${m.label ?? ""}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) continue;
      out.push(m);
      if (out.length >= MAX_CATALOG) break;
    }
    return out;
  }

  /** Look one model up (GET {baseUrl}/models/{id}) to fill in its context window and abilities. */
  async lookupModel(id: string): Promise<ProviderModel | undefined> {
    const model = String(id ?? "").trim();
    if (!model) return undefined;
    const base = this.opts.provider().baseUrl.replace(/\/+$/, "");
    // Keep the slash in owner/name ids; encode each part.
    const url = `${base}/models/${model.split("/").map(encodeURIComponent).join("/")}`;
    const { status, json } = await this.getJson(url, `look up ${model}`);
    if (status === 404 || !json) return undefined;
    const entry = json && typeof json === "object" && !Array.isArray(json) && json.data && typeof json.data === "object" && !Array.isArray(json.data) ? json.data : json;
    const m = normalizeCatalogModel(Array.isArray(entry) ? entry[0] : entry);
    return m ? { ...m, id: m.id || model } : { id: model };
  }

  async dispose(): Promise<void> {
    const runs = [...this.runs];
    for (const r of runs) r.abort();
    for (const c of this.oneShots) c.abort();
    await Promise.all(runs.map((r) => r.wait().catch(() => undefined)));
  }

  // ---------------------------------------------------------------- internals used by sessions

  /** @internal */
  track(run: OaiRun): void {
    this.runs.add(run);
  }

  /** @internal */
  untrack(run: OaiRun): void {
    this.runs.delete(run);
  }

  /** @internal */
  providerConfig(): ProviderConfig {
    return this.opts.provider();
  }

  /** @internal */
  defaultModelId(): string | undefined {
    const p = this.opts.provider();
    return p.defaultModel || p.models[0]?.id || undefined;
  }

  /** @internal */
  modelConfig(id: string): ProviderModel {
    return this.opts.provider().models.find((m) => m.id === id) ?? { id };
  }

  /** @internal */
  quirk(id: string): ModelQuirks {
    let q = this.quirks.get(id);
    if (!q) {
      q = { dropped: new Set() };
      this.quirks.set(id, q);
    }
    return q;
  }

  /** @internal */
  vision(id: string): boolean {
    return this.modelConfig(id).vision === true;
  }

  /** @internal */
  windowFor(id: string): number {
    const configured = this.modelConfig(id).contextWindow ?? this.opts.provider().defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const learned = this.quirk(id).window;
    return Math.max(512, learned ? Math.min(configured, learned) : configured);
  }

  /** @internal Token estimate scaled by what the model reported for earlier prompts. */
  scaled(id: string, raw: number): number {
    return Math.ceil(raw * (this.quirk(id).ratio ?? 1));
  }

  /** @internal */
  ratio(id: string): number {
    return this.quirk(id).ratio ?? 1;
  }

  private outputCap(id: string, choice?: ModelChoice): number {
    return paramMaxTokens(choice) ?? this.modelConfig(id).maxOutputTokens ?? DEFAULT_MAX_OUTPUT;
  }

  /** @internal The reply limit for a prompt of this size: never more than fits, never less than 256. */
  replyLimit(id: string, promptTokens: number, choice?: ModelChoice): number {
    const w = this.windowFor(id);
    const margin = Math.max(256, Math.ceil(w * 0.03));
    return Math.max(MIN_REPLY_TOKENS, Math.min(this.outputCap(id, choice), w - promptTokens - margin));
  }

  /** @internal Largest prompt that leaves the reply its reserve inside ~90% of the window. */
  promptBudget(id: string, choice?: ModelChoice): number {
    const w = this.windowFor(id);
    const reserve = Math.min(this.outputCap(id, choice), Math.max(512, Math.floor(w * 0.2)));
    return Math.floor(w * REQUEST_BUDGET) - reserve;
  }

  /** @internal */
  configuredToolMode(id: string): ToolMode {
    return this.modelConfig(id).toolMode ?? this.opts.provider().toolMode ?? "auto";
  }

  /** @internal */
  toolModeFor(id: string, hasTools: boolean): WireMode {
    if (!hasTools) return "none";
    const mode = this.configuredToolMode(id);
    if (mode === "auto") return this.quirk(id).promptTools ? "prompt" : "native";
    return mode;
  }

  /** @internal An "auto" model calls tools by writing them as text from now on. */
  setPromptTools(id: string): void {
    this.quirk(id).promptTools = true;
  }

  /** @internal Learn the real window (and our estimate's error) from a context-overflow message. */
  learnOverflow(id: string, detail: string, estimate: number): void {
    const q = this.quirk(id);
    const w = /maximum context length is (\d+)/i.exec(detail) ?? /context (?:size|window|length)[^0-9]{0,30}(\d{3,8})/i.exec(detail) ?? /n_ctx[^0-9]{0,5}(\d{3,8})/i.exec(detail);
    if (w) {
      const n = Number(w[1]);
      if (n >= 512 && n < this.windowFor(id)) q.window = n;
    }
    const used = /(\d+) (?:tokens )?in the messages/i.exec(detail) ?? /request \((\d+) tokens\)/i.exec(detail) ?? /n_prompt_tokens[^0-9]{0,5}(\d+)/i.exec(detail);
    if (used && estimate > 0) {
      const r = Number(used[1]) / estimate;
      if (Number.isFinite(r) && r > 0) q.ratio = Math.min(4, Math.max(q.ratio ?? 1, r));
    }
  }

  /** @internal Remove the API key from text that came back from the provider. */
  scrub(text: string): string {
    const key = this.opts.apiKey();
    let s = String(text ?? "");
    if (key && key.length >= 4) s = s.split(key).join("[redacted]");
    return s;
  }

  private clean(text: string, max = 400): string {
    return excerpt(this.scrub(text), max);
  }

  private headers(json: boolean): Headers {
    const p = this.opts.provider();
    const h = new Headers();
    if (json) h.set("content-type", "application/json");
    h.set("accept", "application/json");
    if (this.opts.appUrl) h.set("HTTP-Referer", this.opts.appUrl);
    if (this.opts.appName) h.set("X-Title", this.opts.appName);
    for (const [k, v] of Object.entries(p.headers ?? {})) {
      if (/^(authorization|x-api-key|api-key)$/i.test(k)) continue;
      try {
        h.set(k, String(v));
      } catch {
        // An invalid header is skipped, not fatal.
      }
    }
    const key = this.opts.apiKey();
    if (key) h.set("authorization", `Bearer ${key}`);
    return h;
  }

  /** @internal A request body: the model's extra fields, our fields, then the bot's parameters. */
  makeBody(o: {
    modelId: string;
    messages: WireMessage[];
    stream: boolean;
    maxTokens: number;
    tools?: unknown[];
    choice?: ModelChoice;
    temperature?: number;
  }): Record<string, unknown> {
    const p = this.opts.provider();
    const m = this.modelConfig(o.modelId);
    const body: Record<string, unknown> = { model: o.modelId, messages: o.messages, stream: o.stream };
    for (const [k, v] of Object.entries(m.extraBody ?? {})) if (!RESERVED_BODY_KEYS.has(k)) body[k] = v;
    if (o.stream) body.stream_options = { include_usage: true };
    if (o.tools?.length) body.tools = o.tools;
    if (o.temperature !== undefined) body.temperature = o.temperature;
    else Object.assign(body, mapModelParams(o.choice));
    delete body.max_tokens;
    delete body.max_completion_tokens;
    body[p.maxTokensParam ?? "max_tokens"] = o.maxTokens;
    return body;
  }

  private withQuirks(body: Record<string, unknown>, q: ModelQuirks): Record<string, unknown> {
    const b: Record<string, unknown> = { ...body };
    const maxKey = ["max_tokens", "max_completion_tokens"].find((k) => k in b);
    if (q.maxTokensKey && maxKey && maxKey !== q.maxTokensKey) {
      b[q.maxTokensKey] = b[maxKey];
      delete b[maxKey];
    }
    for (const k of q.dropped) delete b[k];
    if (Array.isArray(b.messages)) {
      let messages = b.messages as WireMessage[];
      if (q.noReasoningEcho)
        messages = messages.map((m) => {
          if (!("reasoning_content" in m) && !("reasoning" in m)) return m;
          const { reasoning_content: _a, reasoning: _b, ...rest } = m;
          return rest as WireMessage;
        });
      if (q.noSystem) messages = foldSystem(messages);
      b.messages = messages;
    }
    return b;
  }

  private costOf(id: string): number {
    return Math.max(1, Math.round(Number(this.modelConfig(id).concurrencyCost) || 1));
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return (this.opts.sleep ?? defaultSleep)(ms, signal);
  }

  /**
   * One logical model call: waits for capacity, posts, parses, and retries what
   * can be retried (rate limits, cold models, overloaded servers, rejected
   * parameters) as long as nothing has been shown yet. Context overflow and
   * "tools not supported" go back to the caller, which can fix the request.
   * @internal
   */
  async chat(call: ChatCall): Promise<ChatResult> {
    const p = this.opts.provider();
    const url = `${p.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const q = this.quirk(call.modelId);
    const tries: Partial<Record<ProviderErrorKind, number>> = {};
    let waited = 0;
    const maxWait = call.maxWaitMs ?? 15 * 60_000;
    for (;;) {
      if (call.signal.aborted) throw abortError();
      const body = this.withQuirks(call.body, q);
      const release = await this.sem.acquire(this.costOf(call.modelId), call.signal, (u) =>
        call.status?.(`Waiting for ${p.label} capacity (${u.used} of ${plural(u.capacity, "concurrency unit")} in use)…`),
      );
      let failure: unknown;
      try {
        const res = await this.attempt(url, body, call);
        this.learn(call, res);
        return res;
      } catch (err) {
        failure = err;
      } finally {
        release();
      }
      if (call.signal.aborted || isAbortError(failure)) throw abortError();
      const pe = failure instanceof ProviderError ? failure : this.networkError(failure);
      if (pe.emitted) throw pe;
      // A request the server can't take as is: change it and go again at once.
      if (pe.kind === "param" && pe.param && (tries.param ?? 0) < 4) {
        tries.param = (tries.param ?? 0) + 1;
        if (pe.param === "reasoning_content" || pe.param === "reasoning") q.noReasoningEcho = true;
        else if ((pe.param === "max_tokens" || pe.param === "max_completion_tokens") && !q.maxTokensSwapped) {
          q.maxTokensSwapped = true;
          q.maxTokensKey = pe.param === "max_tokens" ? "max_completion_tokens" : "max_tokens";
        } else q.dropped.add(pe.param);
        continue;
      }
      if (pe.kind === "system_role" && !q.noSystem) {
        q.noSystem = true;
        continue;
      }
      // A whole-reply call that timed out already waited its full (long) limit.
      if (pe.kind === "timeout" && !call.stream) throw pe;
      const n = tries[pe.kind] ?? 0;
      const delay = this.retryDelay(pe, n, waited);
      if (delay === undefined || waited + delay > maxWait) throw this.exhausted(pe, n, waited, call.modelId);
      tries[pe.kind] = n + 1;
      call.status?.(this.retryStatus(pe, call.modelId, delay));
      await this.sleep(delay, call.signal);
      if (call.signal.aborted) throw abortError();
      waited += delay;
    }
  }

  private retryDelay(pe: ProviderError, n: number, waited: number): number | undefined {
    const asked = pe.retryAfterMs !== undefined ? Math.min(pe.retryAfterMs, MAX_RETRY_WAIT_MS) : undefined;
    const jitter = () => 0.85 + Math.random() * 0.3;
    switch (pe.kind) {
      case "rate":
        return n < 8 ? (asked ?? Math.round(Math.min(30_000, 2000 * 2 ** n) * jitter())) : undefined;
      case "cold": {
        const d = Math.min(Math.max(asked ?? 20_000, 1000), 60_000);
        return waited + d <= COLD_WAIT_MAX_MS ? d : undefined;
      }
      case "unavailable":
        return n < 3 ? (asked ?? [2000, 5000, 10_000][n]!) : undefined;
      case "transient":
        return n < 2 ? (asked ?? [2000, 5000][n]!) : undefined;
      case "network":
      case "timeout":
        return n < 2 ? [1000, 3000][n]! : undefined;
      default:
        return undefined;
    }
  }

  private retryStatus(pe: ProviderError, modelId: string, delay: number): string {
    const p = this.opts.provider();
    const secs = `${Math.max(1, Math.round(delay / 1000))}s`;
    switch (pe.kind) {
      case "rate":
        return `${p.label} is at its concurrency or rate limit; retrying in ${secs}…`;
      case "cold":
        return `${modelId} is loading on ${p.label} (a cold model takes a few minutes); retrying in ${secs}…`;
      case "unavailable":
        return `${p.label} has no capacity for ${modelId} right now; retrying in ${secs}…`;
      default:
        return `${p.label} had a problem (${pe.detail || pe.kind}); retrying in ${secs}…`;
    }
  }

  private exhausted(pe: ProviderError, n: number, waited: number, modelId: string): ProviderError {
    const p = this.opts.provider();
    const http = `${pe.status ? `HTTP ${pe.status}` : "error"}${pe.detail ? `: ${pe.detail}` : ""}`;
    let message: string | undefined;
    if (pe.kind === "rate" && n)
      message = `${p.label} is still at its concurrency or rate limit after ${plural(n, "retry", "retries")} (${http}). Other bots or apps may be using your plan's units: lower this provider's max concurrency, or try again later.`;
    else if (pe.kind === "cold" && n) {
      const mins = Math.max(1, Math.round(waited / 60_000));
      message = `${modelId} is still loading on ${p.label} after ${waited >= 60_000 ? plural(mins, "minute") : plural(Math.round(waited / 1000), "second")} (a cold model can take up to an hour). Try again later, or pick a model that's already warm.`;
    } else if (pe.kind === "unavailable" && n)
      message = `${p.label} still couldn't serve ${modelId} after ${plural(n, "retry", "retries")} (${http}). The model may be temporarily unavailable: try again later or pick another model.`;
    else if ((pe.kind === "transient" || pe.kind === "network" || pe.kind === "timeout") && n)
      message = `${pe.message} (gave up after ${plural(n, "retry", "retries")})`;
    if (!message) return pe;
    const out = new ProviderError(pe.kind, message, { status: pe.status, detail: pe.detail, retryAfterMs: pe.retryAfterMs });
    return out;
  }

  private learn(call: ChatCall, res: ChatResult): void {
    const q = this.quirk(call.modelId);
    if (res.reasoningField) q.reasoningField = res.reasoningField;
    if (res.loneClose) q.implicitThink = true;
    const reported = Number(res.usage?.prompt_tokens);
    // Small prompts are mostly template overhead; calibrate on real ones.
    if (call.estimate && call.estimate > 500 && reported > 0) {
      const r = Math.min(2.5, Math.max(0.5, reported / call.estimate));
      q.ratio = q.ratio ? q.ratio * 0.5 + r * 0.5 : r;
    }
  }

  private networkError(err: unknown): ProviderError {
    const p = this.opts.provider();
    const e = err as any;
    const cause = e?.cause?.code ?? e?.cause?.message ?? e?.code ?? e?.message ?? String(err);
    return new ProviderError("network", `Couldn't reach ${p.label} at ${safeUrl(p.baseUrl)}: ${this.clean(String(cause))}.`, { detail: this.clean(String(cause)) });
  }

  /** @internal An error object from a response body or a stream frame, as a ProviderError. */
  bodyError(e: any, status: number | undefined, modelId: string, candidates: string[]): ProviderError {
    const raw = typeof e === "string" ? e : (e?.message ?? e?.detail ?? e?.error ?? (e ? JSON.stringify(e) : ""));
    const detail = this.clean(typeof raw === "string" ? raw : JSON.stringify(raw));
    const codes = e && typeof e === "object" ? `${e.code ?? ""} ${e.type ?? ""} ${e.metadata?.error_type ?? ""}` : "";
    const st = status ?? (typeof e?.code === "number" && e.code >= 400 && e.code < 600 ? e.code : undefined);
    const { kind, param } = classifyError(st, `${codes} ${detail}`, candidates);
    return new ProviderError(kind, this.describe(kind, st, detail, modelId), { status: st, param, detail });
  }

  private httpError(status: number, headers: Headers, text: string, modelId: string, candidates: string[]): ProviderError {
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      // Not JSON: the text is the message.
    }
    if (Array.isArray(json)) json = json[0];
    const e = json && typeof json === "object" ? (json.error ?? json) : text;
    const pe = this.bodyError(e || `HTTP ${status}`, status, modelId, candidates);
    pe.retryAfterMs = retryAfterMs(headers);
    return pe;
  }

  private describe(kind: ProviderErrorKind, status: number | undefined, detail: string, modelId: string): string {
    const p = this.opts.provider();
    const label = p.label;
    const http = `${status ? `HTTP ${status}` : "error"}${detail ? `: ${detail}` : ""}`;
    const where = "Settings → Brain & models → Providers";
    switch (kind) {
      case "auth":
        return `${label} rejected the API key (${http}). Check the key in ${where}.`;
      case "forbidden":
        return `${label} refused access to ${modelId} (${http}). The model may be gated (accept its license on Hugging Face and connect that account to ${label}) or not included in your plan.`;
      case "notfound":
        return /model/i.test(detail)
          ? `${label} doesn't have the model "${modelId}" (${http}). Check the model id in ${where}.`
          : `${label} answered "not found" (${http}). Check the model id "${modelId}" and the base URL (${safeUrl(p.baseUrl)}) in ${where}.`;
      case "billing":
        return `${label} says the account is out of credits or quota (${http}).`;
      case "rate":
        return `${label} is at its concurrency or rate limit (${http}).`;
      case "cold":
        return `${modelId} isn't loaded on ${label} yet (${http}).`;
      case "unavailable":
        return `${label} has no capacity for ${modelId} right now (${http}).`;
      case "transient":
        return `${label} had a server error (${http}).`;
      case "context":
        return `The conversation is too long for ${modelId} (${http}).`;
      case "tools":
        return `${modelId} on ${label} doesn't support native tool calls (${http}). Set the model's tool mode to "prompt" in ${where}.`;
      case "param":
        return `${label} rejected a request field for ${modelId} (${http}).`;
      default:
        return `${label} returned an error for ${modelId} (${http}).`;
    }
  }

  private async attempt(url: string, body: Record<string, unknown>, call: ChatCall): Promise<ChatResult> {
    const p = this.opts.provider();
    if (call.signal.aborted) throw abortError();
    const local = new AbortController();
    const relay = () => local.abort();
    call.signal.addEventListener("abort", relay, { once: true });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        local.abort();
      }, ms);
    };
    // A streamed reply starts soon, then sends steadily; a whole reply arrives only once it's all written.
    const firstByte = call.stream ? (this.opts.firstByteTimeoutMs ?? 180_000) : Math.max(this.opts.firstByteTimeoutMs ?? 180_000, 600_000);
    const idle = this.opts.idleTimeoutMs ?? 120_000;
    const candidates = Object.keys(body).filter((k) => k !== "model" && k !== "messages" && k !== "stream");
    // Reasoning sent back on assistant messages is a field a strict server may name in its error.
    if (Array.isArray(body.messages) && (body.messages as WireMessage[]).some((m) => "reasoning_content" in m || "reasoning" in m))
      candidates.push("reasoning_content", "reasoning");
    const builder = new ReplyBuilder({
      emit: call.emit,
      startInThink: !!this.quirk(call.modelId).implicitThink,
      hideMarkup: !!call.hideMarkup,
      errorFrom: (e) => this.bodyError(e, undefined, call.modelId, candidates),
    });
    const fail = (err: unknown, during: "connect" | "read"): never => {
      if (call.signal.aborted) throw abortError();
      let pe: ProviderError;
      if (err instanceof ProviderError) pe = err;
      else if (timedOut)
        pe = new ProviderError(
          "timeout",
          during === "connect" || !builder.sawChoice
            ? `${p.label} didn't start answering within ${plural(Math.max(1, Math.round(firstByte / 1000)), "second")}.`
            : `${p.label} stopped sending in the middle of a reply (nothing for ${plural(Math.max(1, Math.round(idle / 1000)), "second")}).`,
        );
      else if (during === "read") {
        const e = err as any;
        pe = new ProviderError("network", `The connection to ${p.label} broke off in the middle of a reply (${this.clean(String(e?.cause?.code ?? e?.message ?? err))}).`);
      } else pe = this.networkError(err);
      pe.emitted = builder.emitted;
      throw pe;
    };
    try {
      arm(firstByte);
      let res: Response;
      try {
        res = await (this.opts.fetch ?? fetch)(url, { method: "POST", headers: this.headers(true), body: JSON.stringify(body), signal: local.signal });
      } catch (err) {
        return fail(err, "connect");
      }
      // Until the first chunk the model may still be reading a long prompt.
      arm(call.stream ? firstByte : idle);
      const requestId = res.headers.get("x-request-id") ?? res.headers.get("request-id") ?? undefined;
      if (!res.ok) {
        let text = "";
        try {
          text = await res.text();
        } catch {
          // The status is enough.
        }
        throw this.httpError(res.status, res.headers, text, call.modelId, candidates);
      }
      const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
      try {
        if (!call.stream || !res.body || (ctype.includes("json") && !ctype.includes("event-stream"))) {
          // A whole JSON reply (asked for, or a server that doesn't stream).
          let text: string;
          try {
            text = await res.text();
          } catch (err) {
            return fail(err, "read");
          }
          let json: any;
          try {
            json = JSON.parse(text);
          } catch {
            throw new ProviderError("fatal", `${p.label} sent a reply that isn't JSON: ${this.clean(text, 200)}`);
          }
          const top = Array.isArray(json) ? json[0] : json;
          if (top?.error && !top?.choices) throw this.bodyError(top.error, undefined, call.modelId, candidates);
          builder.chunk(top);
        } else {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          const sse = new SseParser();
          let finished = false;
          try {
            while (!finished) {
              let r: ReadableStreamReadResult<Uint8Array>;
              try {
                r = await reader.read();
              } catch (err) {
                return fail(err, "read");
              }
              if (r.done) break;
              arm(idle);
              for (const ev of sse.push(decoder.decode(r.value, { stream: true }))) {
                if (this.onSse(ev, builder)) {
                  finished = true;
                  break;
                }
              }
            }
            // A connection closed without [DONE] still ends the reply.
            if (!finished) for (const ev of [...sse.push(decoder.decode()), ...sse.end()]) if (this.onSse(ev, builder)) break;
          } finally {
            reader.cancel().catch(() => {});
          }
        }
        builder.finish();
      } catch (err) {
        if (err instanceof ProviderError) err.emitted = err.emitted || builder.emitted;
        throw err;
      }
      if (!builder.sawChoice && !builder.usage) throw new ProviderError("network", `${p.label} sent an empty reply.`);
      return builder.result(requestId);
    } finally {
      clearTimeout(timer);
      call.signal.removeEventListener("abort", relay);
    }
  }

  /** Handle one SSE event; true at [DONE]. */
  private onSse(ev: { event: string; data: string }, builder: ReplyBuilder): boolean {
    const data = ev.data.trim();
    if (!data) return false;
    if (data === "[DONE]") return true;
    const items: unknown[] = [];
    try {
      items.push(JSON.parse(data));
    } catch {
      // Several JSON lines without blank lines between them.
      for (const line of data.split("\n")) {
        const l = line.trim();
        if (!l || l === "[DONE]") continue;
        try {
          items.push(JSON.parse(l));
        } catch {
          // An unreadable frame is skipped.
        }
      }
    }
    for (const item of items) {
      if (ev.event === "error") throw builder.errorFrom((item as any)?.error ?? item);
      builder.chunk(item);
    }
    return false;
  }

  private async getJson(url: string, what: string): Promise<{ status: number; json: any }> {
    const p = this.opts.provider();
    const ctrl = new AbortController();
    this.oneShots.add(ctrl);
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
      let res: Response;
      try {
        res = await (this.opts.fetch ?? fetch)(url, { method: "GET", headers: this.headers(false), signal: ctrl.signal });
      } catch (err) {
        if (ctrl.signal.aborted) throw new Error(`${p.label} didn't answer within 60 seconds (trying to ${what}).`);
        throw this.networkError(err);
      }
      let text: string;
      try {
        text = await res.text();
      } catch (err) {
        if (ctrl.signal.aborted) throw new Error(`${p.label} didn't finish answering within 60 seconds (trying to ${what}).`);
        throw this.networkError(err);
      }
      if (res.status === 404) return { status: 404, json: undefined };
      if (!res.ok) {
        const pe = this.httpError(res.status, res.headers, text, "", []);
        const hint = res.status === 401 ? " Check the API key in Settings → Brain & models → Providers." : "";
        throw new Error(`${p.label} couldn't ${what} (HTTP ${res.status}${pe.detail ? `: ${pe.detail}` : ""}).${hint}`);
      }
      try {
        return { status: res.status, json: JSON.parse(text) };
      } catch {
        throw new Error(`${p.label} sent something that isn't JSON when asked to ${what}.`);
      }
    } finally {
      clearTimeout(timer);
      this.oneShots.delete(ctrl);
    }
  }

  private transcriptFile(agentId: string): string {
    return path.join(this.opts.transcriptDir, `${agentId}.jsonl`);
  }
}

// ------------------------------------------------------------------ sessions

class OaiSession implements RuntimeSession {
  readonly agentId: string;
  readonly transcript: Transcript;
  /** Tool-call ids already used in this transcript (some servers reuse ids like "call_0"). */
  readonly callIds = new Set<string>();
  private rt: OpenAICompatRuntime;
  private model?: ModelChoice;
  private active?: OaiRun;
  private closed = false;

  constructor(rt: OpenAICompatRuntime, agentId: string, transcript: Transcript, model?: ModelChoice) {
    this.rt = rt;
    this.agentId = agentId;
    this.transcript = transcript;
    this.model = model;
    for (const m of transcript.messages) for (const c of m.tool_calls ?? []) this.callIds.add(c.id);
  }

  async send(input: SendInput): Promise<RuntimeRun> {
    if (this.closed) throw new Error("This session is closed.");
    // The runner takes one turn at a time; a leftover run is stopped before the next starts.
    if (this.active && !this.active.isFinished) await this.active.cancel();
    const choice = input.model?.id ? input.model : this.model?.id ? this.model : undefined;
    const modelId = choice?.id || this.rt.defaultModelId();
    if (!modelId) throw new Error(`${this.rt.providerConfig().label} has no model set: pick one in the bot's details or set the provider's default model.`);
    const run = new OaiRun(this.rt, this, input, modelId, choice);
    this.active = run;
    // Appends the user message before returning: the harness marks this context seen once send() resolves.
    run.begin();
    return run;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.active?.cancel();
  }
}

interface PreparedCall {
  id: string;
  name: string;
  /** Normalized JSON as stored and sent back. */
  storedArgs: string;
  args?: Record<string, unknown>;
  /** Set when the call can't run (bad JSON, unreadable block): the result for the model. */
  error?: string;
}

const SUMMARY_SYSTEM = "You write compact, faithful summaries of an AI assistant's conversation, so it can continue its work with a much shorter context.";
const SUMMARY_REQUEST = [
  "Summarize the conversation above so the assistant can continue without it. Write Markdown with these sections:",
  "- Who and what: the people and bots involved, the assistant's role, the standing instructions and preferences it was given.",
  "- Facts and decisions: everything established that still matters (names, numbers, file paths, URLs, ids).",
  "- Work done: what the assistant did (tools used, files changed, results), briefly.",
  "- Open threads: unanswered questions, pending tasks, and what was about to happen next.",
  "If the conversation starts with an earlier summary, fold it in. Keep it under 600 words. Don't invent anything and don't address anyone.",
].join("\n");

function renderOne(m: TranscriptMessage, caps: { text: number; tool: number }): string {
  if (m.role === "tool") return `[Result of ${m.name ?? "a tool"}]\n${headTail(m.content, caps.tool)}`;
  if (m.role === "user") {
    if (isSummaryMessage(m)) return `[Summary of the conversation before this]\n${headTail(m.content.replace(/<\/?conversation_summary>/g, "").trim(), caps.text * 2)}`;
    return `[User]\n${headTail(m.content, caps.text)}`;
  }
  const calls = (m.tool_calls ?? []).map((c) => `→ called ${c.function.name} ${headTail(c.function.arguments, 300)}`);
  return [`[Assistant]`, m.content ? headTail(m.content, caps.text) : "", ...calls].filter(Boolean).join("\n");
}

/** The messages to summarize as plain text, shortened to fit `maxChars`. */
function renderForSummary(msgs: TranscriptMessage[], maxChars: number): string {
  const levels = [
    { text: 6000, tool: 1500 },
    { text: 2000, tool: 600 },
    { text: 800, tool: 200 },
  ];
  let parts: string[] = [];
  for (const caps of levels) {
    parts = msgs.map((m) => renderOne(m, caps));
    const out = parts.join("\n\n");
    if (out.length <= maxChars) return out;
  }
  // Still too long: the oldest part goes.
  while (parts.length > 1 && parts.join("\n\n").length > maxChars) parts.shift();
  const out = `(…the earliest part is left out…)\n\n${parts.join("\n\n")}`;
  return out.length > maxChars ? out.slice(out.length - maxChars) : out;
}

/**
 * When history is summarized in the middle of a turn, the identity block the
 * harness sent earlier would be lost until the next turn; carry the latest one
 * (the <harness> block with <memory>) over verbatim.
 */
function carryIdentity(head: TranscriptMessage[], kept: TranscriptMessage[]): string | undefined {
  if (kept.some((m) => m.role === "user" && /<harness>[\s\S]*<memory>/.test(m.content))) return undefined;
  for (let i = head.length - 1; i >= 0; i--) {
    const m = head[i]!;
    if (m.role !== "user") continue;
    const block = /<harness>[\s\S]*?<\/harness>/.exec(m.content)?.[0];
    if (block && block.includes("<memory>")) return block.length > 8000 ? `${block.slice(0, 8000)}\n…` : block;
  }
  return undefined;
}

class OaiRun implements RuntimeRun {
  readonly id = `oairun-${randomUUID()}`;
  private rt: OpenAICompatRuntime;
  private s: OaiSession;
  private input: SendInput;
  private modelId: string;
  private choice?: ModelChoice;
  private tools: Map<string, BoundTool>;
  private ctrl = new AbortController();
  private steers: string[] = [];
  private accepting = true;
  private cancelled = false;
  private finished = false;
  private done: Promise<RunOutcome> = Promise.resolve({ status: "cancelled", text: "" });
  private startedAt = Date.now();
  private usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  private respModel?: string;
  private requestId?: string;
  /** The user message that started this turn: kept verbatim by any compaction during the turn. */
  private turnUser?: TranscriptMessage;
  /** Images sent with this turn's messages; only placeholders are stored. */
  private images = new Map<TranscriptMessage, Image[]>();
  private lastMaxTokens = 0;

  constructor(rt: OpenAICompatRuntime, s: OaiSession, input: SendInput, modelId: string, choice?: ModelChoice) {
    this.rt = rt;
    this.s = s;
    this.input = { ...input, tools: Array.isArray(input.tools) ? input.tools : [] };
    this.modelId = modelId;
    this.choice = choice?.id === modelId ? choice : undefined;
    this.tools = new Map(this.input.tools.map((t) => [t.name, t]));
  }

  get isFinished(): boolean {
    return this.finished;
  }

  begin(): void {
    const user = this.userMessage();
    this.s.transcript.append(user);
    this.turnUser = user;
    this.rt.track(this);
    this.done = this.execute();
  }

  async steer(text: string): Promise<boolean> {
    const t = String(text ?? "").trim();
    if (!t || !this.accepting || this.finished || this.cancelled) return false;
    this.steers.push(t);
    return true;
  }

  async cancel(): Promise<void> {
    if (this.finished) return;
    this.abort();
    await this.done;
  }

  /** @internal Stop without waiting (dispose). */
  abort(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.accepting = false;
    this.ctrl.abort();
  }

  wait(): Promise<RunOutcome> {
    return this.done;
  }

  // ---------------------------------------------------------------- the loop

  private async execute(): Promise<RunOutcome> {
    try {
      const text = await this.turn();
      return this.outcome("finished", text);
    } catch (err) {
      const stopped = this.cancelled || isAbortError(err);
      const message = stopped ? "" : this.rt.scrub(String((err as Error)?.message ?? err));
      try {
        // Keep the transcript valid for the next request, and keep what the user said meanwhile.
        this.s.transcript.closeOpenCalls(stopped ? "Cancelled: the turn was stopped before this tool ran or finished." : `Not run: the turn ended with an error (${excerpt(message, 300)}).`);
        this.deliverSteers();
      } catch {
        // A write failure here must not hide the real outcome.
      }
      return stopped ? this.outcome("cancelled", "") : this.outcome("error", "", message);
    } finally {
      this.finished = true;
      this.accepting = false;
      this.steers = [];
      this.images.clear();
      this.rt.untrack(this);
    }
  }

  private async turn(): Promise<string> {
    const answers: string[] = [];
    for (let calls = 1; ; calls++) {
      this.checkAbort();
      this.deliverSteers();
      if (calls > MAX_MODEL_CALLS_PER_TURN) throw new Error(`Stopped after ${MAX_MODEL_CALLS_PER_TURN} model calls in one turn.`);
      const r = await this.callModel();
      const step = this.interpret(r);
      if (step.assistant) this.s.transcript.append(step.assistant);
      if (!step.calls.length) {
        if (step.text) answers.push(step.text);
        else if (r.finishReason === "length" && !answers.length && !this.steers.length)
          throw new Error(
            `${this.modelId} used its whole reply budget (${this.lastMaxTokens} tokens) without answering. Reasoning models think first: raise the model's max output tokens, or turn its reasoning off.`,
          );
        // A message steered in while the answer was being written gets its own model call.
        if (this.steers.length) continue;
        this.accepting = false;
        break;
      }
      await this.runCalls(step.calls, r.finishReason === "length");
    }
    const end = this.endOfTurnBudget();
    if (end.need) await this.compact("end", end.keep);
    return answers.join("\n\n");
  }

  private checkAbort(): void {
    if (this.ctrl.signal.aborted) throw abortError();
  }

  private emit(ev: RuntimeEvent): void {
    try {
      this.input.onEvent(ev);
    } catch {
      // The harness's listener failing doesn't stop the turn.
    }
  }

  private status(text: string): void {
    this.emit({ type: "status", status: text });
  }

  private deliverSteers(): void {
    while (this.steers.length) this.s.transcript.append({ role: "user", content: this.steers.shift()! });
  }

  private userMessage(): TranscriptMessage {
    const imgs = (this.input.images ?? []).filter(validImage);
    const text = String(this.input.text ?? "");
    if (!imgs.length) return { role: "user", content: text };
    const n = plural(imgs.length, "image");
    if (this.rt.vision(this.modelId)) {
      const m: TranscriptMessage = { role: "user", content: `${text}\n\n[${n} attached]` };
      this.images.set(m, imgs);
      return m;
    }
    return { role: "user", content: `${text}\n\n[${n} attached, but ${this.modelId} can't see images, so ${imgs.length === 1 ? "it was" : "they were"} left out]` };
  }

  private systemText(mode: WireMode): string {
    const parts: string[] = [];
    const sys = this.input.system?.trim();
    if (sys) parts.push(sys);
    if (mode === "prompt" && this.input.tools.length) parts.push(promptToolGuide(this.input.tools));
    return parts.join("\n\n");
  }

  private wire(mode: WireMode): WireMessage[] {
    const msgs = this.s.transcript.messages;
    return toWire(msgs, {
      mode,
      vision: this.rt.vision(this.modelId),
      images: this.images,
      reasoningField: this.rt.quirk(this.modelId).reasoningField,
      turnStart: this.turnUser ? msgs.indexOf(this.turnUser) : msgs.length,
    });
  }

  private toolSpecs(mode: WireMode) {
    return mode === "native" ? this.input.tools.map(toolSpec) : undefined;
  }

  private estimateFor(mode: WireMode): number {
    return this.rt.scaled(this.modelId, estimateRequest(this.systemText(mode), this.wire(mode), this.toolSpecs(mode)));
  }

  private request(mode: WireMode): { body: Record<string, unknown>; estimate: number; maxTokens: number } {
    const system = this.systemText(mode);
    const wire = this.wire(mode);
    const tools = this.toolSpecs(mode);
    const estimate = estimateRequest(system, wire, tools);
    const maxTokens = this.rt.replyLimit(this.modelId, this.rt.scaled(this.modelId, estimate), this.choice);
    const messages: WireMessage[] = system ? [{ role: "system", content: system }, ...wire] : wire;
    const body = this.rt.makeBody({ modelId: this.modelId, messages, stream: true, tools, maxTokens, choice: this.choice });
    return { body, estimate, maxTokens };
  }

  private async callModel(): Promise<ChatResult & { mode: WireMode }> {
    let overflowRetried = false;
    let switched = false;
    for (;;) {
      const mode = this.rt.toolModeFor(this.modelId, this.input.tools.length > 0);
      await this.fitBudget(mode);
      const req = this.request(mode);
      this.lastMaxTokens = req.maxTokens;
      try {
        const res = await this.rt.chat({
          modelId: this.modelId,
          body: req.body,
          stream: true,
          signal: this.ctrl.signal,
          emit: (ev) => this.emit(ev),
          status: (t) => this.status(t),
          hideMarkup: mode !== "none",
          estimate: req.estimate,
        });
        this.count(res, req.estimate);
        return { ...res, mode };
      } catch (err) {
        if (!(err instanceof ProviderError) || err.emitted) throw err;
        const label = this.rt.providerConfig().label;
        if (err.kind === "context" && !overflowRetried) {
          // The server counted more than we did: compact harder (to about half the window) and try once more.
          overflowRetried = true;
          this.rt.learnOverflow(this.modelId, err.detail, req.estimate);
          await this.compact("overflow");
          const half = this.rt.windowFor(this.modelId) * 0.5;
          for (const max of [2000, 600]) if (this.estimateFor(mode) > half) this.shorten("in-turn", max, true);
          continue;
        }
        if (err.kind === "tools" && mode === "native" && !switched && this.rt.configuredToolMode(this.modelId) === "auto") {
          switched = true;
          this.rt.setPromptTools(this.modelId);
          this.status(`${this.modelId} on ${label} doesn't take native tool calls; switching to text tool calls.`);
          continue;
        }
        if (err.kind === "context")
          throw new ProviderError(
            "context",
            `The conversation is too long for ${this.modelId}'s context window even after compacting it (${label}: ${err.detail}). Pick a model with a larger context window, or set this model's context window lower so the bot compacts sooner.`,
            { status: err.status, detail: err.detail },
          );
        throw err;
      }
    }
  }

  private count(res: ChatResult, estimate: number): void {
    const u = res.usage;
    const inT = Number(u?.prompt_tokens) || this.rt.scaled(this.modelId, estimate);
    const outChars = res.text.length + res.reasoning.length + res.calls.reduce((n, c) => n + c.name.length + c.args.length, 0);
    const outT = Number(u?.completion_tokens) || Math.ceil(outChars / CHARS_PER_TOKEN);
    const total = Number(u?.total_tokens) || inT + outT;
    this.usage.inputTokens += inT;
    this.usage.outputTokens += outT;
    this.usage.totalTokens += total;
    if (res.model) this.respModel = res.model;
    this.requestId = res.requestId ?? res.id ?? this.requestId;
  }

  /** Turn the model's reply into the assistant message and the calls to run. */
  private interpret(r: ChatResult & { mode: WireMode }): { assistant?: TranscriptMessage; calls: PreparedCall[]; text: string } {
    const names = new Set(this.tools.keys());
    let text = r.text;
    let raw: Array<{ name: string; args: string; id?: string; malformed?: string }> = r.calls.map((c) => ({ name: c.name, args: c.args, id: c.id }));
    if (r.mode === "prompt") {
      const ex = extractToolCalls(text, names, true);
      text = ex.rest;
      raw = [...raw, ...ex.calls];
    } else if (r.mode === "native") {
      const ex = extractToolCalls(text, names, false);
      if (ex.calls.length) {
        text = ex.rest;
        if (!raw.length) {
          // The model wrote its calls as text instead of using the API's tool calls.
          raw = ex.calls;
          if (this.rt.configuredToolMode(this.modelId) === "auto") {
            this.rt.setPromptTools(this.modelId);
            this.status(`${this.modelId} writes its tool calls as text; using text tool calls from now on.`);
          }
        }
      }
    }
    // A model that writes tool results itself is making them up: drop that part.
    if (raw.length) text = text.replace(/<tool_response[\s\S]*$/, "");
    text = text.trim();
    const calls = raw.map((c) => this.prepare(c));
    if (!text && !calls.length) return { calls, text };
    const assistant: TranscriptMessage = { role: "assistant", content: text };
    if (calls.length) assistant.tool_calls = calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.storedArgs } }));
    if (r.reasoning) assistant.reasoning_content = r.reasoning;
    return { assistant, calls, text };
  }

  private prepare(c: { name: string; args: string; id?: string; malformed?: string }): PreparedCall {
    const used = this.s.callIds;
    const id = c.id && /^[A-Za-z0-9_.:-]{1,64}$/.test(c.id) && !used.has(c.id) ? c.id : newCallId(used);
    used.add(id);
    const name = c.name || "invalid_tool_call";
    if (c.malformed) return { id, name, storedArgs: "{}", error: c.malformed };
    const parsed = parseToolArguments(c.args);
    if (!parsed.ok)
      return {
        id,
        name,
        // Stored history must stay valid JSON: some servers parse it and reject the whole request otherwise.
        storedArgs: "{}",
        error: `Your arguments for ${name} weren't valid JSON (${parsed.error}), so the tool didn't run. You sent: ${excerpt(c.args, 300)}. Call it again with the arguments as one JSON object.`,
      };
    return { id, name, storedArgs: JSON.stringify(parsed.value), args: parsed.value };
  }

  private async runCalls(calls: PreparedCall[], cutOff: boolean): Promise<void> {
    const vision = this.rt.vision(this.modelId);
    const images: Image[] = [];
    const from = new Set<string>();
    for (const c of calls) {
      this.checkAbort();
      const tool = this.tools.get(c.name);
      let out: ToolOutput;
      if (cutOff)
        out = {
          text: `Not run: your reply hit its length limit (${this.lastMaxTokens} tokens) before this call was complete. Make the call again with shorter arguments (write big files in several smaller steps).`,
          isError: true,
        };
      else if (c.error) out = { text: c.error, isError: true };
      else if (!tool) out = { text: `There is no tool named "${c.name}". Use one of: ${[...this.tools.keys()].join(", ") || "(none)"}.`, isError: true };
      else {
        this.emit({ type: "tool", callId: c.id, name: c.name, status: "running", args: c.args });
        out = await this.execTool(tool, c.args ?? {});
      }
      let content = capToolResult(typeof out?.text === "string" ? out.text : String(out?.text ?? "")) || "(no output)";
      const imgs = (out?.images ?? []).filter(validImage);
      if (imgs.length) {
        if (vision) {
          images.push(...imgs);
          from.add(c.name);
        } else content += `\n\n(The tool also returned ${plural(imgs.length, "image")}, but ${this.modelId} can't see images.)`;
      }
      this.emit({ type: "tool", callId: c.id, name: c.name, status: out?.isError ? "error" : "completed", args: c.args, result: content });
      this.s.transcript.append({ role: "tool", tool_call_id: c.id, name: c.name, content });
    }
    if (images.length) {
      // Most servers take images only in user messages, so they follow the results.
      const msg: TranscriptMessage = { role: "user", content: `[${plural(images.length, "image")} from ${[...from].join(", ")} attached]` };
      this.s.transcript.append(msg);
      this.images.set(msg, images);
    }
  }

  private async execTool(tool: BoundTool, args: Record<string, unknown>): Promise<ToolOutput> {
    const signal = this.ctrl.signal;
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => reject(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
    });
    stopped.catch(() => {});
    try {
      return await Promise.race([Promise.resolve().then(() => tool.execute(args, { signal })), stopped]);
    } catch (err) {
      if (signal.aborted) throw abortError();
      return { text: `The tool ${tool.name} failed: ${(err as Error)?.message ?? err}`, isError: true };
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  private outcome(status: RunOutcome["status"], text: string, error?: string): RunOutcome {
    return {
      status,
      text,
      error,
      requestId: this.requestId,
      model: this.respModel ?? this.modelId,
      usage: this.usage.totalTokens ? { ...this.usage } : undefined,
      durationMs: Date.now() - this.startedAt,
    };
  }

  // ---------------------------------------------------------------- context management

  /** Before a request: shorten old tool results, then summarize, so prompt + reply fit in ~90% of the window. */
  private async fitBudget(mode: WireMode): Promise<void> {
    const budget = this.rt.promptBudget(this.modelId, this.choice);
    const over = () => this.estimateFor(mode) > budget;
    if (!over()) return;
    if (this.shorten("before-turn", 1500) && !over()) return;
    await this.compact("budget");
    if (!over()) return;
    for (const max of [4000, 1500, 500]) if (this.shorten("in-turn", max) && !over()) return;
    this.shorten("in-turn", 1500, true);
  }

  /** The transcript share at the end of a turn, and how much to keep verbatim when compacting. */
  private endOfTurnBudget(): { need: boolean; keep: number } {
    const mode = this.rt.toolModeFor(this.modelId, this.input.tools.length > 0);
    const window = this.rt.windowFor(this.modelId);
    const fixed = this.rt.scaled(this.modelId, estimateRequest(this.systemText(mode), [], this.toolSpecs(mode)));
    const used = this.rt.scaled(
      this.modelId,
      this.s.transcript.messages.reduce((n, m) => n + estimateStored(m), 0),
    );
    const budget = Math.max(window * END_OF_TURN_COMPACT_AT - fixed, window * 0.15);
    return { need: used > budget, keep: budget * 0.4 };
  }

  /** Shorten long tool results: before this turn, or within it (all but the newest round unless `newest`). */
  private shorten(scope: "before-turn" | "in-turn", max: number, newest = false): boolean {
    const msgs = this.s.transcript.messages;
    const start = this.turnUser ? msgs.indexOf(this.turnUser) : -1;
    let lastAssistant = -1;
    for (let i = msgs.length - 1; i >= 0; i--)
      if (msgs[i]!.role === "assistant") {
        lastAssistant = i;
        break;
      }
    let changed = false;
    msgs.forEach((m, i) => {
      if (m.role !== "tool" || m.content.length <= max) return;
      const inTurn = start >= 0 && i > start;
      if (scope === "before-turn" ? inTurn : !inTurn) return;
      if (scope === "in-turn" && !newest && i > lastAssistant) return;
      m.content = headTail(m.content, max, "left out to save context");
      changed = true;
    });
    if (changed) this.s.transcript.rewrite();
    return changed;
  }

  /**
   * Summarize older history into one message at the start of the transcript.
   * "end": after the answer, keep the newest messages that fit `keep` tokens.
   * "budget"/"overflow": mid-turn, keep this turn's user message and everything after it.
   * If the summary can't be made, the older messages are dropped instead.
   */
  private async compact(reason: "end" | "budget" | "overflow", keep = 0): Promise<boolean> {
    const t = this.s.transcript;
    const msgs = t.messages;
    let cut: number;
    if (reason === "end") {
      cut = msgs.length;
      let total = 0;
      for (let i = msgs.length - 1; i > 0; i--) {
        total += this.rt.scaled(this.modelId, estimateStored(msgs[i]!));
        if (total > keep) break;
        // Cut only before a user message, so no tool call is separated from its results.
        if (msgs[i]!.role === "user") cut = i;
      }
    } else {
      cut = this.turnUser ? msgs.indexOf(this.turnUser) : -1;
      if (cut < 0) cut = msgs.findLastIndex((m) => m.role === "user");
      if (cut < 0) cut = 0;
    }
    const head = msgs.slice(0, cut);
    if (!head.length || (head.length <= 2 && isSummaryMessage(head[0]))) return false;
    this.status(`Compacting the conversation to fit ${this.modelId}'s context window…`);
    let summary: string | undefined;
    try {
      summary = await this.summarize(head);
    } catch (err) {
      if (this.ctrl.signal.aborted || isAbortError(err)) throw abortError();
    }
    const kept = msgs.slice(cut);
    let note = summary ?? "(The earlier conversation was dropped to fit the model's context window; no summary could be made.)";
    if (reason !== "end") {
      const identity = carryIdentity(head, kept);
      if (identity) note += `\n\nThe identity and memory you were given most recently:\n${identity}`;
    }
    t.replace([{ role: "user", content: `<conversation_summary>\n${note}\n</conversation_summary>` }, { role: "assistant", content: SUMMARY_ACK }, ...kept]);
    this.emit({ type: "summary" });
    return true;
  }

  private async summarize(head: TranscriptMessage[]): Promise<string> {
    const rt = this.rt;
    const id = this.modelId;
    const window = rt.windowFor(id);
    const maxTokens = Math.max(512, Math.min(4096, Math.floor(window * 0.25)));
    const roomTokens = Math.floor(window * 0.85) - maxTokens - 400;
    const roomChars = Math.max(2000, Math.floor((roomTokens * CHARS_PER_TOKEN) / rt.ratio(id)));
    const messages: WireMessage[] = [
      { role: "system", content: SUMMARY_SYSTEM },
      { role: "user", content: `<conversation>\n${renderForSummary(head, roomChars)}\n</conversation>\n\n${SUMMARY_REQUEST}` },
    ];
    const estimate = estimateRequest("", messages);
    const body = rt.makeBody({ modelId: id, messages, stream: false, maxTokens, temperature: 0 });
    const res = await rt.chat({ modelId: id, body, stream: false, signal: this.ctrl.signal, status: (s) => this.status(s), estimate });
    this.count(res, estimate);
    const text = res.text.replace(/<\/?conversation_summary>/g, "").trim();
    if (!text) throw new Error("The model returned an empty summary.");
    return headTail(text, 12_000);
  }
}
