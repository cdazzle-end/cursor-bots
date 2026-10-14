import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Harness } from "../src/core/harness.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";
import { createServer } from "../src/server/http.ts";
import { settle } from "./helpers.ts";

async function boot(token?: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-bots-srv-"));
  const h = new Harness({ home, runtimes: [new MockRuntime({ chunkDelayMs: 0 })] });
  h.store.settings.runtime = "mock";
  h.store.settings.groupRouting = "heuristic";
  h.store.settings.approvals.inlineWaitSeconds = 0;
  const server = createServer(h, { port: 0, host: "127.0.0.1", token });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  await h.start({ gatewayUrl: base });
  const call = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === "string" || body instanceof Uint8Array ? (body as any) : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : {} };
  };
  return {
    h,
    base,
    call,
    async close() {
      server.close();
      await h.stop();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test("REST API: bots, messages, uploads, webhooks and static UI", async () => {
  const s = await boot();
  try {
    const page = await fetch(s.base + "/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Cursor Bots/);

    const created = await s.call("POST", "/api/bots", { name: "Critic", label: "Reviews" });
    assert.equal(created.status, 200);
    const bot = created.data;
    const state = (await s.call("GET", "/api/state")).data;
    const dm = state.conversations.find((c: any) => c.kind === "dm" && c.members[0] === bot.id);

    const up = await s.call("POST", "/api/uploads?name=notes.txt", "hello file");
    assert.equal(up.data.mime, "text/plain");
    const sent = await s.call("POST", `/api/conversations/${dm.id}/messages`, { text: "look at this", attachments: [up.data.path] });
    assert.equal(sent.status, 200);
    await settle(s.h);
    const msgs = (await s.call("GET", `/api/conversations/${dm.id}/messages`)).data.messages;
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].attachments[0].name, "notes.txt");

    // Escaping the workspace is refused.
    assert.equal((await s.call("GET", "/api/files/raw?path=../state/bots.json")).status, 400);

    // Webhook routine: wrong key is rejected, right key starts a run.
    const routine = s.h.scheduler.create({ botId: bot.id, name: "On deploy", instruction: "Summarize the deploy", webhook: true });
    assert.equal((await s.call("POST", `/api/webhooks/routines/${routine.id}`, { v: 1 }, { authorization: "Bearer nope" })).status, 401);
    const ok = await s.call("POST", `/api/webhooks/routines/${routine.id}`, { version: "1.2.3" }, { authorization: `Bearer ${routine.webhookKey}` });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.accepted, true);
    await settle(s.h);
    assert.equal(s.h.store.routines.get(routine.id)!.history.at(-1)!.status, "succeeded");

    // Cross-site writes are refused.
    const cross = await s.call("POST", "/api/bots", { name: "Evil" }, { origin: "https://evil.example" });
    assert.equal(cross.status, 403);
  } finally {
    await s.close();
  }
});

test("the installed Cursor hook script maps sessions to bots and gates shell commands", async () => {
  const s = await boot();
  try {
    const bot = s.h.createBot({ name: "Shipper" });
    const gate = path.join(s.h.store.paths.hooksDir, "cursor-bots-gate.mjs");
    const hooks = JSON.parse(fs.readFileSync(s.h.store.paths.hooksJson, "utf8"));
    assert.equal(hooks.hooks.beforeShellExecution[0].command, "node .cursor/hooks/cursor-bots-gate.mjs shell");
    assert.equal(hooks.hooks.beforeSubmitPrompt[0].command, "node .cursor/hooks/cursor-bots-gate.mjs prompt");

    const runHook = (mode: string, input: unknown) => {
      // spawnSync blocks this event loop, so run the script asynchronously instead.
      return new Promise<any>((resolve, reject) => {
        import("node:child_process").then(({ spawn }) => {
          const child = spawn(process.execPath, [gate, mode], { cwd: s.h.store.paths.workspace });
          let out = "";
          child.stdout.on("data", (d) => (out += d));
          child.on("close", () => {
            try {
              resolve(JSON.parse(out));
            } catch (e) {
              reject(e);
            }
          });
          child.stdin.end(JSON.stringify(input));
        });
      });
    };

    assert.deepEqual(await runHook("prompt", { conversation_id: "cursor-conv-1", prompt: '<harness>\n<you name="Shipper" handle="@shipper">' }), { continue: true });
    assert.deepEqual(await runHook("shell", { conversation_id: "cursor-conv-1", command: "ls" }), { permission: "allow" });
    const denied = await runHook("shell", { conversation_id: "cursor-conv-1", command: "git push origin main" });
    assert.equal(denied.permission, "deny");
    assert.match(denied.agent_message, /approval/);
    const pending = s.h.approvals.pendingFor(bot.id);
    assert.equal(pending.length, 1, "the approval card went to the right bot");

    // With the gateway down the hook fails open instead of blocking your own Cursor use.
    const cfgFile = path.join(s.h.store.paths.hooksDir, "cursor-bots-gate.json");
    const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, url: "http://127.0.0.1:9" }));
    const r = spawnSync(process.execPath, [gate, "shell"], { input: JSON.stringify({ command: "git push" }) });
    assert.deepEqual(JSON.parse(r.stdout.toString()), { permission: "allow" });
  } finally {
    await s.close();
  }
});

test("a token protects the API when one is configured", async () => {
  const s = await boot("sekret");
  try {
    assert.equal((await s.call("GET", "/api/state")).status, 401);
    assert.equal((await s.call("GET", "/api/state", undefined, { authorization: "Bearer sekret" })).status, 200);
    const page = await fetch(s.base + "/?token=sekret");
    assert.match(page.headers.get("set-cookie") ?? "", /cb_token=sekret/);
  } finally {
    await s.close();
  }
});
