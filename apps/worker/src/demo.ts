// Demo mode: synthetic sites and traffic for local development and screenshots.
// Only reachable when the Worker runs with DEMO=1 (see `npm run demo`); never enable it in production.
//
// History up to the start of "today" is written straight to R2 in the normal Parquet layout (month files for
// closed months, day files after that). Today, and the live traffic behind the realtime panels, goes through
// the site's Durable Object like real events, so every part of the dashboard has data.
import { dayKey, monthKey, TABLES, type TableName } from "@qwa/shared";
import type { Env, Site } from "./env";
import type { SessionAttrs, SiteEvent } from "./ingest/types";
import { invalidateSites } from "./sites";
import { emptyColumns, TableWriter } from "./storage/parquet";

/** R2 key written once a demo site is fully seeded (so an interrupted run is redone, not skipped). */
export const seededMarker = (siteId: number) => `demo/seeded/${siteId}`;
import { addDays, localMidnight, todayIn } from "./tz";

const HISTORY_DAYS = 400; // enough for 12-month views compared with the year before (partly)

interface Profile {
  domain: string;
  timezone: string;
  /** Visitors on a typical weekday at the start of the history. */
  base: number;
  /** Change in volume over the whole history (0.4 = +40%). */
  growth: number;
  weekend: number;
  bounce: number;
  pages: [string, number][];
  events: [string, number, Record<string, string>?][];
  countries?: [string, number][];
  /** Days ago with a traffic spike (e.g. a launch or a link from a big site), and its size. */
  spikes?: [number, number][];
}

