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

test("a workspace .cursor/mcp.json is moved out of the bots' reach before the next turn", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    const bot = h.createBot({ name: "Surfer" });
    const dm = h.store.dmFor(bot.id)!;
    const file = path.join(h.store.paths.workspace, ".cursor", "mcp.json");
    // Servers in this file would start for every bot with no approval.
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { notes: { command: "sh", args: ["-c", "echo pwned"] } } }));
    h.store.connectors = { github: { command: "npx", args: ["server-github"], enabled: true } };
    await h.postUserMessage(dm.id, { text: "hi" });
    await settle(h);
    assert.equal(fs.existsSync(file), false);
    const moved = fs.readdirSync(path.join(h.store.paths.state, "quarantine"));
    assert.equal(moved.length, 1);
    assert.match(fs.readFileSync(path.join(h.store.paths.state, "quarantine", moved[0]!), "utf8"), /echo pwned/);
    assert.ok(h.store.messages(dm.id).some((m) => m.kind === "notice" && /Moved workspace\/\.cursor\/mcp\.json/.test(m.text)));
    assert.deepEqual(Object.keys(h.mcpServersFor(bot)), ["github"], "only connectors reach the bot");
    // And bots can't write it in the first place.
    assert.ok(h.protectedPaths().includes(file));
    assert.ok(h.touchesHarness("echo '{}' > .cursor/mcp.json"));
  } finally {
    await cleanup();
  }
});

test("shell gate: home-relative spellings, the tool's cwd and the bound host count as touching the gateway", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    const state = h.store.paths.state;
    // Pretend the Cursor Bots home sits in your home folder, as it does by default (~/.cursor-bots).
    const realHome = process.env.HOME;
    process.env.HOME = path.dirname(h.store.paths.home);
    try {
      const rel = path.relative(os.homedir(), state);
      assert.ok(h.touchesHarness(`cat ~/${rel}/ui.token`));
      assert.ok(h.touchesHarness(`ls $HOME/${rel}`));
      assert.ok(h.touchesHarness(`ls \${HOME}/${rel}`));
      assert.ok(!h.touchesHarness("ls ~/projects"));
    } finally {
      process.env.HOME = realHome;
    }
    assert.ok(h.touchesHarness("curl -s http://192.168.1.20:1/api/state"), "any host on the gateway's port");
    assert.ok(!h.touchesHarness("curl -s http://example.com:8080/"));
    const r = await h.gateShell({ command: "cat *", cwd: state });
    assert.equal(r.permission, "deny", "running inside state/ is blocked even with no path in the command");
    // A symlink inside the workspace that leads into state/ counts too.
    fs.symlinkSync(state, path.join(h.store.paths.workspace, "notes-link"));
    assert.equal((await h.gateShell({ command: "ls", cwd: path.join(h.store.paths.workspace, "notes-link") })).permission, "deny");
    assert.equal((await h.gateShell({ command: "ls", cwd: h.store.paths.workspace })).permission, "allow");
  } finally {
    await cleanup();
  }
});

test("shell gate: an unknown Cursor conversation with several bots working isn't pinned on one of them", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    const a = h.createBot({ name: 'Dr "Doc"' });
    const b = h.createBot({ name: "Bee" });
    // A quote in the name no longer breaks learning which bot owns a conversation.
    h.learnHookSession("conv-a", `<harness>\n<you name="Dr &quot;Doc&quot;" handle="@${a.handle}">`);
    await h.postUserMessage(h.store.dmFor(a.id)!.id, { text: "[[sleep 400]] [[reply a]]" });
    await h.postUserMessage(h.store.dmFor(b.id)!.id, { text: "[[sleep 400]] [[reply b]]" });
    await until(() => h.runner(a.id).status().state === "working" && h.runner(b.id).status().state === "working");
    const known = await h.gateShell({ command: "git push origin main", conversation_id: "conv-a" });
    assert.equal(known.permission, "deny");
    assert.equal(h.approvals.pendingFor(a.id).length, 1, "the card went to the bot that owns the conversation");
    const unknown = await h.gateShell({ command: "git push origin other", conversation_id: "conv-unknown" });
    assert.equal(unknown.permission, "deny");
    assert.match(unknown.agent_message!, /couldn't tell which bot/);
    assert.equal(h.approvals.pendingFor(b.id).length, 0, "no card on a bot that didn't ask");
    assert.equal((await h.gateShell({ command: "ls", conversation_id: "conv-unknown" })).permission, "allow", "allowed commands still run");
    await settle(h);
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

// ------------------------------------------------------------------ second review round

test("an approval you decide after a 'stop' in that chat still wakes the bot", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    const bot = h.createBot({ name: "Mailer" });
    const dm = h.store.dmFor(bot.id)!;
    await h.postUserMessage(dm.id, { text: '[[tool request_approval {"action":"Send the newsletter"}]] [[reply waiting]]' });
    await settle(h);
    await h.postUserMessage(dm.id, { text: "stop" });
    await settle(h);
    const before = texts(h, dm.id).filter((t) => t.startsWith("@mailer")).length;
    h.decideApproval(h.approvals.pendingFor(bot.id)[0]!.id, "once");
    await settle(h);
    assert.equal(texts(h, dm.id).filter((t) => t.startsWith("@mailer")).length, before + 1, "your decision is a new action");
  } finally {
    await cleanup();
  }
});

