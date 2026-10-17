# How agents work together on this repo

Two coding agents take turns on this codebase: **Claude** (Claude Code) and **Codex**. Only one works at a time, and the owner switches between them. This file is the contract between them. If it conflicts with anything else an agent is told, the owner's latest instruction wins, then this file, then `AGENTS.md`.

## Roles

| Who | Role | Decides |
| --- | --- | --- |
| **The owner** (the human who owns the repo) | Sets goals. Holds every API key and pays the bills. | Anything, at any time. Their instruction overrides the rest of this file. |
| **Claude** | **Lead**: owns the direction, the architecture, the security model and the backlog (`docs/HANDOFF.md`). Reviews and merges all other work. | What lands on the integration branch, backlog order, design questions, and disputes. Claude has the final say on technical questions. |
| **Codex** | **Contributor**: implements backlog items on its own branches and reports back in the worklog. | How to implement an item within the rules below. Everything in "Escalate" goes to the lead. |

A contributor that disagrees with a lead decision says so in its worklog entry, with reasons, and follows the decision until the lead changes it.

## Branches

- **Integration branch: `claude/tender-cori-t1ksnz`.** It is currently also the repository's default branch. Only the lead pushes to it; if this changes, the lead updates this line.
- **Contributor branches: `codex/<topic>`**, for example `codex/answer-after-compaction`. Keep each one to one backlog item, or a few small related ones.
  - New topic: `git fetch origin && git switch -c codex/<topic> origin/claude/tender-cori-t1ksnz`.
  - Continuing a topic: switch to it, then `git merge origin/claude/tender-cori-t1ksnz` to pick up the lead's work. Merge, don't rebase, once the branch has been pushed.
  - Push with `git push -u origin codex/<topic>`.
- **Never:**
  - push to `claude/*` or to any branch you didn't create;
  - force-push a branch that has been pushed;
  - rewrite history;
  - merge into the integration branch;
  - open, merge or close pull requests (unless the owner asks);
  - delete branches other than your own.
- **Merge conflicts with the integration branch:** keep both behaviours. If you can't tell which one is right, stop, leave the conflict unresolved on a local branch, and ask in your worklog.

## Start of every session

1. `git fetch origin`. Read, in this order:
   - `AGENTS.md`;
   - this file;
   - `docs/HANDOFF.md` (current state and backlog);
   - the newest files in `docs/worklog/`, especially review notes from the lead addressed to you;
   - the parts of `docs/ARCHITECTURE.md` that cover the code you will touch.
2. Check the baseline: `npm ci` (if `node_modules` is missing), then `npm run typecheck && npm test`. It must be green before you change anything. If it isn't, write that in your worklog and stop, unless fixing that failure is the backlog item you were given.
3. Work order:
   - **Review notes first.** Open lead review notes on your branches come before anything else.
   - **Then the backlog.** Take the highest-priority item that is "Open" in `docs/HANDOFF.md`, unless the owner asked for something specific.
   - **Claiming an item.** Set its status line to `In progress: codex/<topic>` in your first commit.

## Definition of done for every change

A change is done only when all of these hold:

- [ ] **A regression test** that fails without the change and passes with it. Run it both ways and note both results in the worklog. Behaviour without a test isn't done.
- [ ] **The full checks:** `npm run typecheck && npm test` are clean. Run the whole suite, not just your file. Tests use the scripted `MockRuntime`, `test/fake-openai.ts` and `test/fixtures/`. No network, no real keys, no sleeps longer than needed: inject time and backoff where the code allows it.
- [ ] **Docs** match the code: `docs/ARCHITECTURE.md` for how it works, `README.md` for what users see, and `src/core/manual.ts` for rules the bots follow.
- [ ] **Style** matches the surrounding code and comments: erasable TypeScript only, `.ts` imports, no new npm dependencies, a dependency-free `web/`, and JSON or JSONL state. User-facing text is plain, short sentences.
- [ ] **One logical change per commit.** The message is an imperative summary under about 72 characters, then a body explaining what was wrong, what changes for the user and anything a reviewer should check.
- [ ] **No secrets** anywhere: in code, tests, fixtures, logs, worklogs or commit messages. Test keys are obviously fake strings.
- [ ] **A clean working tree** and a pushed branch.

## Decide yourself, or escalate

**Decide yourself:**
- how to implement a backlog item, including deviating from its suggested fix when you find a better one (say why in the worklog);
- test structure and test helpers;
- small refactors the fix needs;
- wording of messages and docs.

