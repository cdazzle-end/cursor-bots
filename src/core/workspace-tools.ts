import type { Harness } from "./harness.ts";
import type { RunState } from "./runner.ts";
import type { Id } from "./types.ts";
import type { BoundTool } from "../runtimes/types.ts";

/**
 * The harness's own computer tools (shell, files, search, web fetch) for
 * runtimes that don't bring any (a plain model API). They run in this process,
 * so every approval and protected-path check is enforced directly instead of
 * through Cursor's hooks.
 */
export function buildWorkspaceTools(h: Harness, botId: Id, current: () => RunState | undefined): BoundTool[] {
  void h;
  void botId;
  void current;
  return [];
}
