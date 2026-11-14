// Answering a report from parts. Every traffic metric is built from additive components (counts and sums), so a
// report over a range can be computed for pieces of the range separately (stored daily summaries, the closed days,
// today) and the pieces added up. Web Vitals are percentiles, which can't be added, so they're never split.
//
// Unique visitors are added across pieces too. Visitor hashes change every UTC day, so the sum over days is the count
// over the range, except that a visitor active either side of a local midnight that isn't a UTC midnight is counted
// in both local days. This is the same definition the all-sites overview's daily totals use.
import { SESSION_DIMENSIONS, TRAFFIC_METRICS, type Filter, type GroupBy, type Metric, type QuerySpec, type SessionDimension } from "./query";

/** Sums behind the ratio metrics. Internal: accepted by the query worker, never by the public API. */
export const RAW_METRICS = ["bounces", "duration_sum", "session_pageviews", "engaged_ms", "engaged_visitors", "scroll_sum", "scroll_n"] as const;
export type RawMetric = (typeof RAW_METRICS)[number];
/** The additive components: counts that are metrics in their own right, plus the raw sums. */
export type Component = "visitors" | "visits" | "pageviews" | "events" | RawMetric;
export const COMPONENTS: Component[] = ["visitors", "visits", "pageviews", "events", ...RAW_METRICS];

/** A query as the query worker accepts it from the main Worker (a superset of the public QuerySpec). */
export interface InternalSpec extends Omit<QuerySpec, "metrics"> {
  metrics: (Metric | RawMetric)[];
  /** With a dimension `groupBy`: one row per local day and value (`day`, then the dimension), keeping each day's top `perDay` rows. */
  perDay?: number;
  /** Read only what's in R2, and nothing from the day after the range: for closed days, whose answer then never changes. */
  noLive?: boolean;
}

const NEEDS: Partial<Record<Metric, Component[]>> = {
  visitors: ["visitors"],
  visits: ["visits"],
  pageviews: ["pageviews"],
  events: ["events"],
  views_per_visit: ["session_pageviews", "visits"],
  bounce_rate: ["bounces", "visits"],
  visit_duration: ["duration_sum", "visits"],
  scroll_depth: ["scroll_sum", "scroll_n"],
  time_on_page: ["engaged_ms", "engaged_visitors"],
};

const isSessionDim = (d: unknown): d is SessionDimension => (SESSION_DIMENSIONS as readonly string[]).includes(d as string);
const TIME_KEYS = ["quarter_hour", "hour", "day", "week", "month"];
export const isTimeKey = (g: GroupBy | null | undefined) => TIME_KEYS.includes(g ?? "");

/** Can this report be computed in pieces and added up? Everything except Web Vitals. */
export function canSplit(spec: QuerySpec): boolean {
  if (!spec.metrics.every((m) => (TRAFFIC_METRICS as string[]).includes(m))) return false;
  if (spec.groupBy && !isTimeKey(spec.groupBy) && spec.groupBy !== "weekhour" && spec.groupBy !== "page" && spec.groupBy !== "event" && !isSessionDim(spec.groupBy)) return false;
  return (spec.filters ?? []).every(([d]) => d === "page" || d === "event" || isSessionDim(d));
}

/** The components a report's metrics are built from: the one its rows are ranked by first. */
export function componentsFor(metrics: Metric[]): Component[] {
  const out: Component[] = [];
  for (const m of metrics) for (const c of NEEDS[m] ?? []) if (!out.includes(c)) out.push(c);
  return out;
}

/** How many rows a piece of a grouped report keeps: far more than any report shows, so the tail lost is negligible. */
export const PART_LIMIT = 2000;

/** The query for one piece of `spec`: the same grouping and filters over `range`, returning components. */
export function partSpec(spec: QuerySpec, range: Pick<InternalSpec, "from" | "to" | "since" | "until" | "noLive">): InternalSpec {
  return { from: range.from, to: range.to, since: range.since, until: range.until, metrics: componentsFor(spec.metrics), groupBy: spec.groupBy ?? null, filters: spec.filters ?? [], limit: PART_LIMIT, ...(range.noLive ? { noLive: true } : {}) };
}

export type Row = Record<string, string | number | null>;

const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0;
const ratio = (a: number, b: number, digits: number) => (b > 0 ? Math.round((a / b) * 10 ** digits) / 10 ** digits : 0);

function metricValue(m: Metric, c: Record<string, number>): number {
  switch (m) {
    case "views_per_visit": return ratio(c.session_pageviews, c.visits, 2);
    case "bounce_rate": return ratio(100 * c.bounces, c.visits, 1);
    case "visit_duration": return ratio(c.duration_sum, c.visits, 0);
    case "scroll_depth": return ratio(c.scroll_sum, c.scroll_n, 0);
    case "time_on_page": return ratio(c.engaged_ms / 1000, c.engaged_visitors, 0);
    default: return c[m] ?? 0;
  }
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The first day of the period (`day`, `week` from Monday, `month`) that `date` falls in. */
export function periodStart(date: string, key: "day" | "week" | "month"): string {
  if (key === "month") return `${date.slice(0, 7)}-01`;
  if (key === "week") return addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));
  return date;
}