test("'stop' in a group also drops a handoff reply coming back to that group", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    const alpha = h.createBot({ name: "Alpha" });
    const beta = h.createBot({ name: "Beta" });
    const gamma = h.createBot({ name: "Gamma" });
    const crew = h.createGroup({ title: "Crew", members: [alpha.id, beta.id] });
    const forGamma = nested("[[sleep 500]] [[reply gamma review done]]");
    const forBeta = nested(`[[tool send_message {"to":"@gamma","text":"${forGamma}"}]] [[sleep 2000]] [[reply beta done]]`);
    // Alpha starts the chain in its DM and asks Beta in #crew; Beta hands part of it to Gamma.
    await h.postUserMessage(h.store.dmFor(alpha.id)!.id, { text: `[[tool send_message {"to":"#crew","text":"@beta ${forBeta}"}]] [[reply posted]]` });
    await until(() => h.runner(gamma.id).status().state === "working");
    await h.postUserMessage(crew.id, { text: "stop" });
    await settle(h);
    const after = h.store.messages(crew.id);
    const stoppedAt = after.findIndex((m) => m.kind === "notice" && /^Stopped/.test(m.text));
    assert.ok(stoppedAt >= 0);
    assert.ok(!after.slice(stoppedAt).some((m) => m.author.kind === "bot"), "nothing posts in #crew after you stopped it");
  } finally {
    await cleanup();
  }
});

