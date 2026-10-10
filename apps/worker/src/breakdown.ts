// One breakdown (e.g. events by name) across several sites, for the overview's drill-down: each site's rows for the
// period, with the first metric's value in the comparison period beside them.
import type { Dimension, QueryResult } from "@qwa/shared";

export interface BreakdownRow {
  site: number;
  key: string;
  values: Record<string, number>;
  /** The first metric in the comparison period (0 if the key didn't appear then). */
  previous: number;
}

/** Join a site's current and comparison rows on the dimension's value. */
export function joinRows(site: number, dim: Dimension, metrics: string[], cur: QueryResult, prev: QueryResult): BreakdownRow[] {
  const before = new Map(prev.rows.map((r) => [String(r[dim] ?? ""), Number(r[metrics[0]] ?? 0)]));
  return cur.rows.map((r) => ({
    site,
    key: String(r[dim] ?? ""),
    values: Object.fromEntries(metrics.map((m) => [m, Number(r[m] ?? 0)])),
    previous: before.get(String(r[dim] ?? "")) ?? 0,
  }));
}
