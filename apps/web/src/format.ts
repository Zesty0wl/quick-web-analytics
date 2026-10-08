import type { Dimension, Metric } from "@qwa/shared";

const compactFmt = new Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 });
const wholeFmt = new Intl.NumberFormat("en-GB");

export const compact = (n: number) => (Math.abs(n) >= 10_000 ? compactFmt.format(n) : wholeFmt.format(Math.round(n)));
export const whole = (n: number) => wholeFmt.format(Math.round(n));

export function duration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function metricValue(metric: Metric, v: number | string | null | undefined, opts: { compact?: boolean } = {}): string {
  const n = Number(v ?? 0);
  switch (metric) {
    case "bounce_rate":
    case "scroll_depth":
      return `${Math.round(n)}%`;
    case "visit_duration":
    case "time_on_page":
      return duration(n);
    case "views_per_visit":
      return n.toFixed(2);
    default:
      return opts.compact ? compact(n) : whole(n);
  }
}

export const METRIC_LABELS: Record<Metric, string> = {
  visitors: "Visitors",
  visits: "Visits",
  pageviews: "Pageviews",
  views_per_visit: "Views per visit",
  bounce_rate: "Bounce rate",
  visit_duration: "Visit duration",
  events: "Events",
  scroll_depth: "Scroll depth",
  time_on_page: "Time on page",
};

export const DIMENSION_LABELS: Record<Dimension, string> = {
  source: "Source", channel: "Channel", referrer: "Referrer",
  utm_source: "UTM source", utm_medium: "UTM medium", utm_campaign: "UTM campaign", utm_content: "UTM content", utm_term: "UTM term",
  country: "Country", region: "Region", city: "City",
  browser: "Browser", browser_version: "Browser version", os: "OS", os_version: "OS version", device: "Device",
  entry_page: "Entry page", exit_page: "Exit page", hostname: "Hostname", page: "Page", event: "Event",
};

/** For these metrics a decrease is good news. */
export const LOWER_IS_BETTER = new Set<Metric>(["bounce_rate"]);

export function change(current: number, previous: number): number | null {
  if (!previous) return current ? null : 0;
  return ((current - previous) / previous) * 100;
}

// ---- countries ----
const regionNames = (() => {
  try {
    return new Intl.DisplayNames(["en-GB"], { type: "region" });
  } catch {
    return null;
  }
})();

export function flag(cc: string): string {
  if (!/^[A-Z]{2}$/.test(cc)) return "🌐";
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export function countryName(cc: string): string {
  if (!cc) return "Unknown";
  try {
    return regionNames?.of(cc) ?? cc;
  } catch {
    return cc;
  }
}

/** Human label for a breakdown value. */
export function displayValue(dim: Dimension, value: string): string {
  if (!value) return dim === "source" || dim === "referrer" ? "Direct / none" : dim.startsWith("utm_") ? "(not set)" : "Unknown";
  if (dim === "country") return countryName(value);
  return value;
}

/** A link to the live thing a value refers to, if there is one. */
export function liveUrl(dim: Dimension, value: string, siteDomain: string): string | null {
  if (!value) return null;
  if (dim === "page" || dim === "entry_page" || dim === "exit_page") {
    return value.startsWith("/") ? `https://${siteDomain}${value}` : null;
  }
  if (dim === "hostname") return `https://${value}`;
  if (dim === "referrer") return `https://${value}`;
  if (dim === "source" && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value)) return `https://${value}`;
  return null;
}

export function ago(ts: number | null | undefined): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
}