test("shutdown freezes every bot before waiting on any cancel: nothing runs twice after a restart", async () => {
  const { h, home } = await makeHarness();
  const alpha = h.createBot({ name: "Alpha" });
  const beta = h.createBot({ name: "Beta" });
  const g = h.createGroup({ title: "Crew", members: [alpha.id, beta.id] });
  await h.postUserMessage(h.store.dmFor(alpha.id)!.id, { text: "[[sleep 3000]] [[reply alpha never]]" });
  await h.postUserMessage(g.id, { text: "@beta [[sleep 150]] [[reply beta group]]" });
  await h.postUserMessage(h.store.dmFor(beta.id)!.id, { text: "[[reply BETA-DM-ANSWER]]" });
  await until(() => h.runner(alpha.id).status().state === "working" && h.runner(beta.id).status().state === "working");
  // A slow cancel (real SDK runs take a moment to abort) used to let Beta keep going meanwhile.
  const cur = (h.runner(alpha.id) as any).current;
  await until(() => Boolean(cur.run));
  const cancel = cur.run.cancel.bind(cur.run);
  cur.run.cancel = async () => {
    await sleep(400);
    return cancel();
  };
  await h.stop();
  const h2 = await restart(home);
  try {
    await settle(h2);
    const dm = texts(h2, h2.store.dmFor(beta.id)!.id).filter((t) => /^@beta: BETA-DM-ANSWER/.test(t));
    assert.equal(dm.length, 1, "the queued DM ran once, after the restart");
  } finally {
    await h2.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a restart restores the queue in priority order: your message before a background routine", async () => {
  const { h, home } = await makeHarness();
  const worker = h.createBot({ name: "Worker" });
  const other = h.createBot({ name: "Other" });
  const g = h.createGroup({ title: "Crew", members: [worker.id, other.id] });
  const r = h.scheduler.create({ botId: worker.id, name: "Digest", instruction: "[[reply routine output]]", cron: "0 9 * * *" });
  await h.postUserMessage(g.id, { text: "@worker [[sleep 3000]] [[reply never]]" });
  await until(() => h.runner(worker.id).status().state === "working");
  await h.scheduler.fire(r.id, "schedule");
  await h.postUserMessage(h.store.dmFor(worker.id)!.id, { text: "[[reply your urgent question]]" });
  await h.stop();
  const h2 = await restart(home);
  try {
    await settle(h2);
    const order = [...h2.store.conversations.keys()]
      .flatMap((id) => h2.store.messages(id))
      .filter((m) => m.author.kind === "bot" && /routine output|your urgent question/.test(m.text))
      .sort((a, b) => a.ts - b.ts)
      .map((m) => m.text);
    assert.deepEqual(order, ["your urgent question", "routine output"]);
  } finally {
    await h2.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a send that fails before the run starts keeps the unseen context for the next turn", async () => {
  const { h, mock, cleanup } = await makeHarness();
  try {
    const alpha = h.createBot({ name: "Alpha" });
    const beta = h.createBot({ name: "Beta" });
    const g = h.createGroup({ title: "Crew", members: [alpha.id, beta.id] });
    await h.postUserMessage(g.id, { text: "@alpha hello" });
    await settle(h);
    await h.postUserMessage(g.id, { text: "@beta [[reply BETA-FINDING]]" });
    await settle(h);
    const session = [...mock.sessions.values()].find((s) => s.name === "Alpha")!;
    const send = session.send.bind(session);
    let failed = false;
    session.send = async (input) => {
      if (!failed) {
        failed = true;
        throw new Error("ECONNRESET");
      }
      return send(input);
    };
    await h.postUserMessage(g.id, { text: "@alpha what did beta find?" });
    await settle(h);
    await h.postUserMessage(g.id, { text: "@alpha again please" });
    await settle(h);
    assert.match(session.prompts.at(-1)!, /BETA-FINDING/, "the retry still shows what Alpha missed");
  } finally {
    await cleanup();
  }
});

test("cron spacing is checked on the day's time slots: fast for frequent schedules, dense days far ahead still caught", async () => {
  const { validateCron } = await import("../src/core/scheduler.ts");
  for (const expr of ["* * 1 * *", "0-59 0 1 * *", "* * * 12 *", "0,1 0 1 1 *", "*/4 * * * *", "0,3 9 * * *", "0,58 0,23 * * *" /* 23:58 → 00:00 next day */]) {
    assert.ok(validateCron(expr, "UTC", 5), `${expr} is rejected`);
  }
  const t0 = Date.now();
  for (const expr of ["*/5 * * * *", "0 9 * * *", "0 8 * * 1-5", "30 */2 * * *", "0,30 9-17 * * 1-5", "0 0 1 1 *"]) {
    assert.equal(validateCron(expr, "America/New_York", 5), undefined, expr);
  }
  assert.ok(Date.now() - t0 < 200, "no long croner walk on the event loop");
  assert.match(validateCron("0 0 30 2 *", "UTC", 5)!, /never runs|Invalid/);
});

test("Cursor credentials: an expired stored login and an empty CURSOR_API_KEY aren't reported as usable", async () => {
  const { cursorCredentials } = await import("../src/runtimes/cursor.ts");
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "cb-creds-"));
  const realHome = process.env.HOME;
  const realKey = process.env.CURSOR_API_KEY;
  try {
    process.env.HOME = fakeHome;
    delete process.env.CURSOR_API_KEY;
    assert.equal(cursorCredentials(), undefined);
    fs.mkdirSync(path.join(fakeHome, ".cursor", "sdk"), { recursive: true });
    const auth = path.join(fakeHome, ".cursor", "sdk", "auth.json");
    // The shape Cursor.auth.login() stores.
    const login = (extra: object) => JSON.stringify({ version: 1, backendUrl: "https://api2.cursor.sh", apiKey: "key_x", createdAtMs: Date.now(), ...extra });
    fs.writeFileSync(auth, login({ apiKeyExpiresAtMs: Date.now() - 86400_000 }));
    assert.equal(cursorCredentials(), "expired");
    fs.writeFileSync(auth, login({ apiKeyExpiresAtMs: Date.now() + 86400_000 }));
    assert.equal(cursorCredentials(), "login");
    fs.writeFileSync(auth, login({ backendUrl: "https://other.example" }));
    assert.equal(cursorCredentials(), undefined, "a login for another backend isn't used by the SDK");
    fs.writeFileSync(auth, JSON.stringify({ apiKey: "key_x" }));
    assert.equal(cursorCredentials(), undefined, "neither is a file in another shape");
    fs.writeFileSync(auth, login({}));
    process.env.CURSOR_API_KEY = "";
    assert.equal(cursorCredentials(), "login", "an empty key doesn't count");
  } finally {
    process.env.HOME = realHome;
    if (realKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = realKey;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("skill frontmatter keeps column-0 lists and comments under keys it doesn't manage", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    const dir = path.join(h.skills.root, "ops");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\n# reviewed by ops\nname: ops\ndescription: Run ops checks.\nallowed-tools:\n- Bash\n- Read\nlicense: MIT\n---\n\n# Ops\n");
    assert.equal(h.skills.find("ops")!.description, "Run ops checks.");
    h.skills.save({ name: "ops", description: "Run ops checks.", body: "# Ops\n\nNew" });
    const md = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
    assert.match(md, /^allowed-tools:\n- Bash\n- Read$/m);
    assert.match(md, /^# reviewed by ops$/m);
    assert.match(md, /^license: MIT$/m);
  } finally {
    await cleanup();
  }
});

test("marking a chat read while a card waits changes nothing, so viewers don't loop", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    const bot = h.createBot({ name: "Keys" });
    const dm = h.store.dmFor(bot.id)!;
    await h.postUserMessage(dm.id, { text: '[[tool request_secret {"name":"DEMO_KEY"}]] [[reply asked]]' });
    await settle(h);
    h.markRead(dm.id);
    assert.equal(h.store.conversations.get(dm.id)!.attention, true, "the pending card keeps attention on");
    let events = 0;
    const off = h.bus.on((ev) => {
      if (ev.type === "conversation.updated") events++;
    });
    h.markRead(dm.id);
    h.markRead(dm.id);
    off();
    assert.equal(events, 0);
  } finally {
    await cleanup();
  }
});

test("chat markdown: code fences inside numbered steps stay code blocks", async () => {
  const mdPath = "../web/markdown.js";
  const { renderMarkdown } = (await import(mdPath)) as { renderMarkdown: (s: string) => string };
  assert.equal(
    renderMarkdown("1. Install:\n\n   ```bash\n   npm install\n   npm run build\n   ```\n\n2. Start it:"),
    '<ol><li>Install:</li></ol><pre><code>npm install\nnpm run build</code></pre><ol start="2"><li>Start it:</li></ol>',
  );
});

// ------------------------------------------------------------------ third review round

test("searches can't reach the gateway's keys through a symlink in the workspace", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    const ignore = fs.readFileSync(path.join(h.store.paths.workspace, ".rgignore"), "utf8");
    for (const name of ["ui.token", "secret.key", "secrets.vault", "gate.token", "mcp.token"]) assert.match(ignore, new RegExp(`^${name.replace(".", "\\.")}$`, "m"));
    // Bots can't edit it, and a heal puts it back while keeping your own lines.
    assert.ok(h.protectedPaths().includes(path.join(h.store.paths.workspace, ".rgignore")));
    assert.ok(h.touchesHarness("echo > .rgignore"));
    assert.ok(!h.touchesHarness("cat other-project/.rgignore"));
    fs.writeFileSync(path.join(h.store.paths.workspace, ".rgignore"), "dist/\n");
    h.healWorkspace();
    const healed = fs.readFileSync(path.join(h.store.paths.workspace, ".rgignore"), "utf8");
    assert.match(healed, /^ui\.token$/m);
    assert.match(healed, /^dist\/$/m);
    // With the SDK's own ripgrep and flags, a link to the home folder finds nothing secret.
    const rg = path.join(process.cwd(), "node_modules", "@cursor", `sdk-${process.platform}-${process.arch}`, "bin", "rg");
    if (fs.existsSync(rg)) {
      fs.writeFileSync(path.join(h.store.paths.state, "ui.token"), "needle-token-value");
      fs.symlinkSync("..", path.join(h.store.paths.workspace, "up"));
      const { spawnSync } = await import("node:child_process");
      const out = spawnSync(rg, ["--no-config", "--color=never", "--hidden", "--follow", "--regexp", "needle", "--", "."], { cwd: h.store.paths.workspace }).stdout.toString();
      assert.ok(!out.includes("needle-token-value"), out);
    }
  } finally {
    await cleanup();
  }
});

