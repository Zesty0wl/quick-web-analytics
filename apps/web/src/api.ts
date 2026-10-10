import { useQuery } from "@tanstack/react-query";
import type { Filter, GroupBy, Metric, QueryResult } from "@qwa/shared";

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
    if ((e as Error).name === "TimeoutError") throw new ApiError("This took over a minute, so it was stopped. Try a shorter date range.", 504);
    throw new ApiError("Couldn't reach the server. Check your connection and try again.", 0);
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

export function useStats(siteId: number | undefined, q: StatsQuery, enabled = true) {
  return useQuery({
    queryKey: ["stats", siteId, q],
    queryFn: () => api<QueryResult>(`/sites/${siteId}/query`, { method: "POST", body: JSON.stringify(q) }),
    enabled: enabled && siteId !== undefined,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
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

export function useRealtime(siteId: number | undefined) {
  return useQuery({
    queryKey: ["realtime", siteId],
    queryFn: () => api<Realtime>(`/sites/${siteId}/realtime`),
    enabled: siteId !== undefined,
    refetchInterval: 10_000,
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
