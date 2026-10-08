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
  plausible14d?: number;
  qwa14d?: number;
}

export const useOverview = (r: { from: string; to: string; cfrom: string; cto: string }) =>
  useQuery({
    queryKey: ["overview", r],
    queryFn: () => api<{ sites: OverviewSite[] }>(`/overview?${new URLSearchParams(r)}`),
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });

export interface Realtime {
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