export const DEMO_SITES: Profile[] = [
  {
    domain: "acme.example", timezone: "Europe/London", base: 1300, growth: 0.45, weekend: 0.62, bounce: 0.42,
    pages: [["/", 30], ["/pricing", 14], ["/features", 10], ["/blog", 8], ["/blog/introducing-acme-2", 7], ["/blog/how-we-cut-costs", 5], ["/customers", 4], ["/docs", 6], ["/signup", 6], ["/about", 3], ["/changelog", 4], ["/contact", 2]],
    events: [["Signup", 0.035, { plan: "free" }], ["Outbound Link: Click", 0.05, { url: "https://github.com/acme/acme" }], ["File Download", 0.015, { url: "/acme-brochure.pdf" }], ["Demo Booked", 0.008]],
    spikes: [[38, 2.6], [37, 1.7], [36, 1.2], [210, 1.9]],
  },
  {
    domain: "docs.acme.example", timezone: "America/New_York", base: 820, growth: 0.3, weekend: 0.45, bounce: 0.31,
    pages: [["/", 12], ["/getting-started", 18], ["/api", 14], ["/api/authentication", 9], ["/api/webhooks", 7], ["/guides/deploy", 8], ["/guides/migrate", 6], ["/sdk/javascript", 7], ["/sdk/python", 6], ["/faq", 5], ["/changelog", 4]],
    events: [["Search", 0.18], ["Copy Code", 0.14], ["Feedback", 0.02, { helpful: "yes" }], ["404", 0.012]],
  },
  {
    domain: "recipes.example", timezone: "America/Los_Angeles", base: 560, growth: 0.15, weekend: 1.35, bounce: 0.58,
    pages: [["/", 14], ["/recipes/sourdough", 12], ["/recipes/ramen", 9], ["/recipes/lasagne", 8], ["/recipes/tacos", 7], ["/recipes/banana-bread", 9], ["/collections/weeknight", 6], ["/collections/vegetarian", 5], ["/search", 5]],
    events: [["Print Recipe", 0.06], ["Save Recipe", 0.05], ["Outbound Link: Click", 0.02, { url: "https://www.youtube.com/@recipes" }]],
    spikes: [[12, 3.1], [11, 1.6], [96, 2.2]],
  },
  {
    domain: "northwind-coffee.example", timezone: "Europe/Berlin", base: 380, growth: 0.2, weekend: 1.1, bounce: 0.47,
    pages: [["/", 26], ["/shop", 18], ["/shop/espresso-blend", 9], ["/shop/filter-roast", 7], ["/subscriptions", 8], ["/cafes", 7], ["/cafes/berlin", 5], ["/about", 3], ["/cart", 6], ["/checkout", 3]],
    events: [["Add to Cart", 0.09, { product: "Espresso Blend" }], ["Checkout Started", 0.035], ["Purchase", 0.018, { value: "24.00" }]],
    countries: [["DE", 40], ["AT", 8], ["CH", 7], ["NL", 6], ["GB", 6], ["US", 6], ["FR", 5], ["PL", 4], ["DK", 3], ["SE", 3], ["BE", 3], ["IT", 3], ["ES", 2]],
  },
  {
    domain: "tinyshop.example", timezone: "Australia/Sydney", base: 300, growth: -0.25, weekend: 1.05, bounce: 0.51,
    pages: [["/", 24], ["/products", 16], ["/products/linen-tote", 9], ["/products/ceramic-mug", 8], ["/products/candle", 6], ["/sale", 7], ["/cart", 5], ["/shipping", 3]],
    events: [["Add to Cart", 0.07], ["Purchase", 0.014, { value: "38.00" }]],
    countries: [["AU", 52], ["NZ", 12], ["US", 9], ["GB", 6], ["SG", 4], ["CA", 3], ["JP", 2], ["DE", 2], ["IN", 2], ["IE", 1]],
  },
  {
    domain: "devlog.example", timezone: "UTC", base: 150, growth: 0.6, weekend: 0.8, bounce: 0.64,
    pages: [["/", 22], ["/posts/rust-in-production", 14], ["/posts/postgres-tips", 10], ["/posts/edge-functions", 9], ["/posts/year-in-review", 6], ["/about", 4], ["/rss.xml", 3]],
    events: [["Outbound Link: Click", 0.08, { url: "https://github.com/devlog" }], ["Newsletter Signup", 0.02]],
    spikes: [[64, 6.5], [63, 2.4], [62, 1.4]],
  },
  {
    domain: "photo-atlas.example", timezone: "Asia/Tokyo", base: 90, growth: 0.1, weekend: 1.25, bounce: 0.39,
    pages: [["/", 20], ["/gallery/kyoto", 14], ["/gallery/iceland", 11], ["/gallery/patagonia", 9], ["/prints", 6], ["/about", 3]],
    events: [["File Download", 0.03, { url: "/wallpapers/kyoto-4k.jpg" }], ["Print Enquiry", 0.01]],
    countries: [["JP", 30], ["US", 18], ["GB", 8], ["DE", 6], ["FR", 5], ["KR", 5], ["AU", 4], ["CA", 4], ["TW", 3], ["IT", 3], ["SG", 2], ["NL", 2]],
  },
  {
    domain: "status.acme.example", timezone: "UTC", base: 35, growth: 0.1, weekend: 0.5, bounce: 0.83,
    pages: [["/", 80], ["/incidents", 10], ["/history", 6]],
    events: [["Subscribe", 0.01]],
    spikes: [[3, 9], [4, 2.5], [23, 6]],
  },
];

// ---------- randomness ----------

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rand = () => number;
const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);
const pick = <T>(r: Rand, items: [T, number][]): T => {
  let x = r() * items.reduce((n, [, w]) => n + w, 0);
  for (const [v, w] of items) if ((x -= w) < 0) return v;
  return items[items.length - 1][0];
};
const id53 = (r: Rand) => Math.floor(r() * 2 ** 21) * 2 ** 32 + Math.floor(r() * 2 ** 32);
const normal = (r: Rand) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());

// ---------- traffic model ----------

const HOURS = [1, 0.7, 0.5, 0.4, 0.4, 0.5, 0.9, 1.6, 2.4, 3, 3.3, 3.4, 3.3, 3.2, 3.1, 3, 2.9, 2.8, 2.7, 2.9, 3, 2.6, 2, 1.4];

