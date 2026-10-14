import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Harness } from "../src/core/harness.ts";
import { parseFrontmatter } from "../src/core/skills.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";
import { makeHarness, settle, texts } from "./helpers.ts";

// Regression tests for defects found in review. Each test names the behavior it pins down.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Nested mock directives inside a send_message text: \u005b/\u005d keep the outer [[...]] intact. */
function nested(directives: string): string {
  return JSON.stringify(directives).slice(1, -1).replace(/\[/g, "\\u005b").replace(/\]/g, "\\u005d");
}

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(10);
  }
}

async function restart(home: string): Promise<Harness> {
  const h = new Harness({ home, runtimes: [new MockRuntime({ chunkDelayMs: 0 })] });
  h.store.settings.runtime = "mock";
  h.store.settings.groupRouting = "heuristic";
  h.store.settings.approvals.inlineWaitSeconds = 0;
  await h.start({ gatewayUrl: "http://127.0.0.1:1" });
  return h;
}

const botPosts = (h: Harness) =>
  [...h.store.conversations.keys()].flatMap((id) => h.store.messages(id)).filter((m) => m.author.kind === "bot" && m.kind === "message");

test("a chain that fans out to several bots shares one turn budget", async () => {
  const { h, cleanup } = await makeHarness({ settings: (x) => (x.store.settings.limits.maxChainRuns = 3) });
  try {
    const alpha = h.createBot({ name: "Alpha" });
    for (const n of ["B1", "B2", "B3"]) h.createBot({ name: n });
    const dm = h.store.dmFor(alpha.id)!;
    await h.postUserMessage(dm.id, {
      text: '[[tool send_message {"to":"@b1","text":"one"}]] [[tool send_message {"to":"@b2","text":"two"}]] [[tool send_message {"to":"@b3","text":"three"}]] [[reply sent all three]]',
    });
    await settle(h);
    assert.equal(botPosts(h).length, 3, "Alpha plus two helpers ran; the third handoff and the replies were cut off");
    assert.ok(!texts(h, dm.id).some((t) => /Update from my teammate/.test(t)), "replies past the budget don't wake Alpha");
    assert.equal(h.store.messages(dm.id).filter((m) => m.kind === "notice" && /after 3 turns/.test(m.text)).length, 1, "one notice, where you started it");
  } finally {
    await cleanup();
  }
});

test("an approval decided after a handoff turn ended still sends the result back to the requester", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    const alpha = h.createBot({ name: "Alpha" });
    const beta = h.createBot({ name: "Beta" });
    const dm = h.store.dmFor(alpha.id)!;
    const ask = nested('[[tool request_approval {"action":"Deploy the site"}]] [[reply waiting for approval]]');
    await h.postUserMessage(dm.id, { text: `[[tool send_message {"to":"@beta","text":"${ask}"}]] [[reply asked beta]]` });
    await settle(h);
    const updates = () => texts(h, dm.id).filter((t) => /Update from my teammate: @beta replied/.test(t));
    assert.equal(updates().length, 1, "Beta's 'waiting' reply reached Alpha");
    const pending = h.approvals.pendingFor(beta.id);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.resume?.replyTo?.botId, alpha.id, "the approval remembers the handoff route");

    h.decideApproval(pending[0]!.id, "once");
    await settle(h);
    const thread = h.store.botDmBetween(alpha.id, beta.id)!;
    assert.match(texts(h, thread.id).at(-1)!, /^@beta: /, "Beta resumed in the handoff thread");
    assert.equal(updates().length, 2, "the post-approval result was delivered to Alpha too");
  } finally {
    await cleanup();
  }
});

test("'stop' where you started a chain also stops the work handed to other bots", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    const alpha = h.createBot({ name: "Alpha" });
    const beta = h.createBot({ name: "Beta" });
    const dm = h.store.dmFor(alpha.id)!;
    const slow = nested("[[sleep 3000]] [[reply late answer]]");
    await h.postUserMessage(dm.id, { text: `[[tool send_message {"to":"@beta","text":"${slow}"}]] [[reply handed off]]` });
    await until(() => h.runner(beta.id).status().state === "working");
    const t0 = Date.now();
    await h.postUserMessage(dm.id, { text: "stop" });
    await settle(h);
    assert.ok(Date.now() - t0 < 2000, "Beta's turn was cancelled, not waited out");
    const thread = h.store.botDmBetween(alpha.id, beta.id)!;
    assert.ok(!texts(h, thread.id).some((t) => /^@beta: late answer/.test(t)));
    assert.ok(!texts(h, dm.id).some((t) => /Update from my teammate/.test(t)));
  } finally {
    await cleanup();
  }
});

