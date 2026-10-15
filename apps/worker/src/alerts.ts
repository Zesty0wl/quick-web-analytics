// Nightly anomaly check and alert emails (Cloudflare Email Sending via the EMAIL binding).
import { denseSeries, detectAnomalies, detectIntraday, episodes, type Anomaly } from "./anomaly";
import { renderAlertEmail, renderCapEmail, type AlertDetail, type DayFigures } from "./email";
import type { Env, Site } from "./env";
import { allSites } from "./sites";
import { addDays, localMidnight, todayIn } from "./tz";

export interface StoredAnomaly extends Omit<Anomaly, "metric"> {
  site_id: number;
  metric: "visitors" | "intraday";
  notified_at: string | null;
  detail: string | null;
}

/** Whether alert emails can be sent (binding present and a sender address configured). */
export const emailConfigured = (env: Env) => Boolean(env.EMAIL && env.ALERT_FROM);

/**
 * Recompute a site's anomalies from its daily totals. The whole history is cheap to scan, so episodes stay
 * consistent. Days found for the first time and older than 3 days are marked as history so they never email.
 */
export async function refreshAnomalies(env: Env, site: Site): Promise<number> {
  const { results } = await env.DB.prepare("SELECT day, visitors AS value FROM daily_stats WHERE site_id = ? ORDER BY day")
    .bind(site.id)
    .all<{ day: string; value: number }>();
  const found = episodes(detectAnomalies(denseSeries(results)));
  const { results: old } = await env.DB.prepare("SELECT day, metric, kind, notified_at FROM anomalies WHERE site_id = ?")
    .bind(site.id)
    .all<{ day: string; metric: string; kind: string; notified_at: string | null }>();
  const notified = new Map(old.filter((r) => r.metric === "visitors").map((r) => [r.day, r.notified_at]));
  // Days the hourly check already emailed about (same kind) aren't emailed again by the nightly check.
  const sentHourly = new Map(old.filter((r) => r.metric === "intraday" && r.notified_at).map((r) => [`${r.day}|${r.kind}`, r.notified_at]));
  const fresh = addDays(todayIn(site.timezone), -3);
  const stmts = [
    env.DB.prepare("DELETE FROM anomalies WHERE site_id = ? AND metric = 'visitors'").bind(site.id),
    ...found.map((a) =>
      env.DB.prepare("INSERT INTO anomalies (site_id, day, metric, kind, value, expected, score, notified_at) VALUES (?,?,?,?,?,?,?,?)").bind(
        site.id, a.day, a.metric, a.kind, a.value, a.expected, a.score,
        notified.has(a.day) ? notified.get(a.day) : sentHourly.get(`${a.day}|${a.kind}`) ?? (a.day < fresh ? "history" : null),
      ),
    ),
  ];
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return found.length;
}

export async function siteAnomalies(env: Env, siteIds: number[], from: string, to: string): Promise<StoredAnomaly[]> {
  if (!siteIds.length) return [];
  const { results } = await env.DB.prepare(
    `SELECT site_id, day, metric, kind, value, expected, score, notified_at, detail FROM anomalies WHERE day >= ? AND day <= ? AND site_id IN (${siteIds.map(() => "?").join(",")}) ORDER BY day`,
  )
    .bind(from, to, ...siteIds)
    .all<StoredAnomaly>();
  return results;
}

