// Shared data model for the harness. Everything here is plain JSON so it can be
// persisted to disk as-is and inspected by hand (see docs/ARCHITECTURE.md).

export type Id = string;

export interface ModelChoice {
  id: string;
  params?: Array<{ id: string; value: string }>;
}

export interface Avatar {
  /** One of the built-in blob shapes, see web/avatar.js. */
  shape: string;
  /** CSS color for the blob. */
  color: string;
  /** Optional uploaded image (workspace-relative path). Overrides the blob. */
  image?: string;
}

export interface Bot {
  id: Id;
  name: string;
  /** Lowercase handle used for @mentions ("critic", "e-boy"). Unique. */
  handle: string;
  /** Short label shown next to the name, e.g. "Grok Bots Expert/Tech Support". */
  label?: string;
  /** The job, in operational terms. Durable rules belong in memory. */
  about?: string;
  avatar: Avatar;
  /** Per-bot model. Falls back to settings.defaultModel. */
  model?: ModelChoice;
  /** Runtime id override ("cursor", "mock"). Falls back to settings.runtime. */
  runtime?: string;
  /** Connectors (MCP servers) this bot may use. "all" = every enabled connector. */
  connectors: "all" | string[];
  /** Skills hidden from this bot. */
  disabledSkills: string[];
  notifications: boolean;
  pinned: boolean;
  hidden: boolean;
  section?: string;
  /** "user" or the id of the bot that created this helper bot. */
  createdBy: "user" | Id;
  /** Agent session id in the runtime (Cursor: "agent-<uuid>"). */
  agentId?: string;
  /** Runtime that owns agentId. A runtime switch starts a fresh session. */
  agentRuntime?: string;
  /** Running totals reported by the runtime (every turn spends usage). */
  usage?: { turns: number; inputTokens: number; outputTokens: number; totalTokens: number; since: number };
  createdAt: number;
  updatedAt: number;
}

export type ConversationKind = "dm" | "group" | "botdm";

export interface Conversation {
  id: Id;
  kind: ConversationKind;
  /** Group name. DMs derive their title from the bot. */
  title?: string;
  /** Bot ids. dm: [bot], botdm: [botA, botB], group: 2..6 bots. */
  members: Id[];
  /** Group coordinator that answers un-addressed messages. */
  lead?: Id;
  /** What the group is for. */
  purpose?: string;
  pinned: boolean;
  hidden: boolean;
  unread: number;
  attention: boolean;
  lastMessageAt?: number;
  lastPreview?: string;
  createdAt: number;
  updatedAt: number;
}

export type Author =
  | { kind: "user" }
  | { kind: "bot"; id: Id }
  | { kind: "system" };

export interface Attachment {
  /** Path relative to the shared workspace. */
  path: string;
  name: string;
  mime: string;
  size: number;
}

export type MessageKind =
  | "message"
  | "handoff"
  | "activity"
  | "approval"
  | "secret_request"
  | "routine"
  | "notice"
  | "error";

export interface ActivityItem {
  callId: string;
  name: string;
  status: "running" | "completed" | "error";
  summary: string;
}

export interface Message {
  id: Id;
  convId: Id;
  ts: number;
  author: Author;
  kind: MessageKind;
  text: string;
  attachments?: Attachment[];
  mentions?: Id[];
  replyTo?: Id;
  runId?: Id;
  meta?: Record<string, unknown>;
}

export type WakeSource = "user" | "bot" | "routine" | "webhook" | "approval" | "system";

/** Tracks a cascade of bot-to-bot messages so loops can be cut off. */
export interface Chain {
  id: Id;
  /** Number of bot-to-bot hops since a human or a schedule started the chain. */
  depth: number;
  /** Bot runs spent in this chain so far. */
  runs: number;
}

/** Where a handoff's answer goes: back to the requesting bot, in the conversation it was working in. */
export interface ReplyRoute {
  botId: Id;
  convId: Id;
  handoffId: Id;
  /** The requester's own reply route, so answers keep flowing up a delegation chain. */
  upstream?: ReplyRoute;
}

