import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Harness } from "../src/core/harness.ts";
import type { Message } from "../src/core/types.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";

export async function makeHarness(opts: { settings?: (h: Harness) => void } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-bots-test-"));
  const mock = new MockRuntime({ chunkDelayMs: 0 });
  const h = new Harness({ home, runtimes: [mock] });
  h.store.settings.runtime = "mock";
  h.store.settings.groupRouting = "heuristic";
  h.store.settings.approvals.inlineWaitSeconds = 0;
  opts.settings?.(h);
  await h.start({ gatewayUrl: "http://127.0.0.1:1" });
  return {
    h,
    mock,
    home,
    async cleanup() {
      await h.stop();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Wait until every bot is idle with an empty queue. */
export async function settle(h: Harness, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  let quietSince = 0;
  while (Date.now() < end) {
    const busy = [...h.store.bots.keys()].some((id) => {
      const s = h.runner(id).status();
      return s.state === "working" || s.queued > 0;
    });
    if (!busy) {
      if (!quietSince) quietSince = Date.now();
      if (Date.now() - quietSince > 60) return;
    } else {
      quietSince = 0;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("harness did not settle");
}

export function texts(h: Harness, convId: string, kinds = ["message"]): string[] {
  return h.store
    .messages(convId)
    .filter((m: Message) => kinds.includes(m.kind))
    .map((m) => `${m.author.kind === "bot" ? "@" + h.store.bots.get(m.author.id)?.handle : m.author.kind}: ${m.text}`);
}
