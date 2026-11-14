// Answering the dashboard's reports as cheaply as each allows:
//
//   "summary"  no filters, a grouping that's summarised: the closed days from D1's daily summaries (summary.ts), and
//              only the days after them (today, usually) from the events.
//   "split"    anything else that adds up (filters, hourly charts…): the closed days as one query whose answer never
//              changes, so the query worker keeps it, plus the days still receiving events.
//   "direct"   Web Vitals (percentiles don't add up) and ranges with nothing closed in them: one query, as before.
//
// Either way the pieces are added up by mergeParts (@qwa/shared partial.ts).
import { addDays, canSplit, mergeParts, partSpec, summaryDimFor, type InternalSpec, type QueryPerf, type QueryResult, type QuerySpec, type Row } from "@qwa/shared";
import type { LiveFiles } from "../../query/src/index";
import type { Env, Site } from "./env";
import { answers, cachedSummaryState, summaryRead } from "./summary";
import { todayIn } from "./tz";

export type Answer = { i: number; result: QueryResult } | { i: number; error: string };

/** The last local day wholly before the first day with events not yet in R2 (null: nothing is waiting, every day is closed). */
export function lastClosedDay(timezone: string, live: LiveFiles | undefined): string | null {
  const days = Object.keys(live?.files ?? {}).map((k) => k.match(/\/day\/(\d{4}-\d{2}-\d{2})\.parquet$/)?.[1]).filter((d): d is string => !!d);
  if (!days.length) return null;
  const liveStart = Date.parse(`${days.sort()[0]}T00:00:00Z`);
  return addDays(todayIn(timezone, liveStart), -1);
}

interface Plan {
  spec: QuerySpec;
  source: "summary" | "split" | "direct";
  /** Pieces from the query worker (indexes into the batch sent to it) and from D1 (indexes into the D1 batch). */
  queries: number[];
  stored: number[];
}

function addPerf(a: QueryPerf | undefined, b: QueryPerf | undefined): QueryPerf | undefined {
  if (!a || !b) return a ?? b;
  const sum = (k: keyof QueryPerf) => (Number(a[k] ?? 0) + Number(b[k] ?? 0)) || undefined;
  return {
    duckMs: a.duckMs + b.duckMs, r2Reads: a.r2Reads + b.r2Reads, r2Kb: a.r2Kb + b.r2Kb, cacheHits: a.cacheHits + b.cacheHits, ioMs: a.ioMs + b.ioMs,
    prefetched: sum("prefetched"), prefetchKb: sum("prefetchKb"), prefetchMs: sum("prefetchMs"), ...(a.cold || b.cold ? { cold: true } : {}),
  };
}

/**
 * Answer `specs` for one site, each as soon as it's ready. `live` is the site's not-yet-flushed days (when any range
 * reaches them). `direct` skips the summaries and splitting: every report as one query over the events (for checking
 * one against the other).
 */
export async function* answerMany(env: Env, site: Site, specs: { i: number; spec: QuerySpec }[], live: LiveFiles | undefined, opts: { direct?: boolean } = {}): AsyncGenerator<Answer> {
  const started = Date.now();
  const state = opts.direct ? null : await cachedSummaryState(env, site.id);
  const closed = lastClosedDay(site.timezone, live);
  const queries: { i: number; spec: InternalSpec }[] = [];
  const stored: ReturnType<typeof summaryRead>[] = [];
  const plans = new Map<number, Plan>();
  const ask = (spec: InternalSpec) => queries.push({ i: queries.length, spec }) - 1;

  for (const { i, spec } of specs) {
    const plan: Plan = { spec, source: "direct", queries: [], stored: [] };
    plans.set(i, plan);
    const dim = opts.direct ? null : summaryDimFor(spec);
    const through = state && state.timezone === site.timezone && spec.from >= state.from_day ? [state.through_day, spec.to].sort()[0] : null;
    if (dim !== null && through !== null && through >= spec.from) {
      plan.source = "summary";
      plan.stored.push(stored.push(summaryRead(env, site.id, spec, dim, spec.from, through)) - 1);
      if (through < spec.to) plan.queries.push(ask(partSpec(spec, { from: addDays(through, 1), to: spec.to })));
    } else if (!opts.direct && canSplit(spec) && closed !== null && closed >= spec.from && closed < spec.to) {
      plan.source = "split";
      plan.queries.push(ask(partSpec(spec, { from: spec.from, to: closed, since: spec.since, noLive: true })));
      plan.queries.push(ask(partSpec(spec, { from: addDays(closed, 1), to: spec.to, until: spec.until })));
    } else {
      plan.queries.push(ask(spec));
    }
  }

  // The stored pieces: one round trip to D1 for all of them.
  let storedRows: Row[][] = [];
  let storedError: string | null = null;
  const storedDone = stored.length
    ? env.DB.batch(stored.map((s) => s.stmt)).then(
        (res) => void (storedRows = res.map((r, k) => stored[k].rows(r.results as Record<string, unknown>[]))),
        (e) => void (storedError = `summaries unavailable: ${(e as Error).message}`),
      )
    : Promise.resolve();

  const got = new Map<number, QueryResult | { error: string }>();
  const sent = new Set<number>();
  function* ready(): Generator<Answer> {
    for (const [i, plan] of plans) {
      if (sent.has(i) || !plan.queries.every((q) => got.has(q))) continue;
      sent.add(i);
      const parts = plan.queries.map((q) => got.get(q)!);
      const failed = parts.find((p): p is { error: string } => "error" in p);
      if (failed || (plan.stored.length && storedError)) {
        yield { i, error: failed?.error ?? storedError! };
        continue;
      }
      const results = parts as QueryResult[];
      if (plan.source === "direct") {
        yield { i, result: { ...results[0], meta: { ...results[0].meta, source: "direct" } } };
        continue;
      }
      const rows = mergeParts(plan.spec, [...plan.stored.map((k) => storedRows[k] ?? []), ...results.map((r) => r.rows)]);
      yield {
        i,
        result: {
          rows,
          meta: {
            from: plan.spec.from, to: plan.spec.to, timezone: site.timezone, ms: Date.now() - started,
            files: results.reduce((n, r) => n + r.meta.files, 0),
            ...(results.every((r) => r.meta.cached) ? { cached: true } : {}),
            source: plan.source,
            ...(results.length ? { perf: results.map((r) => r.meta.perf).reduce(addPerf, undefined) } : {}),
          },
        },
      };
    }
  }

  await storedDone;
  yield* ready(); // reports wholly from the summaries
  if (queries.length) {
    try {
      for await (const m of answers(await env.QUERY.queryMany(site.id, site.timezone, queries, live))) {
        got.set(m.i, m.result ?? { error: m.error ?? "query failed" });
        yield* ready();
      }
    } catch (e) {
      console.error("query worker failed", e);
    }
    for (const q of queries) if (!got.has(q.i)) got.set(q.i, { error: "The server didn't answer this query. Try again." });
    yield* ready();
  }
}
