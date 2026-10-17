import type { EventBus } from "./events.ts";
import type { Store } from "./store.ts";
import type { Approval, ApprovalRule, Id, ResumeContext } from "./types.ts";
import { escapeRegExp, newId } from "./util.ts";

export interface ApprovalHost {
  /** Post the approval card into the conversation and return the message id. */
  postCard(approval: Approval): string | undefined;
  /** Called when a decision arrives after the bot stopped waiting, so the bot can be woken. */
  onDeferredDecision(approval: Approval): void;
}

/** The rule "Always allow" saves: this text and nothing else. */
function exactPattern(subject: string): string {
  return `^${escapeRegExp(subject.trim())}$`;
}

export type GateResult =
  | { permission: "allow"; approvalId?: Id }
  | { permission: "deny"; approvalId?: Id; reason: "denied" | "pending" | "expired"; message: string };

/**
 * Approvals keep consequential actions under your control (Grok Bot's
 * "Allow once / Always allow / Deny"). Two paths lead here:
 *
 *  1. Shell commands, via the Cursor `beforeShellExecution` hook that the
 *     harness installs in the workspace (.cursor/hooks.json).
 *  2. Any other action a bot considers consequential, via the
 *     `request_approval` tool (sending, publishing, purchasing, deleting...).
 *
 * A request waits inline for a short time. If you haven't answered, the bot is
 * told to end its turn, and is woken again when you decide.
 */
export class ApprovalService {
  private store: Store;
  private bus: EventBus;
  private host: ApprovalHost;
  /** Turns waiting inline for a decision. `active` says whether that turn is still running. */
  private waiters = new Map<Id, Array<{ done: (a: Approval | undefined) => void; active?: () => boolean }>>();
  private sweep?: NodeJS.Timeout;

  constructor(store: Store, bus: EventBus, host: ApprovalHost) {
    this.store = store;
    this.bus = bus;
    this.host = host;
  }

  start(): void {
    this.sweep = setInterval(() => this.expireStale(), 15_000);
    this.sweep.unref();
  }

  stop(): void {
    if (this.sweep) clearInterval(this.sweep);
  }

  get rules(): ApprovalRule[] {
    return this.store.settings.approvals.rules;
  }

  /**
   * Decide whether a subject needs your approval. "ask" rules win over "allow" rules, except an
   * allow rule for exactly this text (what "Always allow" saves): you approved that very command.
   */
  evaluate(target: "shell" | "action", subject: string): "allow" | "ask" {
    const { mode } = this.store.settings.approvals;
    if (mode === "off") return "allow";
    const exact = exactPattern(subject);
    if (this.rules.some((r) => r.target === target && r.effect === "allow" && r.pattern === exact)) return "allow";
    let allowed = false;
    for (const rule of this.rules) {
      if (rule.target !== target) continue;
      let re: RegExp;
      try {
        re = new RegExp(rule.pattern, "i");
      } catch {
        continue;
      }
      if (!re.test(subject)) continue;
      if (rule.effect === "ask") return "ask";
      allowed = true;
    }
    if (allowed) return "allow";
    if (mode === "ask") return "ask";
    // In auto mode shell commands run unless a rule stops them; explicit
    // approval requests from a bot always reach you.
    return target === "shell" ? "allow" : "ask";
  }

  pendingFor(botId: Id): Approval[] {
    return [...this.store.approvals.values()].filter((a) => a.botId === botId && a.status === "pending");
  }

  request(input: {
    botId: Id;
    convId: Id;
    kind: "shell" | "action";
    title: string;
    details?: string;
    command?: string;
    origin: "foreground" | "background";
    resume?: ResumeContext;
  }): Approval {
    const subject = input.command ?? input.title;
    for (const a of this.store.approvals.values()) {
      if (a.status === "pending" && a.botId === input.botId && (a.command ?? a.title) === subject) return a;
    }
    const now = Date.now();
    const approval: Approval = {
      id: newId("appr"),
      botId: input.botId,
      convId: input.convId,
      kind: input.kind,
      title: input.title,
      details: input.details,
      command: input.command,
      status: "pending",
      origin: input.origin,
      resume: input.resume,
      createdAt: now,
      expiresAt:
        input.origin === "background" ? now + this.store.settings.approvals.backgroundExpiryMinutes * 60_000 : undefined,
    };
    this.store.approvals.set(approval.id, approval);
    approval.messageId = this.host.postCard(approval);
    this.store.saveApprovals();
    this.bus.emit({ type: "approval.updated", approval });
    return approval;
  }

  /**
   * Wait up to `seconds` for a decision. Returns the approval in whatever state
   * it is then, or undefined if the decision arrived after the waiting turn was
   * stopped (that decision wakes the bot afresh instead).
   */
  waitFor(id: Id, seconds: number, active?: () => boolean): Promise<Approval | undefined> {
    const a = this.store.approvals.get(id);
    if (!a || a.status !== "pending" || seconds <= 0) return Promise.resolve(a);
    return new Promise((resolve) => {
      const entry = {
        done: (x: Approval | undefined) => {
          clearTimeout(timer);
          resolve(x);
        },
        active,
      };
      const timer = setTimeout(() => {
        const list = this.waiters.get(id) ?? [];
        this.waiters.set(id, list.filter((w) => w !== entry));
        resolve(this.store.approvals.get(id));
      }, seconds * 1000);
      const list = this.waiters.get(id) ?? [];
      list.push(entry);
      this.waiters.set(id, list);
    });
  }

