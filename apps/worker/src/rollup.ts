// Daily totals per site (D1 `daily_stats`), computed from the Parquet store via the query worker.
import type { Env, Site } from "./env";
import { addDays, todayIn } from "./tz";

export interface DayStats {
  day: string;
  visitors: number;
  visits: number;
  pageviews: number;
  events: number;
  bounces: number;
  duration_sum: number;
}

const CHUNK_DAYS = 90; // keeps distinct counts exact and memory bounded

/** Fill `daily_stats` for every closed local day not yet rolled up (yesterday at most). */
export async function rollupSite(env: Env, site: Site, opts: { maxChunks?: number } = {}): Promise<{ from: string | null; to: string | null; days: number }> {
  const yesterday = addDays(todayIn(site.timezone), -1);
  const row = await env.DB.prepare(
    "SELECT (SELECT MAX(day) FROM daily_stats WHERE site_id = ?1) last, (SELECT substr(created_at, 1, 10) FROM sites WHERE id = ?1) created",
  )
    .bind(site.id)
    .first<{ last: string | null; created: string }>();
  let from = row?.last ? addDays(row.last, 1) : row?.created ?? yesterday;
  if (from > yesterday) return { from: null, to: null, days: 0 };
  const start = from;
  let written = 0;
  for (let chunks = 0; from <= yesterday && chunks < (opts.maxChunks ?? 100); chunks++) {
    const to = [addDays(from, CHUNK_DAYS - 1), yesterday].sort()[0];
    const res = await env.QUERY.query(site.id, site.timezone, {
      from, to, groupBy: "day",
      metrics: ["visitors", "visits", "pageviews", "events", "bounce_rate", "visit_duration"],
    });
    const stmts = res.rows.map((r) =>
      env.DB.prepare(
        "INSERT INTO daily_stats (site_id, day, visitors, visits, pageviews, events, bounces, duration_sum) VALUES (?,?,?,?,?,?,?,?) " +
          "ON CONFLICT(site_id, day) DO UPDATE SET visitors=excluded.visitors, visits=excluded.visits, pageviews=excluded.pageviews, events=excluded.events, bounces=excluded.bounces, duration_sum=excluded.duration_sum",
      ).bind(
        site.id, r.day, Number(r.visitors), Number(r.visits), Number(r.pageviews), Number(r.events),
        Math.round((Number(r.bounce_rate) * Number(r.visits)) / 100), Math.round(Number(r.visit_duration) * Number(r.visits)),
      ),
    );
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    written += stmts.length;
    from = addDays(to, 1);
  }
  return { from: start, to: addDays(from, -1), days: written };
}

export async function storedDays(env: Env, siteIds: number[], fromDay: string): Promise<Map<number, DayStats[]>> {
  const out = new Map<number, DayStats[]>(siteIds.map((id) => [id, []]));
  if (siteIds.length === 0) return out;
  const { results } = await env.DB.prepare(
    `SELECT site_id, day, visitors, visits, pageviews, events, bounces, duration_sum FROM daily_stats WHERE day >= ? AND site_id IN (${siteIds.map(() => "?").join(",")}) ORDER BY day`,
  )
    .bind(fromDay, ...siteIds)
    .all<DayStats & { site_id: number }>();
  for (const { site_id, ...d } of results) out.get(site_id)?.push(d);
  return out;
}
