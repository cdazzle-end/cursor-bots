import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Harness } from "../src/core/harness.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";
import { OpenAICompatRuntime } from "../src/runtimes/openai.ts";
import { settle, texts } from "./helpers.ts";

/**
 * End to end: the real harness and the real OpenAI-compatible runtime against
 * a scripted provider server, with a real MCP connector (the stdio fixture).
 * Checks that the pieces fit: system prompt, the tools the bot gets, tool
 * round trips, memory, approvals, and that the key stays out of everything.
 */

const FAKE_MCP = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));
const KEY = "sk-e2e-provider-key-0123456789";

type Reply = { content?: string; calls?: Array<{ name: string; args: Record<string, unknown> }> };

/** An OpenAI-compatible server: `script` answers each chat request; answers stream as SSE chunks. */
async function fakeProvider(script: (body: any, n: number) => Reply) {
  const requests: Array<{ body: any; auth: string | undefined }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ data: [{ id: "fake/model", context_length: 32768 }] }));
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") return void res.writeHead(404).end();
      const body = JSON.parse(raw);
      requests.push({ body, auth: req.headers.authorization });
      const r = script(body, requests.length);
      const id = `chatcmpl-${requests.length}`;
      const chunk = (delta: unknown, finish: string | null = null) =>
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "fake/model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ id, model: "fake/model", choices: [{ index: 0, message: { role: "assistant", content: r.content ?? "" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": ping\n\n");
      if (r.content) {
        const half = Math.ceil(r.content.length / 2);
        res.write(chunk({ role: "assistant", content: r.content.slice(0, half) }));
        res.write(chunk({ content: r.content.slice(half) }));
      }
      (r.calls ?? []).forEach((c, i) => {
        const args = JSON.stringify(c.args);
        res.write(chunk({ tool_calls: [{ index: i, id: `call_${requests.length}_${i}`, type: "function", function: { name: c.name, arguments: args.slice(0, 5) } }] }));
        res.write(chunk({ tool_calls: [{ index: i, function: { arguments: args.slice(5) } }] }));
      });
      res.write(chunk({}, r.calls?.length ? "tool_calls" : "stop"));
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** The tool results the model was sent in a request (OpenAI "tool" messages). */
function toolResults(body: any): string[] {
  return body.messages.filter((m: any) => m.role === "tool").map((m: any) => String(m.content));
}

