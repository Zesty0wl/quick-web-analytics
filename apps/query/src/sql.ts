// Compiles a QuerySpec into one DuckDB SQL statement over the site's Parquet files.
//
// Each metric family comes from its own table (sessions, pageviews, custom, engagement) in a CTE
// grouped by the same key; CTEs are joined on that key. Filters on another table's columns are
// applied through session-id semi-joins.
import { COLUMNS, SESSION_DIMENSIONS, type Dimension, type Filter, type Metric, type QuerySpec, type SessionDimension, type TableName } from "@qwa/shared";
import { localTimeSql } from "./tz";

export interface SqlInput {
  spec: QuerySpec;
  from: number; // unix seconds, inclusive
  to: number; // unix seconds, exclusive
  segments: [number, number][]; // tz offset segments for [from, to)
  files: Record<TableName, string[]>; // file URLs per table
  approximate: boolean;
}

const isSessionDim = (d: string): d is SessionDimension => (SESSION_DIMENSIONS as readonly string[]).includes(d);

export const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

function source(table: TableName, files: string[]): string {
  if (files.length > 0) return `read_parquet([${files.map(quote).join(", ")}])`;
  // No data yet: an empty relation with the right columns.
  const cols = COLUMNS[table].map(([name, type]) => `${type === "STRING" ? "''" : "0::BIGINT"} AS ${name}`).join(", ");
  return `(SELECT ${cols} WHERE false)`;
}

function cond(col: string, op: Filter[1], value: Filter[2]): string {
  const values = Array.isArray(value) ? value : [value];
  if (op === "contains") {
    const any = values.map((v) => `contains(lower(${col}), ${quote(v.toLowerCase())})`).join(" OR ");
    return `(${any})`;
  }
  const list = values.map(quote).join(", ");
  return op === "is" ? `${col} IN (${list})` : `${col} NOT IN (${list})`;
}

const DIM_COLUMN: Record<Dimension, string> = Object.fromEntries([
  ...SESSION_DIMENSIONS.map((d) => [d, d]),
  ["page", "path"],
  ["event", "name"],
]) as Record<Dimension, string>;