test("shell gate: a working directory spelled with ~ or file:// is resolved like the SDK does", async () => {
  const { h, cleanup } = await makeHarness();
  const realHome = process.env.HOME;
  process.env.HOME = path.dirname(h.store.paths.home);
  try {
    const rel = path.relative(os.homedir(), h.store.paths.state);
    for (const cwd of [`~/${rel}`, `$HOME/${rel}`, `file://${h.store.paths.state}`]) {
      assert.equal((await h.gateShell({ command: "cat *", cwd })).permission, "deny", cwd);
    }
    assert.equal((await h.gateShell({ command: "ls", cwd: `~/${path.relative(os.homedir(), h.store.paths.workspace)}` })).permission, "allow");
    // Another project's Cursor config is fine to work on from the shell.
    assert.ok(!h.touchesHarness("cp templates/mcp.json ~/code/myapp/.cursor/mcp.json"));
    assert.ok(!h.touchesHarness("cat ~/code/app/.cursor/hooks.json"));
    // (A bare relative .cursor/... is read as the workspace's own, which is where bots run.)
    assert.ok(h.touchesHarness("rm .cursor/hooks.json"));
    assert.ok(h.touchesHarness("cat ./.cursor/mcp.json"));
  } finally {
    process.env.HOME = realHome;
    await cleanup();
  }
});

