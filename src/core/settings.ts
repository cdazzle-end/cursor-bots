import type { ApprovalRule, Settings } from "./types.ts";

/**
 * Shell commands that always stop for your approval in "auto" mode. Grok Bot
 * asks first for sending, purchasing, deleting, publishing and production
 * changes; these patterns are the shell-level version of that boundary.
 */
export const DEFAULT_ASK_RULES: Array<Pick<ApprovalRule, "pattern" | "note">> = [
  { pattern: String.raw`\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive|-r)\b`, note: "Recursive delete" },
  { pattern: String.raw`\bsudo\b`, note: "Superuser command" },
  { pattern: String.raw`\bgit\s+push\b`, note: "Publishing commits" },
  { pattern: String.raw`\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)`, note: "Discarding work" },
  { pattern: String.raw`\b(npm|pnpm|yarn)\s+publish\b`, note: "Publishing a package" },
  { pattern: String.raw`\bcurl\b[^|]*\s(-X\s*|--request\s+)(POST|PUT|PATCH|DELETE)\b`, note: "Writing to a remote API" },
  { pattern: String.raw`\b(shutdown|reboot|mkfs|dd\s+if=)`, note: "System-level change" },
  { pattern: String.raw`\b(sendmail|mail\s+-s)\b`, note: "Sending email" },
  { pattern: String.raw`\bgh\s+(pr\s+(create|merge)|release\s+create|repo\s+delete)`, note: "Publishing on GitHub" },
];

export function defaultSettings(): Settings {
  const now = Date.now();
  return {
    user: { name: "Boss", label: "Team lead", avatar: { shape: "classic", color: "#f2f2f2" } },
    timezone: "auto",
    // Real Cursor agents by default; the scripted demo brain only when asked for (--runtime mock).
    runtime: "cursor",
    defaultModel: { id: "composer-2.5" },
    routerModel: { id: "composer-2.5", params: [{ id: "fast", value: "true" }] },
    groupRouting: "llm",
    approvals: {
      mode: "auto",
      rules: DEFAULT_ASK_RULES.map((r, i) => ({
        id: `rule_default_${i}`,
        effect: "ask" as const,
        target: "shell" as const,
        pattern: r.pattern,
        note: r.note,
        createdAt: now,
      })),
      inlineWaitSeconds: 20,
      backgroundExpiryMinutes: 10,
    },
    limits: {
      maxBotsAndGroups: 50,
      maxGroupSize: 6,
      maxRoutinesPerBot: 50,
      routineHistory: 20,
      minRoutineIntervalMinutes: 5,
      maxChainDepth: 8,
      maxChainRuns: 24,
      memoryCharsPerTurn: 6000,
    },
    absencePauseDays: 14,
    cursorAutoReview: false,
    cursorSandbox: false,
    providers: [],
  };
}

/** Deep-merge saved settings over defaults so new fields appear after upgrades. */
export function mergeSettings(saved: Partial<Settings> | undefined): Settings {
  const d = defaultSettings();
  if (!saved) return d;
  return {
    ...d,
    ...saved,
    user: { ...d.user, ...(saved.user ?? {}), avatar: { ...d.user.avatar, ...(saved.user?.avatar ?? {}) } },
    approvals: { ...d.approvals, ...(saved.approvals ?? {}), rules: saved.approvals?.rules ?? d.approvals.rules },
    limits: { ...d.limits, ...(saved.limits ?? {}) },
  };
}