test("'stop' drops a message that was queued behind other work", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    const worker = h.createBot({ name: "Worker" });
    const other = h.createBot({ name: "Other" });
    const g = h.createGroup({ title: "Crew", members: [worker.id, other.id] });
    const dm = h.store.dmFor(worker.id)!;
    await h.postUserMessage(g.id, { text: "@worker [[sleep 600]] [[reply group done]]" });
    await until(() => h.runner(worker.id).status().state === "working");
    await h.postUserMessage(dm.id, { text: "[[reply dm answer]]" });
    assert.equal(h.runner(worker.id).status().queued, 1, "the DM message waits behind the group turn");
    await h.postUserMessage(dm.id, { text: "stop" });
    await settle(h);
    assert.ok(!texts(h, dm.id).some((t) => /^@worker: dm answer/.test(t)), "the queued DM wake was dropped");
    assert.ok(texts(h, g.id).some((t) => /^@worker: group done/.test(t)), "work for another conversation keeps going");
  } finally {
    await cleanup();
  }
});

test("a restart keeps queued work and reports the interrupted turn", async () => {
  const { h, home } = await makeHarness();
  const worker = h.createBot({ name: "Worker" });
  const other = h.createBot({ name: "Other" });
  const g = h.createGroup({ title: "Crew", members: [worker.id, other.id] });
  const dm = h.store.dmFor(worker.id)!;
  await h.postUserMessage(g.id, { text: "@worker [[sleep 3000]] [[reply never posted]]" });
  await until(() => h.runner(worker.id).status().state === "working");
  await h.postUserMessage(dm.id, { text: "[[reply picked up after restart]]" });
  await h.stop();

  const h2 = await restart(home);
  try {
    await settle(h2);
    assert.ok(texts(h2, dm.id).some((t) => /^@worker: picked up after restart/.test(t)), "queued wake survived the restart");
    assert.ok(!texts(h2, g.id).some((t) => /^@worker: never posted/.test(t)));
    assert.ok(h2.store.messages(g.id).some((m) => m.kind === "notice" && /interrupted by a restart/.test(m.text)));
  } finally {
    await h2.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("deleting a bot stops its partner's work in their bot-to-bot thread", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    const alpha = h.createBot({ name: "Alpha" });
    const beta = h.createBot({ name: "Beta" });
    const dm = h.store.dmFor(alpha.id)!;
    const slow = nested("[[sleep 3000]] [[reply late answer]]");
    await h.postUserMessage(dm.id, { text: `[[tool send_message {"to":"@beta","text":"${slow}"}]] [[reply handed off]]` });
    await until(() => h.runner(beta.id).status().state === "working");
    const t0 = Date.now();
    await h.deleteBot(alpha.id);
    await settle(h);
    assert.ok(Date.now() - t0 < 2000, "Beta stopped instead of finishing for a deleted requester");
    assert.ok(!botPosts(h).some((m) => /late answer/.test(m.text)));
  } finally {
    await cleanup();
  }
});

test("a torn last line in a conversation file doesn't swallow the next message", async () => {
  const { h, home } = await makeHarness();
  const bot = h.createBot({ name: "Keeper" });
  const dm = h.store.dmFor(bot.id)!;
  h.postNotice(dm.id, "first");
  await h.stop();
  const file = path.join(h.store.paths.messages, `${dm.id}.jsonl`);
  fs.appendFileSync(file, '{"id":"msg_torn","convId":"'); // crash mid-write

  let h2 = await restart(home);
  assert.deepEqual(h2.store.messages(dm.id).map((m) => m.text), ["first"]);
  h2.postNotice(dm.id, "second");
  h2.postNotice(dm.id, "third");
  await h2.stop();
  h2 = await restart(home);
  try {
    assert.deepEqual(h2.store.messages(dm.id).map((m) => m.text), ["first", "second", "third"]);
  } finally {
    await h2.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("skill frontmatter round-trips: escapes, block scalars and unknown keys", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    const desc = 'Use for "quarterly" reports in C:\\data';
    let info = h.skills.save({ name: "Quarterly", description: desc, body: "Steps" });
    assert.equal(info.description, desc);
    for (let i = 0; i < 3; i++) info = h.skills.save({ name: "Quarterly", description: info.description, body: "Steps" });
    assert.equal(info.description, desc, "saving again doesn't pile up escapes");

    const dir = path.join(h.skills.root, "pdf-tools");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      "---\nname: pdf-tools\ndescription: >\n  Extract text\n  from PDFs.\nlicense: MIT\nallowed-tools: Bash Read\nmetadata:\n  author: someone\n---\n\n# PDF tools\n",
    );
    assert.equal(h.skills.find("pdf-tools")!.description, "Extract text from PDFs.");
    h.skills.save({ name: "pdf-tools", description: "Extract text from PDFs.", body: "# PDF tools\n\nNew steps" });
    const md = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
    assert.match(md, /^license: MIT$/m);
    assert.match(md, /^allowed-tools: Bash Read$/m);
    assert.match(md, /^metadata:\n {2}author: someone$/m);
    assert.match(md, /New steps/);

    assert.equal(parseFrontmatter("---\na: 'it''s'\nb: |\n  one\n  two\n---\n").data.a, "it's");
    assert.equal(parseFrontmatter("---\nb: |\n  one\n  two\n---\n").data.b, "one\ntwo");
  } finally {
    await cleanup();
  }
});

test("duplicating or importing a bot keeps paused routines paused", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    const src = h.createBot({ name: "Digest" });
    const r = h.scheduler.create({ botId: src.id, name: "Send digest", instruction: "x", cron: "0 9 * * 1-5", webhook: true });
    h.scheduler.update(r.id, { enabled: false });
    const copy = h.duplicateBot(src.id);
    const copied = h.scheduler.list(copy.id);
    assert.equal(copied.length, 1);
    assert.equal(copied[0]!.enabled, false);
    assert.ok(copied[0]!.webhookKey && copied[0]!.webhookKey !== r.webhookKey, "webhook trigger kept with a fresh key");
    assert.equal(h.scheduler.describe(copied[0]!).nextRunAt, undefined);

    const imported = h.importBot(h.exportBot(src.id));
    assert.equal(h.scheduler.list(imported.id)[0]!.enabled, false);
  } finally {
    await cleanup();
  }
});

