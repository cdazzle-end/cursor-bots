# Cursor routing cancellation

- Agent: codex
- Date: 2026-10-17
- Branch: codex/cursor-routing-cancellation, from claude/tender-cori-t1ksnz @ ec0c5fd
- Commits:
  - c8d5f06 Claim the Cursor routing cancellation item in B8
  - c9cac02 Cancel Cursor routing completions when their deadline expires
- Backlog items: B8, Cursor cancellation only (status now: In review)
- Flags: CONTRACT (fulfills the existing `complete()` signal option; the runtime interface is unchanged)

## What changed

The harness already aborts model routing after 25 seconds, but Cursor's adapter ignored that signal. The owner explicitly selected this B8 item after the session identified its lead-decision requirement.

`CursorRuntime.complete()` now rejects with `AbortError` promptly when its caller aborts. An already-aborted request starts no SDK work. Aborting during SDK loading or store opening prevents subsequent setup; an agent returned after cancellation is closed and deleted. An active or late SDK run is cancelled, even when cancellation does not settle `wait()`. Scratch-agent cleanup and abort-listener removal also cover normal answers and send/wait failures.

The SDK has no abort option on setup or send, so `routingStep()` stops waiting and retains cleanup callbacks for late results. README and architecture documentation now describe the routing deadline, fallback and cleanup. No bot-tool behavior changed, so the manual needed no update.

## How it was verified

- Fetched origin and confirmed the integration branch matches the handoff at ec0c5fd.
- Installed dependencies with `npm ci --cache /tmp/cursor-bots-npm-cache --no-audit --no-fund`; the writable cache avoids the environment's unavailable default npm cache.
- Baseline `npm run typecheck && npm test`: 170 tests, all passing.
- Before applying the source fix, `node --test test/cursor-runtime.test.ts` with the new tests reported 7 passing and 7 failing counted tests. The six abort scenarios failed, plus their setup parent test; normal completion and error cleanup passed.
- With the fix, the focused file passes all 14 counted tests. Deferred fake-SDK promises cover cancellation before startup and during load, store, create, send and wait, plus late resources, errors and listener removal. No timing sleeps or live services are used.
- Final `npm run typecheck && npm test`: 181 tests, all passing.
- `git diff --check`: clean.
- A separate read-only review checked microtask ordering, late cleanup ownership and SDK cancel/close compatibility and found no actionable issues.

## Not verified / assumptions

- No live Cursor or Featherless call was made: neither `CURSOR_API_KEY` nor `FEATHERLESS_API_KEY` is configured. B6 and B7 remain blocked.
- SDK setup/send cannot be interrupted through its public API. Their late results are cleaned up; SDK run cancellation and agent deletion remain best-effort operations, as deletion was before this change.

## Deviations from the backlog's suggested fix

B8 lists the gap without prescribing an implementation. The fix honors the already-declared signal contract without changing runtime types, defaults, dependencies or state formats.

## Questions for the lead

None for this fix: the owner selected Cursor routing cancellation. The other B8 items still need the lead's decisions.

## Next step

Claude should review c9cac02 and this branch's handoff notes, run the checks, and merge under the collaboration contract. Keep B8 open for its remaining gaps after the cancellation item lands. Run B6/B7 only when the owner configures the respective session keys.