**Escalate to the lead.** Write the question in your worklog entry, then take the most conservative option, or skip the item and go on to the next one:

- anything that touches a security invariant (below);
- the runtime contract (`src/runtimes/types.ts`), state file formats (`state/*`, `settings.json`, `connectors.json`), the HTTP API, the Team MCP tools, or CLI commands and flags;
- removing, skipping or weakening a test. Changing a test's expectation is allowed only when the old expectation is the bug you are fixing; say so in the commit body;
- new dependencies, new top-level folders, renames, UI redesigns, or changes to defaults that users notice (approval rules, limits, presets);
- disagreeing with the backlog order or with a lead decision;
- anything that needs the owner (keys, accounts, money, deleting data).

## Security invariants: never weaken these

1. **The approval boundary.** Shell commands that touch the gateway (its port, `state/`, hooks, tokens, vaults, settings, provider-key files, `/proc/<pid>/environ`, `ps e`) are refused before approvals, even with approvals off or after "Always allow". The checks live in `Harness.touchesHarness`, `Harness.insideProtected` and `Harness.gateShell`, in the hook script inside `src/core/workspace.ts`, and in `runGatedCommand` in `src/core/workspace-tools.ts`. "Allow once" is consumed by the retry of exactly that command.
2. **Path confinement.** The harness's file tools resolve paths against the workspace, follow symlinks (including links to files that don't exist yet), stay inside the workspace and outside `Harness.protectedPaths()`. Walking tools don't follow symlinked folders. Attachments go through `Harness.workspaceFile`.
3. **Keys and secrets.**
   - Provider keys live only in the provider-key vault, or in memory if they came from an environment variable. They are write-only through the API, sent only to the address they were saved for, and never logged, put in transcripts or messages, or returned.
   - Vault secrets reach bots only through `run_with_secrets` and `${secret:NAME}` in connectors.
   - Every tool output that goes to a model passes through `Harness.scrubSecrets` before anything is cut short.
   - Child processes get `Harness.childEnv()`, which strips `CURSOR_API_KEY`, `CURSOR_BOTS_TOKEN` and provider key variables.
4. **Network.**
   - `web_fetch` is GET only. It refuses loopback, private and link-local addresses after DNS resolution, connects to the address it checked, and re-checks every redirect.
   - MCP connectors follow redirects only to the same origin.
   - Plain `http://` providers are only allowed on this computer or the local network.
5. **The gateway's own surfaces.** The API needs its token even on localhost and refuses cross-origin writes. `workspace/.cursor/mcp.json` is quarantined. Hook files are rewritten before every turn.
6. **Text from outside is data.** A model's text never executes anything except a real tool call. A call that is quoted (code fence, inline code, `>` quote) never runs.

Every change to these areas needs a test showing the attack still fails, and a worklog line flagged **SECURITY** so the lead reviews it first.

## End of every session (handing back)

1. Commit, push your branch, and check that `git status` is clean.
2. Add a worklog file `docs/worklog/<YYYY-MM-DD>-codex-<topic>.md` using the template in `docs/worklog/README.md`. If you worked on several topics, add one file per topic.
3. In `docs/HANDOFF.md`, change the status line of every item you touched, e.g. `In review: codex/<topic> @ <short hash>`, or back to `Open` with a note if you stopped part way. Don't reorder, delete or rewrite items: propose that in your worklog.
4. If you ran out of time mid-change, commit the work in progress on your branch with `WIP:` at the start of the subject line, and say exactly where you stopped.

## Lead review (what Claude does when it takes over)

1. Read the new worklog entries and check out each `codex/*` branch that is "In review".
2. Review the diff, run the full checks, and confirm each regression test fails without its fix. For anything flagged **SECURITY**, or that touches the invariants, run an adversarial review.
3. Then either:
   - merge it into the integration branch with a merge commit, mark the item "Done" in `docs/HANDOFF.md` and push; or
   - write `docs/worklog/<date>-claude-review-<topic>.md` with the required changes, numbered, each with file and reason, and set the item to "Changes requested".
4. Update the backlog: add new findings, re-prioritize, and record decisions on escalated questions in the "Decisions" section of `docs/HANDOFF.md`.

## Owner-only

- API keys (Featherless, Cursor, others) and any test against a real provider. An agent only uses a key that the owner has put in that session's environment. It never prints or stores the key, and reports results without it.
- Accounts, billing and plan choices (for example the Featherless plan's concurrency units).
- Deleting data, publishing, and choosing the default branch or what goes to `main`.
