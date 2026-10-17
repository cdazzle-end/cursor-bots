# Handoff: current state and backlog

The lead (Claude) maintains this file. Contributors change only the **Status** line of items they work on (see `docs/COLLABORATION.md`). Read `AGENTS.md` and `docs/COLLABORATION.md` first.

## Current state

Last updated by the lead on 2026-10-17, at integration-branch commit `738250c` plus this documentation.

- **Integration branch:** `claude/tender-cori-t1ksnz` (also the default branch). `npm run typecheck && npm test` is clean, with 163 tests.
- **What the product is.** A self-hosted, Grok-Bot-style team of persistent AI bots:
  - each bot has its own chat, memory, skills, routines and approvals;
  - bots message each other and work in groups;
  - other agents can reach the team over the Team MCP endpoint.

  See `README.md` and `docs/ARCHITECTURE.md`.
- **What was built most recently: provider brains.** Bots can run on any OpenAI-compatible chat API instead of the Cursor SDK. The first target is Featherless AI; OpenRouter, xAI, OpenAI, Groq, Together, DeepInfra, Ollama, LM Studio and custom URLs are presets too. The owner has a Featherless key and wants to run open models such as Qwen3 on it, then add other providers.
- **Never run against a real service.** Neither the Cursor runtime nor the provider runtime has been run against a real service; all testing used local fakes (see B6 and B7).
- **Review status.** An adversarial review of provider brains found 32 confirmed defects; 27 are fixed with regression tests. The open ones are B1–B5.

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

- **Status:** Done (lead; the commit "Token estimates keep what an overflow measured")
- **Where:** `OpenAICompatRuntime.learn()` and `learnOverflow()`; `estimateRequest()` and `estimateStored()` in `src/runtimes/openai.ts`.
- **Problem:** `learn()` caps the ratio at 2.5 and averages it. For dense scripts such as CJK, the estimate drifts back to about 30% low, and the conversation hits a context error every time it nears the window.
- **Suggested fix:** use the same upper clamp as `learnOverflow` (4) and keep a floor from the last overflow (`q.overflowRatio`). Optionally count non-ASCII characters at about 1 token each.
- **Done when:** a test where an overflow teaches a ratio of about 3.5, followed by successful replies, keeps the ratio at least that high.

### B6. Live smoke test with Featherless (needs the owner)

- **Status:** Blocked: needs the owner's key in the session environment (`FEATHERLESS_API_KEY`). Agents never store it.
- **Checklist,** to run on a scratch home (`node src/cli.ts start --home /tmp/cb-live --runtime mock`), and to report in a worklog without the key:
  1. Add the Featherless preset; **Save and test** answers.
  2. `npm run doctor` reports the provider and its test prompt.
  3. A bot on Qwen/Qwen3-32B answers a DM, uses `read_file` and `shell`, and stops for approval on `git push`.
  4. A model that isn't loaded shows the "loading… retrying" status and then answers.
  5. Two bots at once with concurrency 4 and a model of cost 2: neither gets a 429; one waits for capacity.
  6. A long conversation compacts, with a "summary" event, and keeps working.
  7. A Kimi-K2 or Llama model in auto tool mode either calls tools natively or switches to text tool calls.
- **Done when:** every step is reported, and each failure is a new backlog item with what was seen.

### B7. Live smoke test with Cursor (needs the owner)

- **Status:** Blocked: needs a Cursor API key (`CURSOR_API_KEY`) in the session environment.
- **Checklist:** the starter team (`--starter`) answers in DMs and a group, a handoff between bots works, an approval card appears for `git push`, and a restart resumes each bot's context.
- **Done when:** results are reported as in B6.

### B8. Smaller known gaps (ask the lead before starting any of these)

- **Status:** Open, but each needs a lead decision first.
- **Items:**
  - `CursorRuntime.complete()` ignores the new `signal` option.
  - Tool descriptions from MCP servers are cut at 4000 characters but not redacted.
  - `web_fetch` ignores `HTTPS_PROXY`, because it pins the checked address. Behind a mandatory proxy, bots fall back to `curl`.
  - Without a search term, only the first page of Featherless's catalogue is read.
  - Group routing on a reasoning model (Qwen3 thinks by default) can take most of its 25 s deadline. Possible preset change: a routing model, or `{"chat_template_kwargs": {"enable_thinking": false}}` for routing calls.
  - `.claude/worktrees/` holds old, merged worktrees from parallel agents. It's gitignored; remove them with `git worktree remove`.

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

- 2026-10-17: Contributors work on `codex/<topic>` branches; only the lead merges into the integration branch (`docs/COLLABORATION.md`).
- 2026-10-17: Outside prompt mode, a text tool call counts only when the calls end the reply, and a fenced bare-JSON call is an example. Quoted calls never run, in any mode.
- 2026-10-17: Plain `http://` providers are allowed only on this computer and the local network: private, link-local and 100.64/10 addresses, single-label names, `.local`, `.lan` and `.internal`.
- 2026-10-17: A saved provider key is dropped when the provider moves to another host. A preset's environment variable is only sent to that preset's service.