/** Everything an alert email shows about one anomaly. Query failures just leave out the "where from" part. */
export async function alertDetail(
  env: Env,
  site: Site,
  a: { day: string; kind: Anomaly["kind"]; value: number; expected: number },
  /** `window`: for hourly alerts, the hours (unix seconds) the movers count, on the day and on each baseline day. */
  opts: { window?: { since: number; until: number } } = {},
): Promise<AlertDetail> {
  const { results } = await env.DB.prepare(
    "SELECT day, visitors, visits, pageviews, bounces, duration_sum FROM daily_stats WHERE site_id = ? AND day >= ? AND day <= ? ORDER BY day",
  )
    .bind(site.id, addDays(a.day, -42), addDays(a.day, 14))
    .all<DayFigures>();
  const byDay = new Map(results.map((r) => [r.day, r]));
  const empty = (day: string): DayFigures => ({ day, visitors: 0, visits: 0, pageviews: 0, bounces: 0, duration_sum: 0 });
  const history = Array.from({ length: 28 }, (_, i) => byDay.get(addDays(a.day, i - 27)) ?? empty(addDays(a.day, i - 27)));
  const baseline = [6, 5, 4, 3, 2, 1].map((w) => byDay.get(addDays(a.day, -7 * w))).filter((d): d is DayFigures => Boolean(d));
  // Two weeks either side, as far as closed days go (the day itself always included).
  const yesterday = addDays(todayIn(site.timezone), -1);
  const around = Array.from({ length: 29 }, (_, i) => addDays(a.day, i - 14))
    .filter((d) => d <= yesterday || d === a.day)
    .map((d) => byDay.get(d) ?? empty(d));

  let drivers: AlertDetail["drivers"];
  if (a.kind !== "outage") {
    try {
      const regions = new Intl.DisplayNames(["en"], { type: "region" });
      // "Usual" is the average over the same weekdays the anomaly was judged against (those with traffic), and for an
      // hourly alert over the same hours of them, so the movers add up to the headline's change.
      const usualDays = baseline.length ? baseline.map((b) => b.day) : [6, 5, 4, 3, 2, 1].map((w) => addDays(a.day, -7 * w));
      const midnight = localMidnight(site.timezone, a.day);
      const span = (d: string) => {
        if (!opts.window) return {};
        const m = localMidnight(site.timezone, d);
        return { since: m + (opts.window.since - midnight), until: m + (opts.window.until - midnight) };
      };
      const movers = async (dim: "source" | "page" | "country") => {
        const spec = { metrics: ["visitors" as const], groupBy: dim, limit: 300 };
        const [day, ...before] = await Promise.all([
          env.QUERY.query(site.id, site.timezone, { ...spec, from: a.day, to: a.day, ...opts.window }),
          ...usualDays.map((d) => env.QUERY.query(site.id, site.timezone, { ...spec, from: d, to: d, ...span(d) })),
        ]);
        const totals = new Map<string, number>();
        for (const res of before) for (const r of res.rows) totals.set(String(r[dim] ?? ""), (totals.get(String(r[dim] ?? "")) ?? 0) + Number(r.visitors ?? 0));
        const usual = new Map([...totals].map(([k, v]) => [k, v / usualDays.length]));
        const names = new Set([...day.rows.map((r) => String(r[dim] ?? "")), ...usual.keys()]);
        const dayMap = new Map(day.rows.map((r) => [String(r[dim] ?? ""), Number(r.visitors ?? 0)]));
        return [...names].map((k) => ({
          name: dim === "country" && /^[A-Z]{2}$/.test(k) ? (regions.of(k) ?? k) : k,
          value: dayMap.get(k) ?? 0,
          usual: usual.get(k) ?? 0,
        }));
      };
      const [sources, pages, countries] = await Promise.all([movers("source"), movers("page"), movers("country")]);
      drivers = { sources, pages, countries };
    } catch (e) {
      console.error("alert drivers failed", site.domain, e);
    }
  }
  let lastEventAt: number | null = null;
  if (a.kind === "outage") {
    try {
      lastEventAt = (await env.SITE.get(env.SITE.idFromName(String(site.id))).status()).lastEventAt;
    } catch {
      lastEventAt = null;
    }
  }
  return { siteId: site.id, domain: site.domain, day: a.day, kind: a.kind, value: a.value, expected: a.expected, history, baseline, around, drivers, lastEventAt };
}

