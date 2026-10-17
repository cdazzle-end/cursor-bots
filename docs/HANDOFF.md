# Handoff: current state and backlog

The lead (Claude) maintains this file. Contributors change only the **Status** line of items they work on (see `docs/COLLABORATION.md`). Read `AGENTS.md` and `docs/COLLABORATION.md` first.

## Current state

Last updated by the lead on 2026-10-17. Session notes are the newest files in `docs/worklog/`.

- **Integration branch:** `claude/tender-cori-t1ksnz` (also the default branch). `npm run typecheck && npm test` is clean, with 182 tests.
- **Lead's working branch:** `claude/bold-knuth-kcf7i1` holds the lead's 2026-10-17 review session (B6, B9): a fast-forward of the integration branch, clean, with 185 tests. Until it's merged, branch new work from it if it needs those fixes.
- **What the product is.** A self-hosted, Grok-Bot-style team of persistent AI bots:
  - each bot has its own chat, memory, skills, routines and approvals;
  - bots message each other and work in groups;
  - other agents can reach the team over the Team MCP endpoint.

  See `README.md` and `docs/ARCHITECTURE.md`.
- **What was built most recently: provider brains.** Bots can run on any OpenAI-compatible chat API instead of the Cursor SDK. The first target is Featherless AI; OpenRouter, xAI, OpenAI, Groq, Together, DeepInfra, Ollama, LM Studio and custom URLs are presets too. The owner has a Featherless key and wants to run open models such as Qwen3 on it, then add other providers.
- **Live checks.** The provider runtime passes the automatic live check on Featherless, Phala and Routeway (B6). The Cursor runtime has never run against the real service (B7). `npm test` uses only local fakes.
- **Review status.**
  - An adversarial review of provider brains found 32 confirmed defects. All are fixed, each with a regression test (the last five were B1–B5).
  - A lead review of the Team MCP endpoint, the HTTP API, the scheduler and approvals found three more (B9). All are fixed with regression tests.
- **Next up.**
  - B6's manual checks (steps 2 and 4–7), when the owner allows more live tests.
  - B7 (Cursor) needs a Cursor key.
  - Nothing else is open. Ask the lead (or the owner) for the next feature rather than inventing one.

### Map of the provider-brain code

| Piece | File | Tests |
| --- | --- | --- |
| Presets, validation, which hosts count as local | `src/core/providers.ts` | `test/providers.test.ts` |
| Registry, write-only key vault, keys from environment variables, `modelFor`, `systemPromptFor`, scrubbing | `src/core/harness.ts` | `test/providers.test.ts`, `test/regressions.test.ts` |
| Agent loop: SSE parsing, tool modes (native, prompt, auto, none), retries, concurrency units, compaction, JSONL transcripts in `state/agents/` | `src/runtimes/openai.ts` | `test/openai-runtime.test.ts` (fake server: `test/fake-openai.ts`) |
| Shell, file, search and `web_fetch` tools for brains without their own | `src/core/workspace-tools.ts`, `src/core/guard.ts` | `test/workspace-tools.test.ts` |
| MCP client for connectors (stdio, Streamable HTTP, legacy SSE) | `src/core/mcp-client.ts` | `test/mcp-client.test.ts` (fixture: `test/fixtures/fake-mcp-server.mjs`) |
| How a turn uses all of it | `src/core/runner.ts` | `test/provider-e2e.test.ts` (real harness and runtime, fake provider, real MCP fixture) |
| API, CLI, UI | `src/server/http.ts`, `src/cli.ts` (`doctor`, `models --runtime`), `web/app.js` (Settings → Brain & models → Providers) | `test/providers.test.ts` (HTTP API) |

## Backlog

Priority order, top first. Each item says why it matters, a suggested fix (a starting point, not a mandate) and what "done" must show. Line numbers are approximate; search for the named functions.

Status values:
- `Open`
- `In progress: <branch>`
- `In review: <branch> @ <hash>`
- `Changes requested: <review file>`
- `Done @ <hash>`
- `Blocked: <why>`

### B1. A finished answer can be lost behind the end-of-turn summary

- **Status:** Done @ 0cf2ca6 (lead)
- **Where:** `src/runtimes/openai.ts`, in `OaiRun.turn()`, `OaiRun.compact()` and `OaiSession.send()`, plus the outcome handling in `Harness.finishRun`.
- **Problem:**
  - `turn()` appends the final answer to the transcript, then awaits `compact("end")`, a non-streamed summary call that queues for capacity and can retry for minutes. Until it finishes, `run.wait()` doesn't resolve, so the runner posts nothing.
  - If the user presses Stop in that window (the bot shows "Compacting…"), or the gateway shuts down, the outcome is `cancelled` with empty text. The answer is never posted, although the transcript says it was given.
  - The same loss happens when a steer arrives while the final answer streams and the follow-up model call then fails: the outcome is `error` with empty text.
