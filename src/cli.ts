#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";
import { Harness } from "./core/harness.ts";
import { defaultHome } from "./core/paths.ts";
import { createStarterTeam } from "./core/starter.ts";
import { CursorRuntime, cursorCredentials } from "./runtimes/cursor.ts";
import { MockRuntime } from "./runtimes/mock.ts";
import { createServer } from "./server/http.ts";

// The Cursor SDK keeps bot contexts in node:sqlite, which Node 22 still labels
// experimental. Keep that one notice off the console; other warnings still show.
const emitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning?.message;
  const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
  if (type === "ExperimentalWarning" && /sqlite/i.test(text ?? "")) return;
  return (emitWarning as (...a: unknown[]) => void).call(process, warning, ...rest);
}) as typeof process.emitWarning;

const HELP = `cursor-bots — persistent AI teammates on the Cursor SDK

Usage:
  cursor-bots start   [--port 4777] [--host 127.0.0.1] [--home DIR] [--runtime cursor|mock] [--starter] [--open]
  cursor-bots doctor  [--home DIR]          Check Node, the Cursor SDK, your API key and the workspace
  cursor-bots models                        List the models your Cursor API key can use
  cursor-bots say BOT MESSAGE [--port 4777] [--home DIR]  Message a bot through a running gateway

Environment:
  CURSOR_API_KEY     Cursor user or service-account API key (cursor.com/dashboard → API Keys).
                     A login stored by the Cursor SDK (~/.cursor/sdk/auth.json) works too.
  CURSOR_BOTS_HOME   Where bots, chats, memory and the shared workspace live (default ~/.cursor-bots)
`;

function makeRuntimes(home: string, settings: () => Harness["store"]["settings"]) {
  const cursor = new CursorRuntime({
    storeDir: path.join(home, "cursor-store"),
    scratchDir: path.join(home, "scratch", "router"),
    settings: () => {
      const s = settings();
      return { defaultModel: s.defaultModel, autoReview: s.cursorAutoReview, sandbox: s.cursorSandbox };
    },
  });
  return [cursor, new MockRuntime()];
}

async function start(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string", default: process.env.PORT ?? "4777" },
      host: { type: "string", default: "127.0.0.1" },
      home: { type: "string", default: defaultHome() },
      runtime: { type: "string" },
      starter: { type: "boolean", default: false },
      open: { type: "boolean", default: false },
    },
  });
  const home = path.resolve(values.home!);
  let harnessRef: Harness | undefined;
  const runtimes = makeRuntimes(home, () => harnessRef!.store.settings);
  const h = new Harness({ home, runtimes });
  harnessRef = h;
  if (values.runtime) {
    if (!h.runtimes.has(values.runtime)) throw new Error(`Unknown runtime ${values.runtime} (use cursor or mock)`);
    h.store.settings.runtime = values.runtime;
    h.store.saveSettings();
  }

  const loopback = ["127.0.0.1", "localhost", "::1"].includes(values.host!);
  // The API always needs a token, even on localhost: otherwise a bot could
  // curl its own approval endpoint. Your browser gets it once from the link below.
  const token = uiToken(h.store.paths.state);

  const port = Number(values.port);
  const server = createServer(h, { port, host: values.host!, token });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, values.host, () => resolve());
  });
  // The approval hook must reach the gateway at an address it really listens on;
  // if it can't connect it assumes the gateway is off and lets commands through.
  const gatewayUrl = boundUrl(server.address() as AddressInfo);
  await h.start({ gatewayUrl });
  if (!(await gateReachable(gatewayUrl, h.gateToken))) {
    console.error(`\n  ✖ The approval hook can't reach the gateway at ${gatewayUrl}. Start with a --host this machine can connect to (e.g. 127.0.0.1).\n`);
    server.close();
    await h.stop().catch(() => {});
    process.exit(1);
  }
  if (values.starter) createStarterTeam(h);

  const rt = h.runtimes.get(h.store.settings.runtime);
  const avail = rt?.available();
  const shownHost = loopback ? "localhost" : values.host;
  const link = `http://${shownHost}:${port}/?token=${token}`;
  console.log(`\n  Cursor Bots is running → ${link}`);
  console.log(`  (Open that link once; your browser remembers the token.)`);
  console.log(`  Home:      ${h.store.paths.home}`);
  console.log(`  Workspace: ${h.store.paths.workspace}  (the shared computer)`);
  console.log(`  Runtime:   ${rt?.label ?? h.store.settings.runtime}${avail?.ok ? "" : `  ⚠ ${avail?.reason}`}`);
  console.log(`  Bots:      ${h.store.bots.size}\n`);
  if (!avail?.ok && h.store.settings.runtime === "cursor") {
    console.log("  No Cursor credentials found: set CURSOR_API_KEY and restart, or start with --runtime mock to try the demo brain.\n");
  }

  let stopping = false;
  if (values.open) openBrowser(link);

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log("\n  Saving and shutting down…");
    server.close();
    await h.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function boundUrl(a: AddressInfo): string {
  const host = a.address === "0.0.0.0" || a.address === "::" ? "127.0.0.1" : a.address;
  return `http://${host.includes(":") ? `[${host}]` : host}:${a.port}`;
}

async function gateReachable(url: string, gateToken: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/gate/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gate-token": gateToken },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function uiToken(stateDir: string): string {
  const fromEnv = process.env.CURSOR_BOTS_TOKEN;
  // Bots' shell commands inherit this process's environment; the token must not be in it.
  delete process.env.CURSOR_BOTS_TOKEN;
  if (fromEnv) return fromEnv;
  const tokenFile = path.join(stateDir, "ui.token");
  let token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "";
  if (!token) {
    fs.mkdirSync(stateDir, { recursive: true });
    token = randomBytes(18).toString("base64url");
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  }
  return token;
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // No browser available; the link is printed above.
  }
}