const COUNTRIES: [string, number][] = [
  ["US", 30], ["GB", 13], ["DE", 7], ["IN", 7], ["CA", 5], ["FR", 4], ["AU", 4], ["NL", 3], ["BR", 3], ["ES", 2], ["IT", 2], ["SE", 2], ["PL", 2],
  ["JP", 2], ["IE", 1.2], ["CH", 1], ["NO", 1], ["SG", 1], ["MX", 1], ["ZA", 1], ["NZ", 0.8], ["BE", 0.8], ["AT", 0.8], ["DK", 0.7], ["FI", 0.6],
  ["PT", 0.6], ["CZ", 0.5], ["RO", 0.5], ["TR", 0.5], ["AR", 0.5], ["KR", 0.5], ["ID", 0.5], ["PH", 0.5], ["NG", 0.4], ["KE", 0.3], ["EG", 0.3],
  ["IL", 0.4], ["AE", 0.4], ["CL", 0.3], ["CO", 0.3], ["VN", 0.3], ["UA", 0.3], ["GR", 0.3], ["HU", 0.3], ["TW", 0.3],
];
const CITIES: Record<string, [string, string][]> = {
  US: [["New York", "NY"], ["San Francisco", "CA"], ["Los Angeles", "CA"], ["Chicago", "IL"], ["Seattle", "WA"], ["Austin", "TX"], ["Boston", "MA"], ["Denver", "CO"]],
  GB: [["London", "ENG"], ["Manchester", "ENG"], ["Edinburgh", "SCT"], ["Bristol", "ENG"], ["Leeds", "ENG"], ["Cardiff", "WLS"]],
  DE: [["Berlin", "BE"], ["Munich", "BY"], ["Hamburg", "HH"], ["Cologne", "NW"], ["Frankfurt am Main", "HE"]],
  IN: [["Bengaluru", "KA"], ["Mumbai", "MH"], ["Delhi", "DL"], ["Hyderabad", "TG"], ["Pune", "MH"]],
  CA: [["Toronto", "ON"], ["Vancouver", "BC"], ["Montreal", "QC"]],
  FR: [["Paris", "IDF"], ["Lyon", "ARA"], ["Toulouse", "OCC"]],
  AU: [["Sydney", "NSW"], ["Melbourne", "VIC"], ["Brisbane", "QLD"], ["Perth", "WA"]],
  NL: [["Amsterdam", "NH"], ["Rotterdam", "ZH"], ["Utrecht", "UT"]],
  JP: [["Tokyo", "13"], ["Osaka", "27"], ["Kyoto", "26"]],
  BR: [["São Paulo", "SP"], ["Rio de Janeiro", "RJ"]],
};