- **Suggested fix:**
  - Settle the outcome first. Then run `compact("end")` in the background with its own AbortController, kept on the session (e.g. `OaiSession.pendingCompaction`). `send()` awaits it before starting the next run, and `close()`/`dispose()` abort it.
  - If an error comes after at least one complete answer, return the answers with the error, and make `finishRun` post that text before the error card.
- **Done when:** tests show that the answer is posted immediately while the summary is still running, and that Stop during the summary still leaves the answer posted. A steer followed by a failing follow-up call keeps the first answer, and the next turn waits for a pending compaction.

### B2. The reply limit fills the rest of the window

- **Status:** Done @ d0ba669 (lead)
- **Where:** `replyLimit()` and `learnOverflow()` in `src/runtimes/openai.ts`.
- **Problem:**
  - max_tokens is `min(outputCap, window - estimate - 3%)`. With a large `maxOutputTokens` (Featherless lists some models with max_completion_tokens equal to their context), an estimate that is more than 3% low overflows. chars/3.5 undercounts code and JSON by about 15%.
  - `learnOverflow()` doesn't parse vLLM's "your request has N input tokens", so the retry is identical and the turn fails with "too long even after compacting".
- **Suggested fix:**
  - Also parse `/request has (\d+) input tokens/i` and `/\((\d+) of text input/i`.
  - When nothing is learned, raise the ratio anyway (`Math.min(4, ratio * 1.25)`) so the retry asks for less.
  - Cap the reply at about half the window, or use a 10% margin until a ratio has been learned.
- **Done when:** a test where the fake server rejects with vLLM's wording leads to a smaller retry that succeeds, and a test with an unparseable overflow message still retries with a smaller max_tokens.

### B3. Small context windows compact on every turn

- **Status:** Done @ 4622cda (lead)
- **Where:** `OaiRun.fitBudget()` and `promptBudget()` in `src/runtimes/openai.ts`.
- **Problem:**
  - On 8k windows (the Ollama and LM Studio preset default), the fixed system prompt plus about 29 tool schemas (about 23k characters) already exceed the prompt budget. So every turn runs `compact("budget")`, doubling the requests, and the runner resends identity every turn.
  - The request would have fit with a smaller reply.
- **Suggested fix:**
  - Estimate the fixed part (system and tools with no history). If too little room is left, don't compact while the request still fits within `window - MIN_REPLY_TOKENS - margin`, and emit one status line (once per session) saying the window is too small for the tools, with a hint (raise `num_ctx` in Ollama, or pick a larger model).
  - Otherwise compact only when the history part exceeds what remains.
- **Done when:** a test with an 8k window and the full tool list runs several turns without any summary call and shows the warning once.

### B4. Provider fields needed in tool loops are dropped

- **Status:** Done @ eee8155 (lead). Tested against the documented shapes only; confirm on a live Gemini or OpenRouter model when one is used.
- **Where:** `ReplyBuilder.addToolCall()`, `interpret()`, `normalizeStored()`, `serialize()` and `toWire()` in `src/runtimes/openai.ts`.
- **Problem** (taken from provider docs, not reproduced live):
  - Gemini 3 behind its OpenAI-compatible endpoint puts `extra_content.google.thought_signature` on tool calls, and rejects the next request in the loop without it.
  - OpenRouter sends `reasoning_details`, which some models need back.
- **Suggested fix:**
  - Keep `extra_content` on streamed tool calls, merged by index. Carry it through to the transcript, and send it back unchanged on assistant tool_calls within the current turn, for the same model.
  - Do the same for `reasoning_details`.
  - Drop both when `noReasoningEcho` is set or the model changes.
- **Done when:** a fake-server test sees both fields come back on the second request of a tool loop, and sees neither after a model change.

### B5. Token-ratio learning undoes what an overflow taught

- **Status:** Done @ 53ee7a9 (lead)
- **Where:** `OpenAICompatRuntime.learn()` and `learnOverflow()`; `estimateRequest()` and `estimateStored()` in `src/runtimes/openai.ts`.
- **Problem:** `learn()` caps the ratio at 2.5 and averages it. For dense scripts such as CJK, the estimate drifts back to about 30% low, and the conversation hits a context error every time it nears the window.
- **Suggested fix:** use the same upper clamp as `learnOverflow` (4) and keep a floor from the last overflow (`q.overflowRatio`). Optionally count non-ASCII characters at about 1 token each.
- **Done when:** a test where an overflow teaches a ratio of about 3.5, followed by successful replies, keeps the ratio at least that high.

### B6. Live check of Featherless, Phala and Routeway