  /** Let go of waits whose turn was stopped, so the turn can end now; a later decision wakes the bot. */
  releaseStopped(): void {
    for (const [id, list] of this.waiters) {
      const keep = list.filter((w) => !w.active || w.active());
      for (const w of list) if (!keep.includes(w)) w.done(undefined);
      if (keep.length) this.waiters.set(id, keep);
      else this.waiters.delete(id);
    }
  }

  decide(id: Id, decision: "once" | "always" | "deny"): Approval {
    const a = this.store.approvals.get(id);
    if (!a) throw new Error("No such approval");
    if (a.status !== "pending") return a;
    a.status = decision === "deny" ? "denied" : "allowed";
    a.decision = decision;
    a.decidedAt = Date.now();
    if (decision === "always") {
      const subject = a.command ?? a.title;
      this.store.settings.approvals.rules.push({
        id: newId("rule"),
        effect: "allow",
        target: a.kind === "shell" ? "shell" : "action",
        pattern: exactPattern(subject),
        note: `Always allowed from an approval card (${a.kind})`,
        createdAt: Date.now(),
      });
      this.store.saveSettings();
      this.bus.emit({ type: "settings.updated", settings: this.store.settings });
    }
    this.store.saveApprovals();
    this.bus.emit({ type: "approval.updated", approval: a });
    const waiters = this.waiters.get(id) ?? [];
    this.waiters.delete(id);
    const live = waiters.filter((w) => !w.active || w.active());
    // A turn you stopped while it waited is released without the decision (and uses no grant).
    for (const w of waiters) if (!live.includes(w)) w.done(undefined);
    if (live.length) {
      // The bot is still waiting inline; it continues with the decision.
      for (const w of live) w.done(a);
    } else {
      // The bot already ended its turn (or was stopped, or the gateway restarted): wake it with the decision.
      this.host.onDeferredDecision(a);
    }
    return a;
  }

  /**
   * A granted one-time approval is used up by the first matching retry. "Always allow" lives in
   * its rule instead, so deleting the rule in Settings takes it back at once.
   */
  consumeGrant(botId: Id | undefined, subject: string): Approval | undefined {
    const cutoff = Date.now() - 6 * 3600_000;
    for (const a of this.store.approvals.values()) {
      if (a.status !== "allowed" || a.decision !== "once" || a.consumed || (a.decidedAt ?? 0) < cutoff) continue;
      if (botId && a.botId !== botId) continue;
      if ((a.command ?? a.title).trim() !== subject.trim()) continue;
      a.consumed = true;
      this.store.saveApprovals();
      return a;
    }
    return undefined;
  }

  /** The decision procedure the shell hook and request_approval share. */
  async gate(input: {
    botId: Id;
    convId: Id;
    kind: "shell" | "action";
    subject: string;
    details?: string;
    origin: "foreground" | "background";
    waitSeconds: number;
    /** The bot's turn context, so a later decision wakes it where it was working. */
    resume?: ResumeContext;
    /** False once the asking turn was stopped; a decision then wakes the bot instead of reaching the dead turn. */
    active?: () => boolean;
  }): Promise<GateResult> {
    if (this.evaluate(input.kind, input.subject) === "allow") return { permission: "allow" };
    const grant = this.consumeGrant(input.botId, input.subject);
    if (grant) return { permission: "allow", approvalId: grant.id };
    const approval = this.request({
      botId: input.botId,
      convId: input.convId,
      kind: input.kind,
      title: input.kind === "shell" ? `Run a shell command` : input.subject,
      details: input.details,
      command: input.kind === "shell" ? input.subject : undefined,
      origin: input.origin,
      resume: input.resume,
    });
    const decided = (await this.waitFor(approval.id, input.waitSeconds, input.active)) ?? approval;
    if (decided.status === "allowed" && input.active && !input.active()) {
      // Decided after this turn was stopped: the decision wakes the bot afresh and keeps its grant.
      return { permission: "deny", approvalId: decided.id, reason: "pending", message: "This turn was stopped." };
    }
    if (decided.status === "allowed") {
      if (decided.decision === "once") {
        decided.consumed = true;
        this.store.saveApprovals();
      }
      return { permission: "allow", approvalId: decided.id };
    }
    if (decided.status === "denied") {
      return { permission: "deny", approvalId: decided.id, reason: "denied", message: `The user denied this (approval ${decided.id}). Do not retry it; choose another approach or stop and report.` };
    }
    if (decided.status === "expired") {
      return { permission: "deny", approvalId: decided.id, reason: "expired", message: `The approval request expired (${decided.id}). Report that you were blocked waiting for approval.` };
    }
    return {
      permission: "deny",
      approvalId: decided.id,
      reason: "pending",
      message:
        `This needs the user's approval and they haven't answered yet (approval ${decided.id}). ` +
        `Stop here: end your turn with a short note saying what you're waiting to do and why. ` +
        `You will be woken automatically with the decision; if it is granted, retry the exact same action then.`,
    };
  }

  private expireStale(): void {
    const now = Date.now();
    for (const a of this.store.approvals.values()) {
      if (a.status === "pending" && a.expiresAt && a.expiresAt < now) {
        a.status = "expired";
        a.decidedAt = now;
        this.store.saveApprovals();
        this.bus.emit({ type: "approval.updated", approval: a });
        const waiters = this.waiters.get(a.id);
        this.waiters.delete(a.id);
        for (const w of waiters ?? []) w.done(a);
      }
    }
  }
}
