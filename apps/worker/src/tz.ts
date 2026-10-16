// Local-date helpers for a site's timezone (Intl only; no tz database needed).
export function todayIn(tz: string, nowMs = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(nowMs));
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function offsetAt(tz: string, utcSec: number): number {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(utcSec * 1000)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) / 1000 - utcSec;
}

/** UTC seconds of local midnight starting `date` in `tz`. */
export function localMidnight(tz: string, date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d) / 1000;
  const t = guess - offsetAt(tz, guess);
  return guess - offsetAt(tz, t);
}

/** "Today so far" is compared with the same time of day, in steps of this many seconds (so answers can be reused). */
export const SAME_TIME_STEP = 300;

/**
 * When the period is just today, the comparison day up to the same time of day (in `SAME_TIME_STEP` steps, at least
 * one), so a day in progress isn't measured against a whole one. Null for any other period.
 */
export function sameTimeWindow(tz: string, from: string, to: string, cday: string, nowSec = Date.now() / 1000): { start: number; end: number } | null {
  const today = todayIn(tz, nowSec * 1000);
  if (from !== today || to !== today || cday >= today) return null;
  const elapsed = Math.max(SAME_TIME_STEP, Math.floor((nowSec - localMidnight(tz, today)) / SAME_TIME_STEP) * SAME_TIME_STEP);
  const start = localMidnight(tz, cday);
  return { start, end: Math.min(start + elapsed, localMidnight(tz, addDays(cday, 1))) };
}
