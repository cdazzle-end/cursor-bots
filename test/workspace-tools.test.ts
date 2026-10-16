import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as zlib from "node:zlib";
import { blockedAddress, realPrefix } from "../src/core/guard.ts";
import { Harness } from "../src/core/harness.ts";
import type { RunState } from "../src/core/runner.ts";
import { buildTools } from "../src/core/tools.ts";
import type { ActivityItem, Bot } from "../src/core/types.ts";
import { buildWorkspaceTools, compileGlob, htmlToText, type WorkspaceToolsOptions } from "../src/core/workspace-tools.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";
import type { BoundTool, ToolOutput } from "../src/runtimes/types.ts";
import { settle } from "./helpers.ts";

/** A harness whose brain is a bare model API: the harness supplies the shell, file and web tools. */
async function makeHarness() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-bots-ws-"));
  const mock = new MockRuntime({ chunkDelayMs: 0, provides: { workspaceTools: false, projectContext: false, mcp: false } });
  const h = new Harness({ home, runtimes: [mock] });
  h.store.settings.runtime = "mock";
  h.store.settings.groupRouting = "heuristic";
  h.store.settings.approvals.inlineWaitSeconds = 0;
  await h.start({ gatewayUrl: "http://127.0.0.1:1" });
  return {
    h,
    mock,
    home,
    ws: h.store.paths.workspace,
    state: h.store.paths.state,
    async cleanup() {
      await h.stop();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

type Tools = Record<string, BoundTool>;

/** Run `fn` with the workspace tools bound to a real turn of `bot` (one that sleeps until it's stopped). */
async function inTurn<T>(h: Harness, bot: Bot, fn: (tools: Tools, state: RunState) => Promise<T>, opts: WorkspaceToolsOptions = {}): Promise<T> {
  const dm = h.store.dmFor(bot.id)!;
  await h.postUserMessage(dm.id, { text: "[[sleep 60000]]" });
  const runner = h.runner(bot.id);
  for (let i = 0; !runner.current && i < 500; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(runner.current, "the turn started");
  const tools = Object.fromEntries(buildWorkspaceTools(h, bot.id, () => runner.current, { pollMs: 20, ...opts }).map((t) => [t.name, t]));
  try {
    return await fn(tools, runner.current);
  } finally {
    await h.stopConversation(dm.id);
    await settle(h);
  }
}

const call = (tools: Tools, name: string, args: Record<string, unknown>): Promise<ToolOutput> => tools[name]!.execute(args);

function lastActivity(h: Harness, convId: string): ActivityItem[] {
  const msg = h.store.messages(convId).filter((m) => m.kind === "message").at(-1);
  return ((msg?.meta as { activity?: ActivityItem[] } | undefined)?.activity ?? []) as ActivityItem[];
}

/** Whether a process is still running (a zombie waiting to be reaped counts as gone). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return true;
  }
}

async function withHome<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const real = process.env.HOME;
  process.env.HOME = dir;
  try {
    return await fn();
  } finally {
    process.env.HOME = real;
  }
}

test("workspace tools are offered only to runtimes without their own", async () => {
  const { h, mock, cleanup } = await makeHarness();
  try {
    const bot = h.createBot({ name: "Plain" });
    await h.postUserMessage(h.store.dmFor(bot.id)!.id, { text: "hi" });
    await settle(h);
    const names = [...mock.sessions.values()][0]!.toolNames[0]!;
    for (const n of ["shell", "read_file", "write_file", "edit_file", "delete_file", "list_dir", "find_files", "grep", "web_fetch"]) assert.ok(names.includes(n), n);
    assert.ok(names.includes("send_message"), "harness tools too");
    assert.match([...mock.sessions.values()][0]!.systems[0]!, /## Your computer tools/);
  } finally {
    await cleanup();
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-bots-ws-"));
  const cursorLike = new MockRuntime({ chunkDelayMs: 0 });
  const h2 = new Harness({ home, runtimes: [cursorLike] });
  h2.store.settings.runtime = "mock";
  await h2.start({ gatewayUrl: "http://127.0.0.1:1" });
  try {
    const bot = h2.createBot({ name: "Builtin" });
    await h2.postUserMessage(h2.store.dmFor(bot.id)!.id, { text: "hi" });
    await settle(h2);
    assert.ok(![...cursorLike.sessions.values()][0]!.toolNames[0]!.includes("shell"));
  } finally {
    await h2.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("shell: a risky command gets a card on the right bot and chat, the decision wakes the bot, and the retry uses the once-grant", async () => {
  const { h, mock, ws, cleanup } = await makeHarness();
  try {
    h.store.settings.approvals.rules.push({ id: "rule_test", effect: "ask", target: "shell", pattern: "^echo deploy-now$", createdAt: Date.now() });
    const bot = h.createBot({ name: "Shipper" });
    const other = h.createBot({ name: "Other" });
    const dm = h.store.dmFor(bot.id)!;
    await h.postUserMessage(dm.id, { text: '[[tool shell {"command":"echo deploy-now"}]]' });
    await settle(h);
    const pending = h.approvals.pendingFor(bot.id);
    assert.equal(pending.length, 1);
    const card = pending[0]!;
    assert.equal(card.command, "echo deploy-now");
    assert.equal(card.convId, dm.id);
    assert.equal(card.origin, "foreground");
    assert.equal(card.resume?.convId, dm.id);
    assert.equal(h.approvals.pendingFor(other.id).length, 0, "the card is on the bot that asked");
    assert.ok(h.store.messages(dm.id).some((m) => m.kind === "approval" && (m.meta as any)?.approvalId === card.id), "the card is in the bot's chat");
    // A pending card is not an error: the bot is told to end its turn and wait.
    const act = lastActivity(h, dm.id).find((a) => a.name === "shell")!;
    assert.equal(act.status, "completed");
    assert.equal(act.summary, "echo deploy-now");
    assert.match(h.store.messages(dm.id).filter((m) => m.kind === "message").at(-1)!.text, /haven't answered yet/);

    // The decision wakes the bot where it was working.
    const session = [...mock.sessions.values()].find((s) => s.name === "Shipper")!;
    const before = session.prompts.length;
    h.decideApproval(card.id, "once");
    await settle(h);
    assert.equal(session.prompts.length, before + 1);
    assert.match(session.prompts.at(-1)!, /approved your request[\s\S]*Run the exact same command again now/);

    // The retry runs (using the grant), the next one asks again.
    await h.postUserMessage(dm.id, { text: '[[tool shell {"command":"echo deploy-now"}]]' });
    await settle(h);
    assert.match(h.store.messages(dm.id).filter((m) => m.kind === "message").at(-1)!.text, /exit 0\ndeploy-now/);
    assert.equal(h.approvals.pendingFor(bot.id).length, 0);
    await h.postUserMessage(dm.id, { text: '[[tool shell {"command":"echo deploy-now"}]]' });
    await settle(h);
    assert.equal(h.approvals.pendingFor(bot.id).length, 1, "once means once");

    // The default rules apply too, and nothing ran.
    await h.postUserMessage(h.store.dmFor(other.id)!.id, { text: '[[tool shell {"command":"git push origin main"}]]' });
    await settle(h);
    assert.equal(h.approvals.pendingFor(other.id)[0]?.command, "git push origin main");
    assert.equal(fs.existsSync(path.join(ws, ".git")), false);
  } finally {
    await cleanup();
  }
});

test("shell: commands that reach the gateway are refused before approvals, even with approvals off or allow-all", async () => {
  const { h, state, cleanup } = await makeHarness();
  try {
    const bot = h.createBot({ name: "Sneaky" });
    const attempts = [`cat ${state}/gate.token`, "curl -s http://127.0.0.1:1/api/state", "cat ../settings.json", "echo x > .cursor/hooks.json", "cat ~/.cursor-bots/state/ui.token"];
    for (const mode of ["off", "allow-all"] as const) {
      if (mode === "off") h.store.settings.approvals.mode = "off";
      else {
        h.store.settings.approvals.mode = "ask";
        h.store.settings.approvals.rules.push({ id: "rule_all", effect: "allow", target: "shell", pattern: ".*", createdAt: Date.now() });
      }
      await inTurn(h, bot, async (tools) => {
        for (const command of attempts) {
          const r = await call(tools, "shell", { command });
          assert.equal(r.isError, true, `${mode}: ${command}`);
          assert.match(r.text, /can't call the Cursor Bots gateway/, command);
        }
        // run_with_secrets shares the same gate (and now checks its working folder the same way).
        const withSecrets = buildTools(h, bot.id, () => h.runner(bot.id).current).find((t) => t.name === "run_with_secrets")!;
        const r = await withSecrets.execute({ command: "ls", secrets: [], cwd: state });
        assert.equal(r.isError, true);
        assert.match(r.text, /can't call the Cursor Bots gateway/);
      });
    }
    assert.equal(h.approvals.pendingFor(bot.id).length, 0, "no card was ever shown");
  } finally {
    await cleanup();
  }
});

test("shell: a working folder inside the gateway's state is refused by every spelling", async () => {
  const { h, home, ws, state, cleanup } = await makeHarness();
  try {
    const bot = h.createBot({ name: "Runner" });
    fs.symlinkSync(state, path.join(ws, "notes-link"));
    fs.symlinkSync(home, path.join(ws, "up"));
    await withHome(path.dirname(home), () =>
      inTurn(h, bot, async (tools) => {
        const rel = path.relative(os.homedir(), state);
        for (const cwd of [state, "../state", "notes-link", "notes-link/memory", "up/state", `~/${rel}`, `$HOME/${rel}`, `file://${state}`, `file://${path.join(ws, "notes-link")}`]) {
          const r = await call(tools, "shell", { command: "ls", cwd });
          assert.equal(r.isError, true, cwd);
          assert.match(r.text, /can't call the Cursor Bots gateway/, cwd);
        }
        const out = await call(tools, "shell", { command: "ls", cwd: os.tmpdir() });
        assert.match(out.text, /outside the shared workspace/);
        const viaLink = await call(tools, "shell", { command: "ls", cwd: "up" });
        assert.match(viaLink.text, /leads outside the shared workspace through a symlink/);
        const ok = await call(tools, "shell", { command: "pwd", cwd: "bots" });
        assert.equal(ok.isError, false, ok.text);
        assert.match(ok.text, /^exit 0\n.*\/workspace\/bots\n$/);
        const tilde = await call(tools, "shell", { command: "pwd", cwd: `~/${path.relative(os.homedir(), ws)}` });
        assert.equal(tilde.isError, false, tilde.text);
      }),
    );
    assert.equal(h.approvals.pendingFor(bot.id).length, 0);
  } finally {
    await cleanup();
  }
});

test("file tools: the gateway's files and paths that escape through symlinks are refused; workspace files work", async () => {
  const { h, home, ws, state, cleanup } = await makeHarness();
  try {
    const bot = h.createBot({ name: "Filer" });
    fs.symlinkSync("..", path.join(ws, "up"));
    fs.writeFileSync(path.join(home, "outside.txt"), "outside");
    fs.symlinkSync(path.join(home, "planted.txt"), path.join(ws, "dangling-out"));
    fs.symlinkSync(path.join(state, "planted.txt"), path.join(ws, "dangling-state"));
    const managed = [".cursor/hooks.json", ".cursor/rules/cursor-bots.mdc", ".rgignore", ".cursor/hooks/cursor-bots-gate.mjs"];
    const saved = Object.fromEntries(managed.map((f) => [f, fs.readFileSync(path.join(ws, f), "utf8")]));
    await withHome(path.dirname(home), () =>
      inTurn(h, bot, async (tools) => {
        const rel = path.relative(os.homedir(), state);
        for (const p of ["../settings.json", "up/state/gate.token", `${state}/gate.token`, `file://${state}/gate.token`, `~/${rel}/gate.token`, "$HOME/" + rel, ...managed]) {
          const r = await call(tools, "read_file", { path: p });
          assert.equal(r.isError, true, p);
          assert.match(r.text, /belongs to the Cursor Bots gateway/, p);
        }
        for (const p of managed) {
          const w = await call(tools, "write_file", { path: p, content: "pwned" });
          assert.match(w.text, /belongs to the Cursor Bots gateway/, p);
          const e = await call(tools, "edit_file", { path: p, old_string: "a", new_string: "b" });
          assert.match(e.text, /belongs to the Cursor Bots gateway/, p);
          const d = await call(tools, "delete_file", { path: p });
          assert.match(d.text, /belongs to the Cursor Bots gateway/, p);
        }
        // Escapes through a link: reading, writing (also through links to files that don't exist yet) and deleting.
        assert.match((await call(tools, "read_file", { path: "up/outside.txt" })).text, /leads outside the shared workspace through a symlink/);
        assert.match((await call(tools, "write_file", { path: "up/evil.txt", content: "x" })).text, /outside the shared workspace/);
        assert.match((await call(tools, "write_file", { path: "dangling-out", content: "x" })).text, /outside the shared workspace/);
        assert.match((await call(tools, "write_file", { path: "dangling-state", content: "x" })).text, /belongs to the Cursor Bots gateway/);
        assert.match((await call(tools, "delete_file", { path: "up/outside.txt" })).text, /outside the shared workspace/);
        assert.match((await call(tools, "read_file", { path: "/etc/hostname" })).text, /is outside the shared workspace/);

        // Ordinary work.
        const w = await call(tools, "write_file", { path: "bots/filer/notes.md", content: "one\ntwo\nthree\n" });
        assert.equal(w.isError, undefined, w.text);
        assert.match(w.text, /Created bots\/filer\/notes\.md \(3 lines/);
        const r = await call(tools, "read_file", { path: path.join(ws, "bots/filer/notes.md") });
        assert.equal(r.text, "bots/filer/notes.md (lines 1-3 of 3)\n     1\tone\n     2\ttwo\n     3\tthree");
        const page = await call(tools, "read_file", { path: "bots/filer/notes.md", offset: 2, limit: 1 });
        assert.match(page.text, /lines 2-2 of 3\)\n {5}2\ttwo\n… 1 more line; call read_file with offset 3/);
        assert.match((await call(tools, "delete_file", { path: "bots/filer/notes.md" })).text, /^Deleted bots\/filer\/notes\.md\.$/);
        assert.equal(fs.existsSync(path.join(ws, "bots/filer/notes.md")), false);
        assert.match((await call(tools, "delete_file", { path: "bots" })).text, /folder with files in it/);
        assert.match((await call(tools, "read_file", { path: "bots" })).text, /is a folder/);
      }),
    );
    assert.equal(fs.existsSync(path.join(home, "evil.txt")), false);
    assert.equal(fs.existsSync(path.join(home, "planted.txt")), false);
    assert.equal(fs.existsSync(path.join(state, "planted.txt")), false);
    assert.ok(fs.existsSync(path.join(home, "outside.txt")));
    for (const f of managed) assert.equal(fs.readFileSync(path.join(ws, f), "utf8"), saved[f], f);
  } finally {
    await cleanup();
  }
});

test("read_file: binaries are refused, images come back as images", async () => {
  const { h, ws, cleanup } = await makeHarness();
  try {
    const bot = h.createBot({ name: "Viewer" });
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
    fs.writeFileSync(path.join(ws, "pic.png"), png);
    fs.writeFileSync(path.join(ws, "blob.bin"), Buffer.from([1, 2, 0, 3, 4]));
    await inTurn(h, bot, async (tools) => {
      const img = await call(tools, "read_file", { path: "pic.png" });
      assert.equal(img.images?.[0]?.mimeType, "image/png");
      assert.equal(img.images?.[0]?.data, png.toString("base64"));
      const bin = await call(tools, "read_file", { path: "blob.bin" });
      assert.equal(bin.isError, true);
      assert.match(bin.text, /binary file/);
      assert.match((await call(tools, "read_file", { path: "missing.txt" })).text, /doesn't exist/);
      // A FIFO would block the whole gateway on open: it's refused instead, and searches skip it.
      if (process.platform !== "win32") {
        execFileSync("mkfifo", [path.join(ws, "pipe")]);
        assert.match((await call(tools, "read_file", { path: "pipe" })).text, /isn't a regular file/);
        assert.match((await call(tools, "write_file", { path: "pipe", content: "x" })).text, /isn't a regular file/);
        assert.match((await call(tools, "edit_file", { path: "pipe", old_string: "a", new_string: "b" })).text, /isn't a regular file/);
        assert.match((await call(tools, "grep", { pattern: "zz-fifo-probe" })).text, /^No matches/);
        assert.match((await call(tools, "list_dir", {})).text, /^pipe {2}\(special file\)$/m);
      }
    });
  } finally {
    await cleanup();
  }
});

test("searches and listings don't follow links into the gateway's state or out of the workspace", async () => {
  const { h, home, ws, state, cleanup } = await makeHarness();
  try {
    const bot = h.createBot({ name: "Searcher" });
    fs.writeFileSync(path.join(state, "needle.txt"), "needle-secret-value");
    fs.writeFileSync(path.join(home, "needle-outside.txt"), "needle-outside-value");
    fs.symlinkSync("..", path.join(ws, "up"));
    fs.symlinkSync(state, path.join(ws, "st"));
    fs.symlinkSync("/", path.join(ws, "root"));
    fs.mkdirSync(path.join(ws, "bots", "searcher"), { recursive: true });
    fs.writeFileSync(path.join(ws, "bots", "searcher", "find-me.txt"), "a needle in the workspace\n");
    fs.symlinkSync(path.join(state, "needle.txt"), path.join(ws, "bots", "searcher", "leak.txt"));
    fs.symlinkSync("find-me.txt", path.join(ws, "bots", "searcher", "alias.txt"));
    const gateToken = fs.readFileSync(path.join(state, "gate.token"), "utf8").trim();
    await inTurn(h, bot, async (tools) => {
      const g = await call(tools, "grep", { pattern: "needle" });
      assert.equal(g.isError, undefined, g.text);
      assert.match(g.text, /^bots\/searcher\/alias\.txt:1:a needle in the workspace$/m, "links to workspace files are searched");
      assert.match(g.text, /^bots\/searcher\/find-me\.txt:1:a needle in the workspace$/m);
      assert.ok(!g.text.includes("needle-secret-value") && !g.text.includes("needle-outside-value"), g.text);
      // The hook script holds the gate token: it's managed, so it's never searched.
      assert.match((await call(tools, "grep", { pattern: gateToken })).text, /^No matches/);
      assert.match((await call(tools, "grep", { pattern: "needle", path: "st" })).text, /belongs to the Cursor Bots gateway/);
      assert.match((await call(tools, "grep", { pattern: "needle", path: "up" })).text, /outside the shared workspace/);
      assert.match((await call(tools, "grep", { pattern: "needle", path: "bots/searcher/leak.txt" })).text, /belongs to the Cursor Bots gateway/);
      assert.match((await call(tools, "read_file", { path: "bots/searcher/leak.txt" })).text, /belongs to the Cursor Bots gateway/);

      const list = await call(tools, "list_dir", { depth: 4 });
      assert.match(list.text, /^up -> \.\. {2}\(symlink leading outside the workspace; not followed\)$/m);
      assert.match(list.text, /^st {2}\(managed by the gateway; off-limits\)$/m);
      assert.match(list.text, /^\.cursor\/hooks\/ {2}\(managed by the gateway; off-limits\)$/m);
      assert.match(list.text, /^bots\/searcher\/find-me\.txt {2}\d+ B$/m);
      assert.ok(!/^(up|st|root)\//m.test(list.text), list.text);
      assert.ok(!list.text.includes("cursor-bots-gate.mjs"));
      assert.match((await call(tools, "list_dir", { path: "st" })).text, /belongs to the Cursor Bots gateway/);
      assert.match((await call(tools, "list_dir", { path: "up" })).text, /outside the shared workspace/);

      const found = await call(tools, "find_files", { pattern: "*needle*" });
      assert.match(found.text, /^Nothing matches/);
      assert.match((await call(tools, "find_files", { pattern: "*.token" })).text, /^Nothing matches/);
      assert.match((await call(tools, "find_files", { pattern: "*.mjs" })).text, /^Nothing matches/, "the hook script isn't listed");
      const txt = await call(tools, "find_files", { pattern: "bots/**/*.txt" });
      assert.equal(txt.text, "bots/searcher/alias.txt  (symlink)\nbots/searcher/find-me.txt", "the link into state isn't listed");
    });
  } finally {
    await cleanup();
  }
});

