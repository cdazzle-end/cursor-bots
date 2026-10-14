import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Harness } from "../src/core/harness.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";
import { makeHarness, settle, texts } from "./helpers.ts";

test("a bot answers in its own chat and gets identity + memory in the prompt", async () => {
  const { h, mock, cleanup } = await makeHarness();
  try {
    const bot = h.createBot({ name: "Critic", label: "Image critic", about: "Review images against the brief." });
    const dm = h.store.dmFor(bot.id)!;
    await h.postUserMessage(dm.id, { text: "Hello there" });
    await settle(h);
    const msgs = texts(h, dm.id);
    assert.equal(msgs.length, 2);
    assert.match(msgs[1]!, /^@critic: Hi Boss! I'm Critic/);
    const prompt = [...mock.sessions.values()][0]!.prompts[0]!;
    assert.match(prompt, /<you name="Critic" handle="@critic">/);
    assert.match(prompt, /Job: Review images against the brief\./);
    assert.match(prompt, /<memory>/);
    assert.match(prompt, /<incoming from="Boss" kind="message"/);
    assert.equal(h.store.bots.get(bot.id)!.agentId?.startsWith("mock-"), true);
  } finally {
    await cleanup();
  }
});

test("state persists across restarts and the bot resumes the same agent session", async () => {
  const { h, home } = await makeHarness();
  const bot = h.createBot({ name: "Researcher" });
  const dm = h.store.dmFor(bot.id)!;
  await h.postUserMessage(dm.id, { text: "remember that I prefer bullet points" });
  await settle(h);
  const agentId = h.store.bots.get(bot.id)!.agentId;
  await h.stop();

  const mock2 = new MockRuntime({ chunkDelayMs: 0 });
  const h2 = new Harness({ home, runtimes: [mock2] });
  h2.store.settings.runtime = "mock";
  await h2.start({ gatewayUrl: "http://127.0.0.1:1" });
  try {
    assert.equal(h2.store.bots.get(bot.id)?.name, "Researcher");
    assert.equal(h2.store.messages(dm.id).filter((m) => m.kind === "message").length, 2);
    assert.match(h2.store.readMemory(bot.id), /I prefer bullet points/);
    await h2.postUserMessage(dm.id, { text: "again" });
    await settle(h2);
    assert.equal(h2.store.bots.get(bot.id)!.agentId, agentId, "same runtime session id after restart");
    const prompt = [...mock2.sessions.values()][0]!.prompts[0]!;
    assert.match(prompt, /I prefer bullet points/, "memory is injected after restart");
  } finally {
    await h2.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("handoff: bot A asks bot B, B answers in their thread, and the reply wakes A", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    const eboy = h.createBot({ name: "e-boy" });
    const critic = h.createBot({ name: "Critic" });
    const dm = h.store.dmFor(eboy.id)!;
    await h.postUserMessage(dm.id, { text: '[[tool send_message {"to":"@critic","text":"Please review V12"}]] [[reply I sent V12 to @critic.]]' });
    await settle(h);
    const thread = h.store.botDmBetween(eboy.id, critic.id)!;
    assert.ok(thread, "bot-to-bot thread exists");
    const threadMsgs = h.store.messages(thread.id);
    assert.equal(threadMsgs[0]!.kind, "handoff");
    assert.equal(threadMsgs[0]!.text, "Please review V12");
    assert.match(threadMsgs[1]!.text, /^\(Critic\) Done\./);
    const dmTexts = texts(h, dm.id);
    assert.equal(dmTexts[1], "@e-boy: I sent V12 to @critic.");
    assert.match(dmTexts[2]!, /^@e-boy: \(e-boy\) Update from my teammate: @critic replied to your handoff/);
    // The handoff is mirrored into the conversation where e-boy was working.
    assert.ok(h.store.messages(dm.id).some((m) => m.kind === "handoff" && m.meta?.mirror));
  } finally {
    await cleanup();
  }
});

test("groups: @mentions pick responders, bots can @mention each other, and loops are cut off", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    const alpha = h.createBot({ name: "Alpha" });
    const beta = h.createBot({ name: "Beta" });
    const gamma = h.createBot({ name: "Gamma" });
    const g = h.createGroup({ title: "Image Review", members: [alpha.id, beta.id, gamma.id] });

    await h.postUserMessage(g.id, { text: "@gamma what do you think?" });
    await settle(h);
    let t = texts(h, g.id);
    assert.equal(t.length, 2);
    assert.match(t[1]!, /^@gamma: /);

    // Un-addressed message: heuristic routing picks the bot named in the text.
    await h.postUserMessage(g.id, { text: "beta, can you take this one" });
    await settle(h);
    t = texts(h, g.id);
    assert.match(t.at(-1)!, /^@beta: /);

    // Alpha and Beta keep @mentioning each other: the hop limit stops it.
    const before = h.store.messages(g.id).length;
    await h.postUserMessage(g.id, { text: "@alpha [[bounce beta]]" });
    await settle(h, 10000);
    const after = h.store.messages(g.id).slice(before);
    const botPosts = after.filter((m) => m.author.kind === "bot");
    assert.ok(botPosts.length >= 3, "bots woke each other");
    assert.ok(botPosts.length <= h.store.settings.limits.maxChainDepth + 2, `bounded (${botPosts.length})`);
    assert.ok(after.some((m) => m.kind === "notice" && /hop limit/.test(m.text)), "hop limit notice");
  } finally {
    await cleanup();
  }
});

