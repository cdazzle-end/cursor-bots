# Worklog

One file per session and topic, so agents taking turns never conflict on a shared file. Name files `<YYYY-MM-DD>-<agent>-<topic>.md`, e.g. `2026-10-18-codex-answer-after-compaction.md`. Lead reviews are `<YYYY-MM-DD>-claude-review-<topic>.md`. Never edit another agent's entry; write a new one that refers to it.

## Template

```markdown
# <topic>

- Agent: codex | claude
- Date: YYYY-MM-DD
- Branch: codex/<topic>, from claude/tender-cori-t1ksnz @ <hash>
- Commits: <hash> <subject> (one line each)
- Backlog items: B<n> (status now: In review | Open | Blocked)
- Flags: SECURITY | CONTRACT | NONE (SECURITY = touches an invariant in docs/COLLABORATION.md; CONTRACT = runtime contract, state formats, API, CLI)

## What changed
What was wrong, what changes for users or bots, and the main code paths touched.

## How it was verified
- `npm run typecheck && npm test`: <N> tests, all passing.
- Regression tests: <name> fails without the change (<how you checked>) and passes with it.
- Anything run by hand (the app, a browser check), with results.

## Not verified / assumptions
What you couldn't check and why (no key, no network, behaviour taken from docs).

## Deviations from the backlog's suggested fix
What you did differently, and why.

## Questions for the lead
Numbered. For each: what you did in the meantime (the conservative option, or skipped).

## Next step
Where to pick up, and what you would do next.
```