/** A reason to run a bot. Bots process one wake at a time, highest priority first. */
export interface WakeEvent {
  id: Id;
  botId: Id;
  /** 0 = the user, 1 = other bots / approvals, 2 = background (routines). */
  priority: 0 | 1 | 2;
  source: WakeSource;
  /** Conversation the bot's final reply is posted to. */
  convId: Id;
  /** The message that triggered this wake, if any. */
  messageId?: Id;
  /** Other messages folded into this wake (several quick messages from you). */
  alsoMessageIds?: Id[];
  /** Text handed to the bot (already formatted, without the harness envelope). */
  text: string;
  attachments?: Attachment[];
  fromBotId?: Id;
  /** In groups the bot may stay silent by answering NO_REPLY. */
  allowSilence: boolean;
  /** When set, the final reply is also delivered to this bot (handoff replies). */
  replyTo?: ReplyRoute;
  /** How the incoming item is labelled for the bot (message, group_message, handoff, ...). */
  kind?: string;
  /** In groups: was this bot addressed directly, as part of @everyone, or picked by routing? */
  addressed?: "you" | "everyone" | "group";
  chain: Chain;
  routineId?: Id;
  routineRunId?: Id;
  approvalId?: Id;
  createdAt: number;
}

export interface RoutineRun {
  id: Id;
  trigger: "schedule" | "test" | "webhook" | "manual";
  status: "running" | "succeeded" | "failed";
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

export interface Routine {
  id: Id;
  botId: Id;
  name: string;
  /** What the bot does on each run. */
  instruction: string;
  /** Five-field cron expression, or undefined for webhook/manual-only routines. */
  cron?: string;
  timezone?: string;
  /** Webhook trigger: POST /api/webhooks/routines/:id with Bearer key. */
  webhookKey?: string;
  /** Conversation that receives results. Defaults to the bot's DM. */
  postTo?: Id;
  skill?: string;
  enabled: boolean;
  pausedReason?: string;
  history: RoutineRun[];
  lastRunAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type ApprovalStatus = "pending" | "allowed" | "denied" | "expired";

export interface Approval {
  id: Id;
  botId: Id;
  convId: Id;
  kind: "shell" | "action";
  title: string;
  details?: string;
  command?: string;
  status: ApprovalStatus;
  decision?: "once" | "always" | "deny";
  /** "foreground" approvals wait for you; "background" ones expire. */
  origin: "foreground" | "background";
  /** Set once a granted "once" approval has been used. */
  consumed?: boolean;
  createdAt: number;
  decidedAt?: number;
  expiresAt?: number;
  messageId?: Id;
}

export interface ApprovalRule {
  id: Id;
  effect: "ask" | "allow";
  /** What the rule matches: shell commands or named actions. */
  target: "shell" | "action";
  /** Regular expression (case-insensitive) tested against the command or action title. */
  pattern: string;
  note?: string;
  createdAt: number;
}

export interface SecretMeta {
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SecretRequest {
  id: Id;
  botId: Id;
  convId: Id;
  name: string;
  description?: string;
  status: "pending" | "saved" | "dismissed";
  createdAt: number;
  messageId?: Id;
}

export interface ConnectorConfig {
  /** stdio MCP server */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http/sse MCP server */
  type?: "stdio" | "http" | "sse";
  url?: string;
  headers?: Record<string, string>;
  description?: string;
  enabled: boolean;
}

export interface UserProfile {
  name: string;
  label: string;
  avatar: Avatar;
}

export interface Settings {
  user: UserProfile;
  /** IANA time zone used for routines. "auto" = the host's zone. */
  timezone: string;
  /** Default runtime for bots without an override. */
  runtime: string;
  defaultModel: ModelChoice;
  /** Model used for lightweight decisions (group routing). */
  routerModel?: ModelChoice;
  /** How un-addressed group messages pick a responder. */
  groupRouting: "llm" | "lead" | "heuristic";
  approvals: {
    /** auto: only ask-first rules stop; ask: everything stops unless allowed; off: nothing stops. */
    mode: "auto" | "ask" | "off";
    rules: ApprovalRule[];
    /** Seconds a hook or tool waits inline for your decision before deferring. */
    inlineWaitSeconds: number;
    /** Background approvals expire after this many minutes. */
    backgroundExpiryMinutes: number;
  };
  limits: {
    maxBotsAndGroups: number;
    maxGroupSize: number;
    maxRoutinesPerBot: number;
    routineHistory: number;
    minRoutineIntervalMinutes: number;
    /** Max bot-to-bot hops in one chain before the harness stops waking bots. */
    maxChainDepth: number;
    /** Max bot runs one chain may spend. */
    maxChainRuns: number;
    /** Characters of memory injected per turn. */
    memoryCharsPerTurn: number;
  };
  /** Pause routines after this many days without any message from you (0 = never). */
  absencePauseDays: number;
  /** Cursor Auto-review classifier for local tool calls. */
  cursorAutoReview: boolean;
  /** Cursor sandbox for shell commands (bubblewrap/seatbelt). */
  cursorSandbox: boolean;
  lastUserActivityAt?: number;
}
