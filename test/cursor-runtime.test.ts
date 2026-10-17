import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Harness } from "../src/core/harness.ts";
import { CursorRuntime, type Sdk } from "../src/runtimes/cursor.ts";
import type { AgentRuntime, RuntimeEvent } from "../src/runtimes/types.ts";
import { settle } from "./helpers.ts";

/**
 * A stand-in for @cursor/sdk with the same surface the adapter uses. It lets
 * us check the adapter's mapping (options, custom tools, streaming, resume,
 * recovery) without network access or an API key.
 */
function fakeSdk(opts: { failSendOnce?: string } = {}) {
  const calls = { create: [] as any[], resume: [] as any[], sends: [] as any[], stores: [] as any[], disposed: 0 };
  class AgentNotFoundError extends Error {}
  let failNext = opts.failSendOnce;

  class FakeRun {
    id = `run-${calls.sends.length}`;
    result: string;
    steered: string[] = [];
    constructor(result: string) {
      this.result = result;
    }
    supports() {
      return true;
    }
    async *stream() {
      yield { type: "tool_call", agent_id: "a", run_id: this.id, call_id: "c1", name: "shell", status: "running", args: { command: "ls -la" } };
      yield { type: "tool_call", agent_id: "a", run_id: this.id, call_id: "c1", name: "shell", status: "completed", result: "ok" };
      // The real SDK reports compaction only here: the summary arrives as a "task" message.
      yield { type: "task", agent_id: "a", run_id: this.id, text: "Summary of the conversation so far" };
    }
    async steer(text: string) {
      this.steered.push(text);
      return "complete_delivered";
    }
    async cancel() {}
    async wait() {
      return { id: this.id, status: "finished", result: this.result, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 }, requestId: "req-1", model: { id: "composer-2.5" } };
    }
  }

  class FakeAgent {
    agentId: string;
    constructor(id: string) {
      this.agentId = id;
    }
    async send(message: any, sendOpts: any) {
      calls.sends.push({ agentId: this.agentId, message, opts: sendOpts });
      if (failNext) {
        const msg = failNext;
        failNext = undefined;
        throw new Error(msg);
      }
      // Simulate the model calling one harness tool and streaming text.
      const tools = sendOpts.local.customTools;
      let toolOut = "";
      if (tools.list_team) {
        const res = await tools.list_team.execute({}, { toolCallId: "t1" });
        toolOut = res.content[0].text;
      }
      await sendOpts.onDelta({ update: { type: "text-delta", text: "Hello " } });
      await sendOpts.onDelta({ update: { type: "text-delta", text: "there" } });
      return new FakeRun(`Final answer. Team: ${toolOut.split("\n")[0]}`);
    }
    close() {}
  }

  const sdk = {
    Agent: {
      async create(o: any) {
        calls.create.push(o);
        return new FakeAgent(`agent-${calls.create.length}`);
      },
      async resume(id: string, o: any) {
        calls.resume.push({ id, o });
        if (id === "agent-gone") throw new AgentNotFoundError("Agent not found");
        return new FakeAgent(id);
      },
      async delete() {},
    },
    AgentNotFoundError,
    Cursor: { models: { list: async () => [{ id: "composer-2.5", displayName: "Composer 2.5", parameters: [] }] } },
  };
  const openStore = async (o: { workspaceRef: string; stateRoot: string }) => {
    const store = { ...o, dispose: async () => void calls.disposed++ };
    calls.stores.push(store);
    return store as any;
  };
  return { sdk: sdk as unknown as Sdk, calls, openStore };
}

