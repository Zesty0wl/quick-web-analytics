// MCP server: read-only access to a QWA instance for AI agents, at /mcp.
//
// Transport: MCP Streamable HTTP, stateless (each POST carries one JSON-RPC message or a batch; responses are plain
// JSON, no server-sent stream). Auth: a personal access token (`Authorization: Bearer qwa_pat_…`, see tokens.ts),
// optionally limited to some sites. Tools call the dashboard's own API routes as the token's user, so the numbers
// always match the dashboard and the same site permissions apply.
import { DIMENSIONS, METRICS, TRAFFIC_METRICS, VITAL_DIMENSIONS, allowedMetrics, type Dimension, type Metric } from "@qwa/shared";
import { api, INTERNAL_USER } from "./api";
import { visibleSiteIds } from "./auth";
import type { Env, Site } from "./env";
import { cruxRecord, GoogleError, pageSpeed, type CruxRecord, type SpeedResult } from "./google";
import { allSites } from "./sites";
import { authenticateToken, type TokenAuth } from "./tokens";
import { originOf } from "./oauth";
import { addDays, todayIn } from "./tz";

const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "quick-web-analytics", title: "Quick Web Analytics", version: "0.3.0" };
const INSTRUCTIONS = `Read-only access to website analytics from a Quick Web Analytics instance (cookieless, privacy-friendly).
Start with list_sites. Dates are local to each site's timezone. Periods default to the last 30 days, compared with the previous 30.
For performance work, start with web_vitals and slow_interactions: Core Web Vitals measured by the QWA tracker on real visits (INP with the element and interaction behind it, LCP, CLS, TTFB, FCP), per page, device or browser. crux (Google's Chrome UX Report) and speed_test (a Lighthouse run on any page) add Google's view.
Every result includes a link to the same view in the dashboard.`;

type Json = Record<string, unknown>;

class ToolError extends Error {}

interface Call {
  env: Env;
  ctx: ExecutionContext;
  auth: TokenAuth;
  origin: string;
}

// ---------------------------------------------------------------------------------------------------------
// Helpers

/** Call a dashboard API route as the token's user. */
async function internal<T>(c: Call, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const env = { ...c.env, [INTERNAL_USER]: c.auth.user } as Env;
  const res = await api.fetch(
    new Request(`https://qwa.internal${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
    env,
    c.ctx,
  );
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ToolError(j.error ?? `request failed (${res.status})`);
  return j;
}

async function sitesFor(c: Call): Promise<Site[]> {
  const visible = await visibleSiteIds(c.env, c.auth.user);
  return (await allSites(c.env)).filter((s) => (visible === "all" || visible.includes(s.id)) && (!c.auth.sites || c.auth.sites.includes(s.id)));
}

async function resolveSite(c: Call, ref: unknown): Promise<Site> {
  if (ref === undefined || ref === null || ref === "") throw new ToolError("site is required (a domain such as example.com, or an id from list_sites)");
  const sites = await sitesFor(c);
  const raw = String(ref).trim().toLowerCase();
  const domain = raw.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  const site = /^\d+$/.test(raw) ? sites.find((s) => s.id === Number(raw)) : sites.find((s) => s.domain === domain);
  if (!site) throw new ToolError(`No site "${ref}" that this token can read. Sites available: ${sites.map((s) => s.domain).join(", ") || "none"}.`);
  return site;
}

const PERIODS = ["today", "yesterday", "7d", "28d", "30d", "90d", "6m", "12m", "month_to_date", "last_month"] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000) + 1;

function addYears(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y + n, m - 1, d));
  if (t.getUTCMonth() !== m - 1) t.setUTCDate(0); // 29 Feb → 28 Feb
  return t.toISOString().slice(0, 10);
}

interface Period {
  from: string;
  to: string;
  cfrom: string;
  cto: string;
  label: string;
  cmpLabel: string;
}

export function resolvePeriod(site: Site, args: Json): Period {
  const today = todayIn(site.timezone);
  let from: string, to: string, label: string;
  if (args.from || args.to) {
    from = String(args.from ?? "");
    to = String(args.to ?? today);
    if (!DATE.test(from) || !DATE.test(to) || from > to) throw new ToolError("from and to must be YYYY-MM-DD dates, from on or before to");
    if (daysBetween(from, to) > 800) throw new ToolError("the range can be at most 800 days");
    label = `${from} to ${to}`;
  } else {
    const p = String(args.period ?? "30d");
    const back: Record<string, number> = { today: 0, "7d": 6, "28d": 27, "30d": 29, "90d": 89, "6m": 182, "12m": 364 };
    if (p in back) {
      from = addDays(today, -back[p]);
      to = today;
      label = p === "today" ? `today (${today})` : `last ${p.replace("d", " days").replace("m", " months")} (${from} to ${to})`;
    } else if (p === "yesterday") {
      from = to = addDays(today, -1);
      label = `yesterday (${from})`;
    } else if (p === "month_to_date") {
      from = `${today.slice(0, 8)}01`;
      to = today;
      label = `this month so far (${from} to ${to})`;
    } else if (p === "last_month") {
      to = addDays(`${today.slice(0, 8)}01`, -1);
      from = `${to.slice(0, 8)}01`;
      label = `last month (${from} to ${to})`;
    } else {
      throw new ToolError(`period must be one of ${PERIODS.join(", ")}, or give from and to`);
    }
  }
  if (args.compare === "year") return { from, to, cfrom: addYears(from, -1), cto: addYears(to, -1), label, cmpLabel: "the same period last year" };
  const n = daysBetween(from, to);
  return { from, to, cfrom: addDays(from, -n), cto: addDays(from, -1), label, cmpLabel: `the previous ${n === 1 ? "day" : `${n} days`}` };
}

type Filter = [Dimension, "is" | "is_not" | "contains", string | string[]];

export function parseFilters(raw: unknown): Filter[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ToolError("filters must be a list of { dimension, op, value }");
  return raw.map((f) => {
    const o = (f ?? {}) as Json;
    const dim = String(o.dimension ?? "") as Dimension;
    const op = String(o.op ?? "is") as Filter[1];
    if (!DIMENSIONS.includes(dim)) throw new ToolError(`unknown filter dimension "${dim}"; use one of ${DIMENSIONS.join(", ")}`);
    if (op !== "is" && op !== "is_not" && op !== "contains") throw new ToolError(`filter op must be is, is_not or contains`);
    const value = Array.isArray(o.value) ? o.value.map(String) : String(o.value ?? "");
    return [dim, op, value];
  });
}

const n0 = (v: unknown) => Number(v ?? 0);
const whole = (v: unknown) => Math.round(n0(v)).toLocaleString("en-GB");
function duration(s: number): string {
  const t = Math.round(s);
  return t < 60 ? `${t}s` : `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, "0")}s`;
}
function fmt(metric: string, v: unknown): string {
  if (v === null || v === undefined) return "–";
  switch (metric) {
    case "inp":
    case "lcp":
    case "ttfb":
    case "fcp":
    case "inp_delay":
    case "inp_processing":
    case "inp_presentation":
      return ms(n0(v));
    case "cls":
      return n0(v).toFixed(3);
    case "bounce_rate":
    case "scroll_depth":
      return `${Math.round(n0(v))}%`;
    case "visit_duration":
    case "time_on_page":
      return duration(n0(v));
    case "views_per_visit":
      return n0(v).toFixed(2);
    default:
      return whole(v);
  }
}
function change(cur: unknown, prev: unknown): string {
  const a = n0(cur), b = n0(prev);
  if (!b) return a ? "new" : "–";
  const pct = ((a - b) / b) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}
const LABEL: Record<string, string> = {
  visitors: "Visitors", visits: "Visits", pageviews: "Pageviews", views_per_visit: "Views per visit", bounce_rate: "Bounce rate",
  visit_duration: "Visit duration", events: "Events", scroll_depth: "Scroll depth", time_on_page: "Time on page",
  inp: "INP (p75)", lcp: "LCP (p75)", cls: "CLS (p75)", ttfb: "TTFB (p75)", fcp: "FCP (p75)",
  inp_delay: "Input delay (p75)", inp_processing: "Processing (p75)", inp_presentation: "Presentation (p75)", measured_views: "Measured page views",
};
// Google's thresholds: good up to the first number, poor above the second.
const VITAL_LIMITS: Record<string, [number, number]> = { inp: [200, 500], lcp: [2500, 4000], cls: [0.1, 0.25], ttfb: [800, 1800], fcp: [1800, 3000] };
function verdict(metric: string, v: unknown): string {
  const lim = VITAL_LIMITS[metric];
  if (!lim || v === null || v === undefined) return "";
  const x = n0(v);
  return x <= lim[0] ? "good" : x <= lim[1] ? "needs improvement" : "poor";
}
const ms = (v: number | null | undefined) => (v === null || v === undefined ? "–" : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(2)} s`);
const cls = (v: number | null | undefined) => (v === null || v === undefined ? "–" : v.toFixed(3));
const pct = (v: number) => `${Math.round(v * 100)}%`;

