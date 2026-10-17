# Provider brains: build, review, fixes

- Agent: claude (lead)
- Date: 2026-10-14 to 2026-10-17
- Branch: claude/tender-cori-t1ksnz (integration)
- Commits: 87604eb..738250c (scaffold, providers, MCP client, runtime, workspace tools, e2e test, review fixes), plus this documentation
- Backlog items: built the feature; B1–B8 are left
- Flags: SECURITY (approval boundary, key handling, path checks, network rules all changed in this work)

## What changed
- **Provider brains.** Any OpenAI-compatible chat API can be a brain, chosen per bot. The harness supplies everything Cursor normally brings, which a plain API lacks:
  - the system prompt: the manual, `workspace/AGENTS.md`, rules and the skills index;
  - workspace tools: shell, files, search and `web_fetch`, all behind the same approval gate;
  - an MCP client for connectors;
  - the runtime's own transcript and compaction.
- **Keys.** Keys go in a separate write-only vault, or come from an environment variable that is read once. They are scrubbed from every tool output and tied to the host they were saved for.
- **Review.** An adversarial review (five dimensions, each finding checked by a skeptic) confirmed 32 defects. 27 are fixed, each with a test that fails without the fix, including:
  - quoted tool calls that ran;
  - env keys that weren't scrubbed;
  - stop during connector start;
  - secrets cut before scrubbing;
  - think-tag handling;
  - end-of-turn compaction losing the finished turn.
- **Collaboration setup:** `docs/COLLABORATION.md`, the backlog in `docs/HANDOFF.md`, and this worklog folder.

## How it was verified
- `npm run typecheck && npm test`: 163 tests, all passing.
- A browser walk-through (Playwright on Chromium) of Settings → Brain & models against a local fake Featherless server:
  1. add the preset;
  2. paste the key without clicking Save key;
  3. search the catalogue;
  4. add a model by id (the lookup fills in its context size);
  5. Save and test;
  6. add a custom provider by URL;
  7. chat with a bot on the provider.

  All steps passed, with no console errors.

## Not verified / assumptions
- Nothing has run against a real provider or a real Cursor key (B6, B7).
- Featherless behaviour comes from its docs and an earlier research pass: cold models answer 400 while loading, 429 means the concurrency budget is used up, and tool use is documented for Qwen3 and Kimi-K2.
- The Gemini and OpenRouter tool-loop fields (B4) also come from docs.

## Questions for the lead
None; this entry is the lead's.

## Next step
B1 (answers lost behind end-of-turn compaction), then B2–B5, in order.
