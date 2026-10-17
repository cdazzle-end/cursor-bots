import assert from "node:assert/strict";
import * as fs from "node:fs";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Harness, type ProviderRuntimeFactory } from "../src/core/harness.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";
import type { AgentRuntime } from "../src/runtimes/types.ts";
import { createServer } from "../src/server/http.ts";
import { settle } from "./helpers.ts";

// Model providers as brains: registry, keys, model choice, system prompt, API.
// A scripted mock stands in for the OpenAI-compatible runtime (that one has its own tests).

const BARE = { workspaceTools: false, projectContext: false, mcp: false };

function fakeProviders() {
  const made: Array<{ id: string; mock: MockRuntime; key: () => string | undefined; completes: Array<Record<string, unknown> | undefined> }> = [];
  const factory: ProviderRuntimeFactory = (deps) => {
    const mock = new MockRuntime({ chunkDelayMs: 0, provides: BARE });
    const id = deps.provider().id;
    const completes: Array<Record<string, unknown> | undefined> = [];
    made.push({ id, mock, key: deps.apiKey, completes });
    const rt: AgentRuntime = {
      id,
      get label() {
        return deps.provider().label;
      },
      provides: BARE,
      available: () => (deps.apiKey() ? { ok: true } : { ok: false, reason: `${deps.provider().label} needs an API key.` }),
      open: (spec) => mock.open(spec),
      complete: (p, o) => {
        completes.push(o);
        return mock.complete(p);
      },
      listModels: async () => deps.provider().models.map((m) => ({ id: m.id, displayName: m.label ?? m.id, contextWindow: m.contextWindow })),
      fetchModels: async (o) => [{ id: "Qwen/Qwen3-32B", contextWindow: 32768 }, { id: "meta-llama/Llama-3.3-70B-Instruct" }].filter((m) => !o?.search || m.id.toLowerCase().includes(o.search.toLowerCase())),
      lookupModel: async (mid) => (mid === "Qwen/Qwen3-32B" ? { id: mid, contextWindow: 32768, concurrencyCost: 2 } : undefined),
    };
    return rt;
  };
  return { factory, made };
}

