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
  opts: { fraction?: number } = {},
): Promise<AlertDetail> {
  const { results } = await env.DB.prepare(
    "SELECT day, visitors, visits, pageviews, bounces, duration_sum FROM daily_stats WHERE site_id = ? AND day >= ? AND day <= ? ORDER BY day",
  )
    .bind(site.id, addDays(a.day, -42), a.day)
    .all<DayFigures>();
  const byDay = new Map(results.map((r) => [r.day, r]));
  const empty = (day: string): DayFigures => ({ day, visitors: 0, visits: 0, pageviews: 0, bounces: 0, duration_sum: 0 });
  const history = Array.from({ length: 28 }, (_, i) => byDay.get(addDays(a.day, i - 27)) ?? empty(addDays(a.day, i - 27)));
  const baseline = [6, 5, 4, 3, 2, 1].map((w) => byDay.get(addDays(a.day, -7 * w))).filter((d): d is DayFigures => Boolean(d));

  let drivers: AlertDetail["drivers"];
  if (a.kind !== "outage") {
    try {
      const regions = new Intl.DisplayNames(["en"], { type: "region" });
      const movers = async (dim: "source" | "page" | "country") => {
        const spec = { metrics: ["visitors" as const], groupBy: dim, limit: 300 };
        const [day, window] = await Promise.all([
          env.QUERY.query(site.id, site.timezone, { ...spec, from: a.day, to: a.day }),
          env.QUERY.query(site.id, site.timezone, { ...spec, from: addDays(a.day, -28), to: addDays(a.day, -1) }),
        ]);
        // Usual visitors per day, scaled to the part of the day so far for the hourly check.
        const usual = new Map(window.rows.map((r) => [String(r[dim] ?? ""), (Number(r.visitors ?? 0) / 28) * (opts.fraction ?? 1)]));
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
  return { siteId: site.id, domain: site.domain, day: a.day, kind: a.kind, value: a.value, expected: a.expected, history, baseline, drivers, lastEventAt };
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

/** Visits per local hour on the previous six same weekdays (cached per site and day; it doesn't change). */
async function intradayBaseline(env: Env, site: Site, day: string): Promise<number[][]> {
  const cached = await env.DB.prepare("SELECT hourly FROM intraday_baselines WHERE site_id = ? AND day = ?").bind(site.id, day).first<{ hourly: string }>();
  if (cached) return JSON.parse(cached.hourly) as number[][];
  const res = await env.QUERY.query(site.id, site.timezone, { from: addDays(day, -42), to: addDays(day, -1), metrics: ["visits"], groupBy: "hour", limit: 1000 });
  const byHour = new Map(res.rows.map((r) => [String(r.hour), Number(r.visits ?? 0)]));
  const days = [6, 5, 4, 3, 2, 1].map((w) => addDays(day, -7 * w));
  // Only weeks that had any traffic count (a site younger than six weeks has fewer).
  const hourly = days
    .map((d) => Array.from({ length: 24 }, (_, h) => byHour.get(`${d} ${String(h).padStart(2, "0")}:00`) ?? 0))
    .filter((hours) => hours.some((v) => v > 0));
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO intraday_baselines (site_id, day, hourly) VALUES (?, ?, ?)").bind(site.id, day, JSON.stringify(hourly)),
    env.DB.prepare("DELETE FROM intraday_baselines WHERE day < ?").bind(addDays(day, -3)),
  ]);
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

  // Usual share of the day covered by the window (so far today, or the last three hours), to scale "usual" in the
  // where-from tables.
  const dayTotal = medianOf(hourly.map((h) => sumHours(h, 0, 24)));
  const windowUsual = medianOf(history.map((h) => (found.window === "today" ? h.today : h.last3h)));
  const fraction = dayTotal ? windowUsual / dayTotal : 1;
  const base = await alertDetail(env, site, { day, kind: found.kind, value: found.value, expected: found.expected }, { fraction });
  const item: AlertDetail = {
    ...base,
    intraday: {
      hour,
      window: found.window,
      history: history.map((h) => (found.window === "today" ? h.today : h.last3h)),
      hours: { today: byHour.map((d) => d.visits), usual: Array.from({ length: 24 }, (_, h) => medianOf(hourly.map((w) => w[h] ?? 0))) },
    },
    // Today's bar: visitors so far (daily totals only cover closed days).
    history: base.history.map((d) => (d.day === day ? { day, visitors: sofar.visitors, visits: sofar.visits, pageviews: sofar.pageviews, bounces: sofar.bounces, duration_sum: sofar.duration_sum } : d)),
  };
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
