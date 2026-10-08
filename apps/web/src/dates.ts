// Date ranges are local calendar dates in the site's timezone.
import type { TimeGrain } from "@qwa/shared";

export function todayIn(tz?: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

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
  { id: "7d", label: "7D", long: "Last 7 days" },
  { id: "30d", label: "30D", long: "Last 30 days" },
  { id: "90d", label: "90D", long: "Last 90 days" },
  { id: "12m", label: "12M", long: "Last 12 months" },
] as const;
export type Preset = (typeof PRESETS)[number]["id"];
export type Range = Preset | "custom";
export type Compare = "prev" | "year";

export function presetRange(preset: Preset, tz?: string): { from: string; to: string } {
  const today = todayIn(tz);
  const back = { today: 0, "7d": 6, "30d": 29, "90d": 89, "12m": 364 }[preset];
  return { from: addDays(today, -back), to: today };
}

export function comparisonRange(from: string, to: string, mode: Compare): { from: string; to: string } {
  if (mode === "year") return { from: addYears(from, -1), to: addYears(to, -1) };
  const n = daysBetween(from, to);
  return { from: addDays(from, -n), to: addDays(from, -1) };
}

/** Grains that make sense for a range, and the default one. */
export function grainsFor(from: string, to: string): { allowed: TimeGrain[]; auto: TimeGrain } {
  const n = daysBetween(from, to);
  const allowed: TimeGrain[] = [];
  if (n <= 7) allowed.push("hour");
  if (n >= 2 && n <= 400) allowed.push("day");
  if (n >= 14) allowed.push("week");
  if (n >= 60) allowed.push("month");
  const auto: TimeGrain = n <= 7 ? "hour" : n <= 120 ? "day" : n <= 400 ? "week" : "month";
  return { allowed, auto };
}

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
  const n = daysBetween(from, to);
  return range === "12m" ? "the previous 12 months" : `the previous ${n} days`;
}

export function bucketLabel(key: string, grain: TimeGrain): string {
  if (grain === "hour") return key.slice(11, 16) === "00:00" ? shortDate(key.slice(0, 10)) : key.slice(11, 16);
  if (grain === "month") return fmt(key, { month: "short", year: "2-digit" });
  return shortDate(key);
}

export function bucketTitle(key: string, grain: TimeGrain): string {
  if (grain === "hour") return `${longDate(key.slice(0, 10))}, ${key.slice(11, 16)}`;
  if (grain === "week") return `Week of ${longDate(key)}`;
  if (grain === "month") return fmt(key, { month: "long", year: "numeric" });
  return longDate(key);
}