async function boot(opts: { env?: Record<string, string> } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-bots-prov-"));
  for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v;
  const fp = fakeProviders();
  const h = new Harness({ home, runtimes: [new MockRuntime({ chunkDelayMs: 0 })], providerRuntime: fp.factory });
  h.store.settings.runtime = "mock";
  h.store.settings.groupRouting = "heuristic";
  await h.start({ gatewayUrl: "http://127.0.0.1:1" });
  return {
    h,
    fp,
    home,
    async close() {
      await h.stop();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test("providers: a preset becomes a brain; its key is write-only and kept away from bots", async () => {
  const s = await boot();
  try {
    const p = s.h.createProvider({ preset: "featherless" });
    assert.equal(p.id, "featherless");
    assert.equal(p.baseUrl, "https://api.featherless.ai/v1");
    assert.equal(p.defaultModel, "Qwen/Qwen3-32B");
    assert.ok(s.h.runtimes.has("featherless"), "registered as a runtime");
    const snap = () => s.h.snapshot();
    assert.equal(snap().providers.find((x) => x.id === "featherless")!.hasKey, false);
    assert.equal(snap().runtimes.find((r) => r.id === "featherless")!.ok, false);

    s.h.setProviderKey("featherless", "fl_test_key_1234567890");
    assert.equal(snap().providers.find((x) => x.id === "featherless")!.hasKey, true);
    assert.equal(snap().runtimes.find((r) => r.id === "featherless")!.ok, true);
    assert.equal(s.fp.made[0]!.key(), "fl_test_key_1234567890");
    assert.ok(!JSON.stringify(snap()).includes("fl_test_key_1234567890"), "never in the state the UI sees");
    assert.ok(!s.h.vault.list().some((x) => x.name.startsWith("PROVIDER_")), "not a bot-usable secret");
    assert.ok(!s.h.vault.has("PROVIDER_FEATHERLESS"));
    assert.equal(s.h.scrubSecrets("key=fl_test_key_1234567890"), "key=[secret:PROVIDER_FEATHERLESS]");
    assert.ok(s.h.touchesHarness("cat ../state/provider-keys.vault"));
    assert.ok(s.h.touchesHarness("base64 provider-keys.json"));

    // Phala and Routeway presets are valid providers with their own key variables.
    const phala = s.h.createProvider({ preset: "phala" });
    assert.deepEqual([phala.id, phala.baseUrl, phala.keyEnv], ["phala", "https://inference.phala.com/v1", "PHALA_API_KEY"]);
    const routeway = s.h.createProvider({ preset: "routeway" });
    assert.deepEqual([routeway.id, routeway.baseUrl, routeway.keyEnv, routeway.maxTokensParam], ["routeway", "https://api.routeway.ai/v1", "ROUTEWAY_API_KEY", "max_completion_tokens"]);

    // A second provider from the same preset gets its own id.
    assert.equal(s.h.createProvider({ preset: "featherless" }).id, "featherless-2");
    // Reserved and invalid input.
    assert.throws(() => s.h.createProvider({ label: "X", baseUrl: "ftp://x" }), /https/);
    assert.throws(() => s.h.createProvider({ label: "X", baseUrl: "https://user:pw@x.example/v1" }), /credentials/);
    assert.throws(() => s.h.createProvider({ label: "X", baseUrl: "https://x.example/v1", headers: { Authorization: "Bearer y" } }), /key field/);
    assert.equal(s.h.createProvider({ label: "Cursor", baseUrl: "http://localhost:11434/v1" }).id, "cursor-2", "can't take a built-in brain's id");
  } finally {
    await s.close();
  }
});

test("providers: a key in an environment variable is used and taken out of bots' environment", async () => {
  const s = await boot({ env: { FEATHERLESS_API_KEY: "fl_env_key_abcdef" } });
  try {
    s.h.createProvider({ preset: "featherless" });
    assert.equal(s.fp.made[0]!.key(), "fl_env_key_abcdef");
    assert.equal(process.env.FEATHERLESS_API_KEY, undefined, "removed from this process's environment");
    assert.equal(s.h.childEnv().FEATHERLESS_API_KEY, undefined);
    assert.equal(s.h.describeProviders()[0]!.keySource, "environment");
    // Not in any vault, but still taken out of what tools hand back to a model.
    assert.equal(s.h.scrubSecrets("x fl_env_key_abcdef y"), "x [secret:FEATHERLESS_API_KEY] y");

    // FEATHERLESS_API_KEY is for Featherless: pointed at another service, the entry doesn't send it.
    s.h.updateProvider("featherless", { baseUrl: "https://llm.example.com/v1" });
    assert.equal(s.fp.made[0]!.key(), undefined);
    assert.equal(s.h.describeProviders()[0]!.hasKey, false);
    s.h.updateProvider("featherless", { baseUrl: "https://api.featherless.ai/v1" });
    assert.equal(s.fp.made[0]!.key(), "fl_env_key_abcdef");

    // Removing and re-adding the provider keeps the key (it was read once), and it stays scrubbed meanwhile.
    await s.h.deleteProvider("featherless");
    assert.equal(s.h.scrubSecrets("fl_env_key_abcdef"), "[secret:FEATHERLESS_API_KEY]");
    s.h.createProvider({ preset: "featherless" });
    assert.equal(s.h.describeProviders()[0]!.keySource, "environment");
  } finally {
    delete process.env.FEATHERLESS_API_KEY;
    await s.close();
  }
});

test("providers: a saved key stays with its service; plain http only on your own network", async () => {
  const s = await boot();
  try {
    s.h.createProvider({ preset: "featherless" });
    s.h.setProviderKey("featherless", "fl_saved_key_123456");
    // Same host, other path: still the same service.
    s.h.updateProvider("featherless", { baseUrl: "https://api.featherless.ai/v1/" });
    assert.equal(s.fp.made[0]!.key(), "fl_saved_key_123456");
    // Another host must be given its own key; the old one isn't sent there.
    s.h.updateProvider("featherless", { baseUrl: "https://api.featherless.example/v1" });
    assert.equal(s.fp.made[0]!.key(), undefined);
    assert.equal(s.h.describeProviders()[0]!.hasKey, false);

    assert.throws(() => s.h.createProvider({ label: "Remote", baseUrl: "http://api.featherless.ai/v1" }), /Use https:\/\//);
    for (const url of ["http://192.168.1.20:8000/v1", "http://gpu-box:11434/v1", "http://100.101.102.103:1234/v1", "http://ollama.lan/v1", "http://[fd00::5]:8000/v1"]) {
      const p = s.h.createProvider({ label: `LAN ${url}`, baseUrl: url });
      assert.equal(s.h.describeProviders().find((x) => x.id === p.id)!.needsKey, false, url);
    }
    assert.equal(s.h.describeProviders().find((x) => x.id === "featherless")!.needsKey, true);
  } finally {
    await s.close();
  }
});

test("providers: bots run on a provider with its default model, standing instructions and the harness's tools", async () => {
  const s = await boot();
  try {
    s.h.createProvider({ preset: "featherless" });
    s.h.setProviderKey("featherless", "fl_key_0000000000");
    fs.writeFileSync(path.join(s.h.store.paths.workspace, "AGENTS.md"), "# House rules\n\n- Always cite sources.\n");
    s.h.skills.save({ name: "Weekly report", description: "Build the weekly report.", body: "Steps" });
    s.h.skills.save({ name: "Secret sauce", description: "Not for this bot.", body: "Steps" });
    const bot = s.h.createBot({ name: "Feather", runtime: "featherless", disabledSkills: ["secret-sauce"] });
    assert.deepEqual(s.h.modelFor(bot, s.h.runtimes.get("featherless")!), { id: "Qwen/Qwen3-32B" });
    const dm = s.h.store.dmFor(bot.id)!;
    await s.h.postUserMessage(dm.id, { text: "hello" });
    await settle(s.h);
    const session = [...s.fp.made[0]!.mock.sessions.values()][0]!;
    const system = session.systems[0]!;
    assert.match(system, /# You are a bot in Cursor Bots/);
    assert.ok(!system.startsWith("---"), "manual frontmatter stripped");
    assert.match(system, /Always cite sources/);
    assert.match(system, /weekly-report: Build the weekly report/);
    assert.ok(!system.includes("secret-sauce"), "disabled skills are left out");
    assert.ok(session.toolNames[0]!.includes("send_message"));
    assert.ok(s.h.store.bots.get(bot.id)!.agentId?.startsWith("mock-"));

    // A model picked for Cursor means nothing to the provider; one picked for the provider is used there.
    const cursorPick = s.h.createBot({ name: "Mixed", model: { id: "composer-2.5" } });
    s.h.updateBot(cursorPick.id, { runtime: "featherless" });
    assert.deepEqual(s.h.modelFor(s.h.store.bots.get(cursorPick.id)!, s.h.runtimes.get("featherless")!), { id: "Qwen/Qwen3-32B" });
    s.h.updateBot(cursorPick.id, { model: { id: "meta-llama/Llama-3.3-70B-Instruct" } });
    assert.deepEqual(s.h.modelFor(s.h.store.bots.get(cursorPick.id)!, s.h.runtimes.get("featherless")!), { id: "meta-llama/Llama-3.3-70B-Instruct" });

    // Cursor-style runtimes get no system prompt from the harness.
    const plain = s.h.createBot({ name: "Plain" });
    await s.h.postUserMessage(s.h.store.dmFor(plain.id)!.id, { text: "hi" });
    await settle(s.h);
    const mock = s.h.runtimes.get("mock") as MockRuntime;
    assert.equal([...mock.sessions.values()][0]!.systems[0], undefined);
  } finally {
    await s.close();
  }
});

test("providers: removing one moves its bots to the default brain with a notice", async () => {
  const s = await boot();
  try {
    s.h.createProvider({ preset: "featherless" });
    s.h.setProviderKey("featherless", "fl_key_0000000000");
    s.h.updateSettings({ runtime: "featherless" });
    const bot = s.h.createBot({ name: "Mover", runtime: "featherless", model: { id: "Qwen/Qwen3-32B" } });
    await s.h.deleteProvider("featherless");
    assert.equal(s.h.runtimes.has("featherless"), false);
    assert.notEqual(s.h.store.settings.runtime, "featherless");
    const b = s.h.store.bots.get(bot.id)!;
    assert.equal(b.runtime, undefined);
    assert.equal(b.model, undefined);
    assert.ok(s.h.store.messages(s.h.store.dmFor(bot.id)!.id).some((m) => m.kind === "notice" && /Featherless AI was removed/.test(m.text)));
    assert.equal(s.h.providerKeys.has("PROVIDER_FEATHERLESS"), false, "its key is deleted");

    // A bot pointing at a brain that doesn't exist gets a clear error instead of a silent switch.
    s.h.store.bots.get(bot.id)!.runtime = "gone";
    assert.throws(() => s.h.runtimeFor(s.h.store.bots.get(bot.id)!), /no longer exists/);
  } finally {
    await s.close();
  }
});

test("providers: a model stays with its brain through copies, templates and helpers; removing the default brain says so", async () => {
  const s = await boot();
  const savedCursorKey = process.env.CURSOR_API_KEY;
  try {
    const p = s.h.createProvider({ preset: "featherless" });
    assert.equal(p.preset, "featherless", "remembers its preset (for the editor's notes)");
    s.h.setProviderKey("featherless", "fl_key_0000000000");
    // A bot with a Cursor model from before, then Featherless becomes the default brain.
    const old = s.h.createBot({ name: "Old", model: { id: "composer-2.5" }, modelRuntime: "cursor" });
    s.h.updateSettings({ runtime: "featherless" });
    const fl = s.h.runtimes.get("featherless")!;
    const copy = s.h.duplicateBot(old.id);
    assert.equal(copy.modelRuntime, "cursor");
    assert.deepEqual(s.h.modelFor(copy, fl), { id: "Qwen/Qwen3-32B" }, "the Cursor model isn't sent to Featherless");
    const t = s.h.exportBot(old.id);
    assert.equal(t.modelRuntime, "cursor");
    const imported = s.h.importBot({ ...t, modelRuntime: undefined });
    assert.equal(imported.modelRuntime, "cursor", "older templates hold Cursor models");
    assert.deepEqual(s.h.modelFor(imported, fl), { id: "Qwen/Qwen3-32B" });

    // A helper made by a bot on Featherless runs on Featherless too.
    s.h.updateSettings({ runtime: "mock" });
    const maker = s.h.createBot({ name: "Maker", runtime: "featherless" });
    await s.h.postUserMessage(s.h.store.dmFor(maker.id)!.id, { text: '[[tool create_bot {"name":"Helper","job":"Find sources"}]] [[reply Made one.]]' });
    await settle(s.h);
    assert.equal([...s.h.store.bots.values()].find((b) => b.name === "Helper")?.runtime, "featherless");

    // The test prompt gets an abort signal, so a call that runs out of time lets go of its capacity.
    await s.h.testProvider("featherless");
    assert.ok(s.fp.made[0]!.completes.at(-1)?.signal instanceof AbortSignal);

    // Removing the default brain tells the bots that were on it.
    s.h.updateSettings({ runtime: "featherless" });
    const plain = s.h.createBot({ name: "Plain" });
    await s.h.deleteProvider("featherless");
    assert.ok(s.h.store.messages(s.h.store.dmFor(plain.id)!.id).some((m) => m.kind === "notice" && /Featherless AI was removed, so Plain now runs on the default brain \(/.test(m.text)));

    // The Cursor key isn't handed to another provider in tool output either.
    process.env.CURSOR_API_KEY = "key_cursor_abcdef123456";
    assert.equal(s.h.scrubSecrets("k=key_cursor_abcdef123456"), "k=[secret:CURSOR_API_KEY]");
  } finally {
    if (savedCursorKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = savedCursorKey;
    await s.close();
  }
});

test("providers: HTTP API never returns the key, validates input, and lists models per brain", async () => {
  const s = await boot();
  const server = createServer(s.h, { port: 0, host: "127.0.0.1", token: "t" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(base + p, { method, headers: { authorization: "Bearer t", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : {}, text };
  };
  try {
    const presets = await call("GET", "/api/providers");
    assert.ok(presets.data.presets.some((p: any) => p.key === "featherless"));
    const created = await call("POST", "/api/providers", { preset: "featherless" });
    assert.equal(created.status, 200);
    const put = await call("PUT", "/api/providers/featherless/key", { value: "fl_http_key_999999" });
    assert.equal(put.status, 200);
    assert.ok(!put.text.includes("fl_http_key_999999"));
    for (const p of ["/api/state", "/api/providers"]) assert.ok(!(await call("GET", p)).text.includes("fl_http_key_999999"), p);
    assert.equal((await call("PATCH", "/api/providers/featherless", { baseUrl: "javascript:alert(1)" })).status, 400);
    const models = await call("GET", "/api/models?runtime=featherless");
    assert.deepEqual(models.data.models.map((m: any) => m.id), ["Qwen/Qwen3-32B"]);
    const catalog = await call("GET", "/api/providers/featherless/catalog?search=llama");
    assert.deepEqual(catalog.data.models.map((m: any) => m.id), ["meta-llama/Llama-3.3-70B-Instruct"]);
    assert.equal((await call("GET", "/api/providers/featherless/lookup?model=Qwen%2FQwen3-32B")).data.model.concurrencyCost, 2);
    const tested = await call("POST", "/api/providers/featherless/test");
    assert.equal(tested.data.ok, true);
    // Changing models through the API keeps the list valid.
    const patched = await call("PATCH", "/api/providers/featherless", {
      models: [{ id: "Qwen/Qwen3-32B", contextWindow: 32768 }, { id: "moonshotai/Kimi-K2-Instruct", toolMode: "native", extraBody: '{"chat_template_kwargs":{"thinking":false},"model":"evil"}' }],
      defaultModel: "moonshotai/Kimi-K2-Instruct",
    });
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.data.models[1].extraBody, { chat_template_kwargs: { thinking: false } }, "can't override the model through extra fields");
    assert.equal((await call("DELETE", "/api/providers/featherless/key")).status, 200);
    assert.equal(s.h.describeProviders()[0]!.hasKey, false);
    assert.equal((await call("DELETE", "/api/providers/featherless")).status, 200);
    assert.equal((await call("GET", "/api/providers")).data.providers.length, 0);
  } finally {
    server.close();
    await s.close();
  }
});
