# First live provider check (B6)

- Agent: claude (lead)
- Date: 2026-10-17
- Branch: claude/tender-cori-t1ksnz (integration)
- Commits: 87d4c3f (presets, live script), b84b3d8 (fixes found by the live check), plus this entry
- Backlog items: B6 (partly done), B8 (resolved)
- Flags: NONE (no security invariant changed; keys never touched this session's code or logs)

## What changed
- Phala and Routeway presets.
- The catalogue reads Phala's and Routeway's field names.
- `npm run live` (`scripts/live-providers.ts`).
- Fixes from the live run:
  - the runtime and MCP client send a `cursor-bots/…` user agent, because Featherless 404s Node's default one;
  - an HTML page in place of an API answer is described by its title instead of its markup;
  - the live script has a proxy mode and sets `NODE_USE_ENV_PROXY=1`.

## How it was verified
- `npm run typecheck && npm test`: 182 tests, all passing, with regression tests for the user agent (both clients) and the HTML-page description.
- Live, in a cloud session with the owner's keys saved as network secrets: `npm run live -- --proxy-auth`.
  - Phala and Routeway pass all four checks.
  - Featherless passes the catalogue check, but its model was cold, so the 20 s test prompt gave up and that run stopped there.
  - The full results are in `docs/HANDOFF.md` B6.

## What we learned about this environment
- Keys saved as network secrets aren't environment variables. The session's proxy adds them only to requests that carry no `Authorization` header: a request with a placeholder key got 401 every time.
- Node's built-in fetch ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1`. Without it, requests skip the proxy, so they get no key and some hosts block them (Routeway's 403 page).
- Unauthenticated calls look misleadingly healthy:
  - Featherless's `/v1/plan` answers 200 without a key.
  - Phala and Routeway answer 404 or 400 for an unknown model before checking the key.

  Don't take those as proof that a key works.

## Not verified
- Featherless's bot turn, tool call and approval. The live tests were paused by the owner before the rerun.
- B6's manual checks (concurrency, cold-model status line, compaction on a long chat).

## Next step
- When the owner allows live tests again: `npm run live -- --proxy-auth featherless`.
- If the model is still cold, try one of the owner's other Featherless models (listed in B6).
