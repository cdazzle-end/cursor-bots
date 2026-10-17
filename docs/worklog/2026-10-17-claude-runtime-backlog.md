# Runtime backlog B1–B5

- Agent: claude (lead)
- Date: 2026-10-17
- Branch: claude/tender-cori-t1ksnz (integration), from 6380c80
- Commits:
  - 0cf2ca6 Post the answer before the end-of-turn summary; keep a complete answer when a follow-up fails
  - d0ba669 Leave the reply room for estimate errors; an overflow always makes the retry ask for less
  - 4622cda Small windows take shorter replies instead of compacting every turn
  - eee8155 Send provider data on tool calls back during the tool loop
  - 53ee7a9 Token estimates keep what an overflow measured; non-ASCII text counts as denser
- Backlog items: B1–B5 (Done)
- Flags: CONTRACT. `RunOutcome.text` is now defined for errors: an answer that was complete before the error, which `finishRun` posts before the error card. `complete()` takes `signal`. `OaiSession.settled()` is internal, for tests.

## What changed
- **B1.**
  - The end-of-turn summary runs in the background after the outcome settles. The next `send()` and `close()` stop it, and every summary carries the latest identity block.
  - An error after a complete answer keeps that answer. The Cursor adapter returns no text on errors, as before.
- **B2.** Replies are capped at half the window, with a 10% margin until the estimate is calibrated. More overflow messages are parsed; when none can be parsed, the ratio is raised 25%.
- **B3.** When instructions and tools leave less than 15% of the window, the bot takes shorter replies instead of compacting every turn, compacts at the end only when the next request wouldn't fit, and warns once per session.
- **B4.** `extra_content` on tool calls and `reasoning_details` are stored and sent back within the turn's tool loop, and dropped if the server rejects them.
- **B5.** Learned token ratios never drop below what an overflow measured, and are clamped at 4. Non-ASCII characters count as about a token each.

## How it was verified
- `npm run typecheck && npm test`: 170 tests, all passing.
- Each item has regression tests that fail with the old code and pass with the new: I reverted the source file, ran the tests (they fail), and re-applied the change.
  - B1: three tests (runtime and harness).
  - B2–B5: one test each.
- `test/openai-runtime.test.ts`: the `turn()` helper now also awaits `session.settled()`, because the summary arrives after the outcome.

## Not verified / assumptions
- B4 follows the documented Gemini and OpenRouter shapes; no live call was made.
- Featherless and Cursor are still untested against the real services (B6, B7).

## Questions for the lead
None (lead entry).

## Next step
- B6 and B7 when the owner provides keys.
- B8 is a list of small items, each with a decision noted in `docs/HANDOFF.md`.
