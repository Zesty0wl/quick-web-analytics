// Timezone helpers. DuckDB-WASM here has no ICU, so local-time bucketing is done with
// explicit UTC offsets, including DST transitions inside the queried range.

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Offset of `tz` from UTC at the given instant, in seconds (e.g. +3600 for BST). */
export function offsetAt(tz: string, utcSec: number): number {
  const parts = Object.fromEntries(fmt(tz).formatToParts(new Date(utcSec * 1000)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) / 1000;
  return asUtc - utcSec;
}

/** UTC instant (seconds) of local midnight at the start of `date` (YYYY-MM-DD) in `tz`. */
export function localMidnight(tz: string, date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d) / 1000;
  let t = guess - offsetAt(tz, guess);
  t = guess - offsetAt(tz, t);
  return t;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Offset segments covering [from, to): [startSec, offsetSec][] in ascending order. */
export function offsetSegments(tz: string, from: number, to: number): [number, number][] {
  const segs: [number, number][] = [[from, offsetAt(tz, from)]];
  const step = 6 * 3600;
  for (let t = from + step; t < to + step; t += step) {
    const probe = Math.min(t, to);
    const off = offsetAt(tz, probe);
    if (off !== segs[segs.length - 1][1]) {
      // binary search the transition to the second
      let lo = probe - step, hi = probe;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (offsetAt(tz, mid) === off) hi = mid; else lo = mid;
      }
      segs.push([hi, off]);
    }
  }
  return segs;
}

/** SQL expression for `col` shifted into local time. */
export function localTimeSql(col: string, segs: [number, number][]): string {
  if (segs.length === 1) return `(${col} + ${segs[0][1]})`;
  const cases = segs.slice(1).map(([start], i) => `WHEN ${col} < ${start} THEN ${segs[i][1]}`).join(" ");
  return `(${col} + CASE ${cases} ELSE ${segs[segs.length - 1][1]} END)`;
}

export function dayLabel(localDayNumber: number): string {
  return new Date(localDayNumber * 86_400_000).toISOString().slice(0, 10);
}

export function hourLabel(localHourNumber: number): string {
  return new Date(localHourNumber * 3_600_000).toISOString().slice(0, 13).replace("T", " ") + ":00";
}
