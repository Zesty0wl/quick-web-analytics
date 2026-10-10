import { useQuery, useQueryClient, type Query } from "@tanstack/react-query";
import type { Filter, GroupBy, Metric, QueryResult } from "@qwa/shared";
import { addDays, todayIn } from "./dates";

export interface Me {
  user: { id: number; email: string; name: string | null; role: "admin" | "viewer" };
  sites: { id: number; domain: string; timezone: string }[];
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const TIMEOUT_MS = 60_000;

function networkError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  const name = (e as Error).name;
  if (name === "TimeoutError" || name === "AbortError") return new ApiError("This took over a minute, so it was stopped. Try a shorter date range.", 504);
  return new ApiError("Couldn't reach the server. Check your connection and try again.", 0);
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      credentials: "same-origin",
      // Never leave a panel spinning forever on a stuck request.
      signal: init?.signal ?? AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw networkError(e);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? res.statusText, res.status);
  return body as T;
}

export const useMe = () => useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/me"), retry: false });

export interface StatsQuery {
  from: string;
  to: string;
  metrics: Metric[];
  groupBy?: GroupBy | null;
  filters?: Filter[];
  limit?: number;
}

// ---------- Report queries: batched, cached while the data can't change, refreshed live while it can ----------

const BATCH_WINDOW_MS = 8;
const MAX_BATCH = 40;

type Waiting = { spec: StatsQuery; resolve: (r: QueryResult) => void; reject: (e: Error) => void };
const queued = new Map<number, Waiting[]>();

/** Split streamed text into complete lines and the unfinished rest. */
export function splitLines(text: string): { lines: string[]; rest: string } {
  const parts = text.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.filter((l) => l.trim() !== ""), rest };
}

/**
 * Run a report query. Queries asked for within a few milliseconds of each other (a page's worth) go to the server in
 * one request, and each resolves as soon as its own answer streams back.
 */
export function loadStats(siteId: number, spec: StatsQuery): Promise<QueryResult> {
  return new Promise((resolve, reject) => {
    let q = queued.get(siteId);
    if (!q) {
      queued.set(siteId, (q = []));
      setTimeout(() => {
        const all = queued.get(siteId) ?? [];
        queued.delete(siteId);
        for (let i = 0; i < all.length; i += MAX_BATCH) void sendBatch(siteId, all.slice(i, i + MAX_BATCH));
      }, BATCH_WINDOW_MS);
    }
    q.push({ spec, resolve, reject });
  });
}

