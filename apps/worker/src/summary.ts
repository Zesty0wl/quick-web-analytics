// Daily summaries (D1 `daily_dims`): each closed local day's totals, hours and top rows per dimension, written once
// by the hourly job and read by the site page's standard reports (see answer.ts).
import {
  addDays, COMPONENTS, componentsFor, PART_LIMIT, periodStart, SUMMARY_DIMS, SUMMARY_ROWS_PER_DAY, summaryComponents,
  type Component, type InternalSpec, type QueryResult, type QuerySpec, type Row, type SummaryDim,
} from "@qwa/shared";
import type { LiveFiles } from "../../query/src/index";
import type { Env, Site } from "./env";
import { todayIn } from "./tz";

const CHUNK_DAYS = 31;
/** A day is summarised once it has been over for this long, so late events and the last flush to R2 are in. */
const SETTLE_MS = 2 * 3_600_000;

export interface SummaryState { timezone: string; from_day: string; through_day: string }

/** Run several queries in one call to the query worker (one sign-in, one set of files), in the order given. */
export async function queryAll(env: Env, site: Site, specs: InternalSpec[], live?: LiveFiles): Promise<QueryResult[]> {
  const out: (QueryResult | undefined)[] = new Array(specs.length);
  for await (const m of answers(await env.QUERY.queryMany(site.id, site.timezone, specs.map((spec, i) => ({ i, spec })), live))) {
    if (m.error !== undefined || !m.result) throw new Error(m.error ?? "query failed");
    out[m.i] = m.result;
  }
  if (out.some((r) => !r)) throw new Error("the query worker didn't answer every query");
  return out as QueryResult[];
}

/** The query worker's NDJSON answers, one at a time. */
export async function* answers(stream: ReadableStream<Uint8Array>): AsyncGenerator<{ i: number; result?: QueryResult; error?: string }> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buf.trim()) yield JSON.parse(buf);
}

export async function summaryState(env: Env, siteId: number): Promise<SummaryState | null> {
  return env.DB.prepare("SELECT timezone, from_day, through_day FROM summary_state WHERE site_id = ?").bind(siteId).first<SummaryState>();
}

const COLS = COMPONENTS.join(", ");
// One statement per chunk of rows: the rows travel as JSON, [dim, day, key, ...components].
const INSERT = `INSERT OR REPLACE INTO daily_dims (site_id, dim, day, key, ${COLS})
  SELECT ?1, j.value ->> 0, j.value ->> 1, j.value ->> 2, ${COMPONENTS.map((_, i) => `j.value ->> ${i + 3}`).join(", ")} FROM json_each(?2) j`;
const MAX_JSON = 400_000;

type Stored = [string, string, string, ...number[]];

/** The queries that summarise `from`..`to` (local days), and how to turn each answer into rows to store. */
function summaryQueries(from: string, to: string): { spec: InternalSpec; rows: (r: QueryResult) => Stored[] }[] {
  const values = (r: Row) => COMPONENTS.map((c) => Number(r[c] ?? 0) || 0);
  const any = (v: number[]) => v.some((x) => x !== 0);
  return SUMMARY_DIMS.map((dim) => {
    if (dim === "") {
      return { spec: { from, to, groupBy: "day", metrics: COMPONENTS }, rows: (r) => r.rows.map((x) => ["", String(x.day), "", ...values(x)] as Stored).filter((x) => any(x.slice(3) as number[])) };
    }
    if (dim === "hour") {
      // Hour labels are "YYYY-MM-DD HH:00".
      return { spec: { from, to, groupBy: "hour", metrics: COMPONENTS }, rows: (r) => r.rows.map((x) => ["hour", String(x.hour).slice(0, 10), String(x.hour).slice(11, 13), ...values(x)] as Stored).filter((x) => any(x.slice(3) as number[])) };
    }
    return {
      spec: { from, to, groupBy: dim, metrics: summaryComponents(dim), perDay: SUMMARY_ROWS_PER_DAY },
      rows: (r) => r.rows.map((x) => [dim, String(x.day), String(x[dim] ?? ""), ...values(x)] as Stored),
    };
  });
}

/**
 * Summarise the closed local days not yet summarised, oldest first, a month at a time, up to `maxChunks` months
 * (a site's whole history the first time, over several runs). Starts at the site's first day with traffic, which the
 * nightly rollup finds; until that has run there's nothing to do.
 */
