import type { Env, Site } from "./env";

/**
 * Google data: Search Console (clicks, impressions and queries from Google Search) through a service account,
 * and PageSpeed Insights plus the Chrome UX Report (lab and real-user speed) through an API key.
 * Both are optional. An admin connects them under Admin → Google (stored in D1 `settings`), or they can be set
 * as the Worker secrets GOOGLE_SERVICE_ACCOUNT / GOOGLE_API_KEY, which take precedence.
 */

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
}

const SCOPE_GSC = "https://www.googleapis.com/auth/webmasters.readonly";
export const SETTING_SA = "google_service_account";
export const SETTING_KEY = "google_api_key";

// Dashboard-saved settings, cached briefly per isolate.
let saved: { at: number; values: Map<string, string> } | null = null;

async function setting(env: Env, key: string): Promise<string | null> {
  if (!saved || Date.now() - saved.at > 60_000) {
    const { results } = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN (?, ?)").bind(SETTING_SA, SETTING_KEY).all<{ key: string; value: string }>();
    saved = { at: Date.now(), values: new Map(results.map((r) => [r.key, r.value])) };
  }
  return saved.values.get(key) ?? null;
}

export async function saveSetting(env: Env, key: string, value: string | null) {
  if (value === null) await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
  else await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)").bind(key, value, Math.floor(Date.now() / 1000)).run();
  saved = null;
  properties = null;
}

/** Parse and sanity-check a service account key file. */
export function parseServiceAccount(json: string): ServiceAccount | null {
  try {
    const sa = JSON.parse(json) as ServiceAccount & { type?: string };
    return sa.type === "service_account" && sa.client_email && sa.private_key?.includes("PRIVATE KEY") ? sa : null;
  } catch {
    return null;
  }
}

export async function serviceAccount(env: Env): Promise<(ServiceAccount & { source: "secret" | "dashboard" }) | null> {
  if (env.GOOGLE_SERVICE_ACCOUNT) {
    const sa = parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT);
    if (!sa) console.error("GOOGLE_SERVICE_ACCOUNT isn't a service account key file");
    return sa && { ...sa, source: "secret" };
  }
  const v = await setting(env, SETTING_SA);
  const sa = v ? parseServiceAccount(v) : null;
  return sa && { ...sa, source: "dashboard" };
}

export async function apiKey(env: Env): Promise<{ key: string; source: "secret" | "dashboard" } | null> {
  if (env.GOOGLE_API_KEY) return { key: env.GOOGLE_API_KEY, source: "secret" };
  const v = await setting(env, SETTING_KEY);
  return v ? { key: v, source: "dashboard" } : null;
}

const b64url = (data: ArrayBuffer | string) =>
  btoa(typeof data === "string" ? data : String.fromCharCode(...new Uint8Array(data))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Access tokens last an hour; keep one per isolate.
let token: { value: string; exp: number; email: string } | null = null;

async function accessToken(env: Env, given?: ServiceAccount): Promise<string> {
  const sa = given ?? (await serviceAccount(env));
  if (!sa) throw new GoogleError("Search Console isn't connected", 503);
  const now = Math.floor(Date.now() / 1000);
  if (!given && token && token.email === sa.client_email && token.exp - 120 > now) return token.value;
  const der = Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE_GSC, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }))}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(sig)}` }),
  });
  const j = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!j.access_token) throw new GoogleError(`Google sign-in failed: ${j.error_description ?? res.status}`, 502);
  if (given) return j.access_token;
  token = { value: j.access_token, exp: now + (j.expires_in ?? 3600), email: sa.client_email };
  return token.value;
}

export class GoogleError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Fetch JSON from Google, through the edge cache when `ttl` (seconds) is given. */
async function cachedJson<T>(cacheKey: string, ttl: number, load: () => Promise<Response>): Promise<T> {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request(`https://qwa-google-cache.internal/${encodeURIComponent(cacheKey)}`);
  const hit = ttl > 0 ? await cache?.match(key) : undefined;
  if (hit) return hit.json() as Promise<T>;
  const res = await load();
  const body = await res.text();
  if (!res.ok) {
    let msg = body.slice(0, 200);
    try {
      msg = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? msg;
    } catch {}
    throw new GoogleError(msg, res.status === 404 ? 404 : res.status === 403 ? 403 : 502);
  }
  if (ttl > 0 && cache) await cache.put(key, new Response(body, { headers: { "content-type": "application/json", "cache-control": `max-age=${ttl}` } }));
  return JSON.parse(body) as T;
}

