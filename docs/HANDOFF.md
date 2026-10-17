# Handoff: model providers ("provider brains")

Notes for the next agent (Codex or anyone else) picking up this branch. Read `AGENTS.md` and `docs/ARCHITECTURE.md` §9 first.

## Where things stand

- Branch: `claude/tender-cori-t1ksnz`. Everything is committed and pushed; `npm run typecheck && npm test` is clean (163 tests).
- The feature: bots can run on any OpenAI-compatible chat API (Featherless AI first; OpenRouter, xAI, OpenAI, Groq, Together, DeepInfra, Ollama, LM Studio, or a custom URL), chosen per bot as its "brain". The owner has a Featherless key and wants to run open models such as Qwen3 on it, and add more providers later.
- Not yet done: a run against a real provider. Everything is tested against local fake servers only.

| Piece | File | Tests |
| --- | --- | --- |
| Presets, validation, which hosts count as local | `src/core/providers.ts` | `test/providers.test.ts` |
| Registry, write-only key vault, env keys, `modelFor`, `systemPromptFor` | `src/core/harness.ts` | `test/providers.test.ts` |
| The agent loop: SSE, tool modes, retries, concurrency units, compaction, JSONL transcripts | `src/runtimes/openai.ts` | `test/openai-runtime.test.ts` (fake server: `test/fake-openai.ts`) |
| Shell, file, search and `web_fetch` tools for brains without their own | `src/core/workspace-tools.ts`, `src/core/guard.ts` | `test/workspace-tools.test.ts` |
| MCP client for connectors (stdio, Streamable HTTP, legacy SSE) | `src/core/mcp-client.ts` | `test/mcp-client.test.ts` (fixture: `test/fixtures/fake-mcp-server.mjs`) |
| How a turn uses all of it | `src/core/runner.ts` | `test/provider-e2e.test.ts` (real harness and runtime, fake provider, real MCP fixture) |
| API, CLI, UI | `src/server/http.ts`, `src/cli.ts` (`doctor`, `models --runtime`), `web/app.js` (Settings → Brain & models → Providers) | `test/providers.test.ts` (HTTP API) |

An adversarial review found 32 real defects; 27 are fixed, each with a regression test. The five below are left.

## Open work, in priority order

All five are in `src/runtimes/openai.ts`. For each one, add a regression test in `test/openai-runtime.test.ts` that fails before the fix. Then run the whole suite.

1. **A finished answer can be lost behind the end-of-turn summary** (medium). `turn()` appends the final answer to the transcript, then awaits `compact("end")`, a non-streamed summary call that queues for capacity and can retry for minutes. Until it finishes, `run.wait()` doesn't resolve, so the runner posts nothing. If the user presses Stop then (the bot shows "Compacting…"), or the gateway shuts down, the outcome is `cancelled` with empty text and the answer is never posted, although the transcript says it was given. The same loss happens when a steer arrives while the final answer streams and the follow-up call fails: the outcome is `error` with empty text. Fix: settle the outcome first, then run `compact("end")` in the background with its own AbortController, kept on the session. `OaiSession.send()` awaits it before the next run, and `close()`/`dispose()` abort it. If an error comes after at least one complete answer, return the answers along with the error, and have `Harness.finishRun` post that text.
2. **The reply limit fills the rest of the window** (medium). `replyLimit()` sets max_tokens to `min(outputCap, window - estimate - 3%)`. With a large `maxOutputTokens` (Featherless lists some models with max_completion_tokens equal to their context), an estimate that is more than 3% low overflows. chars/3.5 undercounts code and JSON by about 15%. `learnOverflow()` doesn't parse vLLM's "your request has N input tokens", so the retry is identical and fails. Fix: also parse `/request has (\d+) input tokens/i` and `/\((\d+) of text input/i`. When nothing is learned, raise the ratio anyway (`Math.min(4, ratio * 1.25)`). Cap the reply at about half the window, or use a 10% margin until a ratio has been learned.
3. **Small windows compact every turn** (medium). On 8k windows (the Ollama and LM Studio preset default), the fixed system prompt plus about 29 tool schemas already exceed `promptBudget()`. `fitBudget()` then runs `compact("budget")` on every turn, which doubles the requests and resends identity every turn. The request would have fit with a smaller reply. Fix: estimate the fixed part (system and tools with no history). If too little room is left, skip compaction while the request still fits within `window - MIN_REPLY_TOKENS - margin`, and emit a one-time status saying the window is too small for the tools. Otherwise compact only when the history part exceeds what remains.
4. **Provider fields needed in tool loops are dropped** (medium; from provider docs, not reproduced live). Gemini 3 through its OpenAI-compatible endpoint puts `extra_content.google.thought_signature` on tool calls and rejects the next request without it. OpenRouter sends `reasoning_details`. Fix: keep `extra_content` on streamed tool calls (merge it in `ReplyBuilder.addToolCall()`), carry it through `interpret()`, `normalizeStored()` and `serialize()`, and send it back on assistant tool_calls within the current turn for the same model. Do the same for `reasoning_details`, merged by index. Drop both when `noReasoningEcho` is set or the model changes.
5. **Token-ratio learning undoes what an overflow taught** (low). `learn()` caps the ratio at 2.5 and averages it, so for dense scripts (CJK) the estimate drifts back to about 30% low and the conversation hits a context error each cycle. Fix: use the same upper clamp as `learnOverflow` (4), and keep a floor from the last overflow (`q.overflowRatio`). Optionally count non-ASCII characters at about 1 token each.

## Smaller known gaps (not bugs found by the review)

- `CursorRuntime.complete()` ignores the new `signal` option. The Cursor SDK one-shot has no abort.
- Tool descriptions from MCP servers are cut at 4000 characters but not redacted.
- `web_fetch` connects directly to the address it checked, so it ignores `HTTPS_PROXY`. Behind a mandatory proxy, bots use `curl` in the shell.
- Featherless's catalogue is paginated: without a search term only the first page is read.
- Group routing on a reasoning model (Qwen3 thinks by default) can take most of its 25 s deadline. Setting a small router model, or `{"chat_template_kwargs": {"enable_thinking": false}}` in that model's extra request fields, avoids it.
- `.claude/worktrees/` holds finished, merged worktrees from parallel agents. It's gitignored and safe to delete (`git worktree remove`).

## How to check your work

- `npm run typecheck && npm test`. Everything runs locally against fake servers, with no network or API keys.
- To click through the UI without a key, run `npm run demo`. Then add a provider whose base URL points at a local OpenAI-compatible server. `test/fake-openai.ts` shows the response shapes. Local URLs need no key.
- Rules that matter most here, from `AGENTS.md`:
  - Erasable TypeScript only, with `.ts` imports.
  - `web/` has no dependencies.
  - Anything that could get around approvals (the gateway API, `state/`, tokens, provider keys) must stay blocked by `src/core/workspace.ts` and `Harness.touchesHarness`.
  - Provider keys must never be logged, written to transcripts or messages, returned by the API, or readable through any bot tool.
- Don't commit `node_modules` or `.claude/worktrees/`.

## For the owner, once the code is done

Settings → Brain & models → Providers → Featherless AI → paste the key → **Save and test**. Then set Concurrency to the plan's units (4 on the Chat plan; a 32B model uses 2) and pick a bot's brain in its details. `npm run doctor` sends one test prompt per provider.