export async function summariseSite(env: Env, site: Site, opts: { maxChunks?: number; now?: number } = {}): Promise<{ days: number; rows: number; chunks: number; done: boolean }> {
  const now = opts.now ?? Date.now();
  const target = addDays(todayIn(site.timezone, now - SETTLE_MS), -1);
  let state = await summaryState(env, site.id);
  if (state && state.timezone !== site.timezone) {
    await env.DB.batch([env.DB.prepare("DELETE FROM daily_dims WHERE site_id = ?").bind(site.id), env.DB.prepare("DELETE FROM summary_state WHERE site_id = ?").bind(site.id)]);
    state = null;
  }
  let from: string;
  if (state) {
    from = addDays(state.through_day, 1);
  } else {
    const first = await env.DB.prepare("SELECT MIN(day) day FROM daily_stats WHERE site_id = ? AND (visitors > 0 OR pageviews > 0)").bind(site.id).first<{ day: string | null }>();
    if (!first?.day) return { days: 0, rows: 0, chunks: 0, done: true };
    from = first.day;
  }
  const start = state?.from_day ?? from;
  let days = 0, rows = 0, chunks = 0;
  for (; from <= target && chunks < (opts.maxChunks ?? 1); chunks++) {
    const to = [addDays(from, CHUNK_DAYS - 1), target].sort()[0];
    const queries = summaryQueries(from, to);
    const results = await queryAll(env, site, queries.map((q) => q.spec));
    const stored = queries.flatMap((q, i) => q.rows(results[i]));
    const stmts = [env.DB.prepare("DELETE FROM daily_dims WHERE site_id = ? AND day >= ? AND day <= ?").bind(site.id, from, to)];
    let batch: Stored[] = [], size = 0;
    const flush = () => {
      if (batch.length) stmts.push(env.DB.prepare(INSERT).bind(site.id, JSON.stringify(batch)));
      batch = [];
      size = 0;
    };
    for (const r of stored) {
      batch.push(r);
      size += r[2].length + 120;
      if (size > MAX_JSON) flush();
    }
    flush();
    stmts.push(
      env.DB.prepare("INSERT INTO summary_state (site_id, timezone, from_day, through_day) VALUES (?, ?, ?, ?) ON CONFLICT(site_id) DO UPDATE SET through_day = excluded.through_day").bind(site.id, site.timezone, start, to),
    );
    await env.DB.batch(stmts); // one transaction: a chunk is stored whole or not at all
    states.delete(site.id);
    rows += stored.length;
    days += (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
    from = addDays(to, 1);
  }
  return { days, rows, chunks, done: from > target };
}

/** Summarise sites that are behind, sharing `budget` months of work between them (each month is ~20 queries). */
export async function summaryJob(env: Env, sites: Site[], budget = 12): Promise<void> {
  for (const site of sites) {
    if (budget <= 0) break;
    try {
      const r = await summariseSite(env, site, { maxChunks: budget });
      budget -= r.chunks;
      if (r.days) console.log("summarised", site.domain, JSON.stringify(r));
    } catch (e) {
      console.error("summary failed", site.domain, e);
    }
  }
}

// How far each site's summaries go, kept briefly per isolate: it only moves when the job above runs.
const STATE_TTL_MS = 60_000;
const states = new Map<number, { at: number; state: SummaryState | null }>();

export async function cachedSummaryState(env: Env, siteId: number): Promise<SummaryState | null> {
  const hit = states.get(siteId);
  if (hit && Date.now() - hit.at < STATE_TTL_MS) return hit.state;
  const state = await summaryState(env, siteId).catch((e) => {
    console.warn("summary state unavailable", e); // e.g. the migration hasn't been applied yet: answer from the events
    return null;
  });
  states.set(siteId, { at: Date.now(), state });
  return state;
}

/**
 * The stored part of a report: a statement over `from`..`to` (local days, all summarised) and how to read its rows as
 * a piece for mergeParts, keyed by the report's `groupBy`.
 */
export function summaryRead(env: Env, siteId: number, spec: QuerySpec, dim: SummaryDim, from: string, to: string): { stmt: D1PreparedStatement; rows: (results: Record<string, unknown>[]) => Row[] } {
  const comps = componentsFor(spec.metrics);
  const g = spec.groupBy ?? null;
  const pick = (r: Record<string, unknown>) => Object.fromEntries(comps.map((c) => [c, Number(r[c] ?? 0)])) as Record<Component, number>;
  const where = "site_id = ?1 AND dim = ?2 AND day >= ?3 AND day <= ?4";
  if (g === null) {
    return {
      stmt: env.DB.prepare(`SELECT ${comps.map((c) => `COALESCE(SUM(${c}), 0) ${c}`).join(", ")} FROM daily_dims WHERE ${where}`).bind(siteId, dim, from, to),
      rows: (res) => res.map(pick),
    };
  }
  if (g === "day" || g === "week" || g === "month") {
    return {
      stmt: env.DB.prepare(`SELECT day, ${comps.join(", ")} FROM daily_dims WHERE ${where}`).bind(siteId, dim, from, to),
      rows: (res) => res.map((r) => ({ [g]: periodStart(String(r.day), g), ...pick(r) })),
    };
  }
  if (g === "weekhour") {
    return {
      stmt: env.DB.prepare(`SELECT day, key, ${comps.join(", ")} FROM daily_dims WHERE ${where}`).bind(siteId, dim, from, to),
      // Monday is 0.
      rows: (res) => res.map((r) => ({ weekhour: ((new Date(`${r.day}T00:00:00Z`).getUTCDay() + 6) % 7) * 24 + Number(r.key), ...pick(r) })),
    };
  }
  const notBlank = (spec.filters ?? []).length ? " AND key <> ''" : "";
  return {
    stmt: env.DB.prepare(
      `SELECT key, ${comps.map((c) => `SUM(${c}) ${c}`).join(", ")} FROM daily_dims WHERE ${where}${notBlank} GROUP BY key ORDER BY SUM(${comps[0]}) DESC, key LIMIT ${PART_LIMIT}`,
    ).bind(siteId, dim, from, to),
    rows: (res) => res.map((r) => ({ [g]: String(r.key), ...pick(r) })),
  };
}