test("approvals: request_approval waits for you; a later decision wakes the bot", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    const bot = h.createBot({ name: "Mailer" });
    const dm = h.store.dmFor(bot.id)!;
    await h.postUserMessage(dm.id, { text: '[[tool request_approval {"action":"Send the newsletter","details":"to 2,000 subscribers"}]] [[reply Waiting for approval.]]' });
    await settle(h);
    const card = h.store.messages(dm.id).find((m) => m.kind === "approval")!;
    assert.ok(card, "approval card posted");
    const approval = h.store.approvals.get(card.meta!.approvalId as string)!;
    assert.equal(approval.status, "pending");
    assert.equal(h.store.conversations.get(dm.id)!.attention, true);

    h.decideApproval(approval.id, "once");
    await settle(h);
    const last = h.store.messages(dm.id).filter((m) => m.kind === "message").at(-1)!;
    assert.match(last.text, /I'm Mailer/);
    const prompts = [...(h.runtimes.get("mock") as MockRuntime).sessions.values()][0]!.prompts;
    assert.match(prompts.at(-1)!, /approved your request/);
  } finally {
    await cleanup();
  }
});

test("shell gate: risky commands need approval once, then the grant is consumed", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    const bot = h.createBot({ name: "Shipper" });
    const dm = h.store.dmFor(bot.id)!;
    await h.postUserMessage(dm.id, { text: "hi" });
    await settle(h);
    const agentId = h.store.bots.get(bot.id)!.agentId!;

    assert.deepEqual(await h.gateShell({ command: "ls -la", conversation_id: agentId }), { permission: "allow" });
    const first = await h.gateShell({ command: "git push origin main", conversation_id: agentId });
    assert.equal(first.permission, "deny");
    assert.match(first.agent_message!, /approval/);
    const pending = h.approvals.pendingFor(bot.id);
    assert.equal(pending.length, 1);
    h.decideApproval(pending[0]!.id, "once");
    await settle(h);
    assert.equal((await h.gateShell({ command: "git push origin main", conversation_id: agentId })).permission, "allow");
    assert.equal((await h.gateShell({ command: "git push origin main", conversation_id: agentId })).permission, "deny", "once means once");

    // "Always allow" adds a rule.
    const p2 = h.approvals.pendingFor(bot.id)[0]!;
    h.decideApproval(p2.id, "always");
    await settle(h);
    assert.equal((await h.gateShell({ command: "git push origin main", conversation_id: agentId })).permission, "allow");
    assert.equal((await h.gateShell({ command: "git push origin other", conversation_id: agentId })).permission, "deny");
  } finally {
    await cleanup();
  }
});

test("routines: validation, plain-words schedule, test runs and history", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    const bot = h.createBot({ name: "Reporter" });
    const dm = h.store.dmFor(bot.id)!;
    await h.postUserMessage(dm.id, {
      text: '[[tool routine_create {"name":"Too often","instruction":"x","cron":"* * * * *"}]] [[tool routine_create {"name":"Daily risk","instruction":"Summarize risks","cron":"0 8 * * 1-5"}]]',
    });
    await settle(h);
    const routines = h.scheduler.list(bot.id);
    assert.equal(routines.length, 1, "the every-minute routine was rejected");
    const r = routines[0]!;
    assert.equal(h.scheduler.describe(r).when, "Every weekday at 8:00 AM");
    assert.ok(h.scheduler.describe(r).nextRunAt! > Date.now());

    await h.scheduler.fire(r.id, "test");
    await settle(h);
    const msgs = h.store.messages(dm.id);
    assert.ok(msgs.some((m) => m.kind === "routine" && /Daily risk/.test(m.text)));
    assert.equal(h.store.routines.get(r.id)!.history.at(-1)!.status, "succeeded");

    h.scheduler.update(r.id, { enabled: false });
    assert.equal(h.scheduler.describe(h.store.routines.get(r.id)!).nextRunAt, undefined);
  } finally {
    await cleanup();
  }
});