/** Who should hear about a site: its subscribers, plus anyone with "all sites" on, as long as they can still see it. */
async function recipients(env: Env, siteIds: number[]): Promise<{ email: string; site_id: number }[]> {
  if (!siteIds.length) return [];
  const list = siteIds.join(",");
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT u.email, s.id AS site_id FROM users u JOIN sites s ON s.id IN (${list})
     WHERE (u.alert_all = 1 OR EXISTS (SELECT 1 FROM alert_subscriptions sub WHERE sub.user_id = u.id AND sub.site_id = s.id))
       AND (u.role = 'admin' OR EXISTS (SELECT 1 FROM site_access sa WHERE sa.user_id = u.id AND sa.site_id = s.id))`,
  ).all<{ email: string; site_id: number }>();
  return results;
}

export async function sendAlertEmail(env: Env, to: string, items: AlertDetail[], test = false) {
  const message = renderAlertEmail({ appHost: env.APP_HOST, items, test });
  return env.EMAIL!.send({ to, from: env.ALERT_FROM!, ...(env.ALERT_REPLY_TO ? { replyTo: env.ALERT_REPLY_TO } : {}), ...message });
}

/** Email each recipient about new anomalies on their sites (one email each), then mark them as sent. */
export async function sendAlerts(env: Env): Promise<number> {
  const { results: pending } = await env.DB.prepare(
    "SELECT site_id, day, kind, value, expected FROM anomalies WHERE notified_at IS NULL AND metric = 'visitors' ORDER BY day",
  ).all<{ site_id: number; day: string; kind: Anomaly["kind"]; value: number; expected: number }>();
  if (!pending.length) return 0;

  let sent = 0;
  if (emailConfigured(env)) {
    const sites = new Map((await allSites(env)).map((s) => [s.id, s]));
    const details = new Map<string, AlertDetail>();
    for (const p of pending) {
      const site = sites.get(p.site_id);
      if (site) details.set(`${p.site_id}:${p.day}`, await alertDetail(env, site, p));
    }
    const byUser = new Map<string, AlertDetail[]>();
    for (const r of await recipients(env, [...new Set(pending.map((p) => p.site_id))])) {
      const mine = pending.filter((p) => p.site_id === r.site_id).map((p) => details.get(`${p.site_id}:${p.day}`)).filter((d): d is AlertDetail => Boolean(d));
      byUser.set(r.email, [...(byUser.get(r.email) ?? []), ...mine]);
    }
    for (const [email, items] of byUser) {
      if (!items.length) continue;
      try {
        await sendAlertEmail(env, email, items.sort((x, y) => (x.day < y.day ? -1 : 1)));
        sent++;
      } catch (e) {
        console.error("alert email failed", email, e);
      }
    }
  }
  // Alerts are only useful while fresh: mark everything handled, sent or not.
  await env.DB.prepare("UPDATE anomalies SET notified_at = datetime('now') WHERE notified_at IS NULL AND metric = 'visitors'").run();
  return sent;
}

/** Nightly: refresh every site's anomalies, then send alerts. */
export async function anomalyJob(env: Env, sites: Site[]): Promise<void> {
  for (const site of sites) {
    try {
      await refreshAnomalies(env, site);
    } catch (e) {
      console.error("anomaly check failed", site.domain, e);
    }
  }
  const sent = await sendAlerts(env);
  if (sent) console.log("alert emails sent", sent);
}

/** Tell admins (and the site's alert subscribers) that a site hit its daily cap. Called once per site per day. */
export async function notifyCapped(env: Env, site: Site, cap: number, day: string): Promise<void> {
  if (!emailConfigured(env)) return;
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT email FROM users u WHERE u.role = 'admin'
       OR ((u.alert_all = 1 OR EXISTS (SELECT 1 FROM alert_subscriptions s WHERE s.user_id = u.id AND s.site_id = ?1))
           AND EXISTS (SELECT 1 FROM site_access sa WHERE sa.user_id = u.id AND sa.site_id = ?1))`,
  )
    .bind(site.id)
    .all<{ email: string }>();
  const message = renderCapEmail({ appHost: env.APP_HOST, domain: site.domain, siteId: site.id, cap, day });
  for (const { email } of results) {
    await env.EMAIL!.send({ to: email, from: env.ALERT_FROM!, ...(env.ALERT_REPLY_TO ? { replyTo: env.ALERT_REPLY_TO } : {}), ...message });
  }
}

// ---------- hourly "so far today" check ----------

/**
 * Visits per local hour on the previous six same weekdays (cached per site and day; it doesn't change). `cache: false`
 * computes it without storing, for explaining a past day (the cache only keeps the last few days).
 */
