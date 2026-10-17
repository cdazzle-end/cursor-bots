# Working on this repo

Cursor Bots is a Grok-Bot-style harness on the Cursor SDK (bots can also run on any OpenAI-compatible model API). Read `docs/ARCHITECTURE.md` before changing behavior.

## Two agents share this repo

Claude (Claude Code) and Codex take turns on this code. **Claude is the lead and has the final say**; Codex contributes. The full contract is `docs/COLLABORATION.md`; read it before your first change. The essentials:

- **Every session starts the same way.** Read this file, `docs/COLLABORATION.md`, `docs/HANDOFF.md` (state and backlog) and the newest entries in `docs/worklog/`. Then get a green baseline (`npm run typecheck && npm test`) before changing anything.
- **Branches.** Codex works only on `codex/<topic>` branches made from `claude/tender-cori-t1ksnz`. Never push to `claude/*`, never force-push, never merge into the integration branch, never open or merge pull requests unless the owner asks. The lead reviews and merges.
- **What to work on.** First the lead's open review notes, then the top "Open" item in `docs/HANDOFF.md`. Mark it `In progress: codex/<topic>` in your first commit.
- **Done means:**
  - a regression test that fails without the change;
  - the full suite green;
  - docs updated;
  - no secrets;
  - the branch pushed and a worklog entry written (template in `docs/worklog/README.md`).
- **Escalate instead of deciding** when a change touches the security invariants, the runtime contract, state formats, the API or CLI, tests' expectations, dependencies, or defaults users notice. Write the question in your worklog and take the conservative option.

## Code rules

- TypeScript runs directly on Node 22.18+ (type stripping): use erasable syntax only (no enums, namespaces or constructor parameter properties) and import local files with the `.ts` extension.
- `web/` is plain ES modules with no build step. Keep it dependency-free.
- State lives in files under the home directory (`src/core/paths.ts`). Keep it JSON or JSONL and human-readable.
- New bot capabilities go in `src/core/tools.ts` as harness tools. Their behavior rules go in the manual (`src/core/manual.ts`).
- Anything a bot could use to get around approvals (gateway API, `state/`, tokens, provider keys) must stay blocked by the hooks in `src/core/workspace.ts` and `Harness.touchesHarness`. The full list of invariants is in `docs/COLLABORATION.md`.
- Check with `npm run typecheck && npm test`. Tests use the scripted `MockRuntime`; `test/cursor-runtime.test.ts` covers the Cursor adapter against a fake SDK.

This file is for agents editing this codebase. The house rules for *your bots* live in `~/.cursor-bots/workspace/AGENTS.md`.
