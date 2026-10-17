import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { Harness } from "../src/core/harness.ts";
import type { ProviderConfig } from "../src/core/types.ts";
import {
  OpenAICompatRuntime,
  SseParser,
  ThinkFilter,
  UnitSemaphore,
  classifyError,
  extractToolCalls,
  parseToolArguments,
  repairToolPairs,
} from "../src/runtimes/openai.ts";
import type { BoundTool, RunOutcome, RuntimeEvent, RuntimeRun, RuntimeSession, SendInput, ToolOutput } from "../src/runtimes/types.ts";
import { FakeOpenAI, completion, delta, finish, hold, json, sse, textReply, toolCallReply } from "./fake-openai.ts";
import { settle } from "./helpers.ts";

const KEY = "sk-test-secret-123";
const server = new FakeOpenAI();

before(async () => {
  await server.start();
});
after(async () => {
  await server.close();
});
beforeEach(() => server.reset());

// ---------------------------------------------------------------- helpers

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

function setup(
  o: { provider?: Partial<ProviderConfig>; key?: string | null; sleep?: Sleep; fetch?: typeof fetch; firstByteTimeoutMs?: number; idleTimeoutMs?: number } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oai-runtime-"));
  const provider: ProviderConfig = {
    id: "fake",
    label: "Fake AI",
    baseUrl: server.url,
    enabled: true,
    maxConcurrency: 4,
    toolMode: "native",
    defaultModel: "test-model",
    models: [{ id: "test-model", contextWindow: 32768 }],
    createdAt: 0,
    updatedAt: 0,
    ...o.provider,
  };
  const key = { value: o.key === null ? undefined : (o.key ?? KEY) };
  const sleeps: number[] = [];
  const rt = new OpenAICompatRuntime({
    provider: () => provider,
    apiKey: () => key.value,
    transcriptDir: dir,
    appName: "Cursor Bots",
    appUrl: "https://example.test/app",
    fetch: o.fetch,
    firstByteTimeoutMs: o.firstByteTimeoutMs,
    idleTimeoutMs: o.idleTimeoutMs,
    sleep:
      o.sleep ??
      (async (ms) => {
        sleeps.push(ms);
        await new Promise((r) => setImmediate(r));
      }),
  });
  const file = (agentId: string) => path.join(dir, `${agentId}.jsonl`);
  return {
    rt,
    provider,
    dir,
    sleeps,
    key,
    file,
    /** The transcript's parsed lines (torn ones skipped). */
    lines(agentId: string): any[] {
      const out: any[] = [];
      for (const l of fs.readFileSync(file(agentId), "utf8").split("\n")) {
        if (!l.trim()) continue;
        try {
          out.push(JSON.parse(l));
        } catch {
          // torn
        }
      }
      return out;
    },
    open(agentId?: string, model = "test-model") {
      return rt.open({ botId: "bot_1", agentId, name: "Tester", cwd: dir, model: { id: model } });
    },
    async cleanup() {
      await rt.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

type Tool = BoundTool & { calls: Array<Record<string, unknown>> };

function makeTool(name: string, run: (args: Record<string, unknown>) => ToolOutput | string | Promise<ToolOutput | string> = () => "ok"): Tool {
  const calls: Array<Record<string, unknown>> = [];
  return {
    name,
    description: `The ${name} tool.`,
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: [], additionalProperties: false },
    calls,
    async execute(args) {
      calls.push(args);
      const r = await run(args);
      return typeof r === "string" ? { text: r } : r;
    },
  };
}

interface Turn {
  run: RuntimeRun;
  events: RuntimeEvent[];
  outcome: RunOutcome;
}

async function start(session: RuntimeSession, text: string, o: Partial<SendInput> = {}) {
  const events: RuntimeEvent[] = [];
  const run = await session.send({ text, tools: [], mcpServers: {}, onEvent: (e) => events.push(e), ...o });
  return { run, events };
}

/** One whole turn, including the end-of-turn compaction that runs after the outcome. */
async function turn(session: RuntimeSession, text: string, o: Partial<SendInput> = {}): Promise<Turn> {
  const { run, events } = await start(session, text, o);
  const outcome = await run.wait();
  await (session as RuntimeSession & { settled?: () => Promise<void> }).settled?.();
  return { run, events, outcome };
}

function joined(events: RuntimeEvent[], type: "text" | "thinking"): string {
  return events.map((e) => (e.type === type ? e.text : "")).join("");
}

function statuses(events: RuntimeEvent[]): string[] {
  return events.flatMap((e) => (e.type === "status" ? [e.status] : []));
}

function toolEvents(events: RuntimeEvent[]) {
  return events.flatMap((e) => (e.type === "tool" ? [e] : []));
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

function assertValid(lines: any[]): void {
  assert.equal(repairToolPairs(lines).changed, false, `dangling tool calls in ${JSON.stringify(lines)}`);
  assert.ok(!lines.some((l) => l.role === "system"), "no system prompt in the transcript");
}

// ---------------------------------------------------------------- basics

test("streams text and reports usage, model and request id; the request carries model, system, tools and key", async () => {
  const t = setup();
  try {
    server.push((r, res) => sse(res, textReply("Hello world", { usage: [120, 7] }), { split: 5, crlf: true, comments: true, headers: { "x-request-id": "req-123" } }));
    const session = await t.open();
    assert.match(session.agentId, /^oai-[0-9a-f-]{36}$/);
    const memory = makeTool("memory_update");
    const { run, events } = await start(session, "Hi there", { system: "SYSTEM RULES", tools: [memory] });
    // The user message is on disk before send() resolves.
    assert.deepEqual(t.lines(session.agentId), [{ role: "user", content: "Hi there" }]);
    const outcome = await run.wait();
    assert.equal(outcome.status, "finished");
    assert.equal(outcome.text, "Hello world");
    assert.equal(joined(events, "text"), "Hello world");
    assert.deepEqual(outcome.usage, { inputTokens: 120, outputTokens: 7, totalTokens: 127 });
    assert.equal(outcome.model, "test-model-2024");
    assert.equal(outcome.requestId, "req-123");
    assert.equal(typeof outcome.durationMs, "number");

    const req = server.chats()[0]!;
    assert.equal(req.path, "/v1/chat/completions");
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    assert.equal(req.headers["http-referer"], "https://example.test/app");
    assert.equal(req.headers["x-title"], "Cursor Bots");
    assert.equal(req.body.model, "test-model");
    assert.equal(req.body.stream, true);
    assert.deepEqual(req.body.stream_options, { include_usage: true });
    assert.deepEqual(req.body.messages, [
      { role: "system", content: "SYSTEM RULES" },
      { role: "user", content: "Hi there" },
    ]);
    assert.deepEqual(req.body.tools, [{ type: "function", function: { name: "memory_update", description: memory.description, parameters: memory.inputSchema } }]);
    assert.equal(req.body.tool_choice, undefined);
    assert.equal(req.body.max_tokens, 8192);

    const lines = t.lines(session.agentId);
    assert.deepEqual(lines, [
      { role: "user", content: "Hi there" },
      { role: "assistant", content: "Hello world" },
    ]);
    const raw = fs.readFileSync(t.file(session.agentId), "utf8");
    assert.ok(!raw.includes(KEY) && !raw.includes("SYSTEM RULES"));
  } finally {
    await t.cleanup();
  }
});

test("no key header without a key; provider headers are sent; the reply limit follows the window and maxTokensParam", async () => {
  const t = setup({
    key: null,
    provider: { headers: { "X-Extra": "yes" }, maxTokensParam: "max_completion_tokens", models: [{ id: "test-model", contextWindow: 4096, maxOutputTokens: 2000 }] },
  });
  try {
    server.push((r, res) => sse(res, textReply("ok")));
    const session = await t.open();
    await turn(session, "x".repeat(3500));
    const req = server.chats()[0]!;
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers["x-extra"], "yes");
    assert.equal(req.body.max_tokens, undefined);
    // 4096 window, ~1000-token prompt, 256 margin: less than the model's 2000 cap.
    const limit = req.body.max_completion_tokens;
    assert.ok(limit >= 256 && limit < 4096 - 1000, `limit ${limit}`);
    assert.ok(limit <= 2000);
  } finally {
    await t.cleanup();
  }
});

test("estimates usage when the provider sends none", async () => {
  const t = setup();
  try {
    server.push((r, res) => sse(res, textReply("A short answer.")));
    const { outcome } = await turn(await t.open(), "Some question for the model");
    assert.equal(outcome.status, "finished");
    assert.ok(outcome.usage && outcome.usage.inputTokens > 0 && outcome.usage.outputTokens > 0);
    assert.equal(outcome.usage.totalTokens, outcome.usage.inputTokens + outcome.usage.outputTokens);
    assert.equal(outcome.requestId, "chatcmpl-1");
  } finally {
    await t.cleanup();
  }
});

test("model params map to request fields, unknown ids are dropped, and the model's extra fields are merged", async () => {
  const t = setup({ provider: { models: [{ id: "test-model", extraBody: { chat_template_kwargs: { enable_thinking: false }, temperature: 0.9 } }] } });
  try {
    server.push((r, res) => sse(res, textReply("ok")));
    const session = await t.open();
    await turn(session, "hi", {
      model: {
        id: "test-model",
        params: [
          { id: "fast", value: "true" },
          { id: "temperature", value: "0.3" },
          { id: "top_k", value: "40" },
          { id: "minP", value: "0.05" },
          { id: "repetition_penalty", value: "1.1" },
          { id: "seed", value: "7" },
          { id: "reasoning_effort", value: "low" },
          { id: "max_tokens", value: "500" },
          { id: "top_p", value: "not a number" },
        ],
      },
    });
    const body = server.chats()[0]!.body;
    assert.equal(body.temperature, 0.3);
    assert.equal(body.top_k, 40);
    assert.equal(body.min_p, 0.05);
    assert.equal(body.repetition_penalty, 1.1);
    assert.equal(body.seed, 7);
    assert.equal(body.reasoning_effort, "low");
    assert.equal(body.max_tokens, 500);
    assert.equal(body.top_p, undefined);
    assert.equal(body.fast, undefined);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  } finally {
    await t.cleanup();
  }
});

// ---------------------------------------------------------------- tool calls

test("runs streamed parallel tool calls in order and sends the results back", async () => {
  const t = setup();
  try {
    const order: string[] = [];
    const read = makeTool("read_file", () => {
      order.push("read");
      return "A contents";
    });
    const list = makeTool("list_dir", () => {
      order.push("list");
      return "x\ny";
    });
    server.push(
      (r, res) =>
        sse(
          res,
          toolCallReply(
            [
              { id: "call_a", name: "read_file", args: '{"path": "a.md"}' },
              { id: "call_b", name: "list_dir", args: '{"path": "."}' },
            ],
            { text: "Let me check. ", size: 3 },
          ),
          { split: 9 },
        ),
      (r, res) => sse(res, textReply("All done.")),
    );
    const session = await t.open();
    const { outcome, events } = await turn(session, "look around", { tools: [read, list] });
    assert.equal(outcome.status, "finished");
    assert.equal(outcome.text, "All done.");
    assert.deepEqual(order, ["read", "list"]);
    assert.deepEqual(read.calls, [{ path: "a.md" }]);
    assert.deepEqual(list.calls, [{ path: "." }]);
    assert.deepEqual(
      toolEvents(events).map((e) => [e.callId, e.name, e.status, e.args]),
      [
        ["call_a", "read_file", "running", { path: "a.md" }],
        ["call_a", "read_file", "completed", { path: "a.md" }],
        ["call_b", "list_dir", "running", { path: "." }],
        ["call_b", "list_dir", "completed", { path: "." }],
      ],
    );
    const second = server.chats()[1]!.body;
    assert.ok(second.tools?.length === 2, "tools go with every request of the loop");
    const msgs = second.messages;
    assert.deepEqual(msgs[1], {
      role: "assistant",
      content: "Let me check.",
      tool_calls: [
        { id: "call_a", type: "function", function: { name: "read_file", arguments: '{"path":"a.md"}' } },
        { id: "call_b", type: "function", function: { name: "list_dir", arguments: '{"path":"."}' } },
      ],
    });
    assert.deepEqual(msgs[2], { role: "tool", tool_call_id: "call_a", content: "A contents" });
    assert.deepEqual(msgs[3], { role: "tool", tool_call_id: "call_b", content: "x\ny" });
    assertValid(t.lines(session.agentId));
  } finally {
    await t.cleanup();
  }
});

test("invalid argument JSON isn't executed; the model gets an error and the loop goes on", async () => {
  const t = setup();
  try {
    const read = makeTool("read_file");
    server.push(
      (r, res) => sse(res, toolCallReply([{ id: "call_x", name: "read_file", args: '{"path": "a.md"' }])),
      (r, res) => sse(res, textReply("Sorry about that.")),
    );
    const session = await t.open();
    const { outcome, events } = await turn(session, "read it", { tools: [read] });
    assert.equal(outcome.text, "Sorry about that.");
    assert.equal(read.calls.length, 0);
    assert.deepEqual(
      toolEvents(events).map((e) => [e.name, e.status]),
      [["read_file", "error"]],
    );
    const msgs = server.chats()[1]!.body.messages;
    const assistant = msgs.find((m: any) => m.role === "assistant");
    assert.equal(assistant.tool_calls[0].function.arguments, "{}", "stored arguments stay valid JSON");
    const result = msgs.find((m: any) => m.role === "tool");
    assert.match(result.content, /weren't valid JSON/);
    assertValid(t.lines(session.agentId));
  } finally {
    await t.cleanup();
  }
});

test("unknown tools and calls cut off by the length limit don't run", async () => {
  const t = setup();
  try {
    const write = makeTool("write_file");
    server.push(
      (r, res) => sse(res, toolCallReply([{ id: "c1", name: "write_file", args: '{"path": "a.md"}' }], { finish: "length" })),
      (r, res) => sse(res, toolCallReply([{ id: "c2", name: "nope", args: "{}" }])),
      (r, res) => sse(res, textReply("ok")),
    );
    const session = await t.open();
    const { outcome } = await turn(session, "write", { tools: [write] });
    assert.equal(outcome.text, "ok");
    assert.equal(write.calls.length, 0);
    const second = server.chats()[1]!.body.messages.find((m: any) => m.role === "tool");
    assert.match(second.content, /Not run: your reply hit its length limit/);
    const third = server.chats()[2]!.body.messages.filter((m: any) => m.role === "tool").at(-1);
    assert.match(third.content, /There is no tool named "nope"/);
    assertValid(t.lines(session.agentId));
  } finally {
    await t.cleanup();
  }
});

test("tool errors give an error event; tool images go to vision models only, never to disk", async () => {
  const shot = () =>
    makeTool("screenshot", () => ({ text: "took it", isError: true, images: [{ data: "QUJDREVG", mimeType: "image/png" }] }));
  // A model that can't see: a note instead of the image.
  let t = setup();
  try {
    const tool = shot();
    server.push((r, res) => sse(res, toolCallReply([{ id: "s1", name: "screenshot", args: "{}" }])), (r, res) => sse(res, textReply("seen")));
    const { events } = await turn(await t.open(), "look", { tools: [tool] });
    assert.deepEqual(
      toolEvents(events).map((e) => e.status),
      ["running", "error"],
    );
    const body = server.chats()[1]!.body;
    assert.match(body.messages.find((m: any) => m.role === "tool").content, /can't see images/);
    assert.ok(!JSON.stringify(body).includes("QUJDREVG"));
  } finally {
    await t.cleanup();
  }
  // A vision model: the image follows the tool results as a user message.
  server.reset();
  t = setup({ provider: { defaultModel: "vis", models: [{ id: "vis", vision: true }] } });
  try {
    const tool = shot();
    server.push((r, res) => sse(res, toolCallReply([{ id: "s1", name: "screenshot", args: "{}" }])), (r, res) => sse(res, textReply("seen")));
    const session = await t.open(undefined, "vis");
    await turn(session, "look", { tools: [tool], model: { id: "vis" } });
    const msgs = server.chats()[1]!.body.messages;
    const last = msgs.at(-1);
    assert.equal(last.role, "user");
    assert.deepEqual(last.content[1], { type: "image_url", image_url: { url: "data:image/png;base64,QUJDREVG" } });
    assert.equal(msgs.at(-2).role, "tool");
    const raw = fs.readFileSync(t.file(session.agentId), "utf8");
    assert.ok(!raw.includes("QUJDREVG"));
    assert.ok(raw.includes("[1 image from screenshot attached]"));
  } finally {
    await t.cleanup();
  }
});

test("attached images: parts for a vision model (this turn only), a note otherwise; placeholders on disk", async () => {
  const image = { data: "SU1BR0VEQVRB", mimeType: "image/jpeg" };
  let t = setup({ provider: { defaultModel: "vis", models: [{ id: "vis", vision: true }] } });
  try {
    server.push((r, res) => sse(res, textReply("a cat")), (r, res) => sse(res, textReply("still a cat")));
    const session = await t.open(undefined, "vis");
    await turn(session, "what is this?", { images: [image] });
    const user = server.chats()[0]!.body.messages.at(-1);
    assert.deepEqual(user.content, [
      { type: "text", text: "what is this?\n\n[1 image attached]" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,SU1BR0VEQVRB" } },
    ]);
    await turn(session, "and now?");
    const later = server.chats()[1]!.body;
    assert.ok(!JSON.stringify(later).includes("SU1BR0VEQVRB"), "images aren't sent again in later turns");
    assert.ok(!fs.readFileSync(t.file(session.agentId), "utf8").includes("SU1BR0VEQVRB"));
  } finally {
    await t.cleanup();
  }
  server.reset();
  t = setup();
  try {
    server.push((r, res) => sse(res, textReply("no idea")));
    await turn(await t.open(), "what is this?", { images: [image, image] });
    const user = server.chats()[0]!.body.messages.at(-1);
    assert.equal(typeof user.content, "string");
    assert.match(user.content, /\[2 images attached, but test-model can't see images, so they were left out\]/);
  } finally {
    await t.cleanup();
  }
});

// ---------------------------------------------------------------- reasoning

test("reasoning (fields and <think> tags split across chunks) goes to thinking events, never into the reply", async () => {
  const t = setup();
  try {
    server.push(
      (r, res) =>
        sse(res, [
          delta({ role: "assistant", reasoning_content: "step 1. " }),
          delta({ content: "<thi" }),
          delta({ content: "nk>pondering" }),
          delta({ content: "</th" }),
          delta({ content: "ink>\n\nThe answer" }),
          delta({ content: " is 42." }),
          finish("stop"),
        ]),
      // A template that opens the think block in the prompt: only the closing tag appears.
      (r, res) => sse(res, [delta({ content: "I should greet.</th" }), delta({ content: "ink>Hello!" }), finish("stop")]),
      // Learned: replies start inside a think block; one that never closes it was the answer after all.
      (r, res) => sse(res, textReply("Plain answer.")),
    );
    const session = await t.open();
    const one = await turn(session, "q1");
    assert.equal(one.outcome.text, "The answer is 42.");
    assert.equal(joined(one.events, "text"), "The answer is 42.");
    assert.match(joined(one.events, "thinking"), /step 1\. [\s\S]*pondering/);
    const stored = t.lines(session.agentId)[1];
    assert.equal(stored.content, "The answer is 42.");
    assert.match(stored.reasoning_content, /step 1\.[\s\S]*pondering/);

    const two = await turn(session, "q2");
    assert.equal(two.outcome.text, "Hello!");
    const three = await turn(session, "q3");
    assert.equal(three.outcome.text, "Plain answer.");
  } finally {
    await t.cleanup();
  }
});

test("reasoning goes back with this turn's tool calls only, and is dropped if the server rejects it", async () => {
  const t = setup();
  try {
    const read = makeTool("read_file", () => "A");
    const reasoned = (thought: string, id: string) => (r: unknown, res: any) =>
      sse(res, [delta({ reasoning_content: thought }), ...toolCallReply([{ id, name: "read_file", args: "{}" }]).slice(1)]);
    server.push(
      reasoned("I need the file.", "r1"),
      (r, res) => sse(res, textReply("Done.")),
      reasoned("Again.", "r2"),
      (r, res) => json(res, 400, { error: { message: "Extra inputs are not permitted: messages.6.reasoning_content" } }),
      (r, res) => sse(res, textReply("Next.")),
    );
    const session = await t.open();
    await turn(session, "go", { tools: [read] });
    assert.equal(server.chats()[1]!.body.messages[1].reasoning_content, "I need the file.");
    // A later turn: earlier reasoning stays out; a server that rejects the field gets the request again without it.
    const next = await turn(session, "next", { tools: [read] });
    assert.equal(next.outcome.text, "Next.");
    const [third, fourth, fifth] = server.chats().slice(2);
    assert.equal(third!.body.messages[1].reasoning_content, undefined);
    assert.equal(fourth!.body.messages.at(-2).reasoning_content, "Again.");
    assert.ok(!JSON.stringify(fifth!.body).includes("reasoning_content"));
  } finally {
    await t.cleanup();
  }
});

test("timeouts: no first chunk in time is retried; a stall after text is an error", async () => {
  let t = setup({ firstByteTimeoutMs: 100 });
  try {
    server.fallback = (r, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
    };
    const { outcome } = await turn(await t.open(), "hi");
    assert.equal(outcome.status, "error");
    assert.match(outcome.error!, /Fake AI didn't start answering within 1 second\. \(gave up after 2 retries\)/);
    assert.equal(server.chats().length, 3);
  } finally {
    await t.cleanup();
  }
  server.reset();
  t = setup({ idleTimeoutMs: 100 });
  try {
    server.push((r, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify(delta({ content: "Half a" }))}\n\n`);
    });
    const { outcome } = await turn(await t.open(), "hi");
    assert.equal(outcome.status, "error");
    assert.match(outcome.error!, /Fake AI stopped sending in the middle of a reply/);
    assert.equal(server.chats().length, 1);
  } finally {
    await t.cleanup();
  }
});

test("complete(): one non-streamed call, no tools, temperature 0, small limit, reasoning stripped", async () => {
  const t = setup({ provider: { routerModel: "router-model" } });
  try {
    server.push((r, res) => json(res, 200, completion("<think>Maybe @alice?</think> @bob ")));
    const answer = await t.rt.complete("Who should answer?");
    assert.equal(answer, "@bob");
    const body = server.chats()[0]!.body;
    assert.equal(body.model, "router-model");
    assert.equal(body.stream, false);
    assert.equal(body.temperature, 0);
    assert.equal(body.max_tokens, 1024);
    assert.equal(body.tools, undefined);
    assert.equal(body.stream_options, undefined);
    assert.deepEqual(body.messages, [{ role: "user", content: "Who should answer?" }]);
    // An explicit model wins.
    server.push((r, res) => json(res, 200, completion("ok")));
    await t.rt.complete("x", { model: { id: "other", params: [{ id: "fast", value: "true" }] } });
    assert.equal(server.chats()[1]!.body.model, "other");
  } finally {
    await t.cleanup();
  }
});

// ---------------------------------------------------------------- tool modes

test("prompt mode: tools described in the system message, <tool_call> blocks parsed and hidden, results as <tool_response>", async () => {
  const t = setup({ provider: { toolMode: "prompt" } });
  try {
    const read = makeTool("read_file", () => "A contents");
    server.push(
      (r, res) =>
        sse(res, [
          delta({ content: "Checking." }),
          delta({ content: "<tool_" }),
          delta({ content: 'call>\n{"name": "read_file", "arguments": {"path": "a.md"}}\n</tool' }),
          delta({ content: "_call>" }),
          finish("stop"),
        ]),
      (r, res) => sse(res, textReply("Done reading.")),
    );
    const session = await t.open();
    const { outcome, events } = await turn(session, "read a.md", { system: "RULES", tools: [read] });
    assert.equal(outcome.text, "Done reading.");
    assert.deepEqual(read.calls, [{ path: "a.md" }]);
    const shown = joined(events, "text");
    assert.ok(!shown.includes("tool_call") && !shown.includes("a.md"), shown);
    assert.ok(shown.includes("Checking."));
    const first = server.chats()[0]!.body;
    assert.equal(first.tools, undefined);
    assert.match(first.messages[0].content, /^RULES\n\n# Calling tools/);
    assert.match(first.messages[0].content, /- read_file: The read_file tool\./);
    const msgs = server.chats()[1]!.body.messages;
    assert.equal(msgs[2].role, "assistant");
    assert.match(msgs[2].content, /^Checking\.\n\n<tool_call>\n\{"name":"read_file","arguments":\{"path":"a\.md"\}\}\n<\/tool_call>$/);
    assert.equal(msgs[3].role, "user");
    assert.equal(msgs[3].content, '<tool_response name="read_file">\nA contents\n</tool_response>');
    assert.ok(!msgs.some((m: any) => m.role === "tool"));
    // Stored in the usual format.
    const lines = t.lines(session.agentId);
    assert.equal(lines[1].tool_calls[0].function.name, "read_file");
    assertValid(lines);
  } finally {
    await t.cleanup();
  }
});

test("prompt mode: a broken block becomes an error for the model to fix", async () => {
  const t = setup({ provider: { toolMode: "prompt" } });
  try {
    const read = makeTool("read_file");
    server.push((r, res) => sse(res, textReply("<tool_call>this is not json</tool_call>")), (r, res) => sse(res, textReply("ok")));
    const { outcome } = await turn(await t.open(), "go", { tools: [read] });
    assert.equal(outcome.text, "ok");
    assert.equal(read.calls.length, 0);
    assert.match(server.chats()[1]!.body.messages.at(-1).content, /Couldn't read this tool call/);
  } finally {
    await t.cleanup();
  }
});

test("none mode sends no tools and runs nothing", async () => {
  const t = setup({ provider: { toolMode: "none" } });
  try {
    const read = makeTool("read_file");
    server.push((r, res) => sse(res, textReply('<tool_call>{"name": "read_file", "arguments": {}}</tool_call>')));
    const { outcome } = await turn(await t.open(), "go", { system: "RULES", tools: [read] });
    assert.equal(outcome.status, "finished");
    assert.equal(read.calls.length, 0);
    const body = server.chats()[0]!.body;
    assert.equal(body.tools, undefined);
    assert.equal(body.messages[0].content, "RULES");
  } finally {
    await t.cleanup();
  }
});

test("auto mode: falls back to text tool calls when the server says tools aren't supported", async () => {
  const t = setup({ provider: { toolMode: "auto" } });
  try {
    const read = makeTool("read_file", () => "A");
    server.push(
      (r, res) => json(res, 400, { error: { message: "This model does not support tools", type: "invalid_request_error" } }),
      (r, res) => sse(res, textReply('<tool_call>{"name": "read_file", "arguments": {"path": "a"}}</tool_call>')),
      (r, res) => sse(res, textReply("Got it.")),
      (r, res) => sse(res, textReply("Again.")),
    );
    const session = await t.open();
    const { outcome, events } = await turn(session, "go", { tools: [read] });
    assert.equal(outcome.text, "Got it.");
    assert.deepEqual(read.calls, [{ path: "a" }]);
    const [first, second, third] = server.chats();
    assert.ok(first!.body.tools);
    assert.equal(second!.body.tools, undefined);
    assert.match(second!.body.messages[0].content, /# Calling tools/);
    assert.equal(third!.body.tools, undefined);
    assert.ok(statuses(events).some((s) => /switching to text tool calls/.test(s)));
    // Remembered for later turns.
    await turn(session, "again", { tools: [read] });
    assert.equal(server.chats()[3]!.body.tools, undefined);
  } finally {
    await t.cleanup();
  }
});

test("auto mode: a model that writes tool calls as text is switched to prompt mode", async () => {
  const t = setup({ provider: { toolMode: "auto" } });
  try {
    const read = makeTool("read_file", () => "A");
    server.push(
      (r, res) => sse(res, textReply('Sure.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "b"}}\n</tool_call>')),
      (r, res) => sse(res, textReply("Done.")),
    );
    const { outcome, events } = await turn(await t.open(), "go", { tools: [read] });
    assert.equal(outcome.text, "Done.");
    assert.deepEqual(read.calls, [{ path: "b" }]);
    assert.ok(server.chats()[0]!.body.tools);
    assert.equal(server.chats()[1]!.body.tools, undefined);
    assert.ok(statuses(events).some((s) => /writes its tool calls as text/.test(s)));
  } finally {
    await t.cleanup();
  }
});

test("native mode still runs a call written as text to a known tool, without switching modes", async () => {
  const t = setup();
  try {
    const read = makeTool("read_file", () => "A");
    server.push(
      (r, res) => sse(res, textReply('{"name": "read_file", "arguments": {"path": "c"}}')),
      (r, res) => sse(res, textReply("Done.")),
    );
    const { outcome } = await turn(await t.open(), "go", { tools: [read] });
    assert.equal(outcome.text, "Done.");
    assert.deepEqual(read.calls, [{ path: "c" }]);
    assert.ok(server.chats()[1]!.body.tools, "still native");
  } finally {
    await t.cleanup();
  }
});

// ---------------------------------------------------------------- errors and retries

test("429 with Retry-After is retried after that delay, with a status event", async () => {
  const t = setup();
  try {
    server.push(
      (r, res) => json(res, 429, { error: { message: "Concurrency limit exceeded" } }, { "retry-after": "2" }),
      (r, res) => sse(res, textReply("finally")),
    );
    const { outcome, events } = await turn(await t.open(), "hi");
    assert.equal(outcome.status, "finished");
    assert.equal(outcome.text, "finally");
    assert.deepEqual(t.sleeps, [2000]);
    assert.ok(statuses(events).some((s) => /Fake AI is at its concurrency or rate limit; retrying in 2s/.test(s)));
  } finally {
    await t.cleanup();
  }
});

test("429 until the retries run out ends with a clear error", async () => {
  const t = setup();
  try {
    server.fallback = (r, res) => json(res, 429, { error: { message: "Concurrency limit exceeded" } });
    const session = await t.open();
    const { outcome } = await turn(session, "hi");
    assert.equal(outcome.status, "error");
    assert.match(outcome.error!, /Fake AI is still at its concurrency or rate limit after 8 retries \(HTTP 429: Concurrency limit exceeded\)/);
    assert.equal(server.chats().length, 9);
    assert.equal(t.sleeps.length, 8);
    assertValid(t.lines(session.agentId));
  } finally {
    await t.cleanup();
  }
});

test("401, 403 and 404 are fatal, name the provider and model, and never include the key", async () => {
  const cases: Array<[number, object, RegExp]> = [
    [401, { error: { message: `Incorrect API key provided: ${KEY}`, code: "unauthorized" } }, /Fake AI rejected the API key \(HTTP 401: Incorrect API key provided: \[redacted\]\)\. Check the key in Settings/],
    [403, { error: { message: "Model is gated" } }, /Fake AI refused access to test-model \(HTTP 403: Model is gated\)\. The model may be gated .* or not included in your plan/],
    [404, { error: { message: "Model not found", code: "model_not_found" } }, /Fake AI doesn't have the model "test-model" \(HTTP 404: Model not found\)/],
    [402, { error: { message: "Insufficient credits" } }, /out of credits or quota/],
  ];
  for (const [status, body, re] of cases) {
    server.reset();
    const t = setup();
    try {
      server.push((r, res) => json(res, status, body));
      const session = await t.open();
      const { outcome } = await turn(session, "hi");
      assert.equal(outcome.status, "error");
      assert.match(outcome.error!, re);
      assert.ok(!outcome.error!.includes(KEY));
      assert.equal(server.chats().length, 1, `${status} isn't retried`);
      assertValid(t.lines(session.agentId));
    } finally {
      await t.cleanup();
    }
  }
});

test("5xx: 500 is retried twice, 503 three times, then a clear error", async () => {
  let t = setup();
  try {
    server.fallback = (r, res) => json(res, 500, { error: { message: "Internal error" } });
    const { outcome } = await turn(await t.open(), "hi");
    assert.equal(outcome.status, "error");
    assert.match(outcome.error!, /Fake AI had a server error \(HTTP 500: Internal error\)\. \(gave up after 2 retries\)/);
    assert.equal(server.chats().length, 3);
  } finally {
    await t.cleanup();
  }
  server.reset();
  t = setup();
  try {
    server.fallback = (r, res) => json(res, 503, { error: { message: "Service Temporarily Unavailable / No valid Executor" } });
    const { outcome } = await turn(await t.open(), "hi");
    assert.match(outcome.error!, /Fake AI still couldn't serve test-model after 3 retries \(HTTP 503: Service Temporarily Unavailable/);
    assert.deepEqual(t.sleeps, [2000, 5000, 10_000]);
  } finally {
    await t.cleanup();
  }
});

test("Featherless cold model: waits with status events and retries, giving up after about 10 minutes", async () => {
  let t = setup();
  try {
    const cold = (r: unknown, res: any) => json(res, 400, { error: { message: "Model is cold. Please wait for it to load.", type: "invalid_request_error" } });
    server.push(cold, cold, (r, res) => sse(res, textReply("warm now")));
    const { outcome, events } = await turn(await t.open(), "hi");
    assert.equal(outcome.text, "warm now");
    assert.deepEqual(t.sleeps, [20_000, 20_000]);
    assert.equal(statuses(events).filter((s) => /test-model is loading on Fake AI/.test(s)).length, 2);
  } finally {
    await t.cleanup();
  }
  server.reset();
  t = setup();
  try {
    server.fallback = (r, res) => json(res, 400, { error: { message: "Model is cold" } });
    const { outcome } = await turn(await t.open(), "hi");
    assert.equal(outcome.status, "error");
    assert.match(outcome.error!, /test-model is still loading on Fake AI after 10 minutes/);
    assert.equal(
      t.sleeps.reduce((a, b) => a + b, 0),
      600_000,
    );
  } finally {
    await t.cleanup();
  }
});

test("a connection reset mid-reply and an error frame in the stream end the turn with an error", async () => {
  let t = setup();
  try {
    server.push(async (r, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify(delta({ content: "Hello " }))}\n\n`);
      await new Promise((x) => setTimeout(x, 50));
      res.socket?.destroy();
    });
    server.fallback = (r, res) => sse(res, textReply("should not be asked"));
    const session = await t.open();
    const { outcome, events } = await turn(session, "hi");
    assert.equal(joined(events, "text"), "Hello ");
    assert.equal(outcome.status, "error");
    assert.match(outcome.error!, /The connection to Fake AI broke off in the middle of a reply/);
    assert.equal(server.chats().length, 1, "no silent retry once text was shown");
    assertValid(t.lines(session.agentId));
  } finally {
    await t.cleanup();
  }
  server.reset();
  t = setup();
  try {
    server.push((r, res) => sse(res, [delta({ content: "Hi" }), { error: { message: "upstream model crashed", code: 502 } }]));
    const { outcome } = await turn(await t.open(), "hi");
    assert.equal(outcome.status, "error");
    assert.match(outcome.error!, /upstream model crashed/);
  } finally {
    await t.cleanup();
  }
});

test("an error after a tool round leaves a valid transcript; a dangling call on disk is repaired on load", async () => {
  const t = setup();
  try {
    const read = makeTool("read_file", () => "A");
    server.push(
      (r, res) => sse(res, toolCallReply([{ id: "call_1", name: "read_file", args: "{}" }])),
      (r, res) => json(res, 401, { error: { message: "expired" } }),
    );
    const session = await t.open();
    const { outcome } = await turn(session, "go", { tools: [read] });
    assert.equal(outcome.status, "error");
    const lines = t.lines(session.agentId);
    assertValid(lines);
    assert.equal(lines.at(-1).role, "tool");

    // A crash in the middle of a round: the call has no result on disk.
    const id = "oai-11111111-2222-3333-4444-555555555555";
    fs.writeFileSync(
      t.file(id),
      [
        { role: "user", content: "start" },
        { role: "assistant", content: "", tool_calls: [{ id: "lost", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      ]
        .map((m) => JSON.stringify(m))
        .join("\n") + "\n",
    );
    server.push((r, res) => sse(res, textReply("recovered")));
    const resumed = await t.open(id);
    assert.equal(resumed.agentId, id);
    const { outcome: o2 } = await turn(resumed, "continue", { tools: [read] });
    assert.equal(o2.text, "recovered");
    const msgs = server.chats().at(-1)!.body.messages;
    assert.deepEqual(msgs[2], { role: "tool", tool_call_id: "lost", content: "(No result: the turn ended before this tool finished.)" });
    assertValid(t.lines(id));
  } finally {
    await t.cleanup();
  }
});

test("a rejected stream_options is dropped and remembered", async () => {
  const t = setup();
  try {
    server.push(
      (r, res) => json(res, 400, { error: { message: "Unsupported parameter: 'stream_options' is not supported by this server" } }),
      (r, res) => sse(res, textReply("one")),
      (r, res) => sse(res, textReply("two")),
    );
    const session = await t.open();
    assert.equal((await turn(session, "a")).outcome.text, "one");
    assert.equal((await turn(session, "b")).outcome.text, "two");
    const [first, second, third] = server.chats();
    assert.ok(first!.body.stream_options);
    assert.equal(second!.body.stream_options, undefined);
    assert.equal(third!.body.stream_options, undefined);
  } finally {
    await t.cleanup();
  }
});

test("a template without a system role gets the system text at the start of the first user message", async () => {
  const t = setup();
  try {
    server.push(
      (r, res) => json(res, 400, { error: { message: "System role not supported" } }),
      (r, res) => sse(res, textReply("ok")),
      (r, res) => sse(res, textReply("ok again")),
    );
    const session = await t.open();
    await turn(session, "hello", { system: "RULES" });
    await turn(session, "more", { system: "RULES" });
    const [, second, third] = server.chats();
    assert.deepEqual(second!.body.messages, [{ role: "user", content: "RULES\n\nhello" }]);
    assert.equal(third!.body.messages[0].content, "RULES\n\nhello");
    assert.ok(!third!.body.messages.some((m: any) => m.role === "system"));
  } finally {
    await t.cleanup();
  }
});

test("max_tokens rejected in favor of max_completion_tokens is switched once and remembered", async () => {
  const t = setup();
  try {
    server.push(
      (r, res) => json(res, 400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }),
      (r, res) => sse(res, textReply("ok")),
    );
    await turn(await t.open(), "a");
    const second = server.chats()[1]!.body;
    assert.equal(second.max_tokens, undefined);
    assert.ok(second.max_completion_tokens > 0);
  } finally {
    await t.cleanup();
  }
});

// ---------------------------------------------------------------- cancel

test("cancel during the stream aborts the request and resolves as cancelled; the session keeps working", async () => {
  const t = setup();
  try {
    server.push((r, res) => hold(res, [delta({ content: "Thinking about" })]));
    const session = await t.open();
    const { run, events } = await start(session, "hi");
    await until(() => joined(events, "text") === "Thinking about");
    const t0 = Date.now();
    await run.cancel();
    const outcome = await run.wait();
    assert.equal(outcome.status, "cancelled");
    assert.ok(Date.now() - t0 < 1000);
    await until(() => server.aborted === 1);
    await run.cancel(); // idempotent
    assertValid(t.lines(session.agentId));
    server.push((r, res) => sse(res, textReply("fresh")));
    assert.equal((await turn(session, "again")).outcome.text, "fresh");
  } finally {
    await t.cleanup();
  }
});

test("cancel during a tool run stops at once, runs nothing more and closes the round", async () => {
  const t = setup();
  try {
    const stuck = makeTool("slow", () => new Promise<never>(() => {}));
    const next = makeTool("next");
    server.push((r, res) =>
      sse(
        res,
        toolCallReply([
          { id: "t1", name: "slow", args: "{}" },
          { id: "t2", name: "next", args: "{}" },
        ]),
      ),
    );
    const session = await t.open();
    const { run, events } = await start(session, "go", { tools: [stuck, next] });
    await until(() => toolEvents(events).some((e) => e.status === "running"));
    await run.cancel();
    assert.equal((await run.wait()).status, "cancelled");
    assert.equal(next.calls.length, 0);
    const lines = t.lines(session.agentId);
    assertValid(lines);
    assert.match(lines.at(-1).content, /^Cancelled/);
    server.push((r, res) => sse(res, textReply("fresh")));
    const again = await turn(session, "again", { tools: [stuck, next] });
    assert.equal(again.outcome.text, "fresh");
    const msgs = server.chats().at(-1)!.body.messages;
    assert.deepEqual(
      msgs.map((m: any) => m.role),
      ["user", "assistant", "tool", "tool", "user"],
    );
  } finally {
    await t.cleanup();
  }
});

test("cancel during a backoff wait resolves at once; cancel after finishing is a no-op", async () => {
  const t = setup({ sleep: (ms, signal) => new Promise((r) => signal?.addEventListener("abort", () => r(), { once: true })) });
  try {
    server.push((r, res) => json(res, 429, { error: { message: "busy" } }, { "retry-after": "30" }));
    const session = await t.open();
    const { run, events } = await start(session, "hi");
    await until(() => statuses(events).some((s) => /retrying in 30s/.test(s)));
    await run.cancel();
    assert.equal((await run.wait()).status, "cancelled");
    assert.equal(server.chats().length, 1);

    server.push((r, res) => sse(res, textReply("done")));
    const done = await turn(session, "again");
    await done.run.cancel();
    assert.equal((await done.run.wait()).status, "finished");
  } finally {
    await t.cleanup();
  }
});

test("close() and dispose() abort an active run", async () => {
  const t = setup();
  try {
    server.push((r, res) => hold(res), (r, res) => hold(res));
    const session = await t.open();
    const a = await start(session, "hi");
    await until(() => server.inFlight === 1);
    await session.close();
    assert.equal((await a.run.wait()).status, "cancelled");
    const other = await t.open();
    const b = await start(other, "hi");
    await until(() => server.inFlight === 1);
    await t.rt.dispose();
    assert.equal((await b.run.wait()).status, "cancelled");
  } finally {
    await t.cleanup();
  }
});

// ---------------------------------------------------------------- steering

test("steer during a tool round: delivered as a user message before the next model call", async () => {
  const t = setup();
  try {
    const g = gate();
    const read = makeTool("read_file", async () => {
      await g.p;
      return "A";
    });
    server.push((r, res) => sse(res, toolCallReply([{ id: "r1", name: "read_file", args: "{}" }])), (r, res) => sse(res, textReply("Done.")));
    const session = await t.open();
    const { run, events } = await start(session, "go", { tools: [read] });
    await until(() => toolEvents(events).some((e) => e.status === "running"));
    assert.equal(await run.steer!("Message from Boss while you work:\nalso b.md"), true);
    g.open();
    const outcome = await run.wait();
    assert.equal(outcome.text, "Done.");
    const msgs = server.chats()[1]!.body.messages;
    assert.deepEqual(msgs.slice(-3), [
      { role: "assistant", content: "", tool_calls: [{ id: "r1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "r1", content: "A" },
      { role: "user", content: "Message from Boss while you work:\nalso b.md" },
    ]);
    assert.equal(await run.steer!("too late"), false);
  } finally {
    await t.cleanup();
  }
});

test("end-of-turn compaction runs after the answer: the outcome doesn't wait, and the next message or close stops it", async () => {
  const t = setup({ provider: { models: [{ id: "test-model", contextWindow: 4000 }] } });
  try {
    const session = await t.open();
    for (const ch of ["A", "B"]) {
      server.push((r, res) => sse(res, textReply("ok")));
      await turn(session, ch.repeat(3000));
    }
    // The summary request hangs until the client gives up on it.
    const held = gate();
    server.push(
      (r, res) => sse(res, textReply("the answer")),
      async (r, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.on("close", () => held.open());
        await held.p;
      },
    );
    const { run, events } = await start(session, "C".repeat(3000));
    const outcome = await run.wait();
    assert.equal(outcome.status, "finished");
    assert.equal(outcome.text, "the answer", "posted without waiting for the summary");
    await until(() => server.chats().length === 4 && server.inFlight === 1);

    // The next message doesn't wait for it: the summary is abandoned and the history stays as it was.
    server.push((r, res) => sse(res, textReply("next")));
    const t0 = Date.now();
    const next = await turn(session, "D");
    assert.ok(Date.now() - t0 < 1500);
    assert.equal(next.outcome.text, "next");
    assert.ok(!events.some((e) => e.type === "summary"));
    const lines = t.lines(session.agentId);
    assert.ok(JSON.stringify(lines).includes("the answer"));
    assertValid(lines);

    // close() stops a pending compaction too, promptly (a fresh session with the same history size).
    const other = await t.open();
    for (const ch of ["A", "B"]) {
      server.push((r, res) => sse(res, textReply("ok")));
      await turn(other, ch.repeat(3000));
    }
    const again = gate();
    server.push(
      (r, res) => sse(res, textReply("last")),
      async (r, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.on("close", () => again.open());
        await again.p;
      },
    );
    const before = server.chats().length;
    const last = await start(other, "C".repeat(3000));
    assert.equal((await last.run.wait()).text, "last");
    await until(() => server.chats().length === before + 2 && server.inFlight === 1);
    const t1 = Date.now();
    await other.close();
    assert.ok(Date.now() - t1 < 1500);
    assertValid(t.lines(other.agentId));
  } finally {
    await t.cleanup();
  }
});

test("a steered follow-up that fails keeps the answer that was already complete", async () => {
  const t = setup();
  try {
    const g = gate();
    server.push(
      async (r, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify(delta({ content: "First " }))}\n\n`);
        await g.p;
        res.write(`data: ${JSON.stringify(delta({ content: "answer" }))}\n\ndata: ${JSON.stringify(finish("stop"))}\n\ndata: [DONE]\n\n`);
        res.end();
      },
      (r, res) => json(res, 401, { error: { message: "key revoked" } }),
    );
    const session = await t.open();
    const { run, events } = await start(session, "go");
    await until(() => joined(events, "text").includes("First"));
    assert.equal(await run.steer!("and one more thing"), true);
    g.open();
    const outcome = await run.wait();
    assert.equal(outcome.status, "error");
    assert.equal(outcome.text, "First answer");
    assert.match(outcome.error ?? "", /key revoked|401/);
  } finally {
    await t.cleanup();
  }
});

test("steer while the final answer streams: one more model call, and the answers are joined", async () => {
  const t = setup();
  try {
    const g = gate();
    server.push(
      async (r, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify(delta({ content: "First " }))}\n\n`);
        await g.p;
        res.write(`data: ${JSON.stringify(delta({ content: "answer" }))}\n\ndata: ${JSON.stringify(finish("stop"))}\n\ndata: [DONE]\n\n`);
        res.end();
      },
      (r, res) => sse(res, textReply("Second answer")),
    );
    const session = await t.open();
    const { run, events } = await start(session, "go");
    await until(() => joined(events, "text").includes("First"));
    assert.equal(await run.steer!("one more thing"), true);
    g.open();
    const outcome = await run.wait();
    assert.equal(outcome.text, "First answer\n\nSecond answer");
    const msgs = server.chats()[1]!.body.messages;
    assert.deepEqual(msgs.slice(-2), [
      { role: "assistant", content: "First answer" },
      { role: "user", content: "one more thing" },
    ]);
  } finally {
    await t.cleanup();
  }
});

// ---------------------------------------------------------------- context management

test("end of turn over ~60% of the window: older history is summarized and a summary event is emitted", async () => {
  const t = setup({ provider: { models: [{ id: "test-model", contextWindow: 4000 }] } });
  try {
    const session = await t.open();
    for (const ch of ["A", "B"]) {
      server.push((r, res) => sse(res, textReply("ok")));
      const { events } = await turn(session, ch.repeat(3000), { system: "S" });
      assert.ok(!events.some((e) => e.type === "summary"));
    }
    server.push(
      (r, res) => sse(res, textReply("ok")),
      (r, res) => json(res, 200, completion("The user sent blocks of A and B.")),
    );
    const third = await turn(session, "C".repeat(3000), { system: "S" });
    assert.equal(third.outcome.text, "ok", "the answer is kept");
    assert.ok(third.events.some((e) => e.type === "summary"));
    const summaryReq = server.chats()[3]!.body;
    assert.equal(summaryReq.stream, false);
    assert.equal(summaryReq.tools, undefined);
    assert.match(summaryReq.messages[1].content, /AAAA[\s\S]*Summarize the conversation above/);
    const lines = t.lines(session.agentId);
    assert.equal(lines[0].content, "<conversation_summary>\nThe user sent blocks of A and B.\n</conversation_summary>");
    assert.equal(lines[1].role, "assistant");
    assert.equal(lines[2].content, "C".repeat(3000));
    assert.equal(lines.length, 4);
    // The next request: system, summary, the kept turn, the new message.
    server.push((r, res) => sse(res, textReply("ok")));
    await turn(session, "D", { system: "S" });
    const msgs = server.chats()[4]!.body.messages;
    assert.equal(msgs[0].content, "S");
    assert.match(msgs[1].content, /^<conversation_summary>/);
    assert.equal(msgs.at(-1).content, "D");
  } finally {
    await t.cleanup();
  }
});

test("end of turn: the turn that just finished stays verbatim, however long its tool results", async () => {
  const t = setup({ provider: { models: [{ id: "test-model", contextWindow: 6000 }] } });
  try {
    const session = await t.open();
    server.push((r, res) => sse(res, textReply("ok")));
    await turn(session, "A".repeat(3000));
    const read = makeTool("read_file", () => "R".repeat(10000));
    server.push(
      (r, res) => sse(res, toolCallReply([{ id: "c1", name: "read_file", args: '{"path":"big.txt"}' }])),
      (r, res) => sse(res, textReply("here is the patch")),
      (r, res) => json(res, 200, completion("Earlier the user sent a block of A.")),
    );
    const second = await turn(session, "read big.txt and patch it", { tools: [read] });
    assert.equal(second.outcome.text, "here is the patch");
    const lines = t.lines(session.agentId);
    const text = JSON.stringify(lines);
    assert.ok(second.events.some((e) => e.type === "summary"), "the transcript was compacted");
    assert.ok(text.includes("read big.txt and patch it") && text.includes("here is the patch") && text.includes("RRRR"), "this turn is kept verbatim");
    assert.ok(!text.includes("AAAA"), "older turns are summarized");
    assertValid(lines);
  } finally {
    await t.cleanup();
  }
});

test("the reply limit leaves room for estimate errors, and an overflow always makes the retry ask for less", async () => {
  // Some catalogues list a model's reply limit as its whole context.
  const big = { provider: { models: [{ id: "test-model", contextWindow: 8192, maxOutputTokens: 8192 }] } };
  const t = setup(big);
  const t2 = setup(big);
  try {
    server.push((r, res) => sse(res, textReply("ok")));
    await turn(await t.open(), "hello");
    assert.ok(server.chats()[0]!.body.max_tokens <= 4096, `capped at half the window (${server.chats()[0]!.body.max_tokens})`);

    // vLLM's wording: the input count is learned, so the retry fits. (A fresh session: nothing older to summarize.)
    server.push(
      (r, res) => json(res, 400, { error: { message: "'max_tokens' is too large: 4000. This model's maximum context length is 8192 tokens and your request has 7000 input tokens (4000 > 8192 - 7000)." } }),
      (r, res) => sse(res, textReply("fits")),
    );
    const vllm = await turn(await t.open(), "x".repeat(12000));
    assert.equal(vllm.outcome.text, "fits");
    const [a1, a2] = server.chats().slice(-2).map((c) => c.body.max_tokens as number);
    assert.ok(a2! < a1!, `the retry asks for less (${a1} → ${a2})`);

    // A message with no numbers at all still makes the retry smaller instead of repeating it.
    server.push(
      (r, res) => json(res, 400, { error: { message: "Input is too long for this model." } }),
      (r, res) => sse(res, textReply("fits too")),
    );
    const vague = await turn(await t2.open(), "y".repeat(12000));
    assert.equal(vague.outcome.text, "fits too");
    const [b1, b2] = server.chats().slice(-2).map((c) => c.body.max_tokens as number);
    assert.ok(b2! < b1!, `the retry asks for less (${b1} → ${b2})`);
  } finally {
    await t.cleanup();
    await t2.cleanup();
  }
});

test("a small window filled by instructions and tools doesn't compact every turn, and says so once", async () => {
  const t = setup({ provider: { models: [{ id: "test-model", contextWindow: 8192 }] } });
  try {
    // About as much as the harness's own manual and tool schemas.
    const tools = Array.from({ length: 30 }, (_, i) => ({ ...makeTool(`tool_${i}`), description: `Tool ${i}. ${"Explains what it does at length. ".repeat(18)}` }));
    const session = await t.open();
    const all: RuntimeEvent[] = [];
    for (const text of ["one", "two", "three"]) {
      server.push((r, res) => sse(res, textReply(`re ${text}`)));
      const r = await turn(session, text, { tools, system: "S" });
      assert.equal(r.outcome.text, `re ${text}`);
      all.push(...r.events);
    }
    assert.ok(server.chats().every((c) => c.body.stream), "no summary calls");
    assert.equal(all.filter((e) => e.type === "summary").length, 0);
    assert.equal(statuses(all).filter((s) => /barely fits this bot's instructions and tools/.test(s)).length, 1);
    assert.ok(server.chats().every((c) => (c.body.max_tokens as number) >= 256));
  } finally {
    await t.cleanup();
  }
});

test("if the summary can't be made: history stays at the end of a turn; only a request that doesn't fit drops the oldest", async () => {
  const t = setup({ provider: { models: [{ id: "test-model", contextWindow: 4000 }] } });
  try {
    const session = await t.open();
    for (const ch of ["A", "B"]) {
      server.push((r, res) => sse(res, textReply("ok")));
      await turn(session, ch.repeat(3000));
    }
    server.push(
      (r, res) => sse(res, textReply("ok")),
      (r, res) => json(res, 400, { error: { message: "bad things" } }),
    );
    const third = await turn(session, "C".repeat(3000));
    assert.equal(third.outcome.status, "finished");
    // Nothing needed the room yet, so nothing is lost.
    assert.ok(!third.events.some((e) => e.type === "summary"));
    assert.ok(JSON.stringify(t.lines(session.agentId)).includes("AAAA"));

    // The next request doesn't fit: now the oldest messages go.
    const fail = (r: any, res: any) => json(res, 400, { error: { message: "bad things" } });
    server.push(fail, (r, res) => sse(res, textReply("ok")), fail, fail);
    const fourth = await turn(session, "D".repeat(3000));
    assert.equal(fourth.outcome.status, "finished");
    assert.ok(fourth.events.some((e) => e.type === "summary"));
    const lines = t.lines(session.agentId);
    assert.match(lines[0].content, /dropped to fit the model's context window/);
    assert.ok(!JSON.stringify(lines).includes("AAAA"));
    assertValid(lines);
  } finally {
    await t.cleanup();
  }
});

test("a request over budget is compacted first, keeping this turn's message verbatim and the latest identity", async () => {
  const t = setup({ provider: { models: [{ id: "test-model", contextWindow: 4000 }] } });
  try {
    const id = "oai-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const old = [{ role: "user", content: '<harness>\n<you name="Ann">\n<memory>Ann likes tea</memory>\n</you>\n</harness>\nhello' }];
    for (let i = 0; i < 10; i++) old.push({ role: "user", content: `${i}`.repeat(1000) }, { role: "assistant", content: "y".repeat(1000) });
    fs.writeFileSync(t.file(id), old.map((m) => JSON.stringify(m)).join("\n") + "\n");
    server.push(
      (r, res) => json(res, 200, completion("Earlier: a long chat with Ann.")),
      (r, res) => sse(res, textReply("Answer")),
    );
    const session = await t.open(id);
    const { outcome, events } = await turn(session, "Current question", { system: "S" });
    assert.equal(outcome.text, "Answer");
    assert.ok(events.some((e) => e.type === "summary"));
    const [summary, main] = server.chats();
    assert.equal(summary!.body.stream, false);
    const msgs = main!.body.messages;
    assert.equal(msgs[0].content, "S");
    assert.match(msgs[1].content, /^<conversation_summary>\nEarlier: a long chat with Ann\.[\s\S]*<memory>Ann likes tea<\/memory>/);
    assert.equal(msgs.at(-1).content, "Current question");
    assert.equal(msgs.length, 4);
  } finally {
    await t.cleanup();
  }
});

test("a context-overflow error compacts harder and retries once, learning the real window", async () => {
  const t = setup();
  try {
    server.push((r, res) => sse(res, textReply("Reply one")));
    const session = await t.open();
    await turn(session, "First");
    server.push(
      (r, res) =>
        json(res, 400, {
          error: {
            message: "This model's maximum context length is 2048 tokens. However, you requested 3000 tokens (2500 in the messages, 500 in the completion).",
            code: "context_length_exceeded",
          },
        }),
      (r, res) => json(res, 200, completion("Summary of the first exchange.")),
      (r, res) => sse(res, textReply("Reply two")),
    );
    const { outcome, events } = await turn(session, "Second");
    assert.equal(outcome.text, "Reply two");
    assert.ok(events.some((e) => e.type === "summary"));
    const chats = server.chats();
    assert.equal(chats.length, 4);
    assert.equal(chats[2]!.body.stream, false);
    const retry = chats[3]!.body;
    assert.ok(retry.max_tokens < 2048 - 256, `max_tokens ${retry.max_tokens}`);
    assert.match(retry.messages[0].content, /^<conversation_summary>/);
    assert.equal(retry.messages.at(-1).content, "Second");
  } finally {
    await t.cleanup();
  }
});

// ---------------------------------------------------------------- persistence

test("a second runtime resumes the transcript; a missing one gives a new agent id; torn lines are skipped", async () => {
  const t = setup();
  try {
    server.push((r, res) => sse(res, textReply("Noted.")));
    const first = await t.open();
    await turn(first, "Remember: blue");

    const rt2 = new OpenAICompatRuntime({ provider: () => t.provider, apiKey: () => KEY, transcriptDir: t.dir });
    const resumed = await rt2.open({ botId: "bot_1", agentId: first.agentId, name: "Tester", cwd: t.dir });
    assert.equal(resumed.agentId, first.agentId);
    server.push((r, res) => sse(res, textReply("Blue.")));
    await turn(resumed, "What color?");
    assert.deepEqual(server.chats()[1]!.body.messages, [
      { role: "user", content: "Remember: blue" },
      { role: "assistant", content: "Noted." },
      { role: "user", content: "What color?" },
    ]);

    const gone = await rt2.open({ botId: "bot_1", agentId: "oai-00000000-0000-0000-0000-000000000000", name: "Tester", cwd: t.dir });
    assert.notEqual(gone.agentId, "oai-00000000-0000-0000-0000-000000000000");
    assert.match(gone.agentId, /^oai-/);
    const foreign = await rt2.open({ botId: "bot_1", agentId: "agent-123", name: "Tester", cwd: t.dir });
    assert.match(foreign.agentId, /^oai-/);

    // A torn last line after a crash.
    fs.appendFileSync(t.file(first.agentId), '{"role":"user","content":"tor');
    const rt3 = new OpenAICompatRuntime({ provider: () => t.provider, apiKey: () => KEY, transcriptDir: t.dir });
    const again = await rt3.open({ botId: "bot_1", agentId: first.agentId, name: "Tester", cwd: t.dir });
    assert.ok(fs.readFileSync(t.file(first.agentId), "utf8").endsWith("\n"));
    server.push((r, res) => sse(res, textReply("Still blue.")));
    await turn(again, "And now?");
    const msgs = server.chats()[2]!.body.messages;
    assert.equal(msgs.length, 5);
    assert.ok(!JSON.stringify(msgs).includes('"tor'));
    const lines = t.lines(first.agentId);
    assert.deepEqual(lines.slice(-2), [
      { role: "user", content: "And now?" },
      { role: "assistant", content: "Still blue." },
    ]);
  } finally {
    await t.cleanup();
  }
});

// ---------------------------------------------------------------- concurrency

test("one semaphore per provider: two sessions never exceed maxConcurrency; complete() waits its turn", async () => {
  const t = setup({ provider: { maxConcurrency: 1 } });
  try {
    server.fallback = (r, res) => sse(res, textReply("Reply from the model"), { split: 3 });
    const [a, b] = [await t.open(), await t.open()];
    const results = await Promise.all([turn(a, "one"), turn(b, "two")]);
    assert.ok(results.every((r) => r.outcome.status === "finished"));
    assert.equal(server.maxInFlight, 1);
    assert.ok(results.some((r) => statuses(r.events).some((s) => /Waiting for Fake AI capacity \(1 of 1 concurrency unit in use\)/.test(s))));

    server.reset();
    const g = gate();
    server.push(
      async (r, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        await g.p;
        res.end(`data: ${JSON.stringify(delta({ content: "slow" }))}\n\ndata: ${JSON.stringify(finish("stop"))}\n\ndata: [DONE]\n\n`);
      },
      (r, res) => json(res, 200, completion("@x")),
    );
    const slow = await start(a, "slow");
    await until(() => server.inFlight === 1);
    const answer = t.rt.complete("route this");
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(server.chats().length, 1, "complete() is queued behind the running request");
    g.open();
    assert.equal(await answer, "@x");
    assert.equal((await slow.run.wait()).status, "finished");
    assert.equal(server.maxInFlight, 1);
  } finally {
    await t.cleanup();
  }
});

test("complete(): a caller that gives up frees the request and its capacity at once", async () => {
  const t = setup({ provider: { maxConcurrency: 1 } });
  try {
    // A slow router reply: held open until the test ends.
    const g = gate();
    server.push(async (r, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      await g.p;
      res.end("{}");
    });
    const stop = new AbortController();
    const routing = t.rt.complete("route this", { signal: stop.signal });
    routing.catch(() => {});
    await until(() => server.inFlight === 1);
    const t0 = Date.now();
    stop.abort();
    await assert.rejects(routing, /cancelled/);
    assert.ok(Date.now() - t0 < 500);
    // The capacity is free again: a turn runs without waiting for the abandoned call.
    server.push((r, res) => sse(res, textReply("next")));
    const next = await turn(await t.open(), "hello");
    assert.equal(next.outcome.text, "next");
    assert.ok(!statuses(next.events).some((s) => /Waiting for/.test(s)));
    g.open();
    // Already aborted: nothing is sent.
    const before = server.chats().length;
    const dead = new AbortController();
    dead.abort();
    await assert.rejects(t.rt.complete("x", { signal: dead.signal }), /cancelled/);
    assert.equal(server.chats().length, before);
  } finally {
    await t.cleanup();
  }
});

test("UnitSemaphore: FIFO by units, cost clamped to capacity, aborted waiters leave the queue", async () => {
  const sem = new UnitSemaphore(() => 2);
  const r1 = await sem.acquire(1);
  const order: string[] = [];
  const p2 = sem.acquire(2).then((rel) => (order.push("big"), rel));
  const p3 = sem.acquire(1).then((rel) => (order.push("small"), rel));
  await new Promise((r) => setImmediate(r));
  assert.equal(sem.inUse, 1);
  assert.equal(sem.waiting, 2, "the small one waits behind the big one");
  r1();
  const r2 = await p2;
  assert.deepEqual(order, ["big"]);
  r2();
  (await p3)();
  assert.deepEqual(order, ["big", "small"]);
  const huge = await sem.acquire(10);
  assert.equal(sem.inUse, 2);
  const ctrl = new AbortController();
  const waiting = sem.acquire(1, ctrl.signal);
  ctrl.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  assert.equal(sem.waiting, 0);
  huge();
  assert.equal(sem.inUse, 0);
});

// ---------------------------------------------------------------- availability and models

test("available() is synchronous and offline, with actionable reasons", () => {
  let calls = 0;
  const spy = (async () => {
    calls++;
    throw new Error("no network in available()");
  }) as unknown as typeof fetch;
  const mk = (p: Partial<ProviderConfig>, key?: string) =>
    new OpenAICompatRuntime({
      provider: () => ({ id: "featherless", label: "Featherless AI", baseUrl: "https://api.featherless.ai/v1", enabled: true, maxConcurrency: 4, toolMode: "auto", defaultModel: "Qwen/Qwen3-32B", models: [], createdAt: 0, updatedAt: 0, ...p }),
      apiKey: () => key,
      transcriptDir: os.tmpdir(),
      fetch: spy,
    });
  assert.deepEqual(mk({}).available(), { ok: false, reason: "Featherless AI needs an API key: add it in Settings → Brain & models → Providers." });
  assert.deepEqual(mk({}, KEY).available(), { ok: true });
  assert.deepEqual(mk({ baseUrl: "http://localhost:11434/v1" }).available(), { ok: true });
  assert.deepEqual(mk({ baseUrl: "http://studio.local:1234/v1" }).available(), { ok: true });
  assert.match(mk({ enabled: false }, KEY).available().reason!, /Featherless AI is switched off/);
  assert.match(mk({ defaultModel: undefined }, KEY).available().reason!, /Featherless AI has no model yet: add one in Settings → Brain & models → Providers\./);
  assert.match(mk({ baseUrl: "nonsense" }, KEY).available().reason!, /no valid base URL/);
  assert.equal(calls, 0);
});

test("listModels() shows the configured models", async () => {
  const t = setup({
    provider: {
      defaultModel: "a",
      models: [
        { id: "a", label: "Model A", contextWindow: 1000, maxOutputTokens: 200, vision: true, toolMode: "native", concurrencyCost: 2 },
        { id: "b", toolMode: "none" },
      ],
    },
  });
  try {
    assert.deepEqual(await t.rt.listModels(), [
      { id: "a", displayName: "Model A", contextWindow: 1000, maxOutputTokens: 200, vision: true, toolUse: true, concurrencyCost: 2 },
      { id: "b", displayName: "b", contextWindow: undefined, maxOutputTokens: undefined, vision: undefined, toolUse: false, concurrencyCost: undefined },
    ]);
  } finally {
    await t.cleanup();
  }
});

test("fetchModels() reads any list shape and normalizes the fields; lookupModel() keeps the slash", async () => {
  const t = setup();
  try {
    const entries = [
      { id: "google/gemma-4-31B-it", is_gated: false, context_length: 32768, max_completion_tokens: 32768, concurrency_cost: 2, features: { tool_use: true, image_input: true } },
      {
        id: "meta-llama/llama-3.3-70b-instruct",
        name: "Meta: Llama 3.3 70B Instruct",
        context_length: 131072,
        architecture: { input_modalities: ["text"] },
        top_provider: { max_completion_tokens: 16384 },
        supported_parameters: ["tools", "temperature"],
      },
      { id: "Qwen/Qwen3-8B", object: "model", max_model_len: 40960 },
      { id: "mistral-large-latest", max_context_length: 131072, capabilities: { function_calling: true, vision: false } },
      { id: "llama-3.1-8b-instant", context_window: 131072 },
    ];
    const expected = [
      { id: "google/gemma-4-31B-it", contextWindow: 32768, maxOutputTokens: 32768, vision: true, toolUse: true, concurrencyCost: 2 },
      { id: "meta-llama/llama-3.3-70b-instruct", label: "Meta: Llama 3.3 70B Instruct", contextWindow: 131072, maxOutputTokens: 16384, vision: false, toolUse: true },
      { id: "Qwen/Qwen3-8B", contextWindow: 40960 },
      { id: "mistral-large-latest", contextWindow: 131072, vision: false, toolUse: true },
      { id: "llama-3.1-8b-instant", contextWindow: 131072 },
    ];
    server.push(
      (r, res) => json(res, 200, { object: "list", data: entries }),
      (r, res) => json(res, 200, entries),
      (r, res) => json(res, 200, { models: entries }),
      (r, res) => json(res, 200, { data: entries }),
    );
    assert.deepEqual(await t.rt.fetchModels(), expected);
    assert.deepEqual(await t.rt.fetchModels(), expected);
    assert.deepEqual(await t.rt.fetchModels(), expected);
    assert.deepEqual(
      (await t.rt.fetchModels({ search: "LLAMA 70b" })).map((m) => m.id),
      ["meta-llama/llama-3.3-70b-instruct"],
    );
    assert.equal(server.requests[0]!.path, "/v1/models");
    assert.equal(server.requests[0]!.headers.authorization, `Bearer ${KEY}`);
    assert.equal(server.requests[3]!.path, "/v1/models", "no q= for providers other than Featherless");

    server.push(
      (r, res) => json(res, 200, { id: "Qwen/Qwen3-32B", object: "model", context_length: 32768, concurrency_cost: 2, features: { tool_use: true }, vision_supported: false }),
      (r, res) => json(res, 404, { error: { message: "Model not found", code: "model_not_found" } }),
    );
    assert.deepEqual(await t.rt.lookupModel("Qwen/Qwen3-32B"), { id: "Qwen/Qwen3-32B", contextWindow: 32768, vision: false, toolUse: true, concurrencyCost: 2 });
    assert.equal(server.requests.at(-1)!.path, "/v1/models/Qwen/Qwen3-32B");
    assert.equal(await t.rt.lookupModel("nobody/nothing"), undefined);
  } finally {
    await t.cleanup();
  }
});

test("fetchModels() on Featherless passes the search as q= (its full list is paginated)", async () => {
  const urls: string[] = [];
  const auth: Array<string | null> = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    auth.push(new Headers(init?.headers).get("authorization"));
    return new Response(JSON.stringify({ data: [{ id: "Qwen/Qwen3-32B" }, { id: "Qwen/Qwen3-8B" }, { id: "other/thing" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const t = setup({ fetch: fakeFetch, provider: { baseUrl: "https://api.featherless.ai/v1", label: "Featherless AI" } });
  try {
    assert.deepEqual(
      (await t.rt.fetchModels({ search: "qwen3 32b" })).map((m) => m.id),
      ["Qwen/Qwen3-32B"],
    );
    assert.equal(urls[0], "https://api.featherless.ai/v1/models?q=qwen3+32b");
    assert.equal(auth[0], `Bearer ${KEY}`);
    assert.equal((await t.rt.fetchModels()).length, 3);
    assert.equal(urls[1], "https://api.featherless.ai/v1/models");
  } finally {
    await t.cleanup();
  }
});

// ---------------------------------------------------------------- through the harness

test("end to end through the harness: a harness tool call, the reply, usage, the saved agent id and a replayed history", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oai-harness-"));
  const provider: ProviderConfig = {
    id: "fake",
    label: "Fake AI",
    baseUrl: server.url,
    enabled: true,
    maxConcurrency: 2,
    toolMode: "native",
    defaultModel: "test-model",
    models: [{ id: "test-model", contextWindow: 65536 }],
    createdAt: 0,
    updatedAt: 0,
  };
  const transcripts = path.join(home, "state", "agents");
  const rt = new OpenAICompatRuntime({ provider: () => provider, apiKey: () => KEY, transcriptDir: transcripts });
  const h = new Harness({ home, runtimes: [rt] });
  h.store.settings.providers = [provider];
  h.store.settings.runtime = "fake";
  h.store.settings.groupRouting = "heuristic";
  h.store.settings.approvals.inlineWaitSeconds = 0;
  await h.start({ gatewayUrl: "http://127.0.0.1:1" });
  try {
    const bot = h.createBot({ name: "Researcher" });
    const dm = h.store.dmFor(bot.id)!;
    server.push(
      (r, res) =>
        sse(res, toolCallReply([{ id: "m1", name: "memory_update", args: JSON.stringify({ action: "add", section: "Preferences", text: "Boss likes tea." }) }]), {
          split: 11,
        }),
      (r, res) => sse(res, textReply("Saved that.", { usage: [900, 4] })),
    );
    await h.postUserMessage(dm.id, { text: "remember I like tea" });
    await settle(h);
    const reply = h.store.messages(dm.id).at(-1)!;
    assert.equal(reply.author.kind, "bot");
    assert.equal(reply.text, "Saved that.");
    const activity = reply.meta!.activity as any[];
    assert.deepEqual(
      activity.map((a) => [a.name, a.status]),
      [["memory_update", "completed"]],
    );
    assert.match(h.store.readMemory(bot.id), /Boss likes tea\./);
    const saved = h.store.bots.get(bot.id)!;
    assert.match(saved.agentId!, /^oai-/);
    assert.equal(saved.agentRuntime, "fake");
    assert.ok(saved.usage && saved.usage.inputTokens >= 900);
    assert.ok(fs.existsSync(path.join(transcripts, `${saved.agentId}.jsonl`)));

    const first = server.chats()[0]!.body;
    assert.equal(first.model, "test-model");
    assert.equal(first.messages[0].role, "system");
    assert.match(first.messages[1].content, /<you name="Researcher" handle="@researcher">/);
    assert.ok(first.tools.some((t: any) => t.function.name === "memory_update"));

    // The second turn replays the history (the tool round included) before the new message.
    server.push((r, res) => sse(res, textReply("You're welcome.")));
    await h.postUserMessage(dm.id, { text: "thanks" });
    await settle(h);
    assert.equal(h.store.messages(dm.id).at(-1)!.text, "You're welcome.");
    const roles = server.chats()[2]!.body.messages.map((m: any) => m.role);
    assert.deepEqual(roles, ["system", "user", "assistant", "tool", "assistant", "user"]);
  } finally {
    await h.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- parsing helpers

test("SSE parser: split CRLF, comments, multi-line data, no trailing blank line", () => {
  const p = new SseParser();
  const out = [...p.push(": hi\r"), ...p.push("\ndata: {\"a\""), ...p.push(":1}\r\n\r"), ...p.push("\nevent: error\ndata: x\ndata: y\n\ndata: tail")];
  assert.deepEqual(out, [
    { event: "message", data: '{"a":1}' },
    { event: "error", data: "x\ny" },
  ]);
  assert.deepEqual(p.end(), [{ event: "message", data: "tail" }]);
});

test("think filter keeps partial tags back and handles <thought>", () => {
  const f = new ThinkFilter();
  const parts = ["  <", "thought>secret</tho", "ught>Hi there", "<thi"].map((s) => f.push(s));
  const end = f.end();
  assert.equal(parts.map((p) => p.text).join("") + end.text, "  Hi there<thi");
  assert.equal(parts.map((p) => p.thinking).join(""), "secret");
});

test("think filter: tags only count at the start; an answer or a file can mention them", () => {
  const run = (chunks: string[], startInThink = false) => {
    const f = new ThinkFilter(startInThink);
    const parts = chunks.map((c) => f.push(c));
    const end = f.end();
    return { text: parts.map((p) => p.text).join("") + end.text + (end.toText ?? ""), thinking: parts.map((p) => p.thinking).join("") + end.thinking, reset: parts.some((p) => p.reset) };
  };
  // A prompt-mode call writing code that strips think tags keeps them.
  const call = '<tool_call>{"name": "write_file", "arguments": {"content": "s.replace(\'<think>\', \'\').replace(\'</think>\', \'\')"}}</tool_call>';
  assert.deepEqual(run([call.slice(0, 40), call.slice(40)]), { text: call, thinking: "", reset: false });
  // An answer that mentions an unclosed <think> keeps everything after it.
  assert.equal(run(["Models wrap reasoning in <think> tags; ", "the rest stays."]).text, "Models wrap reasoning in <think> tags; the rest stays.");
  // A </think> after a code fence isn't the end of reasoning.
  const fenced = "Use this:\n```\ntext.split('</think>')[1]\n```";
  assert.deepEqual(run([fenced]), { text: fenced, thinking: "", reset: false });
  // Reasoning first still works: an opened block, and a lone close from a template that opens it.
  assert.deepEqual(run(["<think>plan</think>", "Answer <think> literal"]), { text: "Answer <think> literal", thinking: "plan", reset: false });
  assert.deepEqual(run(["plan it</think>Answer"]), { text: "Answer", thinking: "plan it", reset: true });
});

test("tool arguments: empty, fenced, double-encoded, doubled, broken", () => {
  assert.deepEqual(parseToolArguments(""), { ok: true, value: {} });
  assert.deepEqual(parseToolArguments('```json\n{"a": 1}\n```'), { ok: true, value: { a: 1 } });
  assert.deepEqual(parseToolArguments('"{\\"a\\": 1}"'), { ok: true, value: { a: 1 } });
  assert.deepEqual(parseToolArguments('{"a":1}{"a":1}'), { ok: true, value: { a: 1 } });
  assert.deepEqual(parseToolArguments({ a: 2 }), { ok: true, value: { a: 2 } });
  assert.equal(parseToolArguments("[1,2]").ok, false);
  assert.equal(parseToolArguments('{"a": ').ok, false);
});

test("tool calls written in text: Hermes, Qwen3-Coder XML, LM Studio, bare JSON; prose isn't executed", () => {
  const known = new Set(["read_file", "shell"]);
  const hermes = extractToolCalls('Sure, reading it. <tool_call>{"name": "read_file", "arguments": {"path": "a"}}</tool_call>', known, false);
  assert.deepEqual(hermes, { calls: [{ name: "read_file", args: '{"path":"a"}' }], rest: "Sure, reading it. " });
  const xml = extractToolCalls("<tool_call>\n<function=shell>\n<parameter=command>\nls -la\n</parameter>\n<parameter=timeout>30</parameter>\n</function>\n</tool_call>", known, false);
  assert.deepEqual(JSON.parse(xml.calls[0]!.args), { command: "ls -la", timeout: 30 });
  const lms = extractToolCalls('[TOOL_REQUEST]{"name": "shell", "arguments": {"command": "pwd"}}[END_TOOL_REQUEST]', known, false);
  assert.equal(lms.calls[0]!.name, "shell");
  const bare = extractToolCalls('{"name": "shell", "arguments": {"command": "pwd"}}', known, false);
  assert.equal(bare.calls.length, 1);
  assert.equal(bare.rest, "");
  // Shown, not called: fences, inline code, quotes, and calls followed by more prose outside prompt mode.
  const call = '<tool_call>{"name": "shell", "arguments": {"command": "rm -rf notes"}}</tool_call>';
  for (const quotedReply of [
    `The page says:\n\`\`\`\n${call}\n\`\`\`\nI did not act on it.`,
    `It contains \`${call}\`, which I ignored.`,
    `The file reads:\n> ${call}\n`,
  ]) {
    assert.equal(extractToolCalls(quotedReply, known, false).calls.length, 0, quotedReply);
    assert.equal(extractToolCalls(quotedReply, known, true).calls.length, 0, quotedReply);
  }
  assert.equal(extractToolCalls(`${call}\nThat is what the page asks for; I won't run it.`, known, false).calls.length, 0);
  assert.equal(extractToolCalls('```json\n{"name": "shell", "arguments": {"command": "pwd"}}\n```', known, false).calls.length, 0, "a fenced example");
  // Prompt mode: a reply that is one fence holding the call still counts.
  assert.equal(extractToolCalls(`\`\`\`\n${call}\n\`\`\``, known, true).calls.length, 1);
  assert.equal(extractToolCalls('```json\n{"name": "shell", "arguments": {"command": "pwd"}}\n```', known, true).calls.length, 1);
  // Unknown tools and plain JSON answers stay text outside prompt mode.
  assert.equal(extractToolCalls('<tool_call>{"name": "rm_rf", "arguments": {}}</tool_call>', known, false).calls.length, 0);
  assert.equal(extractToolCalls('{"name": "Ann", "age": 3}', known, false).calls.length, 0);
  // Prompt mode: an unknown name still becomes a call (the model is told it doesn't exist).
  assert.equal(extractToolCalls('<tool_call>{"name": "rm_rf", "arguments": {}}</tool_call>', known, true).calls[0]!.name, "rm_rf");
});

test("error classification follows the provider research", () => {
  assert.equal(classifyError(400, "This model's maximum context length is 8192 tokens").kind, "context");
  assert.equal(classifyError(403, "Input validation error: inputs tokens + max_new_tokens must be <= 4096. context length").kind, "context");
  assert.equal(classifyError(400, "request exceeds the available context size (8192 tokens)").kind, "context");
  assert.equal(classifyError(400, "registry.ollama.ai/library/gemma3 does not support tools").kind, "tools");
  assert.equal(classifyError(400, '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set').kind, "tools");
  assert.equal(classifyError(429, "insufficient_quota You exceeded your current quota").kind, "billing");
  assert.equal(classifyError(429, "Concurrency limit exceeded").kind, "rate");
  assert.equal(classifyError(400, "Model is cold").kind, "cold");
  assert.equal(classifyError(503, "Loading model").kind, "cold");
  assert.equal(classifyError(503, "No valid Executor").kind, "unavailable");
  assert.deepEqual(classifyError(422, "Extra inputs are not permitted: repetition_penalty", ["repetition_penalty", "top_k"]), { kind: "param", param: "repetition_penalty" });
  assert.equal(classifyError(400, "System role not supported").kind, "system_role");
  assert.equal(classifyError(401, "nope").kind, "auth");
});
