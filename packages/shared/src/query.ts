// The QWA query spec: used by the dashboard, the API (/api/v1) and MCP tools.

export const METRICS = [
  "visitors", "visits", "pageviews", "views_per_visit", "bounce_rate", "visit_duration",
  "events", "scroll_depth", "time_on_page",
] as const;
export type Metric = (typeof METRICS)[number];

export const SESSION_DIMENSIONS = [
  "source", "channel", "referrer", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
  "country", "region", "city", "browser", "browser_version", "os", "os_version", "device",
  "entry_page", "exit_page", "hostname",
] as const;
export type SessionDimension = (typeof SESSION_DIMENSIONS)[number];
export type Dimension = SessionDimension | "page" | "event";
export const DIMENSIONS: Dimension[] = [...SESSION_DIMENSIONS, "page", "event"];

export type TimeGrain = "hour" | "day" | "week" | "month";
export const TIME_GRAINS: TimeGrain[] = ["hour", "day", "week", "month"];
/** "weekhour": local weekday × hour of day, key = weekday (0 = Monday) * 24 + hour. */
export type GroupBy = Dimension | TimeGrain | "weekhour";
export type FilterOp = "is" | "is_not" | "contains";
export type Filter = [Dimension, FilterOp, string | string[]];

export interface QuerySpec {
  /** Inclusive local dates in the site's timezone. */
  from: string;
  to: string;
  metrics: Metric[];
  groupBy?: GroupBy | null;
  filters?: Filter[];
  limit?: number;
}

export interface QueryResult {
  rows: Record<string, string | number | null>[];
  meta: { from: string; to: string; timezone: string; ms: number; files: number };
}

/** Which metrics can be computed for a given grouping. */
export function allowedMetrics(groupBy: GroupBy | null | undefined): readonly Metric[] {
  if (groupBy === "page") return ["visitors", "pageviews", "scroll_depth", "time_on_page"];
  if (groupBy === "event") return ["visitors", "events"];
  return METRICS;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateSpec(input: unknown): QuerySpec {
  if (!input || typeof input !== "object") throw new Error("query must be an object");
  const q = input as Record<string, unknown>;
  if (typeof q.from !== "string" || !DATE.test(q.from)) throw new Error("from must be YYYY-MM-DD");
  if (typeof q.to !== "string" || !DATE.test(q.to)) throw new Error("to must be YYYY-MM-DD");
  if (q.from > q.to) throw new Error("from must not be after to");
  const groupBy = (q.groupBy ?? null) as GroupBy | null;
  if (groupBy !== null && groupBy !== "weekhour" && !TIME_GRAINS.includes(groupBy as TimeGrain) && !DIMENSIONS.includes(groupBy as Dimension)) {
    throw new Error(`unknown groupBy: ${groupBy}`);
  }
  const metrics = Array.isArray(q.metrics) && q.metrics.length ? (q.metrics as string[]) : ["visitors"];
  const allowed = allowedMetrics(groupBy);
  for (const m of metrics) {
    if (!allowed.includes(m as Metric)) throw new Error(`metric ${m} is not available when grouping by ${groupBy ?? "nothing"}`);
  }
  const filters = Array.isArray(q.filters) ? (q.filters as unknown[]) : [];
  for (const f of filters) {
    if (!Array.isArray(f) || f.length !== 3) throw new Error("filter must be [dimension, op, value]");
    const [dim, op, value] = f;
    if (!DIMENSIONS.includes(dim as Dimension)) throw new Error(`unknown filter dimension: ${dim}`);
    if (op !== "is" && op !== "is_not" && op !== "contains") throw new Error(`unknown filter op: ${op}`);
    const values = Array.isArray(value) ? value : [value];
    if (values.length === 0 || values.length > 50 || values.some((v) => typeof v !== "string" || v.length > 500)) {
      throw new Error("filter value must be a string or a list of up to 50 strings");
    }
  }
  const limit = q.limit === undefined ? undefined : Number(q.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) throw new Error("limit must be 1–1000");
  return { from: q.from, to: q.to, metrics: metrics as Metric[], groupBy, filters: filters as Filter[], limit };
}