test("skills: a bot saves a skill and /skill in your message injects it", async () => {
  const { h, mock, cleanup } = await makeHarness();
  try {
    const bot = h.createBot({ name: "Ops" });
    const dm = h.store.dmFor(bot.id)!;
    await h.postUserMessage(dm.id, {
      text: '[[tool skill_save {"name":"Weekly Report","description":"Build the weekly report. Use every Monday.","instructions":"1. Pull numbers\\n2. Write summary"}]]',
    });
    await settle(h);
    const skill = h.skills.find("weekly-report")!;
    assert.ok(skill);
    assert.ok(fs.existsSync(path.join(h.store.paths.workspace, skill.path)));
    await h.postUserMessage(dm.id, { text: "please run /weekly-report" });
    await settle(h);
    const prompt = [...mock.sessions.values()][0]!.prompts.at(-1)!;
    assert.match(prompt, /<skill name="weekly-report">/);
    assert.match(prompt, /Pull numbers/);
  } finally {
    await cleanup();
  }
});

test("secrets: requested through a card, never shown, injected and scrubbed", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    const bot = h.createBot({ name: "Integrator" });
    const dm = h.store.dmFor(bot.id)!;
    await h.postUserMessage(dm.id, { text: '[[tool request_secret {"name":"DEMO_TOKEN","description":"for the demo API"}]] [[reply asked]]' });
    await settle(h);
    const req = [...h.store.secretRequests.values()][0]!;
    assert.equal(req.status, "pending");
    h.fulfillSecret(req.id, "s3cr3t-value-123");
    await settle(h);
    assert.ok(!JSON.stringify(h.store.messages(dm.id)).includes("s3cr3t-value-123"), "value never in the transcript");
    await h.postUserMessage(dm.id, { text: '[[tool run_with_secrets {"command":"echo token=$DEMO_TOKEN","secrets":["DEMO_TOKEN"]}]]' });
    await settle(h);
    const last = h.store.messages(dm.id).filter((m) => m.kind === "message").at(-1)!;
    assert.match(last.text, /token=\[secret:DEMO_TOKEN\]/);
    assert.ok(!last.text.includes("s3cr3t"));
  } finally {
    await cleanup();
  }
});

test("steering and stop: your message joins the running turn; 'stop' cancels it", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    const bot = h.createBot({ name: "Worker" });
    const dm = h.store.dmFor(bot.id)!;
    await h.postUserMessage(dm.id, { text: "[[sleep 300]] [[reply finished]]" });
    await new Promise((r) => setTimeout(r, 50));
    await h.postUserMessage(dm.id, { text: "also check the footer" });
    await settle(h);
    const last = texts(h, dm.id).at(-1)!;
    assert.match(last, /finished/);
    assert.match(last, /also check the footer/);

    await h.postUserMessage(dm.id, { text: "[[sleep 2000]] [[reply should not appear]]" });
    await new Promise((r) => setTimeout(r, 50));
    await h.postUserMessage(dm.id, { text: "stop" });
    await settle(h);
    assert.ok(!texts(h, dm.id).some((t) => t.startsWith("@worker") && t.includes("should not appear")));
    assert.ok(h.store.messages(dm.id).some((m) => m.kind === "notice" && /^Stopped/.test(m.text)));
  } finally {
    await cleanup();
  }
});

test("bots can create focused helper bots and hand them a first task", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    const lead = h.createBot({ name: "Lead" });
    const dm = h.store.dmFor(lead.id)!;
    await h.postUserMessage(dm.id, { text: '[[tool create_bot {"name":"Scout","job":"Find sources","first_task":"Find 3 sources on agent harnesses"}]] [[reply Made a scout.]]' });
    await settle(h);
    const scout = h.store.botByHandle("scout")!;
    assert.ok(scout);
    assert.equal(scout.createdBy, lead.id);
    const thread = h.store.botDmBetween(lead.id, scout.id)!;
    assert.equal(h.store.messages(thread.id)[0]!.text, "Find 3 sources on agent harnesses");
    assert.ok(texts(h, dm.id).some((t) => /Update from my teammate: @scout replied/.test(t)));
  } finally {
    await cleanup();
  }
});

test("deleting a bot removes its chat and routines but keeps workspace files", async () => {
  const { h, cleanup } = await makeHarness();
  try {
    const a = h.createBot({ name: "Temp" });
    const b = h.createBot({ name: "Keep" });
    const c = h.createBot({ name: "Other" });
    const g = h.createGroup({ members: [a.id, b.id, c.id] });
    h.scheduler.create({ botId: a.id, name: "r", instruction: "x", cron: "0 9 * * *" });
    const file = path.join(h.store.paths.workspace, "bots", "temp", "notes.md");
    fs.writeFileSync(file, "hello");
    await h.deleteBot(a.id);
    assert.equal(h.store.bots.has(a.id), false);
    assert.equal(h.scheduler.list(a.id).length, 0);
    assert.deepEqual(h.store.conversations.get(g.id)!.members, [b.id, c.id]);
    assert.ok(fs.existsSync(file));
  } finally {
    await cleanup();
  }
});
