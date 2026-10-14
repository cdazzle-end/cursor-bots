import { randomBytes } from "node:crypto";
import { Cron } from "croner";
import type { EventBus } from "./events.ts";
import type { Store } from "./store.ts";
import type { Id, Routine, RoutineRun } from "./types.ts";
import { hostTimezone, newId } from "./util.ts";

export interface SchedulerHost {
  /** Start a routine run; resolves when the bot finishes it. */
  runRoutine(routine: Routine, run: RoutineRun, payload?: unknown): Promise<{ ok: boolean; error?: string }>;
  /** Tell the user something (e.g. routines paused after a long absence). */
  notice(botId: Id, text: string): void;
}

function webhookKey(): string {
  return randomBytes(24).toString("base64url");
}

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function validateCron(expr: string, timezone: string, minGapMinutes: number): string | undefined {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return "Use a five-field cron expression: minute hour day-of-month month day-of-week.";
  let job: Cron;
  try {
    job = new Cron(expr, { timezone, mode: "5-part", paused: true });
  } catch (err: any) {
    return `Invalid schedule: ${err?.message ?? err}`;
  }
  const runs = job.nextRuns(6);
  job.stop();
  if (!runs.length) return "That schedule never runs.";
  for (let i = 1; i < runs.length; i++) {
    if (runs[i]!.getTime() - runs[i - 1]!.getTime() < minGapMinutes * 60_000) {
      return `Runs must be at least ${minGapMinutes} minutes apart.`;
    }
  }
  return undefined;
}

export function nextRunAt(expr: string, timezone: string): number | undefined {
  try {
    const job = new Cron(expr, { timezone, mode: "5-part", paused: true });
    const next = job.nextRun();
    job.stop();
    return next?.getTime();
  } catch {
    return undefined;
  }
}

/** Plain-words rendering of common cron shapes, so you can confirm "When to run". */
export function describeCron(expr: string): string {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
  const time = (h: string, m: string) => {
    const hh = Number(h);
    const mm = Number(m);
    if (!Number.isInteger(hh) || !Number.isInteger(mm)) return `${h}:${m}`;
    const ampm = hh >= 12 ? "PM" : "AM";
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    return `${h12}:${String(mm).padStart(2, "0")} ${ampm}`;
  };
  const everyN = /^\*\/(\d+)$/;
  if (everyN.test(min) && hour === "*" && dom === "*" && mon === "*" && dow === "*") return `Every ${everyN.exec(min)![1]} minutes`;
  if (/^\d+$/.test(min) && everyN.test(hour) && dom === "*" && mon === "*" && dow === "*")
    return `Every ${everyN.exec(hour)![1]} hours at :${min.padStart(2, "0")}`;
  if (/^\d+$/.test(min) && hour === "*" && dom === "*" && mon === "*" && dow === "*") return `Every hour at :${min.padStart(2, "0")}`;
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    const t = time(hour, min);
    if (dom === "*" && mon === "*" && dow === "*") return `Every day at ${t}`;
    if (dom === "*" && mon === "*" && (dow === "1-5" || dow === "MON-FRI")) return `Every weekday at ${t}`;
    if (dom === "*" && mon === "*" && (dow === "0,6" || dow === "6,0")) return `Every weekend day at ${t}`;
    if (dom === "*" && mon === "*" && /^\d(,\d)*$/.test(dow)) return `Every ${dow.split(",").map((d) => DOW[Number(d) % 7]).join(", ")} at ${t}`;
    if (/^\d+$/.test(dom) && mon === "*" && dow === "*") return `Monthly on day ${dom} at ${t}`;
  }
  return `Cron "${expr}"`;
}

/**
 * Routines: "a rule that tells one Bot when to run a workflow". Schedules are
 * cron expressions in your time zone; webhook routines start from an HTTP POST.
 * Limits follow Grok Bot: 50 routines per bot, runs at least 5 minutes apart,
 * the last 20 run records kept.
 */
