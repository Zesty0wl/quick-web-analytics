import { Hono } from "hono";
import { validateSpec } from "@qwa/shared";
import { AuthError, canViewSite, currentUser, visibleSiteIds, type User } from "./auth";
import type { Env } from "./env";
import { allSites, invalidateSites, siteById } from "./sites";
import { alertDetail, anomalyJob, checkIntraday, emailConfigured, refreshAnomalies, sendAlertEmail, siteAnomalies } from "./alerts";
import { sampleAlert } from "./email";
import { createDemoSites, demoTick, seededMarker, seedHistory, seedToday } from "./demo";
import { rollupSite, storedDays, type DayStats } from "./rollup";
import { addDays, localMidnight, todayIn } from "./tz";
import { alpha2 } from "./iso3";
import { createToken, forgetGrant, listTokens, revokeToken } from "./tokens";
import { approve, checkAuthorize, listGrants, revokeGrant } from "./oauth";
import {
  apiKey, cruxHistory, GoogleError, gscProperties, pagePath, parseServiceAccount, propertyFor, saveSetting, searchAnalytics, serviceAccount, SETTING_KEY, SETTING_SA,
  speedRuns, testApiKey, testServiceAccount, testSite, type SearchDim, type SearchRow,
} from "./google";

type Ctx = { Bindings: Env; Variables: { user: User } };

export const api = new Hono<Ctx>();

/** Env key under which mcp.ts passes the authenticated token's user to these routes. */
export const INTERNAL_USER = "__qwaInternalUser";

api.onError((err, c) => {
  if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

// Authenticate every API call; reject cross-site writes (state changes must be same-origin JSON).
api.use("*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("origin");
    if (origin && new URL(origin).host !== new URL(c.req.url).host) return c.json({ error: "cross-origin request" }, 403);
    if (!c.req.header("content-type")?.includes("application/json")) return c.json({ error: "expected JSON" }, 415);
  }
  // MCP tool calls run through these same routes as the token's user (set by mcp.ts, never from a request).
  const internal = (c.env as Env & { [INTERNAL_USER]?: User })[INTERNAL_USER];
  c.set("user", internal ?? (await currentUser(c.req.raw, c.env)));
  await next();
});

const siteGuard = async (c: { env: Env; get: (k: "user") => User; req: { param: (k: string) => string } }) => {
  const site = await siteById(c.env, Number(c.req.param("site")));
  if (!site || !(await canViewSite(c.env, c.get("user"), site.id))) return null;
  return site;
};

