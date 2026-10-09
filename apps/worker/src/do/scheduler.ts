import { DurableObject } from "cloudflare:workers";
import { intradayJob } from "../alerts";
import type { Env } from "../env";
import { speedJob } from "../google";
import { nextRun, SPEED_HOURS, SPEED_SITES_PER_RUN } from "../schedule";
import { allSites } from "../sites";

/**
 * One instance ("global") that runs the hourly jobs on a Durable Object alarm: the "so far today" anomaly check and,
 * overnight, the PageSpeed tests. An alarm is used rather than a cron trigger because it's self-sustaining (each run
 * books the next) and visible (`status()`); the Worker calls `ensure()` so the chain restarts if it ever stops.
 */
export class Scheduler extends DurableObject<Env> {
  /** Arm the alarm if it isn't already. Cheap: called once per Worker isolate. */
  async ensure(): Promise<number> {
    const at = await this.ctx.storage.getAlarm();
    if (at !== null) return at;
    const next = nextRun(Date.now());
    await this.ctx.storage.setAlarm(next);
    return next;
  }

  async status(): Promise<{ nextRun: number | null; lastRun: { at: number; ms: number; error?: string } | null }> {
    return { nextRun: await this.ctx.storage.getAlarm(), lastRun: (await this.ctx.storage.get("lastRun")) ?? null };
  }

  async alarm(): Promise<void> {
    // Book the next run first, so a failure below never breaks the chain.
    const started = Date.now();
    await this.ctx.storage.setAlarm(nextRun(started));
    let error: string | undefined;
    try {
      const sites = await allSites(this.env);
      await intradayJob(this.env, sites);
      if (SPEED_HOURS.includes(new Date(started).getUTCHours())) await speedJob(this.env, sites, { limit: SPEED_SITES_PER_RUN });
    } catch (e) {
      error = (e as Error).message;
      console.error("hourly jobs failed", e);
    }
    await this.ctx.storage.put("lastRun", { at: started, ms: Date.now() - started, ...(error ? { error } : {}) });
  }
}