test("changing the account time zone re-arms routines that follow it", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    h.updateSettings({ timezone: "America/New_York" });
    const bot = h.createBot({ name: "Clock" });
    const r = h.scheduler.create({ botId: bot.id, name: "Morning", instruction: "x", cron: "0 9 * * *" });
    const ny = new Date(h.scheduler.describe(r).nextRunAt!);
    h.updateSettings({ timezone: "Asia/Tokyo" });
    const tokyo = new Date(h.scheduler.describe(h.store.routines.get(r.id)!).nextRunAt!);
    assert.equal(tokyo.getUTCHours(), 0, "9:00 in Tokyo is 00:00 UTC");
    assert.notEqual(ny.getUTCHours(), tokyo.getUTCHours());
  } finally {
    await cleanup();
  }
});

test("routines you re-enable after an absence pause stay on; bot-made ones still pause", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    const bot = h.createBot({ name: "Away" });
    const r = h.scheduler.create({ botId: bot.id, name: "Daily", instruction: "x", cron: "0 9 * * *" });
    h.store.settings.lastUserActivityAt = Date.now() - 15 * 86400_000;
    h.scheduler.checkAbsence();
    assert.equal(h.store.routines.get(r.id)!.enabled, false);

    // Created while you're away (e.g. by a bot): paused at the next check.
    const botMade = h.scheduler.create({ botId: bot.id, name: "Bot made", instruction: "x", cron: "0 10 * * *" });
    h.scheduler.checkAbsence();
    assert.equal(h.store.routines.get(botMade.id)!.enabled, false);

    // You come back and switch it on (the API records that as activity).
    h.touchUserActivity();
    h.scheduler.update(r.id, { enabled: true });
    h.scheduler.checkAbsence();
    assert.equal(h.store.routines.get(r.id)!.enabled, true);
  } finally {
    await cleanup();
  }
});