type Channel = { channel: string; source: string; referrer: string; utm?: Partial<SessionAttrs> };
const CHANNELS: [() => Channel, number][] = [
  [() => ({ channel: "Organic Search", source: "Google", referrer: "https://www.google.com/" }), 36],
  [() => ({ channel: "Organic Search", source: "Bing", referrer: "https://www.bing.com/" }), 3.5],
  [() => ({ channel: "Organic Search", source: "DuckDuckGo", referrer: "https://duckduckgo.com/" }), 3],
  [() => ({ channel: "Organic Search", source: "Ecosia", referrer: "https://www.ecosia.org/" }), 0.8],
  [() => ({ channel: "Direct", source: "Direct", referrer: "" }), 27],
  [() => ({ channel: "Referral", source: "news.ycombinator.com", referrer: "https://news.ycombinator.com/" }), 2.5],
  [() => ({ channel: "Referral", source: "GitHub", referrer: "https://github.com/" }), 3],
  [() => ({ channel: "Referral", source: "dev.to", referrer: "https://dev.to/" }), 1.2],
  [() => ({ channel: "Referral", source: "Product Hunt", referrer: "https://www.producthunt.com/" }), 0.8],
  [() => ({ channel: "Organic Social", source: "Reddit", referrer: "https://www.reddit.com/" }), 4],
  [() => ({ channel: "Organic Social", source: "LinkedIn", referrer: "https://www.linkedin.com/" }), 2],
  [() => ({ channel: "Organic Social", source: "Bluesky", referrer: "https://bsky.app/" }), 1.5],
  [() => ({ channel: "Organic Social", source: "Mastodon", referrer: "https://mastodon.social/" }), 0.8],
  [() => ({ channel: "AI Assistants", source: "ChatGPT", referrer: "https://chatgpt.com/" }), 3],
  [() => ({ channel: "AI Assistants", source: "Perplexity", referrer: "https://www.perplexity.ai/" }), 0.9],
  [() => ({ channel: "AI Assistants", source: "Claude", referrer: "https://claude.ai/" }), 0.7],
  [() => ({ channel: "Organic Video", source: "YouTube", referrer: "https://www.youtube.com/" }), 1],
  [() => ({ channel: "Email", source: "Newsletter", referrer: "", utm: { utm_source: "newsletter", utm_medium: "email", utm_campaign: "monthly-digest" } }), 2],
  [() => ({ channel: "Paid Search", source: "Google", referrer: "https://www.google.com/", utm: { utm_source: "google", utm_medium: "cpc", utm_campaign: "brand", utm_term: "acme" } }), 1.2],
  [() => ({ channel: "Organic Social", source: "Reddit", referrer: "https://www.reddit.com/", utm: { utm_source: "reddit", utm_medium: "social", utm_campaign: "launch-week" } }), 0.6],
];

function tech(r: Rand): Pick<SessionAttrs, "device" | "browser" | "browser_version" | "os" | "os_version"> {
  const device = pick(r, [["Desktop", 55], ["Mobile", 41], ["Tablet", 4]]);
  if (device === "Desktop") {
    const os = pick(r, [["Windows", 54], ["Mac", 34], ["GNU/Linux", 9], ["Chrome OS", 3]]);
    const browser = os === "Mac" ? pick(r, [["Safari", 45], ["Chrome", 45], ["Firefox", 6], ["Microsoft Edge", 4]]) : pick(r, [["Chrome", 66], ["Microsoft Edge", 18], ["Firefox", 12], ["Opera", 4]]);
    const os_version = os === "Windows" ? pick(r, [["11", 62], ["10", 38]]) : os === "Mac" ? "10.15" : "";
    return { device, os, os_version, browser, browser_version: browser === "Safari" ? pick(r, [["26.0", 70], ["18.6", 30]]) : browser === "Firefox" ? "143.0" : "141.0" };
  }
  const os = pick(r, [["iOS", 56], ["Android", 44]]);
  const browser = os === "iOS" ? pick(r, [["Safari", 82], ["Chrome", 14], ["Firefox", 4]]) : pick(r, [["Chrome", 78], ["Samsung Browser", 16], ["Firefox", 6]]);
  const os_version = os === "iOS" ? pick(r, [["26.0", 58], ["18.6", 34], ["17.7", 8]]) : pick(r, [["16", 36], ["15", 38], ["14", 18], ["13", 8]]);
  return { device, os, os_version, browser, browser_version: browser === "Safari" ? "26.0" : browser === "Samsung Browser" ? "28.0" : "141.0" };
}

interface GenSession { attrs: SessionAttrs; visitor: number; session: number; start: number; views: { ts: number; path: string; dwell: number; scroll: number }[]; events: { ts: number; name: string; path: string; props: string }[] }

/** Expected visitors on a local day `ago` days before today. */
function dayVolume(p: Profile, ago: number, weekday: number, r: Rand): number {
  const t = 1 - ago / HISTORY_DAYS;
  let v = p.base * (1 + p.growth * t) * (weekday === 0 || weekday === 6 ? p.weekend : 1);
  v *= 1 + 0.08 * Math.sin((2 * Math.PI * ago) / 91) + 0.09 * normal(r);
  for (const [d, m] of p.spikes ?? []) if (d === ago) v *= m;
  return Math.max(1, v);
}

