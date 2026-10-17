# Featherless live check, and a review of the API, Team MCP, scheduler and approvals

- Agent: claude (lead)
- Date: 2026-10-17
- Branch: claude/bold-knuth-kcf7i1, from claude/tender-cori-t1ksnz @ b779e27
- Commits:
  - 0df0339 Always allow keeps a command allowed past the six-hour grant
  - a65e444 Files: list folders with broken links, open any file name, survive read errors
  - c049a49 Team MCP: refuse calls that leave out a required argument
  - plus this entry and the handoff update
- Backlog items: B6 (automatic checks done on all three providers; manual steps still open), B9 (new, Done)
- Flags: SECURITY (0df0339 changes how approval rules combine; see below)

## What changed
- **B6, Featherless.** The owner allowed one more live run (Featherless only). `npm run live -- --proxy-auth featherless` gave 4 PASS, 1 SKIP and 0 FAIL. The model was cold, so the 20 s test prompt was skipped. The bot turn then waited for the model, called `read_file`, replied with the word, and `git push` stopped for approval.
- **The owner picked the next work:** a review of the parts without a focused review since provider brains landed. Those are the Team MCP endpoint, the HTTP API, the scheduler and approvals.
- **Always allow (SECURITY).**
  - The problem:
    - In auto mode a shell command only gets a card when an ask rule matches (`git push`, `sudo`…).
    - "Always allow" saved an allow rule for that exact command, but ask rules beat allow rules, so the rule was dead on arrival.
    - The command only ran because `consumeGrant` honours any allowed decision for six hours. After that it asked again under a card that said "Always allowed".
  - The fix:
    - An allow rule whose pattern is exactly `^<escaped text>$` now wins over ask rules.
    - "Always allow" no longer leaves a grant behind, so deleting its rule takes it back at once.
  - What still asks: broader allow patterns still lose to ask rules, and any other spelling of the command still asks, including a different letter case, extra flags or a `;` tail.
- **The Files browser (`/api/files`, `/api/files/raw`):**
  - A broken symlink made its whole folder 404. Every bot's browser profile has one (Chromium's `SingletonLock`).
  - Non-Latin-1 file names (报告.md, emoji) couldn't be opened. The failed `writeHead` left the file's `content-length` on the error reply, which cut it short, and the leftover bytes corrupted the next reply on that keep-alive connection. Names now go out as an ASCII fallback plus `filename*=UTF-8''…`.
  - A read error after `stat` was an unhandled stream `error` that crashed the gateway. Examples: an unreadable file when the gateway isn't root (files from `sudo` or Docker), or a link to `/proc/self/mem`.
    - The file is now opened before the reply starts, non-blocking so a FIFO can't hang the gateway, and checked with `fstat`.
    - It's streamed with `pipeline`, so a later error or a viewer who leaves closes it.
- **Team MCP.** `message_bot` without `text` posted "undefined" as you, and `create_bot` without `name` or `job` made `@undefined`. Missing values are now a tool error.

## How it was verified
- `npm run typecheck && npm test`: 185 tests, all passing (182 at the start).
- Every regression test was run against the old code and failed:
  - **Always allow** (`test/regressions.test.ts`): with `approvals.ts` reverted it fails at "a day later … allow" (got deny). It also checks:
    - other spellings and a broad allow rule still ask;
    - deleting the rule right after the decision asks again.
  - **Files** (`test/server.test.ts`): I reverted each fix on its own:
    - the old listing fails with 404;
    - the old `Content-Disposition` fails with 400;
    - the old `.pipe()` fails with an uncaught EIO.
    The `/proc/self/mem` part only runs where that file exists (Linux).
  - **Team MCP arguments** (`test/server.test.ts`): fails with the old `mcp.ts` (no `isError`).
- **Adversarial pass on 0df0339:**
  - Bots can't add rules, because `settings.json` is protected.
  - `touchesHarness` and the protected-cwd check still run before `evaluate()`, both in `gateShell` and in `runGatedCommand`.
  - The exact match compares pattern strings, so it can't widen to anything but that one text.

## Checked and found fine
- API token and origin checks, the cookie, webhook keys, the snapshot's masking of connector env and headers, and settings validation of rule patterns.
- Approval expiry, inline waits and `releaseStopped`.
- Routine runs: every runner path (stop, a stale wake, an error, bot deletion) resolves `whenDone`, and a restart reconciles "running" runs.
- `web_fetch` decompression errors are handled.
- The Team MCP's reply wait across chained replies.

## Not fixed (decisions in `docs/HANDOFF.md`)
- **Quadratic regexes on crafted commands.** The default `curl` ask rule takes 1.8 s on 156 KB of `curl curl …`, and the `/proc/…/environ` check takes 2.9 s on 188 KB of `/proc//proc/…`. A model's tool call is rarely that long, and a bot that wants to disrupt the gateway can already run `pkill` or a fork bomb, so the fix isn't worth its code.
- **Uploads through a planted dangling symlink.** `saveUpload` would write through a symlink a bot planted in `uploads/<day>/`. Planting it needs the shell, where an obfuscated command can already write the same place.

## Not verified / assumptions
- Only Featherless was run live this session, as the owner asked. B6's manual steps weren't run.
- The `Content-Disposition` form follows RFC 6266. I didn't check how each browser shows the name.

## Questions for the lead
None (lead entry). For the owner: should this branch be merged into `claude/tender-cori-t1ksnz`? It's a fast-forward.

## Next step
- B6's manual steps when the owner allows more live tests, B7 when a Cursor key is set.
- Small follow-up: make the live script look a model up (`providerLookup`) when it isn't on the catalogue's first page, so the run uses the model's real context window.