export function nextPeriod(date: string, key: "day" | "week" | "month"): string {
  if (key === "day") return addDays(date, 1);
  if (key === "week") return addDays(date, 7);
  const [y, m] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

/**
 * Add up the pieces of a report and finish it: ratios from the summed components, every day/week/month in the range
 * present, rows ranked by the first metric and cut to the report's limit. Each piece is rows of components keyed by
 * the report's `groupBy` (no key for a report of totals).
 */
export function mergeParts(spec: QuerySpec, parts: Row[][]): Row[] {
  const key = spec.groupBy ?? null;
  const sums = new Map<string, { k: string | number | null; c: Record<string, number> }>();
  for (const rows of parts) {
    for (const r of rows) {
      const k = key ? r[key] ?? "" : "";
      let e = sums.get(String(k));
      if (!e) sums.set(String(k), (e = { k, c: {} }));
      for (const [name, v] of Object.entries(r)) if (name !== key) e.c[name] = (e.c[name] ?? 0) + n(v);
    }
  }
  const finish = (c: Record<string, number>) => Object.fromEntries(spec.metrics.map((m) => [m, metricValue(m, c)]));
  if (!key) return [finish(sums.get("")?.c ?? {})];

  if (key === "day" || key === "week" || key === "month") {
    const out: Row[] = [];
    for (let d = periodStart(spec.from, key); d <= spec.to; d = nextPeriod(d, key)) out.push({ [key]: d, ...finish(sums.get(d)?.c ?? {}) });
    return out;
  }
  const rows = [...sums.values()].map((e) => ({ [key]: e.k, ...finish(e.c) }) as Row);
  if (key === "hour" || key === "quarter_hour") return rows.sort((a, b) => (String(a[key]) < String(b[key]) ? -1 : 1));
  if (key === "weekhour") return rows.sort((a, b) => n(a[key]) - n(b[key]));
  const first = spec.metrics[0];
  rows.sort((a, b) => n(b[first]) - n(a[first]) || (String(a[key]) < String(b[key]) ? -1 : String(a[key]) > String(b[key]) ? 1 : 0));
  return rows.slice(0, spec.limit ?? 100);
}

// ---------- Stored daily summaries ----------

/** Session dimensions with a stored daily summary (the ones the site page breaks down by). */
export const SUMMARY_SESSION_DIMS: SessionDimension[] = [
  "source", "channel", "referrer", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
  "country", "city", "browser", "os", "os_version", "device", "entry_page", "exit_page",
];
/** What's summarised per local day: "" is the day's totals, "hour" its hours, the rest a row per value. */
export const SUMMARY_DIMS = ["", "hour", ...SUMMARY_SESSION_DIMS, "page", "event"] as const;
export type SummaryDim = (typeof SUMMARY_DIMS)[number];
/** Each day keeps this many rows per dimension (its biggest by visitors). */
export const SUMMARY_ROWS_PER_DAY = 500;

const SESSION_COMPONENTS: Component[] = ["visitors", "visits", "session_pageviews", "bounces", "duration_sum"];
/** The components stored for a summary dimension. */
export function summaryComponents(dim: SummaryDim): Component[] {
  if (dim === "" || dim === "hour") return COMPONENTS;
  if (dim === "page") return ["visitors", "pageviews", "engaged_ms", "engaged_visitors", "scroll_sum", "scroll_n"];
  if (dim === "event") return ["visitors", "events"];
  return SESSION_COMPONENTS;
}

/** A filter the summaries can apply: "has a value", on the dimension being grouped by (e.g. campaigns that aren't blank). */
const isNotBlank = (f: Filter, groupBy: GroupBy | null | undefined) => f[0] === groupBy && f[1] === "is_not" && f[2] === "";

/**
 * Which summary dimension answers this report, or null if the summaries can't (it's filtered, bounded to the second,
 * grouped by something not summarised, or asks for a metric that isn't stored for that grouping).
 */
export function summaryDimFor(spec: QuerySpec): SummaryDim | null {
  if (!canSplit(spec) || spec.since !== undefined || spec.until !== undefined) return null;
  const g = spec.groupBy ?? null;
  if (!(spec.filters ?? []).every((f) => isNotBlank(f, g))) return null;
  let dim: SummaryDim;
  if (g === null || g === "day" || g === "week" || g === "month") dim = "";
  else if (g === "weekhour") dim = "hour";
  else if ((SUMMARY_DIMS as readonly string[]).includes(g) && g !== "hour") dim = g as SummaryDim;
  else return null;
  if ((spec.filters ?? []).length && (dim === "" || dim === "hour")) return null;
  const stored = summaryComponents(dim);
  return componentsFor(spec.metrics).every((c) => stored.includes(c)) ? dim : null;
}