export class Scheduler {
  private store: Store;
  private bus: EventBus;
  private host: SchedulerHost;
  private jobs = new Map<Id, Cron>();
  private absenceTimer?: NodeJS.Timeout;

  constructor(store: Store, bus: EventBus, host: SchedulerHost) {
    this.store = store;
    this.bus = bus;
    this.host = host;
  }

  timezone(routine?: Routine): string {
    const tz = routine?.timezone || this.store.settings.timezone;
    return !tz || tz === "auto" ? hostTimezone() : tz;
  }

  start(): void {
    for (const r of this.store.routines.values()) this.arm(r);
    this.absenceTimer = setInterval(() => this.checkAbsence(), 3600_000);
    this.absenceTimer.unref();
    this.checkAbsence();
  }

  stop(): void {
    for (const j of this.jobs.values()) j.stop();
    this.jobs.clear();
    if (this.absenceTimer) clearInterval(this.absenceTimer);
  }

  list(botId?: Id): Routine[] {
    return [...this.store.routines.values()].filter((r) => !botId || r.botId === botId).sort((a, b) => a.createdAt - b.createdAt);
  }

  nextRun(r: Routine): number | undefined {
    if (!r.enabled || !r.cron) return undefined;
    return this.jobs.get(r.id)?.nextRun()?.getTime() ?? nextRunAt(r.cron, this.timezone(r));
  }

  describe(r: Routine) {
    return {
      ...r,
      when: r.cron ? describeCron(r.cron) : r.webhookKey ? "When the webhook is called" : "Only when tested",
      timezoneResolved: this.timezone(r),
      nextRunAt: this.nextRun(r),
    };
  }

  private arm(r: Routine): void {
    this.jobs.get(r.id)?.stop();
    this.jobs.delete(r.id);
    if (!r.enabled || !r.cron) return;
    try {
      const job = new Cron(r.cron, { timezone: this.timezone(r), mode: "5-part", protect: true, catch: true, unref: true }, () => {
        void this.fire(r.id, "schedule");
      });
      this.jobs.set(r.id, job);
    } catch {
      // An invalid stored schedule leaves the routine idle; the UI shows it.
    }
  }

  create(input: {
    botId: Id;
    name: string;
    instruction: string;
    cron?: string;
    timezone?: string;
    postTo?: Id;
    skill?: string;
    webhook?: boolean;
  }): Routine {
    const { limits } = this.store.settings;
    if (this.list(input.botId).length >= limits.maxRoutinesPerBot) {
      throw new Error(`A bot can own at most ${limits.maxRoutinesPerBot} routines.`);
    }
    if (!input.cron && !input.webhook) throw new Error("A routine needs a schedule (cron) or a webhook trigger.");
    const tz = input.timezone || undefined;
    if (input.cron) {
      const err = validateCron(input.cron, tz && tz !== "auto" ? tz : this.timezone(), limits.minRoutineIntervalMinutes);
      if (err) throw new Error(err);
    }
    const now = Date.now();
    const routine: Routine = {
      id: newId("rtn"),
      botId: input.botId,
      name: input.name.trim() || "Routine",
      instruction: input.instruction.trim(),
      cron: input.cron?.trim(),
      timezone: tz,
      postTo: input.postTo,
      skill: input.skill,
      webhookKey: input.webhook ? webhookKey() : undefined,
      enabled: true,
      history: [],
      createdAt: now,
      updatedAt: now,
    };
    this.store.routines.set(routine.id, routine);
    this.store.saveRoutines();
    this.arm(routine);
    this.bus.emit({ type: "routine.updated", routine: this.describe(routine) });
    return routine;
  }