test("grep: plain-text fallback, case and glob filters, and a runaway pattern can't freeze the gateway", async () => {
  const { h, ws, cleanup } = await makeHarness();
  try {
    const bot = h.createBot({ name: "Grepper" });
    fs.mkdirSync(path.join(ws, "src", "deep"), { recursive: true });
    fs.writeFileSync(path.join(ws, "src", "a.ts"), "const x = f(1);\nTODO: fix\n");
    fs.writeFileSync(path.join(ws, "src", "deep", "b.md"), "todo later\n");
    fs.mkdirSync(path.join(ws, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(ws, "node_modules", "pkg", "index.js"), "TODO in a dependency\n");
    fs.writeFileSync(path.join(ws, "slow.txt"), `${"a".repeat(40)}!\n`);
    await inTurn(h, bot, async (tools) => {
      const lit = await call(tools, "grep", { pattern: "f(1" });
      assert.match(lit.text, /^src\/a\.ts:1:const x = f\(1\);$/m);
      assert.match(lit.text, /searched as plain text/);
      assert.equal((await call(tools, "grep", { pattern: "TODO" })).text, "src/a.ts:2:TODO: fix", "node_modules is skipped");
      const ci = await call(tools, "grep", { pattern: "todo", case_insensitive: true, glob: "*.md" });
      assert.equal(ci.text, "src/deep/b.md:1:todo later");
      assert.match((await call(tools, "grep", { pattern: "TODO", path: "node_modules" })).text, /^node_modules\/pkg\/index\.js:1:/, "unless you search it directly");
      let ticks = 0;
      const ticker = setInterval(() => ticks++, 20);
      const started = Date.now();
      const slow = await tools.grep!.execute({ pattern: "(a+)+$", path: "slow.txt" });
      clearInterval(ticker);
      assert.equal(slow.isError, true);
      assert.match(slow.text, /took longer than/);
      assert.ok(Date.now() - started < 5000);
      assert.ok(ticks > 5, "the event loop kept running during the search");
    }, { grepTimeoutMs: 400 });
  } finally {
    await cleanup();
  }
});

test("globs: names at any depth, paths with **, braces and classes, without catastrophic backtracking", () => {
  const md = compileGlob("*.md");
  assert.ok(md("README.md") && md("docs/deep/x.MD") && !md("x.mdx"));
  const ts = compileGlob("src/**/*.ts");
  assert.ok(ts("src/a.ts") && ts("src/x/y/z.ts") && !ts("lib/a.ts") && !ts("src/a.tsx"));
  const brace = compileGlob("{a,b}-[0-9].txt");
  assert.ok(brace("a-1.txt") && brace("dir/b-7.txt") && !brace("c-1.txt") && !brace("a-x.txt"));
  const started = Date.now();
  assert.equal(compileGlob("*a*a*a*a*a*a*a*a*b")("a".repeat(200)), false);
  assert.equal(compileGlob("**/**/**/**/**/x")(Array(60).fill("d").join("/")), false);
  assert.ok(Date.now() - started < 1000);
});

test("shell: output is scrubbed of stored secrets and provider keys, and the child env has no gateway credentials", async () => {
  const { h, cleanup } = await makeHarness();
  const saved = { api: process.env.CURSOR_API_KEY, tok: process.env.CURSOR_BOTS_TOKEN };
  process.env.CURSOR_API_KEY = "cursor-key-abc123";
  process.env.CURSOR_BOTS_TOKEN = "bots-token-xyz789";
  try {
    h.vault.set("DEMO_TOKEN", "s3cr3t-value-123");
    h.providerKeys.set("FEATHERLESS", "pk-provider-key-999");
    const bot = h.createBot({ name: "Leaky" });
    await inTurn(h, bot, async (tools) => {
      const r = await call(tools, "shell", {
        command: 'echo "v=s3cr3t-value-123 p=pk-provider-key-999"; echo "k=${CURSOR_API_KEY:-none} t=${CURSOR_BOTS_TOKEN:-none}"; env | grep -c "cursor-key-abc123\\|bots-token-xyz789" || true',
      });
      assert.match(r.text, /^exit 0\n[\s\S]*v=\[secret:DEMO_TOKEN\] p=\[secret:FEATHERLESS\]\nk=none t=none\n0\n$/);
      // A secret that reached a file is scrubbed when read back, too.
      await call(tools, "shell", { command: "mkdir -p bots/leaky && echo 'token s3cr3t-value-123' > bots/leaky/out.txt" });
      assert.match((await call(tools, "read_file", { path: "bots/leaky/out.txt" })).text, /token \[secret:DEMO_TOKEN\]/);
      assert.equal((await call(tools, "grep", { pattern: "token" })).text, "bots/leaky/out.txt:1:token [secret:DEMO_TOKEN]");
    });
  } finally {
    if (saved.api === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = saved.api;
    if (saved.tok === undefined) delete process.env.CURSOR_BOTS_TOKEN;
    else process.env.CURSOR_BOTS_TOKEN = saved.tok;
    await cleanup();
  }
});

test("shell: stopping the turn kills the whole command promptly; timeouts kill it too", async () => {
  const { h, ws, cleanup } = await makeHarness();
  try {
    const bot = h.createBot({ name: "Sleeper" });
    const dm = h.store.dmFor(bot.id)!;
    const dir = path.join(ws, "bots", "sleeper");
    await h.postUserMessage(dm.id, { text: '[[tool shell {"command":"echo $$ > bots/sleeper/pid; sleep 60 & echo $! > bots/sleeper/bg; wait"}]] [[reply finished]]' });
    for (let i = 0; i < 400 && !fs.existsSync(path.join(dir, "bg")); i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    const pid = Number(fs.readFileSync(path.join(dir, "pid"), "utf8"));
    const bg = Number(fs.readFileSync(path.join(dir, "bg"), "utf8"));
    assert.ok(alive(pid) && alive(bg));
    const started = Date.now();
    await h.stopConversation(dm.id);
    await settle(h);
    assert.ok(Date.now() - started < 3000, `stopped in ${Date.now() - started} ms`);
    for (let i = 0; i < 100 && (alive(pid) || alive(bg)); i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(alive(pid), false, "the shell is gone");
    assert.equal(alive(bg), false, "and so is what it started");
    assert.ok(!h.store.messages(dm.id).some((m) => m.kind === "message" && m.author.kind === "bot"), "a stopped turn posts nothing");

    await inTurn(h, bot, async (tools) => {
      const t0 = Date.now();
      const r = await call(tools, "shell", { command: "echo start; sleep 30", timeout_seconds: 1 });
      assert.ok(Date.now() - t0 < 4000);
      assert.equal(r.isError, true);
      assert.match(r.text, /killed after 1s: timed out/);
      assert.match(r.text, /\nstart\n/);
      // A background job doesn't hold the result hostage.
      const t1 = Date.now();
      const bgJob = await call(tools, "shell", { command: "sleep 20 & echo started" });
      assert.match(bgJob.text, /^exit 0\nstarted/);
      assert.ok(Date.now() - t1 < 4000);
    });
  } finally {
    await cleanup();
  }
});

test("edit_file: exact and unique matches, replace_all, and clear errors", async () => {
  const { h, ws, cleanup } = await makeHarness();
  try {
    const bot = h.createBot({ name: "Editor" });
    const file = path.join(ws, "doc.txt");
    fs.writeFileSync(file, "alpha\nfoo\nbeta\nfoo\n");
    fs.writeFileSync(path.join(ws, "win.txt"), "one\r\ntwo\r\n");
    await inTurn(h, bot, async (tools) => {
      const dup = await call(tools, "edit_file", { path: "doc.txt", old_string: "foo", new_string: "bar" });
      assert.equal(dup.isError, true);
      assert.match(dup.text, /appears 2 times in doc\.txt.*replace_all/);
      const one = await call(tools, "edit_file", { path: "doc.txt", old_string: "beta\nfoo", new_string: "beta\n$& $1 baz" });
      assert.equal(one.text, "Edited doc.txt: replaced 1 occurrence (first at line 3).");
      assert.equal(fs.readFileSync(file, "utf8"), "alpha\nfoo\nbeta\n$& $1 baz\n", "the replacement is literal text");
      const all = await call(tools, "edit_file", { path: "doc.txt", old_string: "a", new_string: "A", replace_all: true });
      assert.match(all.text, /replaced 4 occurrences/);
      assert.equal(fs.readFileSync(file, "utf8"), "AlphA\nfoo\nbetA\n$& $1 bAz\n");
      assert.match((await call(tools, "edit_file", { path: "doc.txt", old_string: "nope", new_string: "x" })).text, /wasn't found in doc\.txt/);
      assert.match((await call(tools, "edit_file", { path: "doc.txt", old_string: "", new_string: "x" })).text, /can't be empty/);
      assert.match((await call(tools, "edit_file", { path: "doc.txt", old_string: "foo", new_string: "foo" })).text, /nothing to change/);
      assert.match((await call(tools, "edit_file", { path: "nope.txt", old_string: "a", new_string: "b" })).text, /doesn't exist/);
      // Windows line endings are kept.
      assert.equal((await call(tools, "edit_file", { path: "win.txt", old_string: "one\ntwo", new_string: "uno\ndos" })).isError, undefined);
      assert.equal(fs.readFileSync(path.join(ws, "win.txt"), "utf8"), "uno\r\ndos\r\n");
    });
  } finally {
    await cleanup();
  }
});

test("web_fetch: refuses this computer, private networks and redirects into them; reads public pages as text", async () => {
  const { h, cleanup } = await makeHarness();
  const server = http.createServer((req, res) => {
    const u = req.url ?? "/";
    if (u === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><head><title>Test &amp; page</title><style>.x{color:red}</style><script>var secret = "do-not-show";</script></head>` +
          `<body><h1>Hello</h1><p>Read <a href="/docs">the docs</a> &mdash; or <a href="javascript:alert(1)">this</a>.</p>` +
          `<ul><li>one</li><li>two</li></ul><pre>  indented\n    code</pre><img src="x.png" alt="a cat"></body></html>`,
      );
    } else if (u === "/json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    } else if (u === "/gzip") {
      res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
      res.end(zlib.gzipSync("compressed hello"));
    } else if (u === "/big") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("x".repeat(3 * 1024 * 1024));
    } else if (u === "/to-private") {
      res.writeHead(302, { location: "http://10.1.2.3/admin" });
      res.end();
    } else if (u === "/to-metadata") {
      res.writeHead(301, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    } else if (u === "/to-page") {
      res.writeHead(302, { location: "/page" });
      res.end();
    } else if (u.startsWith("/loop")) {
      res.writeHead(302, { location: `/loop${u.length}` });
      res.end();
    } else if (u === "/bin") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from([0, 1, 2, 3]));
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not here");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    const bot = h.createBot({ name: "Browser" });
    const fakeDns: Record<string, string[]> = { localhost: ["127.0.0.1", "::1"],"mixed.example": ["93.184.216.34", "10.0.0.5"], "rebind.example": ["::ffff:127.0.0.1"] };
    const resolveHost = async (host: string) => {
      const a = fakeDns[host];
      if (!a) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
      return a;
    };
    // Without the loopback allowance (as in production).
    await inTurn(
      h,
      bot,
      async (tools) => {
        for (const url of [`http://127.0.0.1:${port}/page`, `http://localhost:${port}/page`, `http://[::1]:${port}/`, `http://0x7f000001:${port}/`, `http://2130706433:${port}/`, "http://rebind.example/"]) {
          const r = await call(tools, "web_fetch", { url });
          assert.equal(r.isError, true, url);
          assert.match(r.text, /only reaches public internet addresses.*this computer/, url);
        }
        for (const [url, kind] of [
          ["http://10.0.0.1/", "private"],
          ["http://192.168.1.1/", "private"],
          ["http://169.254.169.254/latest/meta-data/", "link-local"],
          ["http://[fd00::1]/", "unique-local"],
          ["http://[fe80::1]/", "link-local"],
          ["http://224.0.0.1/", "multicast"],
          ["http://mixed.example/", "private"],
        ] as const) {
          const r = await call(tools, "web_fetch", { url });
          assert.match(r.text, new RegExp(`a ${kind} address`), url);
        }
        assert.match((await call(tools, "web_fetch", { url: "http://example.com:1/" })).text, /can't call the Cursor Bots gateway/);
        assert.match((await call(tools, "web_fetch", { url: "file:///etc/passwd" })).text, /only fetches http/);
        assert.match((await call(tools, "web_fetch", { url: "ftp://example.com/" })).text, /only fetches http/);
        assert.match((await call(tools, "web_fetch", { url: "not a url" })).text, /isn't a valid URL/);
      },
      { resolveHost },
    );
    // The system resolver's answer is checked the same way.
    await inTurn(h, bot, async (tools) => {
      assert.match((await call(tools, "web_fetch", { url: `http://localhost:${port}/page` })).text, /localhost \((127\.0\.0\.1|::1)\) is this computer/);
    });
    // Loopback allowed (tests only): pages, redirects and limits; redirects into private ranges are still refused.
    await inTurn(
      h,
      bot,
      async (tools) => {
        const base = `http://127.0.0.1:${port}`;
        const page = await call(tools, "web_fetch", { url: `${base}/page` });
        assert.equal(page.isError, false, page.text);
        assert.match(page.text, /^URL: http:\/\/127\.0\.0\.1:\d+\/page\nStatus: 200 OK\nContent-Type: text\/html/);
        assert.match(page.text, /Title: Test & page/);
        assert.match(page.text, /^# Hello$/m);
        assert.match(page.text, new RegExp(`Read \\[the docs\\]\\(${base}/docs\\) — or this\\.`));
        assert.match(page.text, /^- one\n- two$/m);
        assert.match(page.text, / {2}indented\n {4}code/);
        assert.match(page.text, /\[image: a cat\]/);
        assert.ok(!page.text.includes("do-not-show") && !page.text.includes("color:red"));
        assert.match((await call(tools, "web_fetch", { url: `${base}/json` })).text, /\n\n\{"ok":true\}$/);
        assert.match((await call(tools, "web_fetch", { url: `${base}/gzip` })).text, /\n\ncompressed hello$/);
        const big = await call(tools, "web_fetch", { url: `${base}/big` });
        assert.ok(big.text.length < 45_000);
        assert.match(big.text, /Only the first 2\.0 MB/);
        assert.match((await call(tools, "web_fetch", { url: `${base}/to-page` })).text, /\(redirected from .*\/to-page\)[\s\S]*# Hello/);
        assert.match((await call(tools, "web_fetch", { url: `${base}/to-private` })).text, /10\.1\.2\.3 is a private address/);
        assert.match((await call(tools, "web_fetch", { url: `${base}/to-metadata` })).text, /169\.254\.169\.254 is a link-local address/);
        assert.match((await call(tools, "web_fetch", { url: `${base}/loop` })).text, /Too many redirects/);
        assert.match((await call(tools, "web_fetch", { url: `${base}/bin` })).text, /application\/octet-stream content/);
        const missing = await call(tools, "web_fetch", { url: `${base}/nope` });
        assert.equal(missing.isError, true);
        assert.match(missing.text, /Status: 404[\s\S]*not here/);
      },
      { allowLoopback: true },
    );
  } finally {
    server.close();
    await cleanup();
  }
});

test("guard: addresses wrapped in IPv6 forms are classified like the IPv4 inside; dangling links resolve to their target", () => {
  assert.equal(blockedAddress("8.8.8.8"), undefined);
  assert.equal(blockedAddress("2606:4700:4700::1111"), undefined);
  assert.equal(blockedAddress("::ffff:10.0.0.1"), "private");
  assert.equal(blockedAddress("::ffff:7f00:1"), "loopback");
  assert.equal(blockedAddress("64:ff9b::a9fe:a9fe"), "link-local");
  assert.equal(blockedAddress("2002:c0a8:0101::1"), "private");
  assert.equal(blockedAddress("127.0.0.1", { allowLoopback: true }), undefined);
  assert.equal(blockedAddress("10.0.0.1", { allowLoopback: true }), "private");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-bots-guard-"));
  try {
    fs.symlinkSync(path.join(dir, "target", "file.txt"), path.join(dir, "link"));
    assert.equal(realPrefix(path.join(dir, "link")), path.join(fs.realpathSync(dir), "target", "file.txt"));
    fs.symlinkSync("b", path.join(dir, "a"));
    fs.symlinkSync("a", path.join(dir, "b"));
    assert.equal(realPrefix(path.join(dir, "a")), path.join(dir, "a"), "a loop resolves to itself (and can't be opened)");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("html to text stays linear on hostile markup", () => {
  const started = Date.now();
  const hostile = "<script".repeat(50_000) + "<a href='x'".repeat(50_000) + "<!--".repeat(50_000);
  htmlToText(hostile);
  htmlToText("<p>" + "&amp;".repeat(100_000) + "</p>");
  assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
  assert.equal(htmlToText("<p>a &lt; b</p><p>c</p>"), "a < b\n\nc");
});