async function doctor(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { home: { type: "string", default: defaultHome() } } });
  const ok = (m: string) => console.log(`  ✔ ${m}`);
  const warn = (m: string) => console.log(`  ⚠ ${m}`);
  const bad = (m: string) => console.log(`  ✖ ${m}`);
  console.log("\nCursor Bots doctor\n");
  const [maj, min] = process.versions.node.split(".").map(Number) as [number, number];
  if (maj > 22 || (maj === 22 && min >= 18)) ok(`Node ${process.versions.node}`);
  else bad(`Node ${process.versions.node}: need 22.18+ (runs TypeScript directly; the Cursor SDK needs 22.13+)`);
  try {
    const sdk = await import("@cursor/sdk");
    ok("@cursor/sdk loads");
    if (process.env.CURSOR_API_KEY === "") delete process.env.CURSOR_API_KEY;
    const creds = cursorCredentials();
    if (creds === "expired") {
      bad("Your stored Cursor login has expired: log in again or set CURSOR_API_KEY.");
    } else if (creds) {
      try {
        const me = await sdk.Cursor.me();
        ok(`${creds === "key" ? "CURSOR_API_KEY" : "Stored Cursor login"} works (${me.userEmail ?? me.apiKeyName})`);
        const models = await sdk.Cursor.models.list();
        ok(`${models.length} models available: ${models.slice(0, 8).map((m) => m.id).join(", ")}${models.length > 8 ? ", …" : ""}`);
      } catch (err: any) {
        bad(`API key check failed: ${err?.message ?? err}`);
      }
    } else {
      warn("No Cursor credentials found: set CURSOR_API_KEY, or start with --runtime mock to try the demo brain.");
    }
  } catch (err: any) {
    bad(`@cursor/sdk failed to load: ${err?.message ?? err}. Run npm install.`);
  }
  const home = path.resolve(values.home!);
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.accessSync(home, fs.constants.W_OK);
    ok(`Home is writable: ${home}`);
  } catch {
    bad(`Can't write to ${home}`);
  }
  const hooks = path.join(home, "workspace", ".cursor", "hooks.json");
  if (fs.existsSync(hooks)) ok("Approval hook installed in the workspace");
  else warn("Workspace not prepared yet (it is created on first start)");
  const bwrap = ["/usr/bin/bwrap", "/usr/local/bin/bwrap"].some((p) => fs.existsSync(p));
  if (process.platform === "linux") (bwrap ? ok : warn)(bwrap ? "bubblewrap found (Cursor sandbox available)" : "bubblewrap not found: the optional Cursor sandbox won't work on this Linux host");
  console.log("");
}

async function models(): Promise<void> {
  const sdk = await import("@cursor/sdk");
  if (process.env.CURSOR_API_KEY === "") delete process.env.CURSOR_API_KEY;
  const creds = cursorCredentials();
  if (creds === "expired") throw new Error("Your stored Cursor login has expired: log in again or set CURSOR_API_KEY.");
  if (!creds) throw new Error("No Cursor credentials found: set CURSOR_API_KEY first.");
  for (const m of await sdk.Cursor.models.list()) {
    const params = (m.parameters ?? []).map((p) => `${p.id}=${p.values.map((v) => v.value).join("|")}`).join(" ");
    console.log(`${m.id.padEnd(28)} ${m.displayName}${params ? `  [${params}]` : ""}`);
  }
}

async function say(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { port: { type: "string", default: "4777" }, home: { type: "string", default: defaultHome() } },
  });
  const [botRef, ...words] = positionals;
  if (!botRef || !words.length) throw new Error("Usage: cursor-bots say BOT MESSAGE");
  const base = `http://127.0.0.1:${values.port}`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  headers.authorization = `Bearer ${uiToken(path.join(path.resolve(values.home!), "state"))}`;
  const state = await (await fetch(`${base}/api/state`, { headers })).json();
  const ref = botRef.replace(/^@/, "").toLowerCase();
  const bot = state.bots.find((b: any) => b.handle === ref || b.name.toLowerCase() === ref);
  if (!bot) throw new Error(`No bot ${botRef}. Bots: ${state.bots.map((b: any) => "@" + b.handle).join(", ")}`);
  const conv = state.conversations.find((c: any) => c.kind === "dm" && c.members[0] === bot.id);
  const events = await fetch(`${base}/api/events`, { headers });
  await fetch(`${base}/api/conversations/${conv.id}/messages`, { method: "POST", headers, body: JSON.stringify({ text: words.join(" ") }) });
  const reader = events.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  process.stdout.write(`${bot.name}: `);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const ev = JSON.parse(line.slice(6));
      if (ev.botId !== bot.id) continue;
      if (ev.type === "run.delta") process.stdout.write(ev.text);
      if (ev.type === "run.tool" && ev.item.status === "running") process.stdout.write(`\n  [${ev.item.name}] ${ev.item.summary}\n`);
      if (ev.type === "run.finished") {
        process.stdout.write(ev.error ? `\n(error: ${ev.error})\n` : "\n");
        process.exit(0);
      }
    }
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "start":
    case undefined:
      return start(rest);
    case "doctor":
      return doctor(rest);
    case "models":
      return models();
    case "say":
      return say(rest);
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      console.log(HELP);
      process.exit(1);
  }
}

// A long-running gateway logs stray async errors instead of exiting.
process.on("unhandledRejection", (err) => console.error("  ⚠ unhandled:", (err as Error)?.stack ?? err));

main().catch((err) => {
  console.error(`\n  ✖ ${err?.message ?? err}\n`);
  process.exit(1);
});