api.get("/me", async (c) => {
  const user = c.get("user");
  const visible = await visibleSiteIds(c.env, user);
  const sites = (await allSites(c.env)).filter((s) => visible === "all" || visible.includes(s.id));
  return c.json({ user, sites: sites.map(({ id, domain, timezone }) => ({ id, domain, timezone })) });
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMPTY = (day: string): DayStats => ({ day, visitors: 0, visits: 0, pageviews: 0, events: 0, bounces: 0, duration_sum: 0 });

/**
 * All visible sites with daily totals for the current range (`from`..`to`) and the comparison range
 * (`cfrom`..`cto`). Closed days come from D1; today (and yesterday until rolled up) live from each site's
 * DO, falling back to the query worker where the DO's data doesn't cover the whole day.
 */
api.get("/overview", async (c) => {
  const user = c.get("user");
  const q = (k: string) => c.req.query(k) ?? "";
  const from = q("from"), to = q("to"), cfrom = q("cfrom"), cto = q("cto");
  if (![from, to, cfrom, cto].every((d) => DATE.test(d)) || from > to || cfrom > cto) return c.json({ error: "from/to/cfrom/cto must be YYYY-MM-DD ranges" }, 400);
  if (addDays(from, 800) < to || addDays(cfrom, 800) < cto) return c.json({ error: "range too long" }, 400);

  const visible = await visibleSiteIds(c.env, user);
  const sites = (await allSites(c.env)).filter((s) => visible === "all" || visible.includes(s.id));
  const stored = await storedDays(c.env, sites.map((s) => s.id), [from, cfrom].sort()[0]);
  const { results: activeRows } = await c.env.DB.prepare("SELECT site_id, MAX(day) day FROM daily_stats WHERE visitors > 0 OR pageviews > 0 GROUP BY site_id").all<{ site_id: number; day: string }>();
  const lastActive = new Map(activeRows.map((r) => [r.site_id, r.day]));
  const anomalies = await siteAnomalies(c.env, sites.map((s) => s.id), [from, cfrom].sort()[0], to);

  const out = await Promise.all(
    sites.map(async (site) => {
      const today = todayIn(site.timezone);
      const have = new Map((stored.get(site.id) ?? []).map((d) => [d.day, d]));
      const inRange = (d: string) => (d >= from && d <= to) || (d >= cfrom && d <= cto);
      const liveDays = [today, addDays(today, -1)].filter((d) => inRange(d) && (d === today || !have.has(d)));
      const bounds = liveDays.map((day) => ({ day, start: localMidnight(site.timezone, day), end: localMidnight(site.timezone, addDays(day, 1)) }));
      let live;
      try {
        live = await c.env.SITE.get(c.env.SITE.idFromName(String(site.id))).overview(bounds);
      } catch (e) {
        console.error("overview DO failed", site.domain, e);
        live = { firstEventAt: null, lastEventAt: null, plausible14d: 0, qwa14d: 0, plausibleLastAt: null, qwaLastAt: null, cappedAt: null, now: 0, perMinute: [] as number[], days: [] };
      }
      for (const d of live.days) {
        let stats: DayStats = d;
        if (!d.complete) {
          try {
            const r = await c.env.QUERY.query(site.id, site.timezone, {
              from: d.day, to: d.day, metrics: ["visitors", "visits", "pageviews", "events", "bounce_rate", "visit_duration"],
            });
            const x = r.rows[0] ?? {};
            stats = {
              day: d.day, visitors: Number(x.visitors ?? 0), visits: Number(x.visits ?? 0), pageviews: Number(x.pageviews ?? 0), events: Number(x.events ?? 0),
              bounces: Math.round((Number(x.bounce_rate ?? 0) * Number(x.visits ?? 0)) / 100), duration_sum: Math.round(Number(x.visit_duration ?? 0) * Number(x.visits ?? 0)),
            };
          } catch (e) {
            console.error("overview fallback query failed", site.domain, e);
          }
        }
        have.set(d.day, stats);
      }
      const series = (a: string, b: string) => {
        const days: DayStats[] = [];
        for (let d = a; d <= b && d <= today; d = addDays(d, 1)) days.push(have.get(d) ?? EMPTY(d));
        return days;
      };
      // Most recent day with traffic in what we hold (for "last visit" when the DO's window is empty).
      let lastActiveDay: string | null = lastActive.get(site.id) ?? null;
      for (const [d, v] of have) if ((v.visitors > 0 || v.pageviews > 0) && (!lastActiveDay || d > lastActiveDay)) lastActiveDay = d;
      return {
        id: site.id, domain: site.domain, timezone: site.timezone,
        lastEventAt: live.lastEventAt, lastActiveDay, now: live.now, perMinute: live.perMinute, cappedAt: live.cappedAt ?? null,
        current: series(from, to), comparison: series(cfrom, cto),
        anomalies: anomalies.filter((a) => a.site_id === site.id && a.day >= from).map(({ day, kind, value, expected, metric, detail }) => ({ day, kind, value, expected, metric, detail: detail ? JSON.parse(detail) : null })),
        ...(user.role === "admin" ? { plausible14d: live.plausible14d, qwa14d: live.qwa14d, plausibleLastAt: live.plausibleLastAt, qwaLastAt: live.qwaLastAt } : {}),
      };
    }),
  );
  return c.json({ sites: out });
});

api.post("/sites/:site/query", async (c) => {
  const site = await siteGuard(c);
  if (!site) return c.json({ error: "site not found" }, 404);
  let spec;
  try {
    spec = validateSpec(await c.req.json());
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
  try {
    return c.json(await c.env.QUERY.query(site.id, site.timezone, spec));
  } catch (e) {
    console.error("query failed", e);
    return c.json({ error: `query failed: ${(e as Error).message}` }, 502);
  }
});

// ---------- anomalies and alerts ----------

api.get("/sites/:site/anomalies", async (c) => {
  const site = await siteGuard(c);
  if (!site) return c.json({ error: "site not found" }, 404);
  const from = c.req.query("from") ?? "", to = c.req.query("to") ?? "";
  if (!DATE.test(from) || !DATE.test(to)) return c.json({ error: "from/to must be YYYY-MM-DD" }, 400);
  const list = await siteAnomalies(c.env, [site.id], from, to);
  return c.json({ anomalies: list.map(({ day, kind, value, expected, score, metric, detail }) => ({ day, kind, value, expected, score, metric, detail: detail ? JSON.parse(detail) : null })) });
});

/** The signed-in user's alert settings ("all sites", or a list), and whether email is set up at all. */
api.get("/alerts", async (c) => {
  const user = c.get("user");
  const [{ results }, row] = await Promise.all([
    c.env.DB.prepare("SELECT site_id FROM alert_subscriptions WHERE user_id = ?").bind(user.id).all<{ site_id: number }>(),
    c.env.DB.prepare("SELECT alert_all FROM users WHERE id = ?").bind(user.id).first<{ alert_all: number }>(),
  ]);
  return c.json({ email: emailConfigured(c.env), all: Boolean(row?.alert_all), sites: results.map((r) => r.site_id) });
});

/** Replace the signed-in user's alert settings in one go (the Admin → Alerts checklist). */
api.put("/alerts", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ all?: boolean; sites?: number[] }>();
  const visible = await visibleSiteIds(c.env, user);
  const stmts = [];
  if (typeof body.all === "boolean") stmts.push(c.env.DB.prepare("UPDATE users SET alert_all = ? WHERE id = ?").bind(body.all ? 1 : 0, user.id));
  if (Array.isArray(body.sites)) {
    const ids = [...new Set(body.sites.map(Number))].filter((id) => Number.isInteger(id) && (visible === "all" || visible.includes(id)));
    stmts.push(c.env.DB.prepare("DELETE FROM alert_subscriptions WHERE user_id = ?").bind(user.id));
    for (const id of ids) stmts.push(c.env.DB.prepare("INSERT OR IGNORE INTO alert_subscriptions (user_id, site_id) SELECT ?, id FROM sites WHERE id = ?").bind(user.id, id));
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

api.put("/sites/:site/alerts", async (c) => {
  const site = await siteGuard(c);
  if (!site) return c.json({ error: "site not found" }, 404);
  const { on } = await c.req.json<{ on?: boolean }>();
  const user = c.get("user");
  await (on
    ? c.env.DB.prepare("INSERT INTO alert_subscriptions (user_id, site_id) VALUES (?, ?) ON CONFLICT DO NOTHING").bind(user.id, site.id)
    : c.env.DB.prepare("DELETE FROM alert_subscriptions WHERE user_id = ? AND site_id = ?").bind(user.id, site.id)
  ).run();
  return c.json({ on: Boolean(on) });
});

/** Send the signed-in user a test alert: their most recent real anomaly if there is one, otherwise a sample. */
api.post("/alerts/test", async (c) => {
  if (!emailConfigured(c.env)) return c.json({ error: "Email isn't set up: add the EMAIL binding and ALERT_FROM (see docs/DEPLOY.md)." }, 400);
  const user = c.get("user");
  const visible = await visibleSiteIds(c.env, user);
  const sites = (await allSites(c.env)).filter((s) => visible === "all" || visible.includes(s.id));
  const recent = sites.length
    ? await c.env.DB.prepare(`SELECT site_id, day, kind, value, expected FROM anomalies WHERE site_id IN (${sites.map((s) => s.id).join(",")}) ORDER BY day DESC LIMIT 1`)
        .first<{ site_id: number; day: string; kind: "spike" | "drop" | "outage"; value: number; expected: number }>()
    : null;
  const site = recent && sites.find((s) => s.id === recent.site_id);
  const detail = recent && site ? await alertDetail(c.env, site, recent) : sampleAlert(addDays(todayIn("UTC"), -1));
  try {
    const r = await sendAlertEmail(c.env, user.email, [detail], true);
    return c.json({ sent: true, to: user.email, about: recent && site ? `${site.domain}, ${recent.day}` : "a sample alert", messageId: r.messageId });
  } catch (e) {
    return c.json({ error: `Sending failed: ${(e as Error).message}` }, 502);
  }
});

api.get("/sites/:site/realtime", async (c) => {
  const site = await siteGuard(c);
  if (!site) return c.json({ error: "site not found" }, 404);
  return c.json(await c.env.SITE.get(c.env.SITE.idFromName(String(site.id))).realtime());
});

// ---------- Google: Search Console and speed ----------

const googleError = (c: { json: (b: unknown, s: 502) => Response }, e: unknown) => {
  if (e instanceof GoogleError) return c.json({ error: e.message }, (e.status === 503 ? 502 : e.status) as 502);
  throw e;
};
const ZERO: Omit<SearchRow, "key"> = { clicks: 0, impressions: 0, ctr: 0, position: 0 };
// Search Console keeps 16 months.
const gscFloor = () => new Date(Date.now() - 480 * 86_400_000).toISOString().slice(0, 10);

/** Is Search Console connected for this site? Returns the property, or a JSON reply explaining why not. */
async function searchSetup(env: Env, site: NonNullable<Awaited<ReturnType<typeof siteById>>>) {
  const sa = await serviceAccount(env);
  if (!sa) return { reply: { status: "not-connected" as const } };
  const property = await propertyFor(env, site);
  if (!property) return { reply: { status: "no-property" as const, account: sa.client_email } };
  return { property };
}

/** Clicks, impressions, CTR and position for the range and the comparison range, with daily series. */
api.get("/sites/:site/search", async (c) => {
  const site = await siteGuard(c);
  if (!site) return c.json({ error: "site not found" }, 404);
  const q = (k: string) => c.req.query(k) ?? "";
  let from = q("from"), cfrom = q("cfrom");
  const to = q("to"), cto = q("cto");
  if (![from, to, cfrom, cto].every((d) => DATE.test(d)) || from > to || cfrom > cto) return c.json({ error: "from/to/cfrom/cto must be YYYY-MM-DD ranges" }, 400);
  try {
    const setup = await searchSetup(c.env, site);
    if (!setup.property) return c.json(setup.reply);
    from = from < gscFloor() ? gscFloor() : from;
    cfrom = cfrom < gscFloor() ? gscFloor() : cfrom;
    const filters = { page: q("page") || undefined, query: q("query") || undefined };
    const run = (a: string, b: string, dim?: SearchDim) => (a > b ? Promise.resolve([]) : searchAnalytics(c.env, site, setup.property, { from: a, to: b, dim, filters }));
    const [cur, prev, series, prevSeries] = await Promise.all([run(from, to), run(cfrom, cto), run(from, to, "date"), run(cfrom, cto, "date")]);
    const strip = ({ key, ...r }: SearchRow) => r;
    const day = (r: SearchRow) => ({ day: r.key, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position });
    return c.json({
      status: "ok",
      property: setup.property,
      totals: cur[0] ? strip(cur[0]) : ZERO,
      previous: prev[0] ? strip(prev[0]) : ZERO,
      series: series.map(day),
      prevSeries: prevSeries.map(day),
      // The newest day Google has anything for (it trails by a day or two).
      latest: series.length ? series[series.length - 1].key : null,
    });
  } catch (e) {
    return googleError(c, e);
  }
});

/** Top queries, pages, countries or devices from Google Search, with clicks in the comparison range. */
api.get("/sites/:site/search/rows", async (c) => {
  const site = await siteGuard(c);
  if (!site) return c.json({ error: "site not found" }, 404);
  const q = (k: string) => c.req.query(k) ?? "";
  const dim = q("dim") as SearchDim;
  let from = q("from"), cfrom = q("cfrom");
  const to = q("to"), cto = q("cto");
  if (!["query", "page", "country", "device"].includes(dim)) return c.json({ error: "dim must be query, page, country or device" }, 400);
  if (![from, to, cfrom, cto].every((d) => DATE.test(d)) || from > to || cfrom > cto) return c.json({ error: "from/to/cfrom/cto must be YYYY-MM-DD ranges" }, 400);
  const limit = Math.min(Math.max(Number(q("limit")) || 10, 1), 500);
  try {
    const setup = await searchSetup(c.env, site);
    if (!setup.property) return c.json(setup.reply);
    from = from < gscFloor() ? gscFloor() : from;
    cfrom = cfrom < gscFloor() ? gscFloor() : cfrom;
    const filters = { page: q("page") || undefined, query: q("query") || undefined };
    const [rows, prev] = await Promise.all([
      searchAnalytics(c.env, site, setup.property, { from, to, dim, filters, limit }),
      cfrom > cto ? Promise.resolve([]) : searchAnalytics(c.env, site, setup.property, { from: cfrom, to: cto, dim, filters, limit: 1000 }),
    ]);
    const prevClicks = new Map(prev.map((r) => [r.key, r.clicks]));
    return c.json({
      status: "ok",
      rows: rows.map((r) => {
        const out = { ...r, prevClicks: prevClicks.get(r.key) ?? 0 };
        if (dim === "country") return { ...out, key: alpha2(r.key) };
        if (dim === "device") return { ...out, key: r.key.charAt(0) + r.key.slice(1).toLowerCase() };
        if (dim !== "page") return out;
        const p = pagePath(r.key, site.domain);
        return { ...out, url: r.key, key: p.path, local: p.local };
      }),
    });
  } catch (e) {
    return googleError(c, e);
  }
});

/** Stored PageSpeed tests (lab + Chrome field data) and the Chrome UX Report's weekly history for the origin. */
api.get("/sites/:site/speed", async (c) => {
  const site = await siteGuard(c);
  if (!site) return c.json({ error: "site not found" }, 404);
  if (!(await apiKey(c.env))) return c.json({ status: "not-connected" });
  const origin = `https://${site.domain}`;
  const quiet = (p: Promise<unknown>) => p.catch((e) => (console.warn("crux history failed", site.domain, (e as Error).message), null));
  const [runs, phone, desktop] = await Promise.all([speedRuns(c.env, site.id, 180), quiet(cruxHistory(c.env, origin, "PHONE")), quiet(cruxHistory(c.env, origin, "DESKTOP"))]);
  return c.json({ status: "ok", url: `${origin}/`, runs, crux: { phone, desktop } });
});

/** Run a PageSpeed test of the home page now (mobile and desktop, usually under a minute). Admins only. */
api.post("/sites/:site/speed/test", async (c) => {
  if (c.get("user").role !== "admin") return c.json({ error: "admins only" }, 403);
  const site = await siteGuard(c);
  if (!site) return c.json({ error: "site not found" }, 404);
  try {
    const { results, errors } = await testSite(c.env, site);
    return c.json({ status: "ok", results, errors });
  } catch (e) {
    return googleError(c, e);
  }
});

// ---------- personal access tokens (for agents / MCP) ----------

api.get("/tokens", async (c) => c.json({ tokens: await listTokens(c.env, c.get("user").id) }));

api.post("/tokens", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ name?: string; sites?: number[] | null; expiresInDays?: number | null }>();
  const name = (body.name ?? "").trim().slice(0, 80);
  if (!name) return c.json({ error: "give the token a name, e.g. the agent or machine it's for" }, 400);
  let sites: number[] | null = null;
  if (Array.isArray(body.sites) && body.sites.length) {
    const visible = await visibleSiteIds(c.env, user);
    sites = [...new Set(body.sites.map(Number))].filter((id) => Number.isInteger(id) && (visible === "all" || visible.includes(id)));
    if (!sites.length) return c.json({ error: "none of those sites are visible to you" }, 400);
  }
  const days = body.expiresInDays ?? null;
  if (days !== null && !(Number.isInteger(days) && days >= 1 && days <= 3650)) return c.json({ error: "expiresInDays must be 1–3650, or null" }, 400);
  const { token, row } = await createToken(c.env, user.id, { name, sites, expiresInDays: days });
  return c.json({ token, ...row }, 201);
});

api.delete("/tokens/:id", async (c) => {
  const ok = await revokeToken(c.env, c.get("user").id, Number(c.req.param("id")));
  return ok ? c.json({ ok: true }) : c.json({ error: "token not found" }, 404);
});

// ---------- OAuth consent (the page at /oauth/authorize) and connected apps ----------

const authorizeParams = (o: Record<string, unknown>) => ({
  client_id: String(o.client_id ?? ""),
  redirect_uri: o.redirect_uri ? String(o.redirect_uri) : undefined,
  response_type: String(o.response_type ?? ""),
  code_challenge: String(o.code_challenge ?? ""),
  code_challenge_method: o.code_challenge_method ? String(o.code_challenge_method) : undefined,
  state: o.state ? String(o.state) : undefined,
  scope: o.scope ? String(o.scope) : undefined,
  resource: o.resource ? String(o.resource) : undefined,
});

/** What the consent page shows: which app is asking, or why the request can't be approved. */
api.get("/oauth/client", async (c) => {
  const checked = await checkAuthorize(c.env, c.req.raw, authorizeParams(c.req.query()));
  if ("error" in checked) return c.json({ error: checked.error }, 400);
  return c.json({ client_name: checked.client.client_name, redirect_host: new URL(checked.redirectUri).host, user: c.get("user").email });
});

api.post("/oauth/approve", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<Record<string, unknown> & { sites?: number[] | null }>();
  let sites: number[] | null = null;
  if (Array.isArray(body.sites) && body.sites.length) {
    const visible = await visibleSiteIds(c.env, user);
    sites = [...new Set(body.sites.map(Number))].filter((id) => Number.isInteger(id) && (visible === "all" || visible.includes(id)));
    if (!sites.length) return c.json({ error: "none of those sites are visible to you" }, 400);
  }
  const out = await approve(c.env, c.req.raw, user, { ...authorizeParams(body), sites });
  return "error" in out ? c.json({ error: out.error }, 400) : c.json(out);
});

api.get("/oauth/grants", async (c) => c.json({ grants: await listGrants(c.env, c.get("user").id) }));

api.delete("/oauth/grants/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const ok = await revokeGrant(c.env, c.get("user").id, id);
  if (ok) forgetGrant(id);
  return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

// ---------- admin ----------

const admin = new Hono<Ctx>();
admin.use("*", async (c, next) => {
  if (c.get("user").role !== "admin") return c.json({ error: "admins only" }, 403);
  await next();
});

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

admin.get("/sites", async (c) => c.json({ sites: await allSites(c.env) }));

admin.post("/sites", async (c) => {
  const body = await c.req.json<{ domain?: string; timezone?: string }>();
  const domain = (body.domain ?? "").trim().toLowerCase().replace(/^www\./, "");
  const timezone = body.timezone ?? "UTC";
  if (!DOMAIN.test(domain)) return c.json({ error: "invalid domain" }, 400);
  if (!validTimezone(timezone)) return c.json({ error: "invalid timezone" }, 400);
  const row = await c.env.DB.prepare("INSERT INTO sites (domain, timezone) VALUES (?, ?) ON CONFLICT(domain) DO NOTHING RETURNING id")
    .bind(domain, timezone)
    .first<{ id: number }>();
  if (!row) return c.json({ error: "site already exists" }, 409);
  invalidateSites();
  return c.json({ id: row.id }, 201);
});

admin.patch("/sites/:site", async (c) => {
  const id = Number(c.req.param("site"));
  const body = await c.req.json<{ timezone?: string; allowed_hostnames?: string[]; ip_blocklist?: string[]; daily_cap?: number | null; gsc_property?: string | null }>();
  if (body.gsc_property !== undefined && body.gsc_property !== null && !(body.gsc_property === "" || /^(sc-domain:[a-z0-9.-]+|https?:\/\/\S+\/)$/.test(body.gsc_property))) {
    return c.json({ error: "gsc_property must be a Search Console property (sc-domain:example.com or https://example.com/), \"\" for off, or null for automatic" }, 400);
  }
  if (body.daily_cap !== undefined && body.daily_cap !== null && !(Number.isInteger(body.daily_cap) && body.daily_cap >= 0)) {
    return c.json({ error: "daily_cap must be a whole number (0 = no limit) or null (default)" }, 400);
  }
  if (body.timezone !== undefined && !validTimezone(body.timezone)) return c.json({ error: "invalid timezone" }, 400);
  const list = (v: unknown) => Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === "string" && x.length < 100);
  if (body.allowed_hostnames !== undefined && !list(body.allowed_hostnames)) return c.json({ error: "invalid allowed_hostnames" }, 400);
  if (body.ip_blocklist !== undefined && !list(body.ip_blocklist)) return c.json({ error: "invalid ip_blocklist" }, 400);
  await c.env.DB.prepare(
    `UPDATE sites SET timezone = COALESCE(?, timezone), allowed_hostnames = COALESCE(?, allowed_hostnames), ip_blocklist = COALESCE(?, ip_blocklist) WHERE id = ?`,
  )
    .bind(
      body.timezone ?? null,
      body.allowed_hostnames ? JSON.stringify(body.allowed_hostnames) : null,
      body.ip_blocklist ? JSON.stringify(body.ip_blocklist) : null,
      id,
    )
    .run();
  if (body.daily_cap !== undefined) await c.env.DB.prepare("UPDATE sites SET daily_cap = ? WHERE id = ?").bind(body.daily_cap, id).run();
  if (body.gsc_property !== undefined) await c.env.DB.prepare("UPDATE sites SET gsc_property = ? WHERE id = ?").bind(body.gsc_property, id).run();
  invalidateSites();
  return c.json({ ok: true });
});

/** Google connection status: the service account, which properties it can read and which site each matches. */
admin.get("/google", async (c) => {
  const sa = await serviceAccount(c.env);
  const key = await apiKey(c.env);
  let properties: string[] = [];
  let error: string | null = null;
  if (sa) {
    try {
      properties = await gscProperties(c.env, c.req.query("fresh") === "1");
    } catch (e) {
      error = (e as Error).message;
    }
  }
  const { results } = await c.env.DB.prepare("SELECT site_id, MAX(run_at) run_at FROM speed_runs GROUP BY site_id").all<{ site_id: number; run_at: number }>();
  const lastRun = new Map(results.map((r) => [r.site_id, r.run_at]));
  const sites = await Promise.all(
    (await allSites(c.env)).map(async (s) => ({
      id: s.id,
      domain: s.domain,
      setting: s.gsc_property,
      property: sa && !error ? await propertyFor(c.env, s).catch(() => null) : null,
      lastSpeedTest: lastRun.get(s.id) ?? null,
    })),
  );
  return c.json({
    account: sa?.client_email ?? null,
    accountSource: sa?.source ?? null,
    projectId: sa?.project_id ?? null,
    apiKey: !!key,
    apiKeySource: key?.source ?? null,
    properties,
    error,
    sites,
  });
});

/** Save a service account key file (its JSON text) after checking it can sign in and call Search Console. */
admin.put("/google/service-account", async (c) => {
  const { json } = await c.req.json<{ json?: string }>();
  const sa = typeof json === "string" && json.length < 20_000 ? parseServiceAccount(json) : null;
  if (!sa) return c.json({ error: "That isn't a service account key file. In Google Cloud, open the service account → Keys → Add key → Create new key → JSON, and upload the file it downloads." }, 400);
  try {
    const properties = await testServiceAccount(sa);
    await saveSetting(c.env, SETTING_SA, JSON.stringify(sa));
    return c.json({ account: sa.client_email, properties: properties.length });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

admin.delete("/google/service-account", async (c) => {
  await saveSetting(c.env, SETTING_SA, null);
  return c.json({ ok: true });
});

/** Save a Google API key after checking it works for PageSpeed Insights and the Chrome UX Report. */
admin.put("/google/api-key", async (c) => {
  const { key } = await c.req.json<{ key?: string }>();
  const k = (key ?? "").trim();
  if (!/^AIza[0-9A-Za-z_-]{35}$/.test(k)) return c.json({ error: "That doesn't look like a Google API key (they start with AIza and are 39 characters)." }, 400);
  const problem = await testApiKey(k);
  if (problem) return c.json({ error: `Google rejected the key. ${problem}` }, 400);
  await saveSetting(c.env, SETTING_KEY, k);
  return c.json({ ok: true });
});

admin.delete("/google/api-key", async (c) => {
  await saveSetting(c.env, SETTING_KEY, null);
  return c.json({ ok: true });
});

/** When the hourly jobs (anomaly check, overnight speed tests) last ran and will next run. */
admin.get("/scheduler", async (c) => {
  if (!c.env.SCHEDULER) return c.json({ configured: false });
  const stub = c.env.SCHEDULER.get(c.env.SCHEDULER.idFromName("global"));
  await stub.ensure();
  return c.json({ configured: true, ...(await stub.status()) });
});

admin.get("/sites/status", async (c) => {
  const sites = await allSites(c.env);
  const statuses = await Promise.all(
    sites.map(async (s) => {
      try {
        return [s.id, await c.env.SITE.get(c.env.SITE.idFromName(String(s.id))).status()] as const;
      } catch {
        return [s.id, null] as const;
      }
    }),
  );
  return c.json({ status: Object.fromEntries(statuses) });
});

// Fetch the site's homepage and look for a tracker snippet.
admin.get("/sites/:site/check", async (c) => {
  const site = await siteById(c.env, Number(c.req.param("site")));
  if (!site) return c.json({ error: "site not found" }, 404);
  // A snippet on the current, canonical or any old dashboard hostname counts as installed.
  const appHosts = [new URL(c.req.url).host, c.env.APP_HOST ?? "", ...(c.env.LEGACY_APP_HOSTS ?? "").split(",")].map((h) => h.trim()).filter(Boolean);
  try {
    const res = await fetch(`https://${site.domain}/`, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; QWA-InstallCheck/1.0)", accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    const html = (await res.text()).slice(0, 1_000_000);
    const domainRe = site.domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const hostRe = appHosts.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const qwa = new RegExp(`<script[^>]*(${hostRe})/t\\.js[^>]*>`, "i").test(html) && new RegExp(`data-site=["']${domainRe}["']`, "i").test(html);
    const ingestHosts = c.env.INGEST_HOSTS.split(",").map((h) => h.trim().replace(/\./g, "\\.")).filter(Boolean);
    const plausible = new RegExp(`(${[...ingestHosts, "plausible\\.io"].join("|")})/js/|data-domain=|/js/pa-[\\w-]+\\.js`, "i").test(html);
    return c.json({ status: res.status, url: res.url, qwa, plausible });
  } catch (e) {
    return c.json({ error: `could not fetch https://${site.domain}/: ${(e as Error).message}` }, 502);
  }
});

admin.delete("/sites/:site", async (c) => {
  const id = Number(c.req.param("site"));
  const site = await siteById(c.env, id);
  if (!site) return c.json({ error: "site not found" }, 404);
  const body = await c.req.json<{ confirm?: string }>().catch(() => ({ confirm: undefined }));
  if (body.confirm !== site.domain) return c.json({ error: "type the domain to confirm" }, 400);
  await c.env.DB.prepare("DELETE FROM sites WHERE id = ?").bind(id).run();
  invalidateSites();
  return c.json({ ok: true });
});

admin.get("/sites/:site/ingest", async (c) => {
  const id = Number(c.req.param("site"));
  return c.json({ counts: await c.env.SITE.get(c.env.SITE.idFromName(String(id))).ingestCounts() });
});

admin.post("/sites/:site/flush", async (c) => {
  const id = Number(c.req.param("site"));
  return c.json(await c.env.SITE.get(c.env.SITE.idFromName(String(id))).flush());
});

admin.post("/sites/:site/compact", async (c) => {
  const id = Number(c.req.param("site"));
  return c.json({ compacted: await c.env.SITE.get(c.env.SITE.idFromName(String(id))).compactClosedMonths(id) });
});

// Roll up daily totals now (normally nightly). Backfills history the first time it runs for a site.
admin.post("/rollup", async (c) => {
  const results = [];
  for (const site of await allSites(c.env)) {
    try {
      results.push({ domain: site.domain, ...(await rollupSite(c.env, site)) });
    } catch (e) {
      results.push({ domain: site.domain, error: (e as Error).message });
    }
  }
  return c.json({ results });
});

// ---------- demo (local only) ----------
// Seeds synthetic sites and traffic for screenshots and trying QWA out. Only when DEMO=1 *and* on localhost.

const demo = new Hono<Ctx>();
demo.use("*", async (c, next) => {
  const host = new URL(c.req.url).hostname;
  if (c.env.DEMO !== "1" || (host !== "localhost" && host !== "127.0.0.1")) return c.json({ error: "not found" }, 404);
  await next();
});
demo.post("/sites", async (c) => c.json({ sites: await createDemoSites(c.env) }));
demo.post("/seed/:site", async (c) => {
  const site = await siteById(c.env, Number(c.req.param("site")));
  if (!site) return c.json({ error: "no such site" }, 404);
  // Seeding is deterministic, but today's events go through the Durable Object, so only seed once.
  if (await c.env.DATA.head(seededMarker(site.id))) return c.json({ domain: site.domain, skipped: true });
  const sessions = await seedHistory(c.env, site);
  const events = await seedToday(c.env, site);
  await c.env.DATA.put(seededMarker(site.id), new Date().toISOString());
  return c.json({ domain: site.domain, sessions, todayEvents: events });
});
demo.post("/tick", async (c) => {
  const body = await c.req.json<{ seconds?: number }>().catch(() => ({}) as { seconds?: number });
  const seconds = Math.min(1800, Math.max(10, Number(body.seconds) || 60));
  return c.json({ events: await demoTick(c.env, await allSites(c.env), seconds) });
});
admin.route("/demo", demo);

// Re-run the anomaly check now (normally nightly after the rollup). `send: true` also emails new alerts.
admin.post("/anomalies", async (c) => {
  const body = await c.req.json<{ send?: boolean }>().catch(() => ({}) as { send?: boolean });
  const sites = await allSites(c.env);
  if (body.send) {
    await anomalyJob(c.env, sites);
    return c.json({ ok: true, sent: true });
  }
  const results = [];
  for (const site of sites) {
    const anomalies = await refreshAnomalies(c.env, site);
    // Also run the hourly "so far today" check (recorded, not emailed).
    await checkIntraday(c.env, site, { send: false }).catch((e) => console.error("hourly check failed", site.domain, e));
    const today = await c.env.DB.prepare("SELECT kind FROM anomalies WHERE site_id = ? AND metric = 'intraday' AND day = ?").bind(site.id, todayIn(site.timezone)).first<{ kind: string }>();
    results.push({ domain: site.domain, anomalies, today: today?.kind ?? null });
  }
  return c.json({ results });
});

admin.get("/users", async (c) => {
  const { results: users } = await c.env.DB.prepare("SELECT id, email, name, role, created_at, last_seen_at FROM users ORDER BY email").all();
  const { results: grants } = await c.env.DB.prepare("SELECT user_id, site_id FROM site_access").all<{ user_id: number; site_id: number }>();
  return c.json({
    users: users.map((u) => ({ ...u, site_ids: grants.filter((g) => g.user_id === u.id).map((g) => g.site_id) })),
  });
});

async function setGrants(env: Env, userId: number, siteIds: number[], grantedBy: number) {
  const stmts = [env.DB.prepare("DELETE FROM site_access WHERE user_id = ?").bind(userId)];
  for (const sid of new Set(siteIds)) {
    stmts.push(env.DB.prepare("INSERT INTO site_access (user_id, site_id, granted_by) SELECT ?, id, ? FROM sites WHERE id = ?").bind(userId, grantedBy, sid));
  }
  await env.DB.batch(stmts);
}

admin.post("/users", async (c) => {
  const body = await c.req.json<{ email?: string; name?: string; role?: string; site_ids?: number[] }>();
  const email = (body.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: "invalid email" }, 400);
  const role = body.role === "admin" ? "admin" : "viewer";
  const row = await c.env.DB.prepare("INSERT INTO users (email, name, role) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING RETURNING id")
    .bind(email, body.name ?? null, role)
    .first<{ id: number }>();
  if (!row) return c.json({ error: "user already exists" }, 409);
  await setGrants(c.env, row.id, body.site_ids ?? [], c.get("user").id);
  return c.json({ id: row.id }, 201);
});

admin.patch("/users/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ name?: string; role?: string; site_ids?: number[] }>();
  if (id === c.get("user").id && body.role && body.role !== "admin") return c.json({ error: "you can't remove your own admin role" }, 400);
  if (body.role !== undefined || body.name !== undefined) {
    await c.env.DB.prepare("UPDATE users SET role = COALESCE(?, role), name = COALESCE(?, name) WHERE id = ?")
      .bind(body.role === "admin" || body.role === "viewer" ? body.role : null, body.name ?? null, id)
      .run();
  }
  if (Array.isArray(body.site_ids)) await setGrants(c.env, id, body.site_ids, c.get("user").id);
  return c.json({ ok: true });
});

admin.delete("/users/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (id === c.get("user").id) return c.json({ error: "you can't delete yourself" }, 400);
  await c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

api.route("/admin", admin);