function makeSession(p: Profile, r: Rand, start: number, visitor: number): GenSession {
  const ch = pick(r, CHANNELS)();
  const country = pick(r, p.countries ?? COUNTRIES);
  const cities = CITIES[country];
  const [city, region] = cities && r() < 0.85 ? cities[Math.floor(r() ** 1.6 * cities.length)] : ["", ""];
  const attrs: SessionAttrs = {
    referrer: ch.referrer, source: ch.source, channel: ch.channel,
    utm_source: "", utm_medium: "", utm_campaign: "", utm_content: "", utm_term: "", ...ch.utm,
    country, region: region ? `${country}-${region}` : "", city, ...tech(r),
  };
  const bounce = r() < p.bounce;
  const n = bounce ? 1 : 2 + Math.floor(-Math.log(r() || 1e-9) * 2.2);
  const views: GenSession["views"] = [];
  let ts = start;
  let path = pick(r, p.pages);
  for (let i = 0; i < n; i++) {
    const dwell = Math.round(Math.min(900, 8 + -Math.log(r() || 1e-9) * (bounce ? 35 : 70)));
    views.push({ ts, path, dwell, scroll: Math.min(100, Math.round(15 + r() * 90)) });
    ts += dwell;
    path = pick(r, p.pages);
  }
  const events: GenSession["events"] = [];
  for (const [name, rate, props] of p.events) {
    if (r() < rate * (bounce ? 0.4 : 1.6)) {
      const v = views[Math.floor(r() * views.length)];
      events.push({ ts: v.ts + Math.round(v.dwell * r()), name, path: name === "404" ? "/old-page" : v.path, props: props ? JSON.stringify(props) : "" });
    }
  }
  return { attrs, visitor, session: id53(r), start, views, events };
}

/** All sessions starting on local day `day` (deterministic per site and day). */
function daySessions(p: Profile, day: string, ago: number): GenSession[] {
  const r = rng(hash(`${p.domain}|${day}`));
  const midnight = localMidnight(p.timezone, day);
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  const visits = Math.round(dayVolume(p, ago, weekday, r) * 1.12);
  const hourWeights = HOURS.map((w, h) => [h, w] as [number, number]);
  const today: number[] = [];
  const out: GenSession[] = [];
  for (let i = 0; i < visits; i++) {
    const start = midnight + pick(r, hourWeights) * 3600 + Math.floor(r() * 3600);
    // About 1 in 9 visits is the same (daily-hashed) visitor coming back later that day.
    const visitor = today.length && r() < 0.11 ? today[Math.floor(r() * today.length)] : id53(r);
    today.push(visitor);
    out.push(makeSession(p, r, start, visitor));
  }
  return out;
}

// ---------- writing history ----------

type Cols = Record<string, unknown[]>;

/** Append a session's rows; each row goes to the buffer for its own timestamp. */
function addRows(bufAt: (ts: number) => Record<TableName, Cols>, domain: string, s: GenSession) {
  const last = Math.max(...s.views.map((v) => v.ts + v.dwell), ...s.events.map((e) => e.ts));
  const lastView = s.views[s.views.length - 1];
  const interactive = s.events.some((e) => e.name !== "404");
  const row: Record<string, unknown> = {
    session: s.session, visitor: s.visitor, start: s.start, last,
    hostname: domain, entry_page: s.views[0].path, exit_page: lastView.path,
    pageviews: s.views.length, events: s.views.length + s.events.length,
    bounce: s.views.length === 1 && !interactive ? 1 : 0, duration: lastView.ts - s.start, ...s.attrs,
  };
  const push = (t: TableName, ts: number, r: Record<string, unknown>) => {
    for (const [k, list] of Object.entries(bufAt(ts)[t])) list.push(r[k] ?? "");
  };
  push("sessions", s.start, row);
  for (const v of s.views) {
    push("pageviews", v.ts, { ts: v.ts, session: s.session, visitor: s.visitor, hostname: domain, path: v.path, props: "" });
    push("engagement", v.ts + v.dwell, { ts: v.ts + v.dwell, session: s.session, visitor: s.visitor, path: v.path, scroll_depth: v.scroll, engaged_ms: Math.round(v.dwell * 700) });
  }
  for (const e of s.events) push("custom", e.ts, { ts: e.ts, session: s.session, visitor: s.visitor, name: e.name, path: e.path, props: e.props });
}