async function intradayBaseline(env: Env, site: Site, day: string, opts: { cache?: boolean } = {}): Promise<number[][]> {
  const cached = await env.DB.prepare("SELECT hourly FROM intraday_baselines WHERE site_id = ? AND day = ?").bind(site.id, day).first<{ hourly: string }>();
  if (cached) return JSON.parse(cached.hourly) as number[][];
  const res = await env.QUERY.query(site.id, site.timezone, { from: addDays(day, -42), to: addDays(day, -1), metrics: ["visits"], groupBy: "hour", limit: 1000 });
  const byHour = new Map(res.rows.map((r) => [String(r.hour), Number(r.visits ?? 0)]));
  const days = [6, 5, 4, 3, 2, 1].map((w) => addDays(day, -7 * w));
  // Only weeks that had any traffic count (a site younger than six weeks has fewer).
  const hourly = days
    .map((d) => Array.from({ length: 24 }, (_, h) => byHour.get(`${d} ${String(h).padStart(2, "0")}:00`) ?? 0))
    .filter((hours) => hours.some((v) => v > 0));
  if (opts.cache !== false) {
    await env.DB.batch([
      env.DB.prepare("INSERT OR REPLACE INTO intraday_baselines (site_id, day, hourly) VALUES (?, ?, ?)").bind(site.id, day, JSON.stringify(hourly)),
      env.DB.prepare("DELETE FROM intraday_baselines WHERE day < ?").bind(addDays(day, -3)),
    ]);
  }
  return hourly;
}

const sumHours = (h: number[], from: number, to: number) => h.slice(Math.max(0, from), to).reduce((a, b) => a + b, 0);
const medianOf = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