test("a '>' in a bot's name doesn't stop the gate from learning which bot owns a conversation", async () => {
  const { h, mock, cleanup } = await makeHarness();
  try {
    const bot = h.createBot({ name: "Build > Deploy" });
    await h.postUserMessage(h.store.dmFor(bot.id)!.id, { text: "hi" });
    await settle(h);
    const prompt = [...mock.sessions.values()][0]!.prompts[0]!;
    assert.match(prompt, /<you name="Build &gt; Deploy" handle="@build-deploy">/);
    h.learnHookSession("conv-x", prompt.slice(0, 400));
    assert.equal((h as any).hookSessions.get("conv-x"), bot.id);
  } finally {
    await cleanup();
  }
});

test("an approval decided after 'stop' in the requester's chat still delivers the helper's answer", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    const alpha = h.createBot({ name: "Alpha" });
    const beta = h.createBot({ name: "Beta" });
    const dm = h.store.dmFor(alpha.id)!;
    const ask = nested('[[tool request_approval {"action":"Deploy the site"}]] [[reply waiting for approval]]');
    await h.postUserMessage(dm.id, { text: `[[tool send_message {"to":"@beta","text":"${ask}"}]] [[reply asked beta]]` });
    await settle(h);
    await h.postUserMessage(dm.id, { text: "stop" });
    await settle(h);
    const updates = () => texts(h, dm.id).filter((t) => /Update from my teammate: @beta replied/.test(t)).length;
    const before = updates();
    h.decideApproval(h.approvals.pendingFor(beta.id)[0]!.id, "once");
    await settle(h);
    assert.equal(updates(), before + 1);
  } finally {
    await cleanup();
  }
});

