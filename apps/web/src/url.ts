// URL state. Global (every page): range, from/to (custom), cmp.
// Overview: view, sort.   Site detail (/s/<id>): m (metric), g (grain), f (filters).
import { useCallback, useSyncExternalStore } from "react";
import type { Filter, Metric, TimeGrain } from "@qwa/shared";
import { METRICS, TIME_GRAINS } from "@qwa/shared";
import { PRESETS, type Compare, type Range } from "./dates";

const subscribe = (cb: () => void) => {
  window.addEventListener("popstate", cb);
  return () => window.removeEventListener("popstate", cb);
};

export function useLocation() {
  const href = useSyncExternalStore(subscribe, () => location.href);
  const url = new URL(href);
  const navigate = useCallback((to: string, opts: { replace?: boolean; keepScroll?: boolean } = {}) => {
    if (opts.replace) history.replaceState(null, "", to);
    else history.pushState(null, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
    if (!opts.replace && !opts.keepScroll) window.scrollTo({ top: 0 });
  }, []);
  return { url, navigate };
}

export type Navigate = ReturnType<typeof useLocation>["navigate"];

/** Make an <a> navigate client-side (keeps cmd/ctrl-click for new tabs). */
export function linkHandler(navigate: Navigate, to: string) {
  return (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  };
}

export interface GlobalState {
  range: Range;
  from?: string;
  to?: string;
  compare: Compare;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function readGlobal(url: URL): GlobalState {
  const q = url.searchParams;
  const from = q.get("from") ?? "";
  const to = q.get("to") ?? "";
  const custom = DATE.test(from) && DATE.test(to);
  const r = q.get("range");
  return {
    range: custom ? "custom" : PRESETS.some((p) => p.id === r) ? (r as Range) : "30d",
    from: custom ? (from <= to ? from : to) : undefined,
    to: custom ? (from <= to ? to : from) : undefined,
    compare: q.get("cmp") === "year" ? "year" : "prev",
  };
}

/** Rebuild the current URL with some params changed (null removes). */
export function withParams(url: URL, changes: Record<string, string | null | undefined>, path?: string): string {
  const q = new URLSearchParams(url.search);
  for (const [k, v] of Object.entries(changes)) {
    if (v === null || v === undefined || v === "") q.delete(k);
    else q.set(k, v);
  }
  const qs = q.toString();
  return `${path ?? url.pathname}${qs ? `?${qs}` : ""}`;
}

/** Params to carry from page to page (the global range/comparison). */
export function globalParams(url: URL): string {
  const q = new URLSearchParams();
  for (const k of ["range", "from", "to", "cmp"]) {
    const v = url.searchParams.get(k);
    if (v) q.set(k, v);
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

export interface SiteState {
  siteId: number;
  grain: TimeGrain | null;
  metric: Metric;
  filters: Filter[];
}

export function readSiteState(url: URL): SiteState | null {
  const m = url.pathname.match(/^\/s\/(\d+)/);
  if (!m) return null;
  const q = url.searchParams;
  let filters: Filter[] = [];
  try {
    const parsed = JSON.parse(q.get("f") ?? "[]");
    if (Array.isArray(parsed)) filters = parsed;
  } catch {
    filters = [];
  }
  const g = q.get("g");
  const metric = q.get("m");
  return {
    siteId: Number(m[1]),
    grain: TIME_GRAINS.includes(g as TimeGrain) ? (g as TimeGrain) : null,
    metric: METRICS.includes(metric as Metric) ? (metric as Metric) : "visitors",
    filters,
  };
}