test("settings keep a model's params when the same model is saved without them", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    h.updateSettings({ routerModel: { id: "composer-2.5", params: [{ id: "fast", value: "true" }] } });
    h.updateSettings({ routerModel: { id: "composer-2.5" }, defaultModel: { id: "composer-2.5" } });
    assert.deepEqual(h.store.settings.routerModel, { id: "composer-2.5", params: [{ id: "fast", value: "true" }] });
    h.updateSettings({ routerModel: { id: "gpt-5.5" } });
    assert.deepEqual(h.store.settings.routerModel, { id: "gpt-5.5" }, "a different model starts without params");
  } finally {
    await cleanup();
  }
});

test("the workspace's .cursor/mcp.json servers ride along when a bot has connectors", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    const a = h.createBot({ name: "Surfer" });
    const b = h.createBot({ name: "Plain", connectors: [] });
    fs.mkdirSync(path.join(h.store.paths.workspace, ".cursor"), { recursive: true });
    fs.writeFileSync(
      path.join(h.store.paths.workspace, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { docs: { url: "https://docs.example/mcp" }, github: { command: "project-github" } } }),
    );
    h.store.connectors = { github: { command: "npx", args: ["server-github"], enabled: true } };
    const mcp = h.mcpServersFor(a);
    assert.deepEqual(Object.keys(mcp).sort(), ["docs", "github"]);
    assert.equal(mcp.github!.command, "npx", "a connector wins over a project server with the same name");
    assert.equal(mcp.docs!.url, "https://docs.example/mcp");
    assert.deepEqual(h.mcpServersFor(b), {}, "no per-turn servers: the SDK loads mcp.json itself");
  } finally {
    await cleanup();
  }
});

test("chat markdown: fences with any info string, numbered and loose lists", async () => {
  const mdPath = "../web/markdown.js";
  const { renderMarkdown } = (await import(mdPath)) as { renderMarkdown: (s: string) => string };
  assert.equal(
    renderMarkdown("Here:\n```c++\nint main() {}\n```\nAfter **text**."),
    "<p>Here:</p><pre><code>int main() {}</code></pre><p>After <strong>text</strong>.</p>",
  );
  assert.equal(renderMarkdown("````md\n```\ninner\n```\n````"), "<pre><code>```\ninner\n```</code></pre>");
  assert.equal(
    renderMarkdown("1. First\n\n   Details.\n\n2. Second\n\n3. Third"),
    "<ol><li>First<br>Details.</li><li>Second</li><li>Third</li></ol>",
  );
  assert.equal(renderMarkdown("3. three\n4. four"), '<ol start="3"><li>three</li><li>four</li></ol>');
});

test("the HTTP API counts changes you make as activity", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-bots-act-"));
  const h = new Harness({ home, runtimes: [new MockRuntime({ chunkDelayMs: 0 })] });
  h.store.settings.runtime = "mock";
  const { createServer } = await import("../src/server/http.ts");
  const server = createServer(h, { port: 0, host: "127.0.0.1", token: "t" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  await h.start({ gatewayUrl: base });
  try {
    const bot = h.createBot({ name: "Away" });
    const r = h.scheduler.create({ botId: bot.id, name: "Daily", instruction: "x", cron: "0 9 * * *" });
    const old = Date.now() - 15 * 86400_000;
    h.store.settings.lastUserActivityAt = old;
    const res = await fetch(`${base}/api/routines/${r.id}`, {
      method: "PATCH",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(res.status, 200);
    assert.ok(h.store.settings.lastUserActivityAt! > old);
    await fetch(`${base}/api/state`, { headers: { authorization: "Bearer t" } });
    const after = h.store.settings.lastUserActivityAt!;
    h.store.settings.lastUserActivityAt = old;
    await fetch(`${base}/api/state`, { headers: { authorization: "Bearer t" } });
    assert.equal(h.store.settings.lastUserActivityAt, old, "reads alone don't count");
    assert.ok(after > old);
  } finally {
    server.close();
    await h.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