function table(head: string[], rows: (string | number)[][]): string {
  const esc = (x: string | number) => String(x).replace(/\|/g, "\\|");
  return [`| ${head.join(" | ")} |`, `| ${head.map((_, i) => (i === 0 ? "---" : "---:")).join(" | ")} |`, ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`)].join("\n");
}

function link(c: Call, site: Site, p: Period, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({ from: p.from, to: p.to, ...extra });
  return `${c.origin}/s/${site.id}?${q}`;
}
const filterParam = (filters: Filter[]): Record<string, string> => (filters.length ? { f: JSON.stringify(filters) } : {});
const describeFilters = (filters: Filter[]) =>
  filters.length ? ` · filtered: ${filters.map(([d, op, v]) => `${d} ${op.replace("_", " ")} ${Array.isArray(v) ? v.join(" or ") : v}`).join(", ")}` : "";

// Per-token limit for speed_test (each run takes 10–40s of Google's time): a few an hour, per isolate.
const speedRuns = new Map<number, number[]>();
function allowSpeedTest(tokenId: number): boolean {
  const now = Date.now();
  const recent = (speedRuns.get(tokenId) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= 10) return false;
  recent.push(now);
  speedRuns.set(tokenId, recent);
  return true;
}

/** A path or URL on the site, as a full https URL (refuses other hosts). */
export function siteUrl(site: Site, raw: unknown): string {
  const s = String(raw ?? "/").trim() || "/";
  let u: URL;
  try {
    u = s.startsWith("/") ? new URL(`https://${site.domain}${s}`) : new URL(/^https?:\/\//.test(s) ? s : `https://${s}`);
  } catch {
    throw new ToolError(`"${s}" isn't a valid path or URL`);
  }
  const host = u.hostname.replace(/^www\./, "");
  if (host !== site.domain && !host.endsWith(`.${site.domain}`)) throw new ToolError(`${u.hostname} isn't part of ${site.domain}`);
  u.protocol = "https:";
  u.hash = "";
  return u.toString();
}

// ---------------------------------------------------------------------------------------------------------
// Tools

const siteProp = { type: "string", description: "Site domain (e.g. example.com) or its id, from list_sites." };
const periodProps = {
  period: { type: "string", enum: PERIODS, description: "Date range (default 30d). Ignored if from/to are given." },
  from: { type: "string", description: "Start date, YYYY-MM-DD (site's timezone). Use with to for a custom range." },
  to: { type: "string", description: "End date, YYYY-MM-DD, inclusive." },
  compare: { type: "string", enum: ["previous", "year"], description: "Compare with the previous period of the same length (default) or the same dates last year." },
};
const filtersProp = {
  type: "array",
  description: "Narrow the data, e.g. [{ dimension: 'device', op: 'is', value: 'Desktop' }] or [{ dimension: 'page', op: 'contains', value: '/blog' }]. Device values: Desktop, Mobile, Tablet. Countries: ISO codes (GB, US).",
  items: {
    type: "object",
    properties: {
      dimension: { type: "string", enum: DIMENSIONS },
      op: { type: "string", enum: ["is", "is_not", "contains"], description: "Default is." },
      value: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
    },
    required: ["dimension", "value"],
  },
};
const READ = { readOnlyHint: true, openWorldHint: false };

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  annotations?: Json;
  run: (c: Call, args: Json) => Promise<{ text: string; data?: unknown }>;
}

