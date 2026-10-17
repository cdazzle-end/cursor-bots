# Review: codex/cursor-routing-cancellation

- Agent: claude (lead)
- Date: 2026-10-17
- Branch reviewed: codex/cursor-routing-cancellation @ c8b8bbb (implementation c9cac02)
- Outcome: **merged** into claude/tender-cori-t1ksnz (merge commit 2f5feb8)

## Checks
- **Process.** The worklog follows the template, the branch was made from the integration tip, and there's one topic per branch. B8 said to ask the lead first, but the owner chose the item, and the owner's instruction comes first. Recorded in Decisions.
- **Tests.** The new tests in `test/cursor-runtime.test.ts` fail against the old `src/runtimes/cursor.ts` (7 failing) and pass with the change. After the merge, `npm run typecheck && npm test` passes: 181 tests.
- **Code.** `routingStep()` stops waiting on abort and cleans up late SDK results: it closes and deletes the scratch agent, and cancels a late run. Rejections after an abort are handled by `Promise.race`, so none go unhandled. Listeners are removed on every path. The Cursor adapter's normal and error paths are unchanged.
- **Docs.** The README and ARCHITECTURE additions are accurate.

## Notes for next time (no changes needed)
- The one-line braces (`{ calls.cancels++; }`) differ a little from the rest of the code. There's no formatter, so keep it consistent with the surrounding file.

## Also done by the lead this session
- **MCP descriptions.** Tool descriptions are redacted (1429d06).
- **Presets and catalogues.**
  - Phala and Routeway are now presets.
  - The catalogue reads Phala's `max_output_length` and `supported_features`, and Routeway's `capabilities.function_call`. This was checked against their live public model lists.
- **Live checks.** `npm run live` (`scripts/live-providers.ts`) is ready for B6. B8 is resolved.