const emptyBuf = () => Object.fromEntries(TABLES.map((t) => [t, emptyColumns(t)])) as Record<TableName, Cols>;
const TIME: Record<TableName, string> = { sessions: "start", pageviews: "ts", engagement: "ts", custom: "ts" };
const utcDay = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

/** Split a buffer's rows into UTC days. */
function byUtcDay(buf: Record<TableName, Cols>): Map<string, Record<TableName, Cols>> {
  const out = new Map<string, Record<TableName, Cols>>();
  for (const t of TABLES) {
    const cols = buf[t];
    const times = cols[TIME[t]] as number[];
    const names = Object.keys(cols);
    times.forEach((ts, i) => {
      const d = utcDay(ts);
      let b = out.get(d);
      if (!b) out.set(d, (b = emptyBuf()));
      for (const n of names) b[t][n].push(cols[n][i]);
    });
  }
  return out;
}

async function writeFile(env: Env, key: string, table: TableName, cols: Cols) {
  const w = new TableWriter(table);
  w.write(cols);
  if (w.rows) await env.DATA.put(key, w.finish());
}

/**
 * Create the demo sites (idempotent). Their creation date is set to the start of the history so the
 * nightly rollup backfills it.
 */
export async function createDemoSites(env: Env): Promise<{ id: number; domain: string }[]> {
  const created = new Date(Date.now() - (HISTORY_DAYS + 2) * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  for (const p of DEMO_SITES) {
    await env.DB.prepare("INSERT INTO sites (domain, timezone, created_at) VALUES (?, ?, ?) ON CONFLICT(domain) DO NOTHING")
      .bind(p.domain, p.timezone, created)
      .run();
  }
  invalidateSites();
  const { results } = await env.DB.prepare(`SELECT id, domain FROM sites WHERE domain IN (${DEMO_SITES.map(() => "?").join(",")}) ORDER BY id`)
    .bind(...DEMO_SITES.map((p) => p.domain))
    .all<{ id: number; domain: string }>();
  return results;
}

/** First second owned by the Durable Object: the earlier of local midnight today and the UTC midnight before it. */
function liveFrom(p: Profile): number {
  const mid = localMidnight(p.timezone, todayIn(p.timezone));
  return Math.min(mid, Date.parse(`${utcDay(mid)}T00:00:00Z`) / 1000);
}

/** Write a site's history (before `liveFrom`) to R2. Returns the number of sessions written. */
export async function seedHistory(env: Env, site: Site): Promise<number> {
  const p = DEMO_SITES.find((x) => x.domain === site.domain);
  if (!p) throw new Error(`${site.domain} is not a demo site`);
  const cut = liveFrom(p);
  const today = todayIn(p.timezone);
  const curMonth = utcDay(cut).slice(0, 7);
  const months = new Map<string, Record<TableName, Cols>>();
  const bufAt = (ts: number) => {
    const m = utcDay(ts).slice(0, 7);
    let b = months.get(m);
    if (!b) months.set(m, (b = emptyBuf()));
    return b;
  };
  let sessions = 0;

  // Closed months become month files (as compaction would leave them); the current month stays as day files.
  const flushMonth = async (m: string) => {
    const b = months.get(m)!;
    months.delete(m);
    if (m < curMonth) {
      for (const t of TABLES) await writeFile(env, monthKey(site.id, t, m), t, b[t]);
    } else {
      for (const [d, db] of byUtcDay(b)) for (const t of TABLES) await writeFile(env, dayKey(site.id, t, d), t, db[t]);
    }
  };

  for (let ago = HISTORY_DAYS; ago >= 0; ago--) {
    const day = addDays(today, -ago);
    for (const s of daySessions(p, day, ago)) {
      if (s.start >= cut) continue;
      addRows(bufAt, p.domain, s);
      sessions++;
    }
    // Rows can spill past local midnight by a few hours at most, so months ending 2+ days ago are complete.
    const done = utcDay(localMidnight(p.timezone, day) - 2 * 86_400).slice(0, 7);
    for (const m of [...months.keys()]) if (m < done) await flushMonth(m);
  }
  for (const m of [...months.keys()].sort()) await flushMonth(m);
  return sessions;
}

function toEvents(siteDomain: string, s: GenSession, until: number): SiteEvent[] {
  const evs: SiteEvent[] = [];
  const base = { hostname: siteDomain, visitor: s.visitor, prevVisitor: null, via: "qwa" as const, session: s.attrs, props: {} as Record<string, string> };
  for (const v of s.views) {
    if (v.ts <= until) evs.push({ ...base, ts: v.ts, kind: "pageview", name: "pageview", path: v.path, scrollDepth: null, engagedMs: null, interactive: true });
    if (v.ts + v.dwell <= until) evs.push({ ...base, ts: v.ts + v.dwell, kind: "engagement", name: "engagement", path: v.path, scrollDepth: v.scroll, engagedMs: Math.round(v.dwell * 700), interactive: false });
  }
  for (const e of s.events) {
    if (e.ts <= until) evs.push({ ...base, ts: e.ts, kind: "custom", name: e.name, path: e.path, props: e.props ? JSON.parse(e.props) : {}, scrollDepth: null, engagedMs: null, interactive: e.name !== "404" });
  }
  return evs.sort((a, b) => a.ts - b.ts);
}

/** Feed "today" (from `liveFrom` up to now) through the site's Durable Object, then write its day files. */
export async function seedToday(env: Env, site: Site): Promise<number> {
  const p = DEMO_SITES.find((x) => x.domain === site.domain);
  if (!p) throw new Error(`${site.domain} is not a demo site`);
  const from = liveFrom(p);
  const now = Math.floor(Date.now() / 1000);
  const today = todayIn(p.timezone);
  const evs: SiteEvent[] = [];
  for (const ago of [1, 0]) {
    for (const s of daySessions(p, addDays(today, -ago), ago)) if (s.start >= from && s.start <= now) evs.push(...toEvents(p.domain, s, now));
  }
  evs.sort((a, b) => a.ts - b.ts);
  const stub = env.SITE.get(env.SITE.idFromName(String(site.id)));
  for (let i = 0; i < evs.length; i += 500) await stub.ingestMany(site.id, evs.slice(i, i + 500));
  await stub.flush();
  return evs.length;
}

/** Live traffic for every demo site over the last `seconds` (default a minute), so the realtime panels move. */
export async function demoTick(env: Env, sites: Site[], seconds = 60): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const r = rng(now);
  let n = 0;
  for (const site of sites) {
    const p = DEMO_SITES.find((x) => x.domain === site.domain);
    if (!p) continue;
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: p.timezone, hour: "2-digit", hourCycle: "h23" }).format(new Date()));
    const perMinute = (p.base * (1 + p.growth) * 1.12 * HOURS[hour]) / HOURS.reduce((a, b) => a + b, 0) / 60;
    const count = Math.floor((perMinute * seconds) / 60 + r());
    const evs: SiteEvent[] = [];
    for (let i = 0; i < count; i++) evs.push(...toEvents(p.domain, makeSession(p, r, now - Math.floor(r() * seconds), id53(r)), now));
    if (!evs.length) continue;
    evs.sort((a, b) => a.ts - b.ts);
    const stub = env.SITE.get(env.SITE.idFromName(String(site.id)));
    for (let i = 0; i < evs.length; i += 500) await stub.ingestMany(site.id, evs.slice(i, i + 500));
    n += evs.length;
  }
  return n;
}
