/**
 * Live check of model providers (backlog B6). Uses real API keys from the environment and real
 * network calls, so it is never part of `npm test`. Keys are read by the harness itself (each
 * preset's keyEnv) and never printed; every line of output goes through the harness's scrubbing.
 *
 *   FEATHERLESS_API_KEY=… PHALA_API_KEY=… ROUTEWAY_API_KEY=… npm run live
 *   npm run live -- featherless            # only some providers
 *   LIVE_MODEL_ROUTEWAY=<model id> npm run live -- routeway
 *
 * For each provider whose key is set:
 *   1. the model catalogue loads;
 *   2. one test prompt answers;
 *   3. a bot on that brain reads a file with read_file and reports a word only that file holds;
 *   4. a `git push` request stops for approval (the request is denied afterwards).
 * The model is LIVE_MODEL_<ID>, else the preset's default, else a free model from the catalogue
 * that can call tools. A provider without a usable model is skipped with the reason.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Harness } from "../src/core/harness.ts";
import { PROVIDER_PRESETS } from "../src/core/providers.ts";
import type { ProviderModel } from "../src/core/types.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";
import { OpenAICompatRuntime } from "../src/runtimes/openai.ts";

const DEFAULT_TARGETS = ["featherless", "phala", "routeway"];
const TURN_TIMEOUT_MS = 10 * 60_000; // a cold Featherless model can take minutes to load

type Result = { provider: string; step: string; ok: boolean | "skipped"; detail: string };
/** A catalogue entry: a model config plus what the provider says about tool use. */
type Entry = ProviderModel & { toolUse?: boolean };

async function idle(h: Harness, botId: string, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  await new Promise((r) => setTimeout(r, 200));
  while (Date.now() < end) {
    const s = h.runner(botId).status();
    if (s.state !== "working" && !s.queued) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`);
}

async function main(): Promise<number> {
  const targets = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TARGETS;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-bots-live-"));
  const h = new Harness({
    home,
    runtimes: [new MockRuntime({ chunkDelayMs: 0 })],
    providerRuntime: (deps) => new OpenAICompatRuntime({ ...deps, appName: "Cursor Bots", appUrl: "https://github.com/cdazzle-end/cursor-bots" }),
  });
  h.store.settings.runtime = "mock";
  h.store.settings.groupRouting = "heuristic";
  h.store.settings.approvals.inlineWaitSeconds = 0;
  await h.start({ gatewayUrl: "http://127.0.0.1:1" });
  const results: Result[] = [];
  const say = (r: Result) => {
    r.detail = h.scrubSecrets(r.detail).replace(/\s+/g, " ").slice(0, 300);
    results.push(r);
    console.log(`${r.ok === true ? "PASS" : r.ok === "skipped" ? "SKIP" : "FAIL"}  ${r.provider.padEnd(12)} ${r.step.padEnd(10)} ${r.detail}`);
  };

  try {
    for (const key of targets) {
      const preset = PROVIDER_PRESETS.find((p) => p.key === key);
      if (!preset) {
        say({ provider: key, step: "setup", ok: false, detail: `no preset "${key}" (known: ${PROVIDER_PRESETS.map((p) => p.key).join(", ")})` });
        continue;
      }
      if (preset.needsKey && (!preset.keyEnv || !process.env[preset.keyEnv])) {
        say({ provider: key, step: "setup", ok: "skipped", detail: `${preset.keyEnv ?? "its key variable"} is not set in this environment` });
        continue;
      }
      const p = h.createProvider({ preset: key });

      // 1. Catalogue.
      let catalog: Entry[] = [];
      try {
        catalog = (await h.providerCatalog(p.id)) as Entry[];
        say({ provider: key, step: "catalogue", ok: catalog.length > 0, detail: `${catalog.length} models listed` });
      } catch (err) {
        say({ provider: key, step: "catalogue", ok: false, detail: String((err as Error)?.message ?? err) });
      }

      // The model to use.
      const wanted = process.env[`LIVE_MODEL_${key.toUpperCase()}`] || p.defaultModel || catalog.find((m) => m.toolUse && /:free$/.test(m.id))?.id;
      if (!wanted) {
        say({ provider: key, step: "model", ok: "skipped", detail: `no default model: set LIVE_MODEL_${key.toUpperCase()} to a model id from its catalogue` });
        continue;
      }
      const entry = catalog.find((m) => m.id === wanted) ?? { id: wanted };
      const { toolUse: _toolUse, ...model } = entry as Entry;
      h.updateProvider(p.id, { models: [...p.models.filter((m) => m.id !== wanted), model], defaultModel: wanted });
      say({ provider: key, step: "model", ok: true, detail: `${wanted}${entry.contextWindow ? ` (${entry.contextWindow} tokens)` : ""}` });

      // 2. One test prompt.
      const t = await h.testProvider(p.id);
      say({ provider: key, step: "prompt", ok: t.ok, detail: t.ok ? `answered "${t.reply}" in ${(t.ms / 1000).toFixed(1)} s` : t.error ?? "failed" });
      if (!t.ok) continue;

      // 3. A real turn with a tool call.
      const bot = h.createBot({ name: `Live ${key}`, runtime: p.id });
      const dm = h.store.dmFor(bot.id)!;
      const word = `word-${randomBytes(4).toString("hex")}`;
      fs.mkdirSync(path.join(h.store.paths.workspace, "live"), { recursive: true });
      fs.writeFileSync(path.join(h.store.paths.workspace, "live", `${key}.txt`), `The secret word is ${word}.\n`);
      const since = Date.now();
      try {
        await h.postUserMessage(dm.id, { text: `Use your read_file tool to open live/${key}.txt, then reply with only the secret word it contains.` });
        await idle(h, bot.id, TURN_TIMEOUT_MS);
        const replies = h.store.messages(dm.id).filter((m) => m.author.kind === "bot" && m.ts >= since);
        const last = replies.at(-1);
        const usedTool = JSON.stringify(last?.meta?.activity ?? []).includes("read_file");
        const ok = !!last && last.kind === "message" && last.text.includes(word) && usedTool;
        say({ provider: key, step: "tool turn", ok, detail: `${usedTool ? "called read_file" : "no read_file call"}; replied: ${last?.text ?? "(nothing)"}` });
      } catch (err) {
        say({ provider: key, step: "tool turn", ok: false, detail: String((err as Error)?.message ?? err) });
      }

      // 4. The approval boundary holds on this brain.
      try {
        await h.postUserMessage(dm.id, { text: "Run exactly this command with your shell tool, then tell me what happened: git push origin main" });
        await idle(h, bot.id, TURN_TIMEOUT_MS);
        const card = h.approvals.pendingFor(bot.id).find((a) => /git\s+push/.test(a.command ?? ""));
        say({ provider: key, step: "approval", ok: !!card, detail: card ? `stopped for approval: ${card.command}` : "no approval card (the model may not have called the shell)" });
        if (card) h.decideApproval(card.id, "deny");
      } catch (err) {
        say({ provider: key, step: "approval", ok: false, detail: String((err as Error)?.message ?? err) });
      }
    }
  } finally {
    await h.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }

  const failed = results.filter((r) => r.ok === false).length;
  const passed = results.filter((r) => r.ok === true).length;
  console.log(`\n${passed} passed, ${failed} failed, ${results.filter((r) => r.ok === "skipped").length} skipped`);
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(String(err?.message ?? err));
    process.exit(1);
  },
);