async function sha(s: string) {
  return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).slice(0, 32);
}

// ---------------------------------------------------------------------------------------------------------
// Search Console

/** Properties the service account can read, e.g. "sc-domain:example.com" or "https://example.com/". */
let properties: { at: number; list: string[] } | null = null;

export async function gscProperties(env: Env, fresh = false): Promise<string[]> {
  if (!fresh && properties && Date.now() - properties.at < 15 * 60_000) return properties.list;
  const list = await listProperties(await accessToken(env));
  properties = { at: Date.now(), list };
  return list;
}

/** Properties a token can read. Unverified ones (the owner hasn't proved ownership yet) give no data, so they're left out. */
async function listProperties(token: string): Promise<string[]> {
  const res = await fetch("https://www.googleapis.com/webmasters/v3/sites", { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 403) throw new GoogleError("The Google Search Console API isn't turned on for this key's Google Cloud project", 400);
  if (!res.ok) throw new GoogleError(`Search Console: ${res.status}`, 502);
  const j = (await res.json()) as { siteEntry?: { siteUrl: string; permissionLevel: string }[] };
  return (j.siteEntry ?? []).filter((s) => s.permissionLevel !== "siteUnverifiedUser").map((s) => s.siteUrl);
}

/** Check a key file works (signs in, can call Search Console); returns the properties it can already read. */
export async function testServiceAccount(sa: ServiceAccount): Promise<string[]> {
  return listProperties(await accessToken({} as Env, sa));
}

/** Check an API key works for both the Chrome UX Report and PageSpeed Insights. Returns a problem, or null. */
export async function testApiKey(key: string): Promise<string | null> {
  const crux = await fetch(`https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ origin: "https://www.google.com", metrics: ["largest_contentful_paint"] }),
  });
  const reason = async (r: Response) => ((await r.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? String(r.status);
  if (!crux.ok && crux.status !== 404) return `Chrome UX Report: ${await reason(crux)}`;
  // An invalid URL fails fast with 400 once the key is accepted; a key that can't use the API gets 403.
  const psi = await fetch(`https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed?url=not-a-url&key=${encodeURIComponent(key)}`);
  if (psi.status === 403 || psi.status === 401) return `PageSpeed Insights: ${await reason(psi)}`;
  return null;
}

/** The Search Console property for a site: its own setting, else a domain or URL-prefix property that matches. */
export async function propertyFor(env: Env, site: Site): Promise<string | null> {
  if (site.gsc_property === "") return null; // turned off for this site
  if (!(await serviceAccount(env))) return null;
  const list = await gscProperties(env);
  if (site.gsc_property) return list.includes(site.gsc_property) ? site.gsc_property : null;
  const d = site.domain.toLowerCase();
  const candidates = [`sc-domain:${d}`, `https://${d}/`, `https://www.${d}/`, `http://${d}/`, `http://www.${d}/`];
  return candidates.find((c) => list.includes(c)) ?? null;
}

export interface SearchRow {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export type SearchDim = "query" | "page" | "device" | "country" | "date";

export interface SearchFilters {
  /** A dashboard page path ("/pricing"): matched on any scheme and on www. */
  page?: string;
  /** An exact search query. */
  query?: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Search Analytics for a property; cached at the edge (longer once the days have settled). */
export async function searchAnalytics(env: Env, site: Site, property: string, q: { from: string; to: string; dim?: SearchDim; filters?: SearchFilters; limit?: number }): Promise<SearchRow[]> {
  const filters = [];
  if (q.filters?.page) filters.push({ dimension: "page", operator: "includingRegex", expression: `^https?://(www\\.)?${escapeRe(site.domain)}${escapeRe(q.filters.page)}$` });
  if (q.filters?.query) filters.push({ dimension: "query", operator: "equals", expression: q.filters.query });
  const body = {
    startDate: q.from,
    endDate: q.to,
    dimensions: q.dim ? [q.dim] : [],
    rowLimit: q.limit ?? (q.dim === "date" ? 1000 : 50),
    dataState: "all", // include the freshest (still settling) days
    ...(filters.length ? { dimensionFilterGroups: [{ groupType: "and", filters }] } : {}),
  };
  // Recent days keep changing for ~3 days; older ranges are final.
  const settled = q.to < new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10);
  const key = `gsc:${property}:${await sha(JSON.stringify(body))}`;
  const j = await cachedJson<{ rows?: { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number }[] }>(key, settled ? 86_400 : 3 * 3600, async () =>
    fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${await accessToken(env)}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return (j.rows ?? []).map((r) => ({ key: r.keys?.[0] ?? "", clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }));
}

/** "https://www.example.com/a?b" → "/a?b" when it is this site's host; other hosts keep their name. */
export function pagePath(url: string, domain: string): { path: string; local: boolean } {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const path = (u.pathname || "/") + u.search;
    return host === domain.replace(/^www\./, "") ? { path, local: true } : { path: `${u.hostname}${path}`, local: false };
  } catch {
    return { path: url, local: false };
  }
}

// ---------------------------------------------------------------------------------------------------------
// PageSpeed Insights + Chrome UX Report

export type Strategy = "mobile" | "desktop";

export interface LabMetrics {
  lcp: number | null; // ms
  cls: number | null;
  tbt: number | null; // ms
  fcp: number | null; // ms
  si: number | null; // ms
  ttfb: number | null; // ms
}

/** p75 values from the Chrome UX Report (real Chrome users, last 28 days). */
export interface FieldMetrics {
  scope: "url" | "origin";
  lcp: number | null; // ms
  inp: number | null; // ms
  cls: number | null;
  fcp: number | null; // ms
  ttfb: number | null; // ms
  /** Google's overall Core Web Vitals verdict for the scope. */
  verdict: "FAST" | "AVERAGE" | "SLOW" | null;
}

export interface Opportunity {
  id: string;
  title: string;
  savingsMs: number;
}

export interface SpeedResult {
  url: string;
  strategy: Strategy;
  score: number | null;
  lab: LabMetrics;
  field: FieldMetrics | null;
  opportunities: Opportunity[];
}

type Audit = { title?: string; score?: number | null; numericValue?: number; details?: { type?: string; overallSavingsMs?: number }; metricSavings?: Record<string, number> };
type Experience = { overall_category?: string; metrics?: Record<string, { percentile?: number }> };

function field(exp: Experience | undefined, scope: "url" | "origin"): FieldMetrics | null {
  const m = exp?.metrics;
  if (!m || !Object.keys(m).length) return null;
  const p = (k: string) => (m[k]?.percentile ?? null);
  const cls = p("CUMULATIVE_LAYOUT_SHIFT_SCORE");
  const v = exp.overall_category;
  return {
    scope,
    lcp: p("LARGEST_CONTENTFUL_PAINT_MS"),
    inp: p("INTERACTION_TO_NEXT_PAINT"),
    cls: cls === null ? null : cls / 100,
    fcp: p("FIRST_CONTENTFUL_PAINT_MS"),
    ttfb: p("EXPERIMENTAL_TIME_TO_FIRST_BYTE"),
    verdict: v === "FAST" || v === "AVERAGE" || v === "SLOW" ? v : null,
  };
}

/** One Lighthouse run through PageSpeed Insights (takes 10–40 seconds). */
export async function pageSpeed(env: Env, url: string, strategy: Strategy): Promise<SpeedResult> {
  const k = await apiKey(env);
  if (!k) throw new GoogleError("PageSpeed isn't connected", 503);
  const qs = new URLSearchParams({ url, strategy, category: "performance", key: k.key });
  const res = await fetch(`https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed?${qs}`);
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GoogleError(`PageSpeed: HTTP ${res.status}${res.status === 524 || res.status === 504 ? " (Lighthouse timed out on this page)" : ""}`, 502);
  }
  const j = parsed as {
    error?: { message?: string };
    lighthouseResult?: { categories?: { performance?: { score?: number | null } }; audits?: Record<string, Audit> };
    loadingExperience?: Experience & { origin_fallback?: boolean };
    originLoadingExperience?: Experience;
  };
  if (!res.ok || !j.lighthouseResult) throw new GoogleError(`PageSpeed: ${j.error?.message ?? res.status}`, 502);
  const a = j.lighthouseResult.audits ?? {};
  const num = (id: string) => (typeof a[id]?.numericValue === "number" ? a[id].numericValue! : null);
  const score = j.lighthouseResult.categories?.performance?.score;
  const opportunities = Object.entries(a)
    .map(([id, x]) => {
      const ms = x.details?.overallSavingsMs ?? Math.max(0, ...Object.entries(x.metricSavings ?? {}).filter(([k]) => k !== "CLS").map(([, v]) => v));
      return { id, title: x.title ?? id, savingsMs: Math.round(ms), score: x.score };
    })
    .filter((o) => o.savingsMs >= 50 && typeof o.score === "number" && o.score < 0.9)
    .sort((x, y) => y.savingsMs - x.savingsMs)
    .slice(0, 5)
    .map(({ id, title, savingsMs }) => ({ id, title: title.replace(/`/g, ""), savingsMs }));
  const urlField = j.loadingExperience && !j.loadingExperience.origin_fallback ? field(j.loadingExperience, "url") : null;
  return {
    url,
    strategy,
    score: typeof score === "number" ? Math.round(score * 100) : null,
    lab: { lcp: num("largest-contentful-paint"), cls: num("cumulative-layout-shift"), tbt: num("total-blocking-time"), fcp: num("first-contentful-paint"), si: num("speed-index"), ttfb: num("server-response-time") },
    field: urlField ?? field(j.originLoadingExperience, "origin"),
    opportunities,
  };
}

export interface CruxHistory {
  /** Last day of each 28-day collection window (weekly). */
  dates: string[];
  lcp: (number | null)[];
  inp: (number | null)[];
  cls: (number | null)[];
}

/** Weekly p75 Core Web Vitals for an origin over the last ~6 months; null when Chrome has too little data. */
export async function cruxHistory(env: Env, origin: string, formFactor: "PHONE" | "DESKTOP"): Promise<CruxHistory | null> {
  const k = await apiKey(env);
  if (!k) return null;
  const body = { origin, formFactor, metrics: ["largest_contentful_paint", "interaction_to_next_paint", "cumulative_layout_shift"] };
  type Rec = { record?: { metrics?: Record<string, { percentilesTimeseries?: { p75s?: (number | string | null)[] } }>; collectionPeriods?: { lastDate: { year: number; month: number; day: number } }[] } };
  let j: Rec;
  try {
    j = await cachedJson<Rec>(`crux:${origin}:${formFactor}`, 12 * 3600, () =>
      fetch(`https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord?key=${encodeURIComponent(k.key)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    );
  } catch (e) {
    if (e instanceof GoogleError && e.status === 404) return null; // not enough Chrome traffic
    throw e;
  }
  const r = j.record;
  if (!r?.collectionPeriods?.length) return null;
  const series = (k: string) => (r.metrics?.[k]?.percentilesTimeseries?.p75s ?? []).map((v) => (v === null || v === undefined ? null : Number(v)));
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    dates: r.collectionPeriods.map((p) => `${p.lastDate.year}-${pad(p.lastDate.month)}-${pad(p.lastDate.day)}`),
    lcp: series("largest_contentful_paint"),
    inp: series("interaction_to_next_paint"),
    cls: series("cumulative_layout_shift"),
  };
}

export interface CruxMetric {
  /** 75th percentile (ms; CLS unitless). */
  p75: number | null;
  /** Share of page loads in Google's good / needs improvement / poor bands, 0–1. */
  good: number;
  needsImprovement: number;
  poor: number;
}

export interface CruxRecord {
  /** What the data covers: the exact URL, or the whole origin. */
  key: { url?: string; origin?: string; formFactor?: string };
  /** The 28-day collection window. */
  period: { first: string; last: string };
  metrics: Partial<Record<"inp" | "lcp" | "cls" | "fcp" | "ttfb", CruxMetric>>;
}

const CRUX_METRICS: Record<string, "inp" | "lcp" | "cls" | "fcp" | "ttfb"> = {
  interaction_to_next_paint: "inp",
  largest_contentful_paint: "lcp",
  cumulative_layout_shift: "cls",
  first_contentful_paint: "fcp",
  experimental_time_to_first_byte: "ttfb",
};

/** The Chrome UX Report's current 28-day record for a URL or an origin; null when Chrome has too little data for it. */
export async function cruxRecord(env: Env, target: { url: string } | { origin: string }, formFactor?: "PHONE" | "DESKTOP" | "TABLET"): Promise<CruxRecord | null> {
  const k = await apiKey(env);
  if (!k) throw new GoogleError("PageSpeed / Chrome UX Report isn't connected", 503);
  const body = { ...target, ...(formFactor ? { formFactor } : {}), metrics: Object.keys(CRUX_METRICS) };
  type Rec = { record?: { key: CruxRecord["key"]; collectionPeriod?: { firstDate: { year: number; month: number; day: number }; lastDate: { year: number; month: number; day: number } }; metrics?: Record<string, { histogram?: { density?: number }[]; percentiles?: { p75?: number | string } }> } };
  let j: Rec;
  try {
    j = await cachedJson<Rec>(`cruxrec:${JSON.stringify(body)}`, 12 * 3600, () =>
      fetch(`https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${encodeURIComponent(k.key)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    );
  } catch (e) {
    if (e instanceof GoogleError && e.status === 404) return null;
    throw e;
  }
  const r = j.record;
  if (!r) return null;
  const d = (x?: { year: number; month: number; day: number }) => (x ? `${x.year}-${String(x.month).padStart(2, "0")}-${String(x.day).padStart(2, "0")}` : "");
  const metrics: CruxRecord["metrics"] = {};
  for (const [name, m] of Object.entries(r.metrics ?? {})) {
    const id = CRUX_METRICS[name];
    if (!id) continue;
    const h = m.histogram ?? [];
    const p75 = m.percentiles?.p75;
    metrics[id] = { p75: p75 === undefined ? null : Number(p75), good: h[0]?.density ?? 0, needsImprovement: h[1]?.density ?? 0, poor: h[2]?.density ?? 0 };
  }
  return { key: r.key, period: { first: d(r.collectionPeriod?.firstDate), last: d(r.collectionPeriod?.lastDate) }, metrics };
}

// ---------------------------------------------------------------------------------------------------------
// Storage of speed runs (nightly, plus "test now")

export interface StoredRun extends SpeedResult {
  runAt: number;
}

export async function saveRun(env: Env, siteId: number, r: SpeedResult) {
  await env.DB.prepare("INSERT INTO speed_runs (site_id, url, strategy, run_at, score, lab, field, opportunities) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(siteId, r.url, r.strategy, Math.floor(Date.now() / 1000), r.score, JSON.stringify(r.lab), r.field ? JSON.stringify(r.field) : null, JSON.stringify(r.opportunities))
    .run();
}

export async function speedRuns(env: Env, siteId: number, sinceDays = 180): Promise<StoredRun[]> {
  const { results } = await env.DB.prepare("SELECT url, strategy, run_at, score, lab, field, opportunities FROM speed_runs WHERE site_id = ? AND run_at >= ? ORDER BY run_at")
    .bind(siteId, Math.floor(Date.now() / 1000) - sinceDays * 86_400)
    .all<{ url: string; strategy: Strategy; run_at: number; score: number | null; lab: string; field: string | null; opportunities: string }>();
  return results.map((r) => ({ url: r.url, strategy: r.strategy, runAt: r.run_at, score: r.score, lab: JSON.parse(r.lab), field: r.field ? JSON.parse(r.field) : null, opportunities: JSON.parse(r.opportunities) }));
}

/**
 * Test a site's home page on mobile and desktop (in parallel) and store the results. PageSpeed's Lighthouse
 * fails now and then ("Something went wrong"), so each is retried once, and one strategy failing doesn't
 * lose the other.
 */
export async function testSite(env: Env, site: Site): Promise<{ results: SpeedResult[]; errors: string[] }> {
  const url = `https://${site.domain}/`;
  const attempt = async (s: Strategy) => {
    try {
      return await pageSpeed(env, url, s);
    } catch (e) {
      if (e instanceof GoogleError && e.status === 503) throw e; // not connected: no point retrying
      return pageSpeed(env, url, s);
    }
  };
  const settled = await Promise.allSettled((["mobile", "desktop"] as Strategy[]).map(attempt));
  const results: SpeedResult[] = [];
  const errors: string[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") {
      await saveRun(env, site.id, r.value);
      results.push(r.value);
    } else errors.push((r.reason as Error).message);
  }
  if (!results.length) throw new GoogleError(errors[0] ?? "PageSpeed failed", 502);
  return { results, errors };
}

/**
 * Overnight PageSpeed tests: sites that had visitors in the last week and haven't been tested in the last 20 hours,
 * least recently tested first, at most `limit` per run (the scheduler spreads them over several hours, since each
 * test takes up to a minute or two). Runs older than 13 months are dropped.
 */
export async function speedJob(env: Env, sites: Site[], opts: { limit?: number } = {}) {
  if (!(await apiKey(env))) return;
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const { results } = await env.DB.prepare("SELECT DISTINCT site_id FROM daily_stats WHERE day >= ? AND visitors > 0").bind(since).all<{ site_id: number }>();
  const active = new Set(results.map((r) => r.site_id));
  const { results: last } = await env.DB.prepare("SELECT site_id, MAX(run_at) run_at FROM speed_runs GROUP BY site_id").all<{ site_id: number; run_at: number }>();
  const lastRun = new Map(last.map((r) => [r.site_id, r.run_at]));
  const due = Math.floor(Date.now() / 1000) - 20 * 3600;
  const queue = sites
    .filter((s) => active.has(s.id) && (lastRun.get(s.id) ?? 0) < due)
    .sort((a, b) => (lastRun.get(a.id) ?? 0) - (lastRun.get(b.id) ?? 0))
    .slice(0, opts.limit ?? Infinity);
  if (!queue.length) return;
  let failed = 0;
  const tested = queue.length;
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      try {
        const { errors } = await testSite(env, s);
        if (errors.length) console.warn("speed test partly failed", s.domain, errors.join("; "));
      } catch (e) {
        failed++;
        console.warn("speed test failed", s.domain, (e as Error).message);
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  await env.DB.prepare("DELETE FROM speed_runs WHERE run_at < ?").bind(Math.floor(Date.now() / 1000) - 400 * 86_400).run();
  console.log("speed tests done", JSON.stringify({ tested, failed }));
}