const TOOLS: Tool[] = [
  {
    name: "list_sites",
    title: "List sites",
    description: "The sites this token can read, with their timezones and visitors today.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ,
    run: async (c) => {
      const sites = await sitesFor(c);
      const rows = await Promise.all(
        sites.map(async (s) => {
          const today = todayIn(s.timezone);
          const r = await internal<{ rows: Json[] }>(c, "POST", `/sites/${s.id}/query`, { from: today, to: today, metrics: ["visitors", "pageviews"] }).catch(() => ({ rows: [{} as Json] }));
          return { id: s.id, domain: s.domain, timezone: s.timezone, visitorsToday: n0(r.rows[0]?.visitors), pageviewsToday: n0(r.rows[0]?.pageviews) };
        }),
      );
      rows.sort((a, b) => b.visitorsToday - a.visitorsToday);
      return {
        text: rows.length ? table(["Site", "Id", "Timezone", "Visitors today", "Pageviews today"], rows.map((r) => [r.domain, r.id, r.timezone, whole(r.visitorsToday), whole(r.pageviewsToday)])) : "This token can't read any sites.",
        data: { sites: rows },
      };
    },
  },
  {
    name: "get_summary",
    title: "Site summary",
    description: "Headline metrics for a site over a period, with the change against the comparison period: visitors, visits, pageviews, views per visit, bounce rate, visit duration, events, scroll depth and time on page.",
    inputSchema: { type: "object", properties: { site: siteProp, ...periodProps, filters: filtersProp }, required: ["site"] },
    annotations: READ,
    run: async (c, args) => {
      const site = await resolveSite(c, args.site);
      const p = resolvePeriod(site, args);
      const filters = parseFilters(args.filters);
      const [cur, prev] = await Promise.all([
        internal<{ rows: Json[] }>(c, "POST", `/sites/${site.id}/query`, { from: p.from, to: p.to, metrics: METRICS, filters }),
        internal<{ rows: Json[] }>(c, "POST", `/sites/${site.id}/query`, { from: p.cfrom, to: p.cto, metrics: METRICS, filters }),
      ]);
      const a = cur.rows[0] ?? {}, b = prev.rows[0] ?? {};
      const vitals = n0(a.measured_views)
        ? `\n\nWeb Vitals, real visits measured by the QWA tracker (p75, ${whole(a.measured_views)} page views): ${(["inp", "lcp", "cls", "ttfb"] as const).map((m) => `${m.toUpperCase()} ${fmt(m, a[m])}${a[m] !== null && a[m] !== undefined ? ` (${verdict(m, a[m])}${b[m] !== null && b[m] !== undefined ? `, was ${fmt(m, b[m])}` : ""})` : ""}`).join(", ")}.`
        : "";
      return {
        text: `**${site.domain}** · ${p.label} vs ${p.cmpLabel}${describeFilters(filters)}\n\n${table(["Metric", "Value", "Previous", "Change"], TRAFFIC_METRICS.map((m) => [LABEL[m], fmt(m, a[m]), fmt(m, b[m]), change(a[m], b[m])]))}${vitals}\n\nDashboard: ${link(c, site, p, filterParam(filters))}`,
        data: { site: site.domain, period: p, current: a, previous: b },
      };
    },
  },
  {
    name: "breakdown",
    title: "Breakdown",
    description:
      "Top values of a dimension, e.g. most visited pages, entry pages, sources, channels, countries, devices, browsers or custom events, with change against the comparison period. Use filters to narrow (e.g. device is Desktop).",
    inputSchema: {
      type: "object",
      properties: {
        site: siteProp,
        dimension: { type: "string", enum: DIMENSIONS, description: "What to break down by. page = pages viewed; entry_page / exit_page = where visits started or ended; event = custom and automatic events." },
        metrics: { type: "array", items: { type: "string", enum: METRICS }, description: "Defaults depend on the dimension. The first metric sorts the list. Pages support visitors, pageviews, scroll_depth, time_on_page; events support visitors, events." },
        ...periodProps,
        filters: filtersProp,
        limit: { type: "integer", minimum: 1, maximum: 100, description: "How many rows (default 20)." },
      },
      required: ["site", "dimension"],
    },
    annotations: READ,
    run: async (c, args) => {
      const site = await resolveSite(c, args.site);
      const p = resolvePeriod(site, args);
      const filters = parseFilters(args.filters);
      const dim = String(args.dimension) as Dimension;
      if (!DIMENSIONS.includes(dim)) throw new ToolError(`dimension must be one of ${DIMENSIONS.join(", ")}`);
      const allowed = allowedMetrics(dim);
      const defaults: Metric[] =
        dim === "page" ? ["visitors", "pageviews", "time_on_page", "scroll_depth"]
        : dim === "event" ? ["events", "visitors"]
        : (VITAL_DIMENSIONS as readonly string[]).includes(dim) ? ["measured_views", "inp", "lcp"]
        : ["visitors", "visits", "bounce_rate", "visit_duration"];
      const metrics = (Array.isArray(args.metrics) && args.metrics.length ? (args.metrics as Metric[]) : defaults).filter((m) => allowed.includes(m));
      if (!metrics.length) throw new ToolError(`for ${dim}, metrics can be: ${allowed.join(", ")}`);
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
      const [cur, prev] = await Promise.all([
        internal<{ rows: Json[] }>(c, "POST", `/sites/${site.id}/query`, { from: p.from, to: p.to, metrics, groupBy: dim, filters, limit }),
        internal<{ rows: Json[] }>(c, "POST", `/sites/${site.id}/query`, { from: p.cfrom, to: p.cto, metrics: [metrics[0]], groupBy: dim, filters, limit: 500 }),
      ]);
      const before = new Map(prev.rows.map((r) => [String(r[dim] ?? ""), r[metrics[0]]]));
      const rows = cur.rows.map((r) => [String(r[dim] ?? "") || "(none)", ...metrics.map((m) => fmt(m, r[m])), change(r[metrics[0]], before.get(String(r[dim] ?? "")))]);
      return {
        text: `**${site.domain}** · top ${dim.replace("_", " ")} · ${p.label}${describeFilters(filters)}\n\n${rows.length ? table([dim, ...metrics.map((m) => LABEL[m]), `${LABEL[metrics[0]]} change`], rows) : "No data for this period."}\n\nDashboard: ${link(c, site, p, filterParam(filters))}`,
        data: { site: site.domain, period: p, dimension: dim, metrics, rows: cur.rows.map((r) => ({ ...r, previous: before.get(String(r[dim] ?? "")) ?? null })) },
      };
    },
  },
  {
    name: "timeseries",
    title: "Time series",
    description: "One metric over time (by hour, day, week or month), with the comparison period alongside and any unusual days the anomaly check flagged.",
    inputSchema: {
      type: "object",
      properties: {
        site: siteProp,
        metric: { type: "string", enum: METRICS, description: "Default visitors." },
        grain: { type: "string", enum: ["hour", "day", "week", "month"], description: "Default: hour up to 2 days, day up to 120 days, then week." },
        ...periodProps,
        filters: filtersProp,
      },
      required: ["site"],
    },
    annotations: READ,
    run: async (c, args) => {
      const site = await resolveSite(c, args.site);
      const p = resolvePeriod(site, args);
      const filters = parseFilters(args.filters);
      const metric = (METRICS as readonly string[]).includes(String(args.metric)) ? (String(args.metric) as Metric) : "visitors";
      const days = daysBetween(p.from, p.to);
      const grain = ["hour", "day", "week", "month"].includes(String(args.grain)) ? String(args.grain) : days <= 2 ? "hour" : days <= 120 ? "day" : "week";
      if (grain === "hour" && days > 14) throw new ToolError("hourly data is limited to 14 days; use day or a shorter range");
      const [cur, prev, an] = await Promise.all([
        internal<{ rows: Json[] }>(c, "POST", `/sites/${site.id}/query`, { from: p.from, to: p.to, metrics: [metric], groupBy: grain, filters }),
        internal<{ rows: Json[] }>(c, "POST", `/sites/${site.id}/query`, { from: p.cfrom, to: p.cto, metrics: [metric], groupBy: grain, filters }),
        internal<{ anomalies: { day: string; kind: string; value: number; expected: number }[] }>(c, "GET", `/sites/${site.id}/anomalies?from=${p.from}&to=${p.to}`).catch(() => ({ anomalies: [] })),
      ]);
      const flagged = new Map(an.anomalies.map((a) => [a.day, a.kind]));
      const rows = cur.rows.map((r, i) => [String(r[grain]), fmt(metric, r[metric]), prev.rows[i] ? fmt(metric, prev.rows[i][metric]) : "–", flagged.get(String(r[grain]).slice(0, 10)) ?? ""]);
      return {
        text: `**${site.domain}** · ${LABEL[metric]} by ${grain} · ${p.label} vs ${p.cmpLabel}${describeFilters(filters)}\n\n${table([grain, LABEL[metric], "Comparison", "Unusual"], rows)}\n\nDashboard: ${link(c, site, p, filterParam(filters))}`,
        data: { site: site.domain, period: p, metric, grain, rows: cur.rows, comparison: prev.rows, anomalies: an.anomalies },
      };
    },
  },
  {
    name: "realtime",
    title: "Realtime",
    description: "Who's on the site right now: visitors in the last 5 and 30 minutes, active pages, where they arrived from and their countries.",
    inputSchema: { type: "object", properties: { site: siteProp }, required: ["site"] },
    annotations: READ,
    run: async (c, args) => {
      const site = await resolveSite(c, args.site);
      const r = await internal<{ visitors5m: number; visitors30m: number; pages: { path: string; visitors: number }[]; sources: { name: string; visitors: number }[]; countries: { name: string; visitors: number }[] }>(c, "GET", `/sites/${site.id}/realtime`);
      const list = (xs: { visitors: number }[], key: "path" | "name") => (xs.length ? xs.slice(0, 10).map((x) => `- ${(x as unknown as Record<string, string>)[key] || "(none)"}: ${x.visitors}`).join("\n") : "- none");
      return {
        text: `**${site.domain}** right now: ${r.visitors5m} visitors in the last 5 minutes, ${r.visitors30m} in the last 30.\n\nActive pages:\n${list(r.pages, "path")}\n\nArriving from:\n${list(r.sources, "name")}\n\nCountries (30 min):\n${list(r.countries, "name")}\n\nDashboard: ${c.origin}/s/${site.id}?range=today#s-realtime`,
        data: r,
      };
    },
  },
  {
    name: "anomalies",
    title: "Unusual days",
    description: "Spikes, drops, bursts and possible outages the anomaly checks flagged for a site in a period, described in plain English.",
    inputSchema: { type: "object", properties: { site: siteProp, ...periodProps }, required: ["site"] },
    annotations: READ,
    run: async (c, args) => {
      const site = await resolveSite(c, args.site);
      const p = resolvePeriod(site, { period: "90d", ...args });
      const r = await internal<{ anomalies: { day: string; kind: string; value: number; expected: number; metric?: string; detail?: { hour: number; window: string } | null }[] }>(c, "GET", `/sites/${site.id}/anomalies?from=${p.from}&to=${p.to}`);
      const text = r.anomalies.length
        ? r.anomalies
            .map((a) => {
              const when = a.metric === "intraday" && a.detail ? `${a.day} (by ${String(a.detail.hour).padStart(2, "0")}:00, ${a.detail.window === "last3h" ? "last 3 hours" : "day so far"})` : a.day;
              const ratio = a.expected ? (a.value / a.expected).toFixed(1) : "–";
              return `- ${when}: ${a.kind}, ${whole(a.value)} visits vs about ${whole(a.expected)} usually (${ratio}×)`;
            })
            .join("\n")
        : "Nothing unusual in this period.";
      return { text: `**${site.domain}** · unusual days · ${p.label}\n\n${text}`, data: r };
    },
  },
  {
    name: "search_console",
    title: "Google Search Console",
    description: "How the site does in Google Search: clicks, impressions, CTR and average position, plus the top queries, pages, countries or devices. Data trails by 1–2 days.",
    inputSchema: {
      type: "object",
      properties: {
        site: siteProp,
        dimension: { type: "string", enum: ["query", "page", "country", "device"], description: "Default query." },
        ...periodProps,
        page: { type: "string", description: "Only searches that led to this page path, e.g. /pricing." },
        query: { type: "string", description: "Only this exact search query." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 20." },
      },
      required: ["site"],
    },
    annotations: READ,
    run: async (c, args) => {
      const site = await resolveSite(c, args.site);
      const p = resolvePeriod(site, args);
      const dim = ["query", "page", "country", "device"].includes(String(args.dimension)) ? String(args.dimension) : "query";
      const qs = new URLSearchParams({ from: p.from, to: p.to, cfrom: p.cfrom, cto: p.cto, ...(args.page ? { page: String(args.page) } : {}), ...(args.query ? { query: String(args.query) } : {}) });
      const sum = await internal<{ status: string; totals?: Json; previous?: Json; latest?: string | null; property?: string; account?: string }>(c, "GET", `/sites/${site.id}/search?${qs}`);
      if (sum.status === "not-connected") return { text: "Search Console isn't connected on this instance (Admin → Google)." };
      if (sum.status === "no-property") return { text: `No Search Console property is shared with this instance for ${site.domain}. Add ${sum.account} as a Restricted user on the property.` };
      const rows = await internal<{ rows: { key: string; clicks: number; impressions: number; ctr: number; position: number; prevClicks: number }[] }>(c, "GET", `/sites/${site.id}/search/rows?${qs}&dim=${dim}&limit=${Math.min(100, Number(args.limit) || 20)}`);
      const t = sum.totals ?? {}, b = sum.previous ?? {};
      const head = table(["", "Clicks", "Impressions", "CTR", "Avg. position"], [
        ["This period", whole(t.clicks), whole(t.impressions), `${(n0(t.ctr) * 100).toFixed(1)}%`, n0(t.position).toFixed(1)],
        ["Comparison", whole(b.clicks), whole(b.impressions), `${(n0(b.ctr) * 100).toFixed(1)}%`, n0(b.position).toFixed(1)],
      ]);
      const body = table([dim, "Clicks", "Impressions", "CTR", "Position", "Clicks change"], rows.rows.map((r) => [r.key || "(unknown)", whole(r.clicks), whole(r.impressions), `${(r.ctr * 100).toFixed(1)}%`, r.position.toFixed(1), change(r.clicks, r.prevClicks)]));
      return {
        text: `**${site.domain}** · Google Search · ${p.label} vs ${p.cmpLabel}${args.page ? ` · page ${args.page}` : ""}${args.query ? ` · query "${args.query}"` : ""}\nGoogle's data runs to ${sum.latest ?? "–"}.\n\n${head}\n\n${body}\n\nDashboard: ${link(c, site, p)}#s-search`,
        data: { site: site.domain, period: p, totals: t, previous: b, latest: sum.latest, dimension: dim, rows: rows.rows },
      };
    },
  },
  {
    name: "web_vitals",
    title: "Web Vitals from real visits",
    description:
      "Core Web Vitals measured by the QWA tracker on real visits (all browsers that support each metric): 75th-percentile INP, LCP, CLS, TTFB and FCP, with Google's good / needs improvement / poor verdicts, grouped by page (default), device, browser, os, country, entry_page or day. Use filters to narrow, e.g. device is Desktop. Sorted by page views measured, so the busiest come first.",
    inputSchema: {
      type: "object",
      properties: {
        site: siteProp,
        group_by: { type: "string", enum: ["page", "device", "browser", "os", "country", "entry_page", "day", "none"], description: "Default page." },
        ...periodProps,
        filters: filtersProp,
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 20." },
      },
      required: ["site"],
    },
    annotations: READ,
    run: async (c, args) => {
      const site = await resolveSite(c, args.site);
      const p = resolvePeriod(site, args);
      const filters = parseFilters(args.filters);
      const g = String(args.group_by ?? "page");
      const groupBy = g === "none" ? null : ["page", "device", "browser", "os", "country", "entry_page", "day"].includes(g) ? g : "page";
      const metrics = ["measured_views", "inp", "lcp", "cls", "ttfb", "fcp"];
      const r = await internal<{ rows: Json[] }>(c, "POST", `/sites/${site.id}/query`, { from: p.from, to: p.to, metrics, groupBy, filters, limit: Math.min(100, Number(args.limit) || 20) });
      const rows = r.rows.filter((x) => n0(x.measured_views) > 0);
      if (!rows.length) {
        return { text: `No Web Vitals measured for ${site.domain} in ${p.label}${describeFilters(filters)}. The QWA tracker measures them on every page view from October 2026 (sites need the current /t.js; Plausible's script doesn't measure them). Try crux for Google's data.` };
      }
      const cell = (m: string, x: Json) => (x[m] === null || x[m] === undefined ? "–" : `${fmt(m, x[m])} ${verdict(m, x[m]) === "good" ? "✓" : verdict(m, x[m]) === "poor" ? "✗" : "~"}`);
      return {
        text: `**${site.domain}** · Web Vitals from real visits (p75) · ${p.label}${describeFilters(filters)}\n✓ good, ~ needs improvement, ✗ poor (Google's thresholds: INP 200/500 ms, LCP 2.5/4 s, CLS 0.1/0.25, TTFB 0.8/1.8 s).\n\n${table([groupBy ?? "site", "Page views", "INP", "LCP", "CLS", "TTFB", "FCP"], rows.map((x) => [groupBy ? String(x[groupBy] ?? "") || "(none)" : site.domain, whole(x.measured_views), cell("inp", x), cell("lcp", x), cell("cls", x), cell("ttfb", x), cell("fcp", x)]))}\n\nDashboard: ${link(c, site, p, filterParam(filters))}#s-speed`,
        data: { site: site.domain, period: p, groupBy, rows },
      };
    },
  },
  {
    name: "slow_interactions",
    title: "Slow interactions (INP attribution)",
    description:
      "Which elements visitors were interacting with when a page view's slowest interaction happened, measured by the QWA tracker: for each element (a CSS-style description like 'nav > button.menu-toggle'), how many page views had it as their slowest interaction, the 75th-percentile INP, and where the time went (input delay, processing, presentation). Filter by page and device to focus. This is the data for fixing INP.",
    inputSchema: {
      type: "object",
      properties: {
        site: siteProp,
        page: { type: "string", description: "Only this page path, e.g. /starlink." },
        device: { type: "string", enum: ["Desktop", "Mobile", "Tablet"], description: "Only this device type." },
        ...periodProps,
        filters: filtersProp,
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 15." },
      },
      required: ["site"],
    },
    annotations: READ,
    run: async (c, args) => {
      const site = await resolveSite(c, args.site);
      const p = resolvePeriod(site, args);
      const filters = parseFilters(args.filters);
      if (args.page) filters.push(["page", "is", String(args.page)]);
      if (args.device) filters.push(["device", "is", String(args.device)]);
      const metrics = ["measured_views", "inp", "inp_delay", "inp_processing", "inp_presentation"];
      const limit = Math.min(50, Number(args.limit) || 15);
      const [targets, types, overall] = await Promise.all([
        internal<{ rows: Json[] }>(c, "POST", `/sites/${site.id}/query`, { from: p.from, to: p.to, metrics, groupBy: "inp_target", filters, limit }),
        internal<{ rows: Json[] }>(c, "POST", `/sites/${site.id}/query`, { from: p.from, to: p.to, metrics: ["measured_views", "inp"], groupBy: "inp_type", filters, limit: 10 }),
        internal<{ rows: Json[] }>(c, "POST", `/sites/${site.id}/query`, { from: p.from, to: p.to, metrics: ["measured_views", "inp"], filters }),
      ]);
      if (!targets.rows.length) {
        return { text: `No interactions measured for ${site.domain} in ${p.label}${describeFilters(filters)}. INP needs the current QWA tracker (/t.js, October 2026 or later) and a browser that reports Event Timing (Chrome, Edge, Firefox; not Safari).` };
      }
      const o = overall.rows[0] ?? {};
      return {
        text: `**${site.domain}** · slowest interaction per page view · ${p.label}${describeFilters(filters)}\nOverall INP (p75): ${fmt("inp", o.inp)} (${verdict("inp", o.inp)}) over ${whole(o.measured_views)} measured page views.\n\n${table(["Element", "Page views", "INP p75", "Input delay", "Processing", "Presentation"], targets.rows.map((x) => [String(x.inp_target) || "(element removed from the page)", whole(x.measured_views), `${fmt("inp", x.inp)} ${verdict("inp", x.inp) === "good" ? "✓" : verdict("inp", x.inp) === "poor" ? "✗" : "~"}`, fmt("inp_delay", x.inp_delay), fmt("inp_processing", x.inp_processing), fmt("inp_presentation", x.inp_presentation)]))}\n\nBy interaction type: ${types.rows.map((x) => `${x.inp_type || "?"} ${whole(x.measured_views)} (p75 ${fmt("inp", x.inp)})`).join(", ")}.\n\nReading it: **input delay** is time before the handler could start (the main thread was busy: long tasks, hydration, third-party scripts); **processing** is the event handlers themselves; **presentation** is rendering the result (large DOM updates, layout, paint). Fix the biggest part for the elements with the most page views first.`,
        data: { site: site.domain, period: p, filters, overall: o, targets: targets.rows, types: types.rows },
      };
    },
  },
  {
    name: "speed",
    title: "Speed (stored)",
    description: "The site's stored PageSpeed results for its home page (nightly, mobile and desktop): Lighthouse score, lab metrics, the biggest suggested fixes, real Chrome users' Core Web Vitals (LCP, INP, CLS), and the six-month trend of those.",
    inputSchema: { type: "object", properties: { site: siteProp }, required: ["site"] },
    annotations: READ,
    run: async (c, args) => {
      const site = await resolveSite(c, args.site);
      const r = await internal<{ status: string; runs?: (SpeedResult & { runAt: number })[]; crux?: Record<string, { dates: string[]; lcp: (number | null)[]; inp: (number | null)[]; cls: (number | null)[] } | null> }>(c, "GET", `/sites/${site.id}/speed`);
      if (r.status !== "ok") return { text: "PageSpeed isn't connected on this instance (Admin → Google)." };
      const latest = (s: string) => [...(r.runs ?? [])].reverse().find((x) => x.strategy === s);
      const parts = ["mobile", "desktop"].map((s) => {
        const x = latest(s);
        if (!x) return `### ${s}\nNot tested yet.`;
        const f = x.field;
        return `### ${s} · tested ${new Date(x.runAt * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC\nLighthouse score ${x.score ?? "–"}. Lab: LCP ${ms(x.lab.lcp)}, TBT ${ms(x.lab.tbt)}, CLS ${cls(x.lab.cls)}, FCP ${ms(x.lab.fcp)}.\n${f ? `Real Chrome users (p75, ${f.scope === "url" ? "this page" : "whole site"}): LCP ${ms(f.lcp)}, INP ${ms(f.inp)}, CLS ${cls(f.cls)}, verdict ${f.verdict ?? "–"}.` : "No real-user data from Chrome for this page."}\n${x.opportunities.length ? `Biggest wins: ${x.opportunities.map((o) => `${o.title} (~${ms(o.savingsMs)})`).join("; ")}.` : ""}`;
      });
      const trend = (k: string) => {
        const t = r.crux?.[k];
        if (!t || !t.dates.length) return null;
        const last = t.dates.length - 1;
        return `${k}: INP ${ms(t.inp[last])} (was ${ms(t.inp[0])} on ${t.dates[0]}), LCP ${ms(t.lcp[last])}, CLS ${cls(t.cls[last])}`;
      };
      const trends = ["phone", "desktop"].map(trend).filter(Boolean);
      return {
        text: `**${site.domain}** · speed\n\n${parts.join("\n\n")}${trends.length ? `\n\nSix-month trend, whole site (p75): \n- ${trends.join("\n- ")}` : ""}\n\nDashboard: ${c.origin}/s/${site.id}#s-speed`,
        data: r,
      };
    },
  },
  {
    name: "speed_test",
    title: "Run a PageSpeed test",
    description: "Run Google PageSpeed Insights (Lighthouse) on any page of the site now, mobile or desktop. Takes 10–40 seconds. Returns the score, lab metrics (LCP, TBT, CLS, FCP, Speed Index), the biggest suggested fixes, and Chrome's real-user data for the page if it has enough traffic. Limited to 10 runs an hour.",
    inputSchema: {
      type: "object",
      properties: { site: siteProp, url: { type: "string", description: "A path (e.g. /pricing) or full URL on the site. Default /." }, strategy: { type: "string", enum: ["mobile", "desktop"], description: "Default mobile." } },
      required: ["site"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (c, args) => {
      const site = await resolveSite(c, args.site);
      const url = siteUrl(site, args.url);
      const strategy = args.strategy === "desktop" ? "desktop" : "mobile";
      if (!allowSpeedTest(c.auth.tokenId)) throw new ToolError("speed_test is limited to 10 runs an hour per token; try again later or use the crux tool for real-user data");
      let r: SpeedResult;
      try {
        r = await pageSpeed(c.env, url, strategy);
      } catch (e) {
        if (e instanceof GoogleError && e.status === 503) throw new ToolError("PageSpeed isn't connected on this instance (Admin → Google)");
        // Lighthouse on Google's side fails now and then ("Something went wrong"): one retry.
        try {
          r = await pageSpeed(c.env, url, strategy);
        } catch (again) {
          throw new ToolError(`PageSpeed couldn't test ${url} (${(again as Error).message}). Google's Lighthouse fails now and then; try again in a minute.`);
        }
      }
      const f = r.field;
      return {
        text: `**${url}** · ${strategy} · Lighthouse score ${r.score ?? "–"}\n\nLab: LCP ${ms(r.lab.lcp)}, TBT ${ms(r.lab.tbt)} (the lab's stand-in for INP), CLS ${cls(r.lab.cls)}, FCP ${ms(r.lab.fcp)}, Speed Index ${ms(r.lab.si)}, server response ${ms(r.lab.ttfb)}.\n${f ? `Real Chrome users (p75, ${f.scope === "url" ? "this page" : "whole site, too few visits to this page"}): LCP ${ms(f.lcp)}, INP ${ms(f.inp)}, CLS ${cls(f.cls)}, TTFB ${ms(f.ttfb)}, verdict ${f.verdict ?? "–"}.` : "No real-user data from Chrome for this page."}\n\n${r.opportunities.length ? `Biggest wins:\n${r.opportunities.map((o) => `- ${o.title}: ~${ms(o.savingsMs)}`).join("\n")}` : "No big suggested fixes."}`,
        data: r,
      };
    },
  },
  {
    name: "crux",
    title: "Chrome real-user Core Web Vitals",
    description: "Real Chrome users' Core Web Vitals (INP, LCP, CLS, FCP, TTFB) over the last 28 days, from Google's Chrome UX Report, for a specific page or the whole site, on phones, desktops or both. Pages need enough Chrome traffic to have data.",
    inputSchema: {
      type: "object",
      properties: {
        site: siteProp,
        url: { type: "string", description: "A path (e.g. /pricing) or full URL. Omit for the whole site (origin)." },
        form_factor: { type: "string", enum: ["PHONE", "DESKTOP", "TABLET", "ALL"], description: "Default ALL." },
      },
      required: ["site"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (c, args) => {
      const site = await resolveSite(c, args.site);
      const ff = ["PHONE", "DESKTOP", "TABLET"].includes(String(args.form_factor)) ? (String(args.form_factor) as "PHONE" | "DESKTOP" | "TABLET") : undefined;
      const target = args.url ? { url: siteUrl(site, args.url) } : { origin: `https://${site.domain}` };
      let rec: CruxRecord | null;
      try {
        rec = await cruxRecord(c.env, target, ff);
      } catch (e) {
        if (e instanceof GoogleError && e.status === 503) throw new ToolError("The Chrome UX Report isn't connected on this instance (Admin → Google)");
        throw e;
      }
      const what = "url" in target ? target.url : `${target.origin} (whole site)`;
      if (!rec) return { text: `Chrome has too little traffic data for ${what}${ff ? ` on ${ff.toLowerCase()}` : ""} to report Core Web Vitals.`, data: null };
      const LIM: Record<string, [number, number]> = { inp: [200, 500], lcp: [2500, 4000], cls: [0.1, 0.25], fcp: [1800, 3000], ttfb: [800, 1800] };
      const rows = (["inp", "lcp", "cls", "fcp", "ttfb"] as const)
        .filter((k) => rec!.metrics[k])
        .map((k) => {
          const m = rec!.metrics[k]!;
          const v = m.p75 ?? 0;
          const verdict = v <= LIM[k][0] ? "good" : v <= LIM[k][1] ? "needs improvement" : "poor";
          return [k.toUpperCase(), k === "cls" ? cls(m.p75) : ms(m.p75), verdict, pct(m.good), pct(m.needsImprovement), pct(m.poor)];
        });
      return {
        text: `**${what}** · ${ff ? ff.toLowerCase() : "all devices"} · Chrome UX Report, ${rec.period.first} to ${rec.period.last}\n\n${table(["Metric", "p75", "Verdict", "Good", "Needs work", "Poor"], rows)}`,
        data: rec,
      };
    },
  },
];

// ---------------------------------------------------------------------------------------------------------
// Prompts

const PROMPTS = [
  {
    name: "investigate_inp",
    title: "Investigate INP (slow interactions)",
    description: "Find the most-used pages with slow interactions (INP) on a device type, and work out what to fix first.",
    arguments: [
      { name: "site", description: "Site domain, e.g. example.com", required: true },
      { name: "device", description: "Desktop or Mobile (default Desktop)", required: false },
    ],
    text: (a: Record<string, string>) => {
      const device = a.device === "Mobile" ? "Mobile" : "Desktop";
      const ff = device === "Mobile" ? "PHONE" : "DESKTOP";
      return `Help me fix Interaction to Next Paint (INP) on ${a.site} for ${device.toLowerCase()} visitors. Use the Quick Web Analytics tools:
1. web_vitals for ${a.site}, filters device is ${device}, last 30 days, group_by page: INP (and LCP/CLS) per page from real visits, busiest first.
2. slow_interactions for ${a.site} with device ${device}: which elements cause the slowest interactions, and whether the time is input delay, processing or presentation. Then again with page set to each of the two or three worst busy pages.
3. web_vitals with group_by day (period 90d, device ${device}) to see when INP got worse, if it did: match that against recent changes in this codebase.
4. If our own data is thin for a page, crux for that page's url with form_factor ${ff} gives Google's view, and speed_test with strategy ${device === "Mobile" ? "mobile" : "desktop"} shows the long JavaScript tasks (Total Blocking Time) and suggested fixes.
5. Rank the fixes by page views × how slow the interaction is, find the code behind each element (selectors like "nav > button.menu-toggle" map to components here), and propose concrete changes, starting with the top one. After deploying a fix, web_vitals for that page over the following days shows whether it worked.`;
    },
  },
  {
    name: "weekly_review",
    title: "Weekly review",
    description: "What changed on a site this week, and why.",
    arguments: [{ name: "site", description: "Site domain, e.g. example.com", required: true }],
    text: (a: Record<string, string>) => `Give me a short weekly review of ${a.site} using the Quick Web Analytics tools:
1. get_summary for the last 7 days (period 7d) vs the previous 7.
2. anomalies for the last 7 days.
3. breakdown by source and by page for 7d, and say which gained or lost the most.
4. If Search Console is connected, search_console for 7d: notable queries and position changes.
Finish with three bullet points: what went up, what went down, and one thing worth doing next.`,
  },
];

// ---------------------------------------------------------------------------------------------------------
// JSON-RPC over HTTP

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Json;
}

const rpcResult = (id: RpcMessage["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: RpcMessage["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function dispatch(c: Call, m: RpcMessage): Promise<unknown> {
  const id = m.id;
  switch (m.method) {
    case "initialize": {
      const asked = String(m.params?.protocolVersion ?? "");
      return rpcResult(id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS.map(({ run, ...t }) => t) });
    case "tools/call": {
      const name = String(m.params?.name ?? "");
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return rpcError(id, -32602, `unknown tool: ${name}`);
      try {
        const out = await tool.run(c, (m.params?.arguments ?? {}) as Json);
        return rpcResult(id, { content: [{ type: "text", text: out.text }], ...(out.data !== undefined && out.data !== null && typeof out.data === "object" && !Array.isArray(out.data) ? { structuredContent: out.data } : {}) });
      } catch (e) {
        if (!(e instanceof ToolError)) console.error("mcp tool failed", name, e);
        return rpcResult(id, { content: [{ type: "text", text: e instanceof ToolError ? e.message : `The tool failed: ${(e as Error).message}` }], isError: true });
      }
    }
    case "prompts/list":
      return rpcResult(id, { prompts: PROMPTS.map(({ text, ...p }) => p) });
    case "prompts/get": {
      const p = PROMPTS.find((x) => x.name === m.params?.name);
      if (!p) return rpcError(id, -32602, `unknown prompt: ${m.params?.name}`);
      const args = (m.params?.arguments ?? {}) as Record<string, string>;
      if (!args.site) return rpcError(id, -32602, "the site argument is required");
      return rpcResult(id, { description: p.description, messages: [{ role: "user", content: { type: "text", text: p.text(args) } }] });
    }
    default:
      return rpcError(id, -32601, `method not found: ${m.method}`);
  }
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "access-control-expose-headers": "mcp-session-id",
};

function reply(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { ...CORS, ...(body === null ? {} : { "content-type": "application/json" }), ...headers } });
}

export async function handleMcp(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...CORS, "access-control-max-age": "86400" } });
  // Stateless server: no server-initiated stream (GET) and no sessions to end (DELETE).
  if (req.method !== "POST") return reply(rpcError(null, -32000, "Use POST. This server doesn't offer a server-sent event stream."), 405, { allow: "POST, OPTIONS" });

  const auth = await authenticateToken(env, req.headers.get("authorization"));
  if (!auth) {
    const origin = originOf(env, req);
    return reply(rpcError(null, -32001, "Sign in with OAuth (clients that support it do this automatically), or create a token in the dashboard under Account → Agent access and send it as 'Authorization: Bearer qwa_pat_…'."), 401, {
      // MCP authorization: points OAuth-capable clients at the protected resource metadata.
      "www-authenticate": `Bearer realm="qwa", error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    });
  }
  if (env.MCP_LIMITER && !(await env.MCP_LIMITER.limit({ key: `mcp:${auth.tokenId}` })).success) {
    return reply(rpcError(null, -32002, "Too many requests: slow down (60 a minute per token)."), 429, { "retry-after": "30" });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return reply(rpcError(null, -32700, "parse error: expected JSON"), 400);
  }
  const origin = originOf(env, req);
  const c: Call = { env, ctx, auth, origin };
  const messages = (Array.isArray(body) ? body : [body]) as RpcMessage[];
  const out: unknown[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object" || m.jsonrpc !== "2.0" || typeof m.method !== "string") {
      out.push(rpcError((m as RpcMessage | null)?.id ?? null, -32600, "invalid request"));
      continue;
    }
    if (m.id === undefined || m.id === null) continue; // a notification (e.g. notifications/initialized): no reply
    out.push(await dispatch(c, m));
  }
  if (!out.length) return reply(null, 202);
  return reply(Array.isArray(body) ? out : out[0]);
}