function runtime(fake: ReturnType<typeof fakeSdk>, dir: string) {
  return new CursorRuntime({
    apiKey: "key_test",
    storeDir: path.join(dir, "store"),
    scratchDir: path.join(dir, "scratch"),
    settings: () => ({ defaultModel: { id: "composer-2.5" }, autoReview: true, sandbox: false }),
    loadSdk: async () => fake.sdk,
    openStore: fake.openStore,
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A routing-only SDK fake whose setup and run can each pause independently. */
function routingRuntime(opts: { pause?: "load" | "store" | "create" | "send" | "wait"; sendError?: Error; waitError?: Error } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cursor-routing-"));
  const gate = deferred();
  const entered = { load: deferred(), store: deferred(), create: deferred(), send: deferred(), wait: deferred() };
  const calls = { loads: 0, stores: 0, creates: [] as any[], sends: [] as string[], waits: 0, cancels: 0, closes: 0, deletes: [] as string[] };
  const pause = async (phase: keyof typeof entered) => {
    entered[phase].resolve();
    if (opts.pause === phase) await gate.promise;
  };
  const run = {
    async cancel() { calls.cancels++; },
    async wait() {
      calls.waits++;
      await pause("wait");
      if (opts.waitError) throw opts.waitError;
      return { status: "finished", result: "bot-a" };
    },
  };
  const agent = {
    agentId: "scratch-agent",
    async send(prompt: string) {
      calls.sends.push(prompt);
      await pause("send");
      if (opts.sendError) throw opts.sendError;
      return run;
    },
    close() { calls.closes++; },
  };
  const sdk = {
    Agent: {
      async create(o: unknown) {
        calls.creates.push(o);
        await pause("create");
        return agent;
      },
      async delete(id: string) { calls.deletes.push(id); },
    },
  } as unknown as Sdk;
  const rt = new CursorRuntime({
    apiKey: "key_test",
    storeDir: path.join(dir, "store"),
    scratchDir: path.join(dir, "scratch"),
    settings: () => ({ defaultModel: { id: "composer-2.5" }, autoReview: true, sandbox: false }),
    loadSdk: async () => { calls.loads++; await pause("load"); return sdk; },
    openStore: async () => { calls.stores++; await pause("store"); return {} as any; },
  });
  // Exercise the same completion contract used by harness routing.
  const complete: NonNullable<AgentRuntime["complete"]> = rt.complete.bind(rt);
  return {
    complete, calls, entered,
    release: gate.resolve,
    async cleanup() {
      gate.resolve();
      await nextTurn();
      await rt.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function assertRoutingAbort(pending: Promise<string>) {
  const outcome = await Promise.race([
    pending.then((value) => ({ status: "fulfilled" as const, value }), (error: unknown) => ({ status: "rejected" as const, error })),
    nextTurn().then(() => ({ status: "pending" as const })),
  ]);
  assert.equal(outcome.status, "rejected", "routing must reject on abort without waiting for the SDK");
  if (outcome.status === "rejected") {
    assert.ok(outcome.error instanceof Error);
    assert.equal(outcome.error.name, "AbortError");
  }
}

test("Cursor routing: a pre-aborted signal starts no SDK work", async () => {
  const t = routingRuntime();
  const ctrl = new AbortController();
  ctrl.abort();
  try {
    await assertRoutingAbort(t.complete("pick a bot", { signal: ctrl.signal }));
    assert.equal(t.calls.loads, 0);
    assert.equal(t.calls.stores, 0);
    assert.equal(t.calls.creates.length, 0);
  } finally {
    await t.cleanup();
  }
});

test("Cursor routing: abort during setup prevents downstream work and cleans a late agent", async (parent) => {
  for (const phase of ["load", "store", "create"] as const) {
    await parent.test(phase, async () => {
      const t = routingRuntime({ pause: phase });
      const ctrl = new AbortController();
      const pending = t.complete("pick a bot", { signal: ctrl.signal });
      try {
        await t.entered[phase].promise;
        ctrl.abort();
        await assertRoutingAbort(pending);
        t.release();
        await nextTurn();
        assert.equal(t.calls.sends.length, 0, "an abandoned routing prompt must never be sent");
        if (phase === "load") assert.equal(t.calls.stores, 0);
        if (phase !== "create") assert.equal(t.calls.creates.length, 0);
        assert.equal(t.calls.closes, phase === "create" ? 1 : 0);
        assert.deepEqual(t.calls.deletes, phase === "create" ? ["scratch-agent"] : []);
        assert.equal(getEventListeners(ctrl.signal, "abort").length, 0);
      } finally {
        await t.cleanup();
      }
    });
  }
});

test("Cursor routing: abort while send is pending cancels its late run", async () => {
  const t = routingRuntime({ pause: "send" });
  const ctrl = new AbortController();
  const pending = t.complete("pick a bot", { signal: ctrl.signal });
  try {
    await t.entered.send.promise;
    ctrl.abort();
    await assertRoutingAbort(pending);
    t.release();
    await nextTurn();
    assert.equal(t.calls.cancels, 1);
    assert.equal(t.calls.closes, 1);
    assert.deepEqual(t.calls.deletes, ["scratch-agent"]);
    assert.equal(getEventListeners(ctrl.signal, "abort").length, 0);
  } finally {
    await t.cleanup();
  }
});

test("Cursor routing: abort rejects promptly when cancelling does not settle wait", async () => {
  const t = routingRuntime({ pause: "wait" });
  const ctrl = new AbortController();
  const pending = t.complete("pick a bot", { signal: ctrl.signal });
  try {
    await t.entered.wait.promise;
    ctrl.abort();
    await assertRoutingAbort(pending);
    assert.equal(t.calls.cancels, 1);
    assert.equal(t.calls.closes, 1);
    assert.deepEqual(t.calls.deletes, ["scratch-agent"]);
    assert.equal(getEventListeners(ctrl.signal, "abort").length, 0);
  } finally {
    await t.cleanup();
  }
});

test("Cursor routing: a completed answer keeps cleanup and removes the abort listener", async () => {
  const t = routingRuntime();
  const ctrl = new AbortController();
  try {
    assert.equal(await t.complete("pick a bot", { model: { id: "gpt-5.5" }, signal: ctrl.signal }), "bot-a");
    assert.equal(t.calls.creates[0].model.id, "gpt-5.5");
    assert.deepEqual(t.calls.creates[0].tools, []);
    assert.deepEqual(t.calls.creates[0].local.settingSources, []);
    assert.equal(t.calls.closes, 1);
    assert.deepEqual(t.calls.deletes, ["scratch-agent"]);
    assert.equal(getEventListeners(ctrl.signal, "abort").length, 0);
    ctrl.abort();
    assert.equal(t.calls.cancels, 0, "a later abort must not cancel a completed run");
  } finally {
    await t.cleanup();
  }
});

test("Cursor routing: send and wait failures preserve the error and clean the scratch agent", async (parent) => {
  for (const phase of ["send", "wait"] as const) {
    await parent.test(phase, async () => {
      const error = new Error(`${phase} failed`);
      const t = routingRuntime(phase === "send" ? { sendError: error } : { waitError: error });
      const ctrl = new AbortController();
      try {
        await assert.rejects(t.complete("pick a bot", { signal: ctrl.signal }), (err) => err === error);
        assert.equal(t.calls.closes, 1);
        assert.deepEqual(t.calls.deletes, ["scratch-agent"]);
        assert.equal(getEventListeners(ctrl.signal, "abort").length, 0);
        ctrl.abort();
        assert.equal(t.calls.cancels, 0);
      } finally {
        await t.cleanup();
      }
    });
  }
});

test("Cursor runtime: create, custom tools, streaming, outcome mapping", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cursor-"));
  try {
    const fake = fakeSdk();
    const { calls } = fake;
    const rt = runtime(fake, dir);
    const session = await rt.open({ botId: "b1", name: "Critic", cwd: "/ws" });
    assert.equal(session.agentId, "agent-1");
    const created = calls.create[0];
    assert.equal(created.name, "Critic (Cursor Bots)");
    assert.deepEqual(created.model, { id: "composer-2.5" });
    assert.equal(created.local.cwd, "/ws");
    assert.deepEqual(created.local.settingSources, ["project"]);
    assert.equal(created.local.autoReview, true);
    assert.deepEqual(created.local.sandboxOptions, { enabled: false });
    assert.equal(created.local.store, calls.stores[0], "sessions share one opened store");
    assert.deepEqual({ ...calls.stores[0], dispose: undefined }, { workspaceRef: "/ws", stateRoot: path.join(dir, "store"), dispose: undefined });

    const events: RuntimeEvent[] = [];
    let toolCalled = false;
    const run = await session.send({
      text: "hi",
      images: [{ data: "AAAA", mimeType: "image/png" }],
      tools: [{ name: "list_team", description: "d", inputSchema: { type: "object", properties: {} }, execute: async () => ((toolCalled = true), { text: "Bots: @critic" }) }],
      mcpServers: { github: { type: "stdio", command: "npx", args: ["x"], env: { A: "1" } }, docs: { type: "http", url: "https://e.com/mcp", headers: { Authorization: "Bearer z" } } },
      onEvent: (e) => events.push(e),
    });
    const out = await run.wait();
    assert.ok(toolCalled, "harness tool reached through customTools");
    assert.equal(out.status, "finished");
    assert.equal(out.text, "Final answer. Team: Bots: @critic");
    assert.deepEqual(out.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    assert.equal(out.requestId, "req-1");
    assert.deepEqual(
      events.filter((e) => e.type === "text").map((e: any) => e.text),
      ["Hello ", "there"],
    );
    assert.ok(events.some((e) => e.type === "summary"));
    assert.ok(events.some((e: any) => e.type === "tool" && e.name === "shell" && e.status === "running"));
    const sent = calls.sends[0];
    assert.deepEqual(sent.message.images, [{ data: "AAAA", mimeType: "image/png" }]);
    assert.deepEqual(sent.opts.mcpServers.github, { type: "stdio", command: "npx", args: ["x"], env: { A: "1" }, cwd: undefined });
    assert.deepEqual(sent.opts.mcpServers.docs, { type: "http", url: "https://e.com/mcp", headers: { Authorization: "Bearer z" } });
    assert.equal(sent.opts.local.force, false);
    assert.equal(await run.steer!("also this"), true);

    await rt.open({ botId: "b2", name: "Writer", cwd: "/ws" });
    assert.equal(calls.stores.length, 1, "a second bot reuses the store");
    await rt.dispose();
    assert.equal(calls.disposed, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Cursor runtime: resume, fall back when the checkpoint store lost the agent, retry a stuck run", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cursor-"));
  try {
    const fake = fakeSdk({ failSendOnce: "Agent is busy: an active run exists" });
    const { calls } = fake;
    const rt = runtime(fake, dir);
    const resumed = await rt.open({ botId: "b1", agentId: "agent-old", name: "Critic", cwd: "/ws" });
    assert.equal(resumed.agentId, "agent-old");
    assert.equal(calls.resume[0].id, "agent-old");
    const fresh = await rt.open({ botId: "b1", agentId: "agent-gone", name: "Critic", cwd: "/ws" });
    assert.equal(fresh.agentId, "agent-1", "a lost agent is recreated instead of failing");

    const run = await resumed.send({ text: "hi", tools: [], mcpServers: {}, onEvent: () => {} });
    await run.wait();
    assert.equal(calls.sends.length, 2, "busy error retried once");
    assert.equal(calls.sends[1].opts.local.force, true);
    assert.equal(calls.sends[1].opts.mcpServers, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a harness bot runs end to end on the Cursor adapter and keeps its agent id", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cursor-home-"));
  const fake = fakeSdk();
  const { calls } = fake;
  const h = new Harness({ home, runtimes: [runtime(fake, home)] });
  h.store.settings.runtime = "cursor";
  await h.start({ gatewayUrl: "http://127.0.0.1:1" });
  try {
    const bot = h.createBot({ name: "Researcher", model: { id: "gpt-5.5" } });
    const dm = h.store.dmFor(bot.id)!;
    await h.postUserMessage(dm.id, { text: "find sources" });
    await settle(h);
    const reply = h.store.messages(dm.id).at(-1)!;
    assert.equal(reply.author.kind, "bot");
    assert.match(reply.text, /^Final answer\. Team: User: Boss/);
    const act = reply.meta!.activity as any[];
    assert.equal(act[0].name, "shell");
    assert.equal(act[0].summary, "ls -la");
    assert.equal(h.store.bots.get(bot.id)!.agentId, "agent-1");
    assert.deepEqual(calls.create[0].model, { id: "gpt-5.5" }, "per-bot model");
    assert.match(calls.sends[0].message.text, /<you name="Researcher" handle="@researcher">/);
    assert.ok(Object.keys(calls.sends[0].opts.local.customTools).includes("send_message"));

    // Second turn reuses the open session (no new create) and still names the bot.
    await h.postUserMessage(dm.id, { text: "thanks" });
    await settle(h);
    assert.equal(calls.create.length, 1);
    assert.equal(calls.sends.length, 2);
    // The fake's stream reported a compaction ("task"), so identity + memory are re-sent in full.
    assert.match(calls.sends[1].message.text, /<memory>/);
  } finally {
    await h.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
