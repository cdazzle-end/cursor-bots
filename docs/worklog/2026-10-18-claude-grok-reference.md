# The owner's Grok Bot export as reference, and a Featherless retry fix

- Agent: claude (lead)
- Date: 2026-10-18
- Branch: claude/bold-knuth-kcf7i1, from claude/tender-cori-t1ksnz @ 919a54f
- Commits:
  - a948994 Retry Featherless "temporarily at capacity" errors sent inside the stream
  - plus this entry, `docs/RESEARCH.md` §6 and the handoff update
- Backlog items: B10 (new, Done), B11–B14 (new proposals, waiting for the owner)
- Flags: NONE

## What changed
- The owner shared three things in their Google Drive:
  - their Grok Bot export: bot profiles, groups, their skills and Grok Bot's built-in skills, with secrets left out;
  - a generated index of those skills;
  - the code and live logs of an earlier attempt at this project, built by their Grok bots on Hermes Agent.
- I read them through the Drive connector and kept notes outside the repo. This repo is public, so only design facts went in, in my own words, as `docs/RESEARCH.md` §6. None of the owner's bot instructions, none of Grok Bot's skill text, and no paths or ids.
- **B10.** The earlier attempt's live logs show Featherless accepting a request, then sending "*model* is temporarily at capacity" as an error frame in the stream. `classifyError` treated that as fatal. Capacity wording with no status or a 5xx is now "unavailable", retried three times with backoff.
- **Proposals for the owner** (B11–B14): import a Grok Bot team; a tool for one bot to update another's job; Grok Bot's routine conventions; and a live check of Featherless context windows plus a fallback model.

## How it was verified
- `npm run typecheck && npm test`: 186 tests, all passing.
- New test "Featherless 'temporarily at capacity' inside a 200 stream is retried like a 503". It fails with the old `openai.ts` (the outcome is `error`) and passes with the fix. Two new classification assertions behave the same way.

## What the reference showed that we already do
- Our request prefix stays stable: the system prompt has nothing that changes each turn, and per-turn context goes in the user message. That suits Featherless's prefix caching, which served 94–100% of prompt tokens from cache in those logs.
- A model's context window can be raised by hand in the provider editor.
- A bot can send its user a private note during a group turn (`send_message` to `@user`).

## Not verified / assumptions
- Whether Featherless serves more than a model's listed context window: no live request was made.
- Featherless's exact error frame fields (`code`, `type`). The logs show only the message, so the fix keys on the wording.
- I read about 30 of the export's 342 files: every bot profile with instructions, the group files, the settings, and the built-in skills about harness behaviour. I skipped the site playbooks, the plugin skills and the owner's image-generation playbook.

## Questions for the owner
1. Which of B11–B14 to build first. B11 (import your Grok Bot team) looks the most useful to you.
2. Grok Bot keeps an "app UI map" for its bots at `/home/box/reference/app-ui.md`, with more files beside it. A bot could copy that folder to your Drive the same way as the setup files. It's likely the most accurate description of Grok Bot's interface there is.

## Next step
The owner's pick from B11–B14. B6's remaining manual checks and B7 still need live tests and a Cursor key.