async function boot(script: (body: any, n: number) => Reply) {
  const prov = await fakeProvider(script);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-bots-e2e-"));
  const h = new Harness({
    home,
    runtimes: [new MockRuntime({ chunkDelayMs: 0 })],
    providerRuntime: (deps) => new OpenAICompatRuntime({ ...deps, sleep: async () => {} }),
  });
  h.store.settings.runtime = "mock";
  h.store.settings.groupRouting = "heuristic";
  h.store.settings.approvals.inlineWaitSeconds = 0;
  await h.start({ gatewayUrl: "http://127.0.0.1:1" });
  const p = h.createProvider({ preset: "custom", label: "Fake AI", baseUrl: `${prov.base}/v1`, models: [{ id: "fake/model", contextWindow: 32768, toolMode: "native" }], defaultModel: "fake/model" });
  h.setProviderKey(p.id, KEY);
  return {
    h,
    prov,
    home,
    providerId: p.id,
    async close() {
      await h.stop();
      await prov.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Every file under a folder, as text. */
function allText(dir: string): string {
  let out = "";
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const f = path.join(e.parentPath, e.name);
    if (/\.vault$|provider-keys\.json$/.test(f)) continue;
    out += fs.readFileSync(f, "utf8");
  }
  return out;
}

test("a bot on a provider brain: system prompt, all three kinds of tools, memory and a connector round trip", async () => {
  const env = await boot((body, n) => {
    if (n === 1) return { content: "On it.", calls: [{ name: "memory_update", args: { action: "add", section: "Preferences", text: "Likes green tea" } }] };
    if (n === 2) return { calls: [{ name: "fake__echo", args: { text: "ping" } }] };
    return { content: `Saved, and the connector said: ${toolResults(body).at(-1)}` };
  });
  const { h, prov } = env;
  try {
    h.store.connectors = { fake: { command: process.execPath, args: [FAKE_MCP], enabled: true } };
    const bot = h.createBot({ name: "Opal", runtime: env.providerId });
    const dm = h.store.dmFor(bot.id)!;
    await h.postUserMessage(dm.id, { text: "Remember that I like green tea, then ping the fake app." });
    await settle(h, 15_000);

    assert.equal(prov.requests.length, 3);
    assert.ok(prov.requests.every((r) => r.auth === `Bearer ${KEY}`));
    const first = prov.requests[0]!.body;
    assert.equal(first.model, "fake/model");
    assert.equal(first.stream, true);
    // Standing instructions go in the system message: the manual and the house rules.
    assert.equal(first.messages[0].role, "system");
    assert.match(first.messages[0].content, /House rules/);
    assert.match(first.messages[0].content, /computer tools/i);
    // The envelope (identity, memory, the message) is the user turn.
    const user = first.messages.find((m: any) => m.role === "user");
    assert.match(typeof user.content === "string" ? user.content : JSON.stringify(user.content), /green tea/);
    const names = first.tools.map((t: any) => t.function.name);
    for (const n of ["send_message", "memory_update", "request_approval", "fake__echo"]) assert.ok(names.includes(n), `offers ${n}`);
    assert.ok(names.length > 25, `harness, workspace and connector tools (${names.length})`);
    assert.ok(names.every((n: string) => /^[a-zA-Z0-9_-]{1,64}$/.test(n)));

    assert.match(h.store.readMemory(bot.id), /Likes green tea/);
    assert.match(toolResults(prov.requests[1]!.body).join("\n"), /Saved to Preferences/);
    assert.match(toolResults(prov.requests[2]!.body).at(-1)!, /ping/);
    const said = texts(h, dm.id).filter((t) => t.startsWith("@opal"));
    assert.equal(said.length, 1);
    assert.match(said[0]!, /the connector said: .*ping/);

    // The key reaches the provider in the header and nowhere else.
    assert.doesNotMatch(allText(env.home), new RegExp(KEY));
    assert.equal(fs.readdirSync(path.join(env.home, "state", "agents")).filter((f) => f.endsWith(".jsonl")).length, 1);
  } finally {
    await env.close();
  }
});

test("a provider bot's shell command stops for approval, and Allow once runs it on the retry", async () => {
  let shellTool = "";
  const env = await boot((body, n) => {
    const names: string[] = (body.tools ?? []).map((t: any) => t.function.name);
    shellTool ||= names.find((x) => /^(shell|run_shell|bash|run_command|terminal)$/.test(x)) ?? "";
    const results = toolResults(body);
    if (n === 1) return { calls: [{ name: shellTool, args: { command: "git push origin main" } }] };
    if (n === 2) return { content: `Waiting: ${results.at(-1)}` };
    if (n === 3) return { calls: [{ name: shellTool, args: { command: "git push origin main" } }] };
    return { content: `Ran it: ${results.at(-1)}` };
  });
  const { h, prov } = env;
  try {
    const bot = h.createBot({ name: "Quartz", runtime: env.providerId });
    const dm = h.store.dmFor(bot.id)!;
    await h.postUserMessage(dm.id, { text: "Push the branch." });
    await settle(h, 15_000);
    assert.ok(shellTool, "a shell tool is offered");
    const pending = h.approvals.pendingFor(bot.id);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.command, "git push origin main");
    assert.equal(prov.requests.length, 2);

    h.decideApproval(pending[0]!.id, "once");
    await settle(h, 15_000);
    assert.equal(prov.requests.length, 4);
    // It ran (and failed: the workspace isn't a git repository), and the grant was used up.
    assert.match(toolResults(prov.requests[3]!.body).at(-1)!, /not a git repository|exit/i);
    assert.equal(h.approvals.pendingFor(bot.id).length, 0);
  } finally {
    await env.close();
  }
});