/** Check one site's day so far; on an anomaly, record it and email straight away. Returns emails sent. */
export async function checkIntraday(env: Env, site: Site, opts: { send?: boolean } = { send: true }): Promise<number> {
  const day = todayIn(site.timezone);
  const midnight = localMidnight(site.timezone, day);
  const hour = Math.floor((Date.now() / 1000 - midnight) / 3600); // full hours since local midnight
  if (hour < 3) return 0;
  const already = await env.DB.prepare("SELECT 1 FROM anomalies WHERE site_id = ? AND day = ? AND metric = 'intraday'").bind(site.id, day).first();
  if (already) return 0; // at most one hourly alert per site per day

  const hourly = await intradayBaseline(env, site, day);
  const history = hourly.map((h) => ({ today: sumHours(h, 0, hour), last3h: sumHours(h, hour - 3, hour) }));
  // The day so far, the last three hours, and each hour so far (for the email's chart).
  const live = await env.SITE.get(env.SITE.idFromName(String(site.id))).overview([
    { day, start: midnight, end: midnight + hour * 3600 },
    { day: "last3h", start: midnight + (hour - 3) * 3600, end: midnight + hour * 3600 },
    ...Array.from({ length: hour }, (_, h) => ({ day: `h${h}`, start: midnight + h * 3600, end: midnight + (h + 1) * 3600 })),
  ]);
  const [sofar, recent, ...byHour] = live.days;
  const found = detectIntraday({ today: sofar.visits, last3h: recent.visits, history, hour });
  if (!found) return 0;
  // A run of unusual days is one event: stay quiet if this site had the same kind of anomaly in the last 2 days.
  const recentSame = await env.DB.prepare("SELECT 1 FROM anomalies WHERE site_id = ? AND kind = ? AND day >= ? AND day < ?")
    .bind(site.id, found.kind, addDays(day, -2), day)
    .first();
  if (recentSame) return 0;

  const detail = { hour, window: found.window };
  await env.DB.prepare("INSERT OR IGNORE INTO anomalies (site_id, day, metric, kind, value, expected, score, notified_at, detail) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(site.id, day, "intraday", found.kind, found.value, found.expected, found.score, opts.send && emailConfigured(env) ? null : "not sent", JSON.stringify(detail))
    .run();
  if (!opts.send || !emailConfigured(env)) return 0;

  const item = await intradayDetail(env, site, day, hour, hourly, found, sofar, byHour.map((d) => d.visits));
  let sent = 0;
  for (const r of await recipients(env, [site.id])) {
    try {
      await sendAlertEmail(env, r.email, [item]);
      sent++;
    } catch (e) {
      console.error("hourly alert email failed", r.email, e);
    }
  }
  await env.DB.prepare("UPDATE anomalies SET notified_at = datetime('now') WHERE site_id = ? AND day = ? AND metric = 'intraday'").bind(site.id, day).run();
  if (sent) console.log("hourly alert", site.domain, found.kind, found.window, `${found.value} vs ${found.expected}`);
  return sent;
}

/** Everything an hourly alert shows: the window against earlier same weekdays, and today's hours against usual. */
async function intradayDetail(
  env: Env, site: Site, day: string, hour: number, hourly: number[][],
  found: { kind: Anomaly["kind"]; value: number; expected: number; window: "today" | "last3h" },
  sofar: Omit<DayFigures, "day"> | null, byHour: number[],
): Promise<AlertDetail> {
  const from = found.window === "today" ? 0 : hour - 3;
  const history = hourly.map((h) => sumHours(h, from, hour));
  const midnight = localMidnight(site.timezone, day);
  const window = { since: midnight + Math.max(0, from) * 3600, until: midnight + hour * 3600 };
  const base = await alertDetail(env, site, { day, kind: found.kind, value: found.value, expected: found.expected }, { window });
  return {
    ...base,
    intraday: {
      hour,
      window: found.window,
      history,
      hours: { today: byHour, usual: Array.from({ length: 24 }, (_, h) => medianOf(hourly.map((w) => w[h] ?? 0))) },
    },
    // Today's bar: visitors so far (daily totals only cover closed days).
    history: sofar ? base.history.map((d) => (d.day === day ? { day, ...sofar } : d)) : base.history,
    around: sofar ? base.around?.map((d) => (d.day === day ? { day, ...sofar } : d)) : base.around,
  };
}

/**
 * Why a day was unusual, for the dashboard's explanation page: the same analysis as its alert email. An hourly alert
 * is explained hour by hour (that day's hours against a usual one, the movers counted in its window); a nightly one
 * as a whole day.
 */
export async function explainAnomaly(env: Env, site: Site, a: StoredAnomaly): Promise<AlertDetail> {
  const detail = a.detail ? (JSON.parse(a.detail) as { hour?: number; window?: "today" | "last3h" }) : null;
  if (a.metric !== "intraday" || detail?.hour === undefined || !detail.window) return alertDetail(env, site, a);
  const hour = detail.hour;
  const found = { ...a, window: detail.window };
  if (a.day === todayIn(site.timezone)) {
    // Today: from the site's Durable Object, as the hourly check saw it.
    const midnight = localMidnight(site.timezone, a.day);
    const hourly = await intradayBaseline(env, site, a.day);
    const live = await env.SITE.get(env.SITE.idFromName(String(site.id))).overview([
      { day: a.day, start: midnight, end: midnight + hour * 3600 },
      ...Array.from({ length: hour }, (_, h) => ({ day: `h${h}`, start: midnight + h * 3600, end: midnight + (h + 1) * 3600 })),
    ]);
    const [sofar, ...byHour] = live.days;
    return intradayDetail(env, site, a.day, hour, hourly, found, sofar, byHour.map((d) => d.visits));
  }
  // An earlier day: the whole day's hours from the query worker.
  const [hourly, day] = await Promise.all([
    intradayBaseline(env, site, a.day, { cache: false }),
    env.QUERY.query(site.id, site.timezone, { from: a.day, to: a.day, metrics: ["visits"], groupBy: "hour" }),
  ]);
  const byHour = new Map(day.rows.map((r) => [Number(String(r.hour).slice(11, 13)), Number(r.visits ?? 0)]));
  return intradayDetail(env, site, a.day, hour, hourly, found, null, Array.from({ length: 24 }, (_, h) => byHour.get(h) ?? 0));
}

/** Hourly: check every site's day so far. */
export async function intradayJob(env: Env, sites: Site[]): Promise<void> {
  for (const site of sites) {
    try {
      await checkIntraday(env, site);
    } catch (e) {
      console.error("hourly check failed", site.domain, e);
    }
  }
}
