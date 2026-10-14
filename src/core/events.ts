import { EventEmitter } from "node:events";

/** Everything the UI needs to stay live is published here and fanned out over SSE. */
export type HarnessEvent =
  | { type: "bot.updated"; bot: unknown }
  | { type: "bot.deleted"; id: string }
  | { type: "bot.status"; botId: string; status: BotStatus }
  | { type: "conversation.updated"; conversation: unknown }
  | { type: "conversation.deleted"; id: string }
  | { type: "message.created"; message: unknown }
  | { type: "message.updated"; message: unknown }
  | { type: "run.started"; botId: string; convId: string; runId: string; source: string }
  | { type: "run.delta"; botId: string; convId: string; runId: string; text: string }
  | { type: "run.thinking"; botId: string; convId: string; runId: string; text: string }
  | { type: "run.tool"; botId: string; convId: string; runId: string; item: unknown }
  | { type: "run.finished"; botId: string; convId: string; runId: string; status: string; error?: string }
  | { type: "approval.updated"; approval: unknown }
  | { type: "secretRequest.updated"; request: unknown }
  | { type: "routine.updated"; routine: unknown }
  | { type: "routine.deleted"; id: string; botId: string }
  | { type: "settings.updated"; settings: unknown }
  | { type: "skills.updated" }
  | { type: "connectors.updated" }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string; botId?: string };

export interface BotStatus {
  state: "idle" | "working" | "error";
  /** Conversation the current run will reply to. */
  convId?: string;
  queued: number;
  since?: number;
  detail?: string;
}

export class EventBus {
  private emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(0);
  }
  emit(event: HarnessEvent): void {
    this.emitter.emit("event", event);
  }
  on(listener: (event: HarnessEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
}