async function sendBatch(siteId: number, items: Waiting[]): Promise<void> {
  if (items.length === 1) {
    api<QueryResult>(`/sites/${siteId}/query`, { method: "POST", body: JSON.stringify(items[0].spec) }).then(items[0].resolve, items[0].reject);
    return;
  }
  const settled = new Set<number>();
  const settle = (i: number, fn: () => void) => {
    if (!items[i] || settled.has(i)) return;
    settled.add(i);
    fn();
  };
  // The minute's timeout restarts with every answer, so a long batch isn't cut off while it's still answering.
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(`/api/sites/${siteId}/batch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ queries: items.map((x) => x.spec) }),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw networkError(e);
    }
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(body.error ?? res.statusText, res.status);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read().catch((e) => { throw networkError(e); });
      if (done) break;
      clearTimeout(timer);
      timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const { lines, rest } = splitLines(buf + value);
      buf = rest;
      for (const line of lines) {
        const m = JSON.parse(line) as { i: number; result?: QueryResult; error?: string; status?: number };
        settle(m.i, () => (m.result ? items[m.i].resolve(m.result) : items[m.i].reject(new ApiError(m.error ?? "query failed", m.status ?? 502))));
      }
    }
    throw new ApiError("The server didn't answer this query. Try again.", 502);
  } catch (e) {
    const err = networkError(e);
    items.forEach((it, i) => settle(i, () => it.reject(err)));
  } finally {
    clearTimeout(timer);
  }
}

export interface SiteRef {
  id: number;
  timezone: string;
}

/** How quickly a report follows new events: "fast" for the headline numbers and chart, "slow" for the sections. */
export type Freshness = "fast" | "slow";
export const FRESHNESS_MS: Record<Freshness, number> = { fast: 10_000, slow: 30_000 };
/** Even without word of new events (e.g. the live connection is down), reports reaching today refresh this often. */
export const FALLBACK_REFRESH_MS = 5 * 60_000;

/** A report's answer, plus the site's data version when it was asked for. */
export type Stats = QueryResult & { version?: string };

/** Does this range reach today in the site's timezone (so new events still change it)? */
export const isLive = (q: { to: string }, tz: string) => q.to >= todayIn(tz);

export function useStats(site: SiteRef | undefined, q: StatsQuery, opts: { enabled?: boolean; freshness?: Freshness } = {}) {
  const qc = useQueryClient();
  const today = site ? todayIn(site.timezone) : "";
  return useQuery({
    queryKey: ["stats", site?.id, q],
    queryFn: async (): Promise<Stats> => {
      const version = qc.getQueryData<Realtime>(["realtime", site!.id])?.version;
      return { ...(await loadStats(site!.id, q)), version };
    },
    enabled: (opts.enabled ?? true) && site !== undefined,
    // Ranges before yesterday never change. Yesterday can still gain a little (visits running past midnight).
    // Ranges reaching today are refreshed by useLiveUpdates as events arrive.
    staleTime: q.to === addDays(today, -1) ? 60 * 60_000 : Infinity,
    meta: { freshness: opts.freshness ?? "slow" },
    placeholderData: (prev) => prev,
  });
}

/**
 * Which of a site's on-screen live reports to refresh now: those asked for before the latest data version, once they're
 * older than their freshness interval (or older than the fallback interval regardless). `baseline` stands in for the
 * version of answers fetched before any version was known.
 */
export function staleLiveQueries(queries: Query[], tz: string, version: string | undefined, baseline: string | undefined, now = Date.now()): Query[] {
  return queries.filter((q) => {
    const spec = q.queryKey[2] as StatsQuery | undefined;
    const data = q.state.data as Stats | undefined;
    if (!spec || !data || q.state.fetchStatus !== "idle" || !isLive(spec, tz)) return false;
    const age = now - q.state.dataUpdatedAt;
    if (age >= FALLBACK_REFRESH_MS) return true;
    const changed = version !== undefined && (data.version ?? baseline) !== version;
    return changed && age >= FRESHNESS_MS[(q.meta?.freshness as Freshness | undefined) ?? "slow"];
  });
}

export interface DayStats {
  day: string;
  visitors: number;
  visits: number;
  pageviews: number;
  events: number;
  bounces: number;
  duration_sum: number;
}

export type AnomalyKind = "spike" | "drop" | "outage";
export interface Anomaly {
  day: string;
  kind: AnomalyKind;
  value: number;
  expected: number;
  /** "visitors": a whole day (nightly check); "intraday": the day so far (hourly check). */
  metric?: "visitors" | "intraday";
  detail?: { hour: number; window: "today" | "last3h" } | null;
}

export interface OverviewSite {
  id: number;
  domain: string;
  timezone: string;
  lastEventAt: number | null;
  lastActiveDay: string | null;
  now: number;
  perMinute: number[];
  current: DayStats[];
  comparison: DayStats[];
  anomalies: Anomaly[];
  /** Unix seconds when the site hit its daily event cap today (recording paused), if it did. */
  cappedAt: number | null;
  plausible14d?: number;
  /** Unix seconds of the last event through each front door (admins only). */
  plausibleLastAt?: number | null;
  qwaLastAt?: number | null;
  qwa14d?: number;
}

export const useOverview = (r: { from: string; to: string; cfrom: string; cto: string }) =>
  useQuery({
    queryKey: ["overview", r],
    queryFn: () => api<{ sites: OverviewSite[] }>(`/overview?${new URLSearchParams(r)}`),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    staleTime: 10_000,
    placeholderData: (prev) => prev,
  });

export function useAnomalies(siteId: number, from: string, to: string) {
  return useQuery({
    queryKey: ["anomalies", siteId, from, to],
    queryFn: () => api<{ anomalies: Anomaly[] }>(`/sites/${siteId}/anomalies?from=${from}&to=${to}`),
    staleTime: 10 * 60_000,
    placeholderData: (prev) => prev,
  });
}

export const useAlerts = () => useQuery({ queryKey: ["alerts"], queryFn: () => api<{ email: boolean; all: boolean; sites: number[] }>("/alerts") });

export interface Realtime {
  /** Changes whenever the site stores an event. */
  version?: string;
  cappedAt: number | null;
  /** Unix seconds of the last event through each front door (admins only). */
  plausibleLastAt?: number | null;
  qwaLastAt?: number | null;
  visitors5m: number;
  visitors30m: number;
  perMinute: number[];
  pages: { path: string; visitors: number }[];
  sources: { name: string; visitors: number }[];
  countries: { name: string; visitors: number }[];
}

/** The site's live numbers. Pushed over a WebSocket by useLiveUpdates; `poll` fetches them instead while that's down. */
export function useRealtime(siteId: number | undefined, poll = true) {
  return useQuery({
    queryKey: ["realtime", siteId],
    queryFn: () => api<Realtime>(`/sites/${siteId}/realtime`),
    enabled: siteId !== undefined && poll,
    refetchInterval: poll ? 10_000 : false,
    refetchOnWindowFocus: poll,
  });
}

// ---------- Google: Search Console and speed ----------

export interface SearchTotals {
  clicks: number;
  impressions: number;
  /** 0–1 */
  ctr: number;
  /** Average position in Google results (1 = top). */
  position: number;
}
export interface SearchDay extends SearchTotals {
  day: string;
}
export type SearchSummary =
  | { status: "not-connected" }
  | { status: "no-property"; account: string }
  | { status: "ok"; property: string; totals: SearchTotals; previous: SearchTotals; series: SearchDay[]; prevSeries: SearchDay[]; latest: string | null };

export interface SearchRow extends SearchTotals {
  key: string;
  prevClicks: number;
  /** Pages: the full URL, and whether it is on this site (so it can become a page filter). */
  url?: string;
  local?: boolean;
}
export type SearchDim = "query" | "page" | "country" | "device";
export interface SearchParams {
  from: string;
  to: string;
  cfrom: string;
  cto: string;
  page?: string;
  query?: string;
}

const searchQs = (p: SearchParams & { dim?: string; limit?: number }) =>
  new URLSearchParams(Object.entries(p).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));

export function useSearch(siteId: number, p: SearchParams, enabled: boolean) {
  return useQuery({
    queryKey: ["search", siteId, p],
    queryFn: () => api<SearchSummary>(`/sites/${siteId}/search?${searchQs(p)}`),
    enabled,
    staleTime: 30 * 60_000,
    placeholderData: (prev) => prev,
    retry: 1,
  });
}

export function useSearchRows(siteId: number, p: SearchParams & { dim: SearchDim; limit?: number }, enabled: boolean) {
  return useQuery({
    queryKey: ["search-rows", siteId, p],
    queryFn: () => api<{ status: string; rows?: SearchRow[] }>(`/sites/${siteId}/search/rows?${searchQs(p)}`),
    enabled,
    staleTime: 30 * 60_000,
    placeholderData: (prev) => prev,
    retry: 1,
  });
}

export interface LabMetrics { lcp: number | null; cls: number | null; tbt: number | null; fcp: number | null; si: number | null; ttfb: number | null }
export interface FieldMetrics { scope: "url" | "origin"; lcp: number | null; inp: number | null; cls: number | null; fcp: number | null; ttfb: number | null; verdict: "FAST" | "AVERAGE" | "SLOW" | null }
export interface SpeedRun {
  url: string;
  strategy: "mobile" | "desktop";
  runAt: number;
  score: number | null;
  lab: LabMetrics;
  field: FieldMetrics | null;
  opportunities: { id: string; title: string; savingsMs: number }[];
}
export interface CruxHistory { dates: string[]; lcp: (number | null)[]; inp: (number | null)[]; cls: (number | null)[] }
export type SpeedData =
  | { status: "not-connected" }
  | { status: "ok"; url: string; runs: SpeedRun[]; crux: { phone: CruxHistory | null; desktop: CruxHistory | null } };

export function useSpeed(siteId: number, enabled: boolean) {
  return useQuery({
    queryKey: ["speed", siteId],
    queryFn: () => api<SpeedData>(`/sites/${siteId}/speed`),
    enabled,
    staleTime: 10 * 60_000,
  });
}