- **Status:** Partly done. Run by the lead on 2026-10-17 in a cloud session, with the owner's keys as network secrets (`npm run live -- --proxy-auth`):
  - **Phala** `phala/qwen3.8-27b-uncensored`: all four checks pass. The catalogue lists 22 models; the test prompt answers in 1.3 s; a bot called `read_file` and reported the word; `git push` stopped for approval.
  - **Routeway** `glm-5.3-flash-uncensored`: all four pass. 290 models; the prompt answers in 2.7 s; tool turn and approval pass.
  - **Featherless** `DavidAU/Qwen3.8-27B-TURBO-Fable-Cold-Fusion-735-882-Heretic-Uncensored-NM-DAU`: three checks pass and one is skipped (rerun with the owner's go-ahead, 2026-10-17).
    - The catalogue loads: 5,000 models, our cap.
    - The model was still cold, so the 20 s test prompt was skipped.
    - The bot turn then waited for the model to load, called `read_file` and replied with the word.
    - `git push` stopped for approval.
    - The model isn't on the catalogue's first page, so the run used the preset's default context window. The live script could look it up the way the editor does (`providerLookup`).
  - Bugs this found, fixed in b84b3d8: Featherless 404s Node's default user agent; HTML error pages were shown as markup; Node's fetch skipped the session proxy.
- **Keys:** `FEATHERLESS_API_KEY`, `PHALA_API_KEY` (base URL `https://inference.phala.com/v1`) and `ROUTEWAY_API_KEY` (`https://api.routeway.ai/v1`). Agents never store keys or ask for them in chat. The owner's `LIVE_MODEL_*` defaults are set as environment variables in the cloud session.
- **Other models the owner can use:**
  - Featherless: `gemma-4-31b-gembrain-uncensored-heretic`, `huihui-ai/Huihui-Qwen3.8-27B-abliterated`, `wangzhang/gemma-4-31B-it-abliterated`, `DavidAU/gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking`.
  - Phala: `phala/gemma-4-26b-a4b-uncensored`.
  - Routeway: `qwen3.8-27b-uncensored`, `gemma-4-31b-gembrain-uncensored-heretic`.
- **The automatic part:** `npm run live` (`scripts/live-providers.ts`).
  - For each provider whose key is set, it checks four things: the catalogue loads, one test prompt answers, a bot reads a file with `read_file` and reports a word only that file holds, and `git push` stops for approval.
  - It prints PASS/FAIL/SKIP lines, never the key, and exits non-zero on a failure.
  - It uses a scratch home, removed afterwards. `npm run live -- featherless` runs one provider.
  - Phala and Routeway have no default model: set `LIVE_MODEL_PHALA` / `LIVE_MODEL_ROUTEWAY` to a model id from their catalogue. Otherwise the script picks a free model that can call tools, if the catalogue has one.
- **Where to run it:**
  - **Simplest:** on the owner's own computer, with the keys exported in that terminal.
  - **In a Claude Code cloud session:** the keys go in that environment's settings (the cloud environment menu in the session title bar → Edit), and only a new session sees them. Keys saved as **network secrets** never appear as environment variables: the session's proxy adds them to requests for their host. Run `npm run live -- --proxy-auth` there (the owner's keys are set up this way since 2026-10-17; the `LIVE_MODEL_*` variables are ordinary environment variables).
  - **Codex's environment:** the lead has no evidence of how it is configured.
- **By hand,** for Featherless, on a scratch home (`node src/cli.ts start --home /tmp/cb-live --runtime mock`). Report each in a worklog, without the key:
  1. Add the Featherless preset; **Save and test** answers.
  2. `npm run doctor` reports the provider and its test prompt.
  3. A bot on Qwen/Qwen3-32B answers a DM, uses `read_file` and `shell`, and stops for approval on `git push`.
  4. A model that isn't loaded shows the "loading… retrying" status and then answers.
  5. Two bots at once with concurrency 4 and a model of cost 2: neither gets a 429; one waits for capacity.
  6. A long conversation compacts, with a "summary" event, and keeps working.
  7. A Kimi-K2 or Llama model in auto tool mode either calls tools natively or switches to text tool calls.
- **Done when:** every step is reported, and each failure is a new backlog item with what was seen.
- **Still to do:** the automatic checks cover step 3 on all three providers. Steps 1–2 (in the app and `npm run doctor`) and 4–7 aren't reported yet.

### B7. Live smoke test with Cursor (needs the owner)

- **Status:** Blocked: needs a Cursor API key (`CURSOR_API_KEY`) in the session environment.
- **Checklist:** the starter team (`--starter`) answers in DMs and a group, a handoff between bots works, an approval card appears for `git push`, and a restart resumes each bot's context.
- **Done when:** results are reported as in B6.

### B8. Smaller known gaps (ask the lead before starting any of these)

- **Status:** Done or decided (2026-10-17). Nothing here is open for work without a new lead decision.
- **Items:**
  - **`CursorRuntime.complete()` ignores the `signal` option.** Done by Codex (owner's pick), reviewed and merged in 2f5feb8.
  - **MCP tool descriptions weren't redacted.** Done @ 1429d06.
  - **`web_fetch` ignores `HTTPS_PROXY`.** Won't fix: pinning the checked address is what stops DNS rebinding. Behind a mandatory proxy, bots use `curl` in the shell (text-gated).
  - **Featherless's unsearched catalogue is only the first page.** Won't fix: the editor shows "narrow the search", and searching (`q=`) reaches every model.
  - **Group routing on a reasoning model is slow.** No code change: the deadline now aborts the call and frees capacity. Recommend setting a fast routing model (Settings → Brain & models → the provider → Routing model), or extra request fields with `{"chat_template_kwargs": {"enable_thinking": false}}` on that model.
  - **Old worktrees in `.claude/worktrees/`.** Removed by the lead.

### B9. Review of the Team MCP endpoint, HTTP API, scheduler and approvals

- **Status:** Done (lead, 2026-10-17, on `claude/bold-knuth-kcf7i1`). See `docs/worklog/2026-10-17-claude-review-api-approvals.md`.
- **Fixed, each with a regression test:**
  - **"Always allow" lapsed after six hours.** @ 0df0339. In auto mode a shell card only appears when an ask rule matches, and ask rules beat allow rules. So the saved rule never applied, and the command ran only on the decision's six-hour grant. An allow rule for exactly that text now beats ask rules.
  - **The file browser.** @ a65e444.
    - A folder with a broken symlink (every browser profile's `SingletonLock`) didn't list.
    - A file whose name isn't Latin-1 couldn't be opened, and the cut-off error reply corrupted the next reply on that connection.
    - A read error after `stat` crashed the gateway.
  - **Team MCP arguments.** @ c049a49. `message_bot` without `text` posted "undefined" as you, and `create_bot` without a name made `@undefined`.
- **Checked and fine:** token and origin checks, webhook keys, the snapshot's masking, approval expiry and waits, routine runs after a stop, restart or deletion, and the Team MCP's reply wait.

## Adding another provider

The owner plans more providers. A new OpenAI-compatible service needs no new code:
1. Add a preset to `PROVIDER_PRESETS` in `src/core/providers.ts`, filling in:
   - `key`, `label`, `baseUrl`, `keyUrl` and `keyEnv`;
   - `maxConcurrency`, `toolMode`, and `maxTokensParam` (OpenAI-style APIs want `max_completion_tokens`);
   - `defaultContextWindow`, starter `models`, and a `note` with any setup advice. The note is shown in the editor.
2. Extend the preset test in `test/providers.test.ts`.
3. Mention it in `README.md` (Other models).

A service that is not OpenAI-compatible (for example the Anthropic Messages API or Gemini's native API) needs a new runtime. Escalate that to the lead first.

## Decisions

The lead records answers to escalated questions here, newest first.

- 2026-10-17: An allow rule whose pattern is exactly one command (`^…$` of the escaped text, which "Always allow" saves) beats ask rules. Broader allow patterns still lose to ask rules. "Always allow" no longer also leaves a six-hour grant, so deleting its rule takes it back.
- 2026-10-17: Won't fix: the default `curl` ask rule and the `/proc/…/environ` check are quadratic on crafted input: 150–190 KB of command text takes about 2–3 s. A model's tool call is rarely that long, and a bot that wants to disrupt the gateway can already do worse with plain commands (`pkill`, a fork bomb).
- 2026-10-17: Won't fix: an upload written through a dangling symlink a bot planted in `uploads/`. Planting it needs the shell, where an obfuscated command could already write the same place.

- 2026-10-17: Phala and Routeway are presets (`PHALA_API_KEY`, `ROUTEWAY_API_KEY`). Routeway asks with `max_completion_tokens`, as its catalogue lists, and the runtime switches per model if needed. No key links are shown, since none were verified.
- 2026-10-17: B8 resolved (see the item). `web_fetch` keeps pinning addresses over proxy support.
- 2026-10-17: Codex's Cursor routing cancellation was accepted. Owner-selected work may skip the "ask the lead first" step; it still comes in on a `codex/` branch for review.

- 2026-10-17: Contributors work on `codex/<topic>` branches; only the lead merges into the integration branch (`docs/COLLABORATION.md`).
- 2026-10-17: Outside prompt mode, a text tool call counts only when the calls end the reply, and a fenced bare-JSON call is an example. Quoted calls never run, in any mode.
- 2026-10-17: Plain `http://` providers are allowed only on this computer and the local network: private, link-local and 100.64/10 addresses, single-label names, `.local`, `.lan` and `.internal`.
- 2026-10-17: A saved provider key is dropped when the provider moves to another host. A preset's environment variable is only sent to that preset's service.