  update(id: Id, patch: Partial<Pick<Routine, "name" | "instruction" | "cron" | "timezone" | "postTo" | "skill" | "enabled">> & { webhook?: boolean }): Routine {
    const r = this.store.routines.get(id);
    if (!r) throw new Error("No such routine");
    const { limits } = this.store.settings;
    if (patch.cron !== undefined && patch.cron) {
      const tz = patch.timezone ?? r.timezone;
      const err = validateCron(patch.cron, tz && tz !== "auto" ? tz : this.timezone(), limits.minRoutineIntervalMinutes);
      if (err) throw new Error(err);
    }
    if (patch.name !== undefined) r.name = patch.name;
    if (patch.instruction !== undefined) r.instruction = patch.instruction;
    if (patch.cron !== undefined) r.cron = patch.cron || undefined;
    if (patch.timezone !== undefined) r.timezone = patch.timezone || undefined;
    if (patch.postTo !== undefined) r.postTo = patch.postTo || undefined;
    if (patch.skill !== undefined) r.skill = patch.skill || undefined;
    if (patch.enabled !== undefined) {
      r.enabled = patch.enabled;
      if (patch.enabled) r.pausedReason = undefined;
    }
    if (patch.webhook === true && !r.webhookKey) r.webhookKey = webhookKey();
    if (patch.webhook === false) r.webhookKey = undefined;
    r.updatedAt = Date.now();
    this.store.saveRoutines();
    this.arm(r);
    this.bus.emit({ type: "routine.updated", routine: this.describe(r) });
    return r;
  }

  delete(id: Id): boolean {
    const r = this.store.routines.get(id);
    if (!r) return false;
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
    this.store.routines.delete(id);
    this.store.saveRoutines();
    this.bus.emit({ type: "routine.deleted", id, botId: r.botId });
    return true;
  }

  deleteForBot(botId: Id): void {
    for (const r of this.list(botId)) this.delete(r.id);
  }

  /** Start a run now. Scheduled runs are skipped while paused; tests and webhooks are explicit. */
  async fire(id: Id, trigger: RoutineRun["trigger"], payload?: unknown): Promise<RoutineRun | undefined> {
    const r = this.store.routines.get(id);
    if (!r) return undefined;
    if (trigger === "schedule" && !r.enabled) return undefined;
    if (trigger === "webhook" && !r.enabled) throw new Error("Routine is paused");
    const run: RoutineRun = { id: newId("rrun"), trigger, status: "running", startedAt: Date.now() };
    r.history.push(run);
    const keep = this.store.settings.limits.routineHistory;
    if (r.history.length > keep) r.history.splice(0, r.history.length - keep);
    r.lastRunAt = run.startedAt;
    this.store.saveRoutines();
    this.bus.emit({ type: "routine.updated", routine: this.describe(r) });
    const finish = (ok: boolean, error?: string) => {
      run.status = ok ? "succeeded" : "failed";
      run.error = error;
      run.finishedAt = Date.now();
      this.store.saveRoutines();
      const cur = this.store.routines.get(id);
      if (cur) this.bus.emit({ type: "routine.updated", routine: this.describe(cur) });
    };
    // Don't await the bot here: the caller (webhook, test button) returns as soon as the run starts.
    this.host
      .runRoutine(r, run, payload)
      .then((res) => finish(res.ok, res.error))
      .catch((err) => finish(false, String(err?.message ?? err)));
    return run;
  }

  /** Grok Bot pauses routines after a long absence; so do we. */
  checkAbsence(): void {
    const days = this.store.settings.absencePauseDays;
    const last = this.store.settings.lastUserActivityAt;
    if (!days || !last) return;
    if (Date.now() - last < days * 86400_000) return;
    const paused = new Map<Id, number>();
    for (const r of this.store.routines.values()) {
      if (!r.enabled || !r.cron) continue;
      r.enabled = false;
      r.pausedReason = `Paused after ${days} days without activity from you`;
      paused.set(r.botId, (paused.get(r.botId) ?? 0) + 1);
      this.arm(r);
      this.bus.emit({ type: "routine.updated", routine: this.describe(r) });
    }
    if (!paused.size) return;
    this.store.saveRoutines();
    for (const [botId, n] of paused) {
      this.host.notice(botId, `I paused ${n} routine${n === 1 ? "" : "s"} because you've been away for ${days} days. Resume them from my details when you're back.`);
    }
  }
}
