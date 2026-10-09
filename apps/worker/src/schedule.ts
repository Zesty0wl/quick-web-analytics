// When the Scheduler (do/scheduler.ts) runs the hourly jobs. Kept apart from the Durable Object so it can be unit-tested.

/** Minutes past each hour that the hourly jobs run. */
export const AT_MINUTE = 10;
/** UTC hours in which the day's PageSpeed tests are spread (a few sites per hour keeps each run short). */
export const SPEED_HOURS = [2, 3, 4, 5, 6, 7];
export const SPEED_SITES_PER_RUN = 6;

/** The next hh:10 after `now`. */
export function nextRun(now: number): number {
  const d = new Date(now);
  d.setUTCMinutes(AT_MINUTE, 0, 0);
  if (d.getTime() <= now) d.setUTCHours(d.getUTCHours() + 1);
  return d.getTime();
}