test("'stop' survives a restart: a reply to a stopped chat doesn't come back afterwards", async () => {
  const { h, home } = await makeHarness();
  const alpha = h.createBot({ name: "Alpha" });
  const beta = h.createBot({ name: "Beta" });
  const gamma = h.createBot({ name: "Gamma" });
  const crew = h.createGroup({ title: "Crew", members: [alpha.id, beta.id] });
  const forGamma = nested("[[sleep 3000]] [[reply gamma review done]]");
  const forBeta = nested(`[[tool send_message {"to":"@gamma","text":"${forGamma}"}]] [[reply asked gamma]]`);
  await h.postUserMessage(h.store.dmFor(alpha.id)!.id, { text: `[[tool send_message {"to":"#crew","text":"@beta ${forBeta}"}]] [[reply posted]]` });
  await until(() => h.runner(gamma.id).status().state === "working" && h.runner(beta.id).status().state !== "working");
  await h.postUserMessage(crew.id, { text: "stop" });
  await h.stop();
  const h2 = await restart(home);
  try {
    await settle(h2);
    const msgs = h2.store.messages(crew.id);
    const stoppedAt = msgs.findIndex((m) => m.kind === "notice" && /^Stopped/.test(m.text));
    assert.ok(stoppedAt >= 0, "the stop reached Gamma's work for #crew");
    assert.ok(!msgs.slice(stoppedAt).some((m) => m.author.kind === "bot"), "nothing posts in #crew after the stop, even across a restart");
  } finally {
    await h2.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("cron spacing respects the day fields: weekly and monthly schedules pass large minimums", async () => {
  const { validateCron } = await import("../src/core/scheduler.ts");
  assert.equal(validateCron("0 9 * * 1", "UTC", 2880), undefined);
  assert.equal(validateCron("0 9 1 * *", "UTC", 10080), undefined);
  assert.ok(validateCron("0 9 * * *", "UTC", 2880), "daily is closer than two days");
  assert.ok(validateCron("0 9 * * 1,2", "UTC", 2880), "Monday then Tuesday is one day apart");
  assert.equal(validateCron("0,58 0,23 * * 1", "UTC", 5), undefined, "only Mondays: 23:58 is never followed by 00:00");
  assert.ok(validateCron("0,58 0,23 * * 1,2", "UTC", 5), "Monday 23:58 then Tuesday 00:00");
  assert.equal(validateCron("0 0,23 * * 5", "UTC", 120), undefined);
});

test("skill frontmatter: a comment belongs to the key below it", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    const dir = path.join(h.skills.root, "notes");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      "---\nname: notes\ndescription: >\n  Take meeting notes\n  after calls.\n# License below is required by legal\nlicense: MIT\n# maintained by ops\n---\n\n# Notes\n",
    );
    const info = h.skills.find("notes")!;
    assert.equal(info.description, "Take meeting notes after calls.");
    h.skills.save({ name: "notes", description: info.description, body: "# Notes\n\nNew" });
    const md = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
    assert.match(md, /^# License below is required by legal\nlicense: MIT$/m);
    assert.match(md, /^# maintained by ops$/m);
    assert.equal(h.skills.find("notes")!.description, "Take meeting notes after calls.");
  } finally {
    await cleanup();
  }
});

test("chat markdown: a deeper-indented ``` inside code is content; inline ``` code stays in its list item", async () => {
  const mdPath = "../web/markdown.js";
  const { renderMarkdown } = (await import(mdPath)) as { renderMarkdown: (s: string) => string };
  const py = 'def add(a, b):\n    """Add.\n\n    ```\n    >>> add(1, 2)\n    ```\n    """\n    return a + b';
  assert.equal(renderMarkdown("```python\n" + py + "\n```"), `<pre><code>${py.replace(/>/g, "&gt;").replace(/"/g, "&quot;")}</code></pre>`);
  assert.equal(renderMarkdown("- item\n  ```npm i``` to install\n- two"), "<ul><li>item ``<code>npm i</code>`` to install</li><li>two</li></ul>");
});

test("stopping a bot while it waits on an approval card: your later decision wakes it and keeps the grant", async () => {
  const { h, cleanup } = await makeHarness({ settings: (x) => (x.store.settings.approvals.inlineWaitSeconds = 3) });
  try {
    const bot = h.createBot({ name: "Mailer" });
    const dm = h.store.dmFor(bot.id)!;
    await h.postUserMessage(dm.id, { text: '[[tool request_approval {"action":"Send the newsletter"}]] [[reply sent it]]' });
    await until(() => h.approvals.pendingFor(bot.id).length === 1);
    await h.postUserMessage(dm.id, { text: "stop" });
    await until(() => h.runner(bot.id).status().state !== "working");
    const before = texts(h, dm.id).filter((t) => t.startsWith("@mailer")).length;
    const a = h.decideApproval(h.approvals.pendingFor(bot.id)[0]!.id, "once");
    await settle(h);
    assert.equal(texts(h, dm.id).filter((t) => t.startsWith("@mailer")).length, before + 1, "the decision woke the bot");
    assert.notEqual(h.store.approvals.get(a.id)!.consumed, true, "the stopped turn didn't use up the grant");
  } finally {
    await cleanup();
  }
});

test("a home folder behind a symlink: bots can still search their workspace", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-linkhome-"));
  fs.mkdirSync(path.join(base, "real"));
  fs.symlinkSync(path.join(base, "real"), path.join(base, "home"));
  const h = new Harness({ home: path.join(base, "home"), runtimes: [new MockRuntime({ chunkDelayMs: 0 })] });
  h.store.settings.runtime = "mock";
  await h.start({ gatewayUrl: "http://127.0.0.1:1" });
  try {
    const ws = h.store.paths.workspace;
    const gate = path.join(h.store.paths.hooksDir, "cursor-bots-gate.mjs");
    const { spawnSync } = await import("node:child_process");
    const run = (input: unknown) => JSON.parse(spawnSync(process.execPath, [gate, "tool"], { input: JSON.stringify(input), cwd: ws }).stdout.toString()).permission;
    assert.equal(run({ cwd: ws, tool_name: "Grep", tool_input: { pattern: "x", path: "." } }), "allow");
    assert.equal(run({ cwd: ws, tool_name: "List", tool_input: { path: ws } }), "allow");
    assert.equal(run({ cwd: ws, tool_name: "Read", tool_input: { path: "../state/settings.json" } }), "deny");
  } finally {
    await h.stop();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("shell gate: the bound LAN address is matched as a whole host on the gateway's port", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cb-lan-"));
  const h = new Harness({ home, runtimes: [new MockRuntime({ chunkDelayMs: 0 })] });
  h.store.settings.runtime = "mock";
  await h.start({ gatewayUrl: "http://192.168.1.5:4777" });
  try {
    assert.ok(h.touchesHarness("curl -s http://192.168.1.5:4777/api/state"));
    assert.ok(h.touchesHarness("curl -s http://localhost:4777/api/state"));
    for (const cmd of ["ssh deploy@192.168.1.50 uptime", "ping -c1 192.168.1.57", "curl http://192.168.1.5:3000/"]) assert.ok(!h.touchesHarness(cmd), cmd);
  } finally {
    await h.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("shell gate: a relative working directory is checked where the SDK would run it, too", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    // The SDK resolves a relative workingDirectory against the gateway's own cwd.
    const rel = path.relative(process.cwd(), h.store.paths.state);
    assert.equal((await h.gateShell({ command: "cat *", cwd: rel })).permission, "deny");
    assert.equal((await h.gateShell({ command: "ls", cwd: "bots" })).permission, "allow");
  } finally {
    await cleanup();
  }
});

test("an attachment that is a symlink into the gateway's state is refused and never sent to the model", async () => {
  const { h, mock, cleanup } = await makeHarness();
  try {
    const bot = h.createBot({ name: "Viewer" });
    const dm = h.store.dmFor(bot.id)!;
    const ws = h.store.paths.workspace;
    fs.writeFileSync(path.join(ws, "real.png"), Buffer.from("png"));
    // A link with an image name pointing at the gateway's token: its bytes would go to the model provider.
    fs.symlinkSync(path.join(h.store.paths.state, "gate.token"), path.join(ws, "leak.png"));
    fs.symlinkSync(os.tmpdir(), path.join(ws, "outside"));
    assert.throws(() => h.attachmentFor("leak.png"), /Not a workspace file/);
    assert.throws(() => h.attachmentFor("outside/anything.png"), /Not a workspace file/);
    assert.equal(h.attachmentFor("real.png").name, "real.png");

    const att = (p: string) => ({ path: p, name: p, mime: "image/png", size: 3 });
    await h.postUserMessage(dm.id, { text: "look", attachments: [att("leak.png"), att("real.png")] });
    await settle(h);
    const session = [...mock.sessions.values()][0]!;
    assert.deepEqual(session.imageCounts, [1], "only the real file is inlined");
  } finally {
    await cleanup();
  }
});

test("hook: a link to a file that doesn't exist yet in the gateway's state counts as that file", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    const ws = h.store.paths.workspace;
    // Writing through this link would create the file inside state/.
    fs.symlinkSync(path.join(h.store.paths.state, "planted.json"), path.join(ws, "notes.json"));
    const gate = path.join(h.store.paths.hooksDir, "cursor-bots-gate.mjs");
    const { spawnSync } = await import("node:child_process");
    const run = (input: unknown) => JSON.parse(spawnSync(process.execPath, [gate, "tool"], { input: JSON.stringify(input), cwd: ws }).stdout.toString()).permission;
    assert.equal(run({ cwd: ws, tool_name: "Write", tool_input: { path: "notes.json", contents: "{}" } }), "deny");
    assert.equal(run({ cwd: ws, tool_name: "Write", tool_input: { path: "fresh.json", contents: "{}" } }), "allow");
  } finally {
    await cleanup();
  }
});
