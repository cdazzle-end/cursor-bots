# Working on this repo

Cursor Bots is a Grok-Bot-style harness on the Cursor SDK. Read `docs/ARCHITECTURE.md` before changing behavior.

- TypeScript runs directly on Node 22.18+ (type stripping): use erasable syntax only (no enums, namespaces or constructor parameter properties) and import local files with the `.ts` extension.
- `web/` is plain ES modules with no build step. Keep it dependency-free.
- State lives in files under the home directory (`src/core/paths.ts`). Keep it JSON or JSONL and human-readable.
- New bot capabilities go in `src/core/tools.ts` as harness tools. Their behavior rules go in the manual (`src/core/manual.ts`).
- Anything a bot could use to get around approvals (gateway API, `state/`, tokens) must stay blocked by the hooks in `src/core/workspace.ts` and `Harness.touchesHarness`.
- Check with `npm run typecheck && npm test`. Tests use the scripted `MockRuntime`; `test/cursor-runtime.test.ts` covers the Cursor adapter against a fake SDK.

This file is for agents editing this codebase. The house rules for *your bots* live in `~/.cursor-bots/workspace/AGENTS.md`.
