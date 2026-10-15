// Date ranges are local calendar dates in the site's timezone.
import type { TimeGrain } from "@qwa/shared";

export function todayIn(tz?: string, at = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** The local date of a unix-seconds instant. */
const dateAt = (tz: string | undefined, sec: number) => todayIn(tz, new Date(sec * 1000));

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function addYears(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const target = new Date(Date.UTC(y + n, m - 1, d));
  if (target.getUTCMonth() !== m - 1) target.setUTCDate(0); // 29 Feb → 28 Feb
  return target.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
}

export const PRESETS = [
  { id: "today", label: "Today", long: "Today" },
  { id: "24h", label: "24H", long: "Last 24 hours" },
  { id: "7d", label: "7D", long: "Last 7 days" },
  { id: "30d", label: "30D", long: "Last 30 days" },
  { id: "90d", label: "90D", long: "Last 90 days" },
  { id: "12m", label: "12M", long: "Last 12 months" },
  { id: "all", label: "All", long: "All time" },
] as const;
export type Preset = (typeof PRESETS)[number]["id"];
export type Range = Preset | "custom";
export type Compare = "prev" | "year";

/**
 * A reporting period: inclusive local dates, and for "the last 24 hours" exact bounds in unix seconds (`since`
 * inclusive, `until` exclusive) that replace the dates' midnights. The dates then name the days it touches.
 */
export interface Period {
  from: string;
  to: string;
  since?: number;
  until?: number;
}

/** `first`: the site's first day of data (or the earliest of several sites'), where "All" starts. */
export function presetRange(preset: Preset, tz?: string, first?: string): Period {
  const today = todayIn(tz);
  if (preset === "24h") {
    // Whole hours, so the window (and its query) only moves on once an hour: the 23 before this one, and this one so far.
    const until = (Math.floor(Date.now() / 3_600_000) + 1) * 3600;
    const since = until - 86_400;
    return { from: dateAt(tz, since), to: today, since, until };
  }
  if (preset === "all") return { from: first && first < today ? first : today, to: today };
  const back = { today: 0, "7d": 6, "30d": 29, "90d": 89, "12m": 364 }[preset];
  return { from: addDays(today, -back), to: today };
}

export function comparisonRange(p: Period, mode: Compare, tz?: string): Period {
  if (p.since !== undefined && p.until !== undefined) {
    const yearBefore = (sec: number) => {
      const d = new Date(sec * 1000);
      d.setUTCFullYear(d.getUTCFullYear() - 1);
      return d.getTime() / 1000;
    };
    const since = mode === "year" ? yearBefore(p.since) : p.since - (p.until - p.since);
    const until = mode === "year" ? yearBefore(p.until) : p.since;
    return { from: dateAt(tz, since), to: dateAt(tz, until - 1), since, until };
  }
  if (mode === "year") return { from: addYears(p.from, -1), to: addYears(p.to, -1) };
  const n = daysBetween(p.from, p.to);
  return { from: addDays(p.from, -n), to: addDays(p.from, -1) };
}

/**
 * What the overview (and the site switcher's totals) ask for. It totals whole days; for the last 24 hours it gets one
 * exact window and the one before, keyed by their last days, as it does for today.
 */
export function overviewRange(p: Period, cmp: Period) {
  return p.since !== undefined
    ? { from: p.to, to: p.to, cfrom: cmp.to, cto: cmp.to, since: p.since, until: p.until, csince: cmp.since, cuntil: cmp.until }
    : { from: p.from, to: p.to, cfrom: cmp.from, cto: cmp.to };
}

/** Grains that make sense for a period, and the default one: 15 minutes for a day or less, hourly up to a week. */
export function grainsFor(p: Period): { allowed: TimeGrain[]; auto: TimeGrain } {
  const n = p.since !== undefined && p.until !== undefined ? Math.ceil((p.until - p.since) / 86_400) : daysBetween(p.from, p.to);
  const allowed: TimeGrain[] = [];
  if (n <= 2) allowed.push("quarter_hour");
  if (n <= 7) allowed.push("hour");
  if (n >= 2 && n <= 400) allowed.push("day");
  if (n >= 14) allowed.push("week");
  if (n >= 60) allowed.push("month");
  const auto: TimeGrain = n <= 1 ? "quarter_hour" : n <= 7 ? "hour" : n <= 120 ? "day" : n <= 400 ? "week" : "month";
  return { allowed, auto };
}

export const GRAIN_LABELS: Record<TimeGrain, string> = { quarter_hour: "15 min", hour: "Hourly", day: "Daily", week: "Weekly", month: "Monthly" };

const fmt = (d: string, opts: Intl.DateTimeFormatOptions) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" });

export const weekday = (d: string) => fmt(d, { weekday: "short" });
export const shortDate = (d: string) => fmt(d, { day: "numeric", month: "short" });
export const longDate = (d: string) => fmt(d, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
export const isWeekend = (d: string) => [0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay());

export function rangeLabel(from: string, to: string): string {
  if (from === to) return longDate(from);
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return `${fmt(from, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) })} – ${fmt(to, { day: "numeric", month: "short", year: "numeric" })}`;
}

export function periodLabel(range: Range, from: string, to: string): string {
  return range === "custom" ? rangeLabel(from, to) : PRESETS.find((p) => p.id === range)!.long;
}

export function compareLabel(range: Range, compare: Compare, from: string, to: string): string {
  if (compare === "year") return "the same period last year";
  if (range === "today") return "yesterday";
  if (range === "24h") return "the 24 hours before";
  const n = daysBetween(from, to);
  return range === "12m" ? "the previous 12 months" : `the previous ${n} days`;
}

export function bucketLabel(key: string, grain: TimeGrain): string {
  if (grain === "hour" || grain === "quarter_hour") return key.slice(11, 16) === "00:00" ? shortDate(key.slice(0, 10)) : key.slice(11, 16);
  if (grain === "month") return fmt(key, { month: "short", year: "2-digit" });
  return shortDate(key);
}

export function bucketTitle(key: string, grain: TimeGrain): string {
  if (grain === "hour") return `${longDate(key.slice(0, 10))}, ${key.slice(11, 16)}`;
  if (grain === "quarter_hour") {
    const [h, m] = key.slice(11, 16).split(":").map(Number);
    const end = h * 60 + m + 15;
    return `${longDate(key.slice(0, 10))}, ${key.slice(11, 16)}–${String(Math.floor(end / 60) % 24).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
  }
  if (grain === "week") return `Week of ${longDate(key)}`;
  if (grain === "month") return fmt(key, { month: "long", year: "numeric" });
  return longDate(key);
}