export function buildSql(input: SqlInput): { sql: string; key: string | null } {
  const { spec, from, to, segments, files } = input;
  const filters = spec.filters ?? [];
  const groupBy = spec.groupBy ?? null;
  const distinct = (col: string) => (input.approximate ? `approx_count_distinct(${col})` : `COUNT(DISTINCT ${col})`);

  const range: Record<TableName, string> = {
    sessions: `start >= ${from} AND start < ${to}`,
    pageviews: `ts >= ${from} AND ts < ${to}`,
    engagement: `ts >= ${from} AND ts < ${to}`,
    custom: `ts >= ${from} AND ts < ${to}`,
  };
  // Sessions referenced from event tables may have started up to a day before the range.
  const sessionsForJoin = `SELECT * FROM src_sessions WHERE start >= ${from - 86_400} AND start < ${to}`;

  const sessionFilters = filters.filter(([d]) => isSessionDim(d));
  const pageFilters = filters.filter(([d]) => d === "page");
  const eventFilters = filters.filter(([d]) => d === "event");

  /** WHERE clauses for a CTE over `table` (aliased t). */
  function whereFor(table: TableName): string[] {
    const w = [range[table].replace(/\b(start|ts)\b/g, "t.$1")];
    if (table === "sessions") {
      for (const [d, op, v] of sessionFilters) w.push(cond(`t.${DIM_COLUMN[d]}`, op, v));
    } else if (sessionFilters.length) {
      w.push(`t.session IN (SELECT session FROM (${sessionsForJoin}) s WHERE ${sessionFilters.map(([d, op, v]) => cond(`s.${DIM_COLUMN[d]}`, op, v)).join(" AND ")})`);
    }
    for (const [, op, v] of pageFilters) {
      if (table === "sessions") {
        const inner = `SELECT session FROM src_pageviews p WHERE p.ts >= ${from} AND p.ts < ${to + 86_400} AND ${cond("p.path", op === "is_not" ? "is" : op, v)}`;
        w.push(op === "is_not" ? `t.session NOT IN (${inner})` : `t.session IN (${inner})`);
      } else {
        w.push(cond("t.path", op, v));
      }
    }
    for (const [, op, v] of eventFilters) {
      if (table === "custom") {
        w.push(cond("t.name", op, v));
      } else {
        const inner = `SELECT session FROM src_custom c WHERE c.ts >= ${from - 86_400} AND c.ts < ${to + 86_400} AND ${cond("c.name", op === "is_not" ? "is" : op, v)}`;
        w.push(op === "is_not" ? `t.session NOT IN (${inner})` : `t.session IN (${inner})`);
      }
    }
    return w;
  }

  /** Grouping key expression for a CTE over `table`; may need a join to sessions for the dimension. */
  function keyFor(table: TableName): { expr: string; join: string } | null {
    if (!groupBy) return null;
    const timeCol = table === "sessions" ? "t.start" : "t.ts";
    if (groupBy === "day") return { expr: `${localTimeSql(timeCol, segments)} // 86400`, join: "" };
    if (groupBy === "hour") return { expr: `${localTimeSql(timeCol, segments)} // 3600`, join: "" };
    if (groupBy === "weekhour") {
      const lt = localTimeSql(timeCol, segments);
      // 1970-01-01 was a Thursday, so (day + 3) % 7 makes Monday 0.
      return { expr: `((${lt} // 86400 + 3) % 7) * 24 + (${lt} // 3600) % 24`, join: "" };
    }
    // Weeks start on Monday; both return the local day number of the period's first day.
    if (groupBy === "week" || groupBy === "month") {
      return { expr: `epoch(date_trunc('${groupBy}', make_timestamp(${localTimeSql(timeCol, segments)} * 1000000)))::BIGINT // 86400`, join: "" };
    }
    if (isSessionDim(groupBy)) {
      if (table === "sessions") return { expr: `t.${groupBy}`, join: "" };
      return { expr: `s.${groupBy}`, join: `JOIN (${sessionsForJoin}) s ON s.session = t.session` };
    }
    return { expr: `t.${DIM_COLUMN[groupBy]}`, join: "" };
  }

  type Cte = { table: TableName; selects: string[] };
  const ctes = new Map<TableName, Cte>();
  const add = (table: TableName, select: string) => {
    const c = ctes.get(table) ?? { table, selects: [] };
    c.selects.push(select);
    ctes.set(table, c);
  };

  const visitorsTable: TableName = groupBy === "page" ? "pageviews" : groupBy === "event" ? "custom" : "sessions";
  const metricSql: Record<Metric, () => void> = {
    visitors: () => add(visitorsTable, `${distinct("t.visitor")} AS visitors`),
    visits: () => add("sessions", "COUNT(*) AS visits"),
    views_per_visit: () => add("sessions", "round(SUM(t.pageviews) / nullif(COUNT(*), 0), 2) AS views_per_visit"),
    bounce_rate: () => add("sessions", "round(100.0 * SUM(t.bounce) / nullif(COUNT(*), 0), 1) AS bounce_rate"),
    visit_duration: () => add("sessions", "round(AVG(t.duration)) AS visit_duration"),
    pageviews: () => add("pageviews", "COUNT(*) AS pageviews"),
    events: () => add("custom", "COUNT(*) AS events"),
    scroll_depth: () => add("engagement", "round(AVG(nullif(t.scroll_depth, 0))) AS scroll_depth"),
    time_on_page: () => add("engagement", `round(SUM(t.engaged_ms) / 1000.0 / nullif(${distinct("t.visitor")}, 0)) AS time_on_page`),
  };
  for (const m of spec.metrics) metricSql[m]();

  const used = new Set<TableName>([...ctes.keys()]);
  for (const f of filters) {
    if (f[0] === "page") used.add("pageviews");
    if (f[0] === "event") used.add("custom");
    if (isSessionDim(f[0])) used.add("sessions");
  }
  if (groupBy && isSessionDim(groupBy)) used.add("sessions");

  const withs: string[] = [];
  for (const t of used) withs.push(`src_${t} AS (SELECT * FROM ${source(t, files[t])})`);

  const order: TableName[] = [visitorsTable, "sessions", "pageviews", "custom", "engagement"].filter(
    (t, i, a) => ctes.has(t as TableName) && a.indexOf(t) === i,
  ) as TableName[];
  for (const t of order) {
    const c = ctes.get(t)!;
    const key = keyFor(t);
    withs.push(
      `m_${t} AS (SELECT ${key ? `${key.expr} AS k, ` : ""}${c.selects.join(", ")} FROM src_${t} t ${key?.join ?? ""} WHERE ${whereFor(t).join(" AND ")}${key ? " GROUP BY 1" : ""})`,
    );
  }

  const [main, ...rest] = order;
  const cols = spec.metrics.map((m) => `COALESCE(${m}, 0) AS ${m}`);
  let sql: string;
  if (!groupBy) {
    sql = `SELECT ${cols.join(", ")} FROM m_${main}${rest.map((t) => ` CROSS JOIN m_${t}`).join("")}`;
  } else {
    const keyCol = groupBy;
    const joins = rest.map((t) => ` LEFT JOIN m_${t} USING (k)`).join("");
    const isTime = groupBy === "day" || groupBy === "hour" || groupBy === "week" || groupBy === "month" || groupBy === "weekhour";
    const sortMetric = spec.metrics[0];
    const orderBy = isTime ? "k" : `${sortMetric} DESC, k`;
    const limit = isTime ? "" : ` LIMIT ${spec.limit ?? 100}`;
    sql = `SELECT k AS ${keyCol}, ${cols.join(", ")} FROM m_${main}${joins} ORDER BY ${orderBy}${limit}`;
  }
  return { sql: `WITH ${withs.join(",\n")}\n${sql}`, key: groupBy };
}
