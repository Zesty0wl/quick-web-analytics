// One Durable Object per site: sessionises incoming events, keeps the last few days in
// SQLite (realtime + safety margin) and rewrites each live UTC day's Parquet files in R2.
import { DurableObject } from "cloudflare:workers";
import { COLUMNS, dayKey, monthKey, TABLES, tablePrefix, type TableName } from "@qwa/shared";
import type { Env } from "../env";
import type { SiteEvent } from "../ingest/types";
import { emptyColumns, TableWriter } from "../storage/parquet";
import { mergeTable, r2Buffer, type MergeSource } from "../storage/compact";
import { randomId, utcDay } from "../ingest/visitor";

const SESSION_TIMEOUT_S = 30 * 60;
const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
const LOCAL_RETENTION_S = 3 * 86_400;

const SESSION_COLS = COLUMNS.sessions.map(([c]) => c);

export class SiteDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        session INTEGER PRIMARY KEY, visitor INTEGER NOT NULL, start INTEGER NOT NULL, last INTEGER NOT NULL,
        hostname TEXT, entry_page TEXT, exit_page TEXT, pageviews INTEGER, events INTEGER, bounce INTEGER, duration INTEGER,
        referrer TEXT, source TEXT, channel TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT,
        country TEXT, region TEXT, city TEXT, browser TEXT, browser_version TEXT, os TEXT, os_version TEXT, device TEXT);
      CREATE INDEX IF NOT EXISTS sessions_visitor ON sessions(visitor, last);
      CREATE INDEX IF NOT EXISTS sessions_start ON sessions(start);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
        hostname TEXT, path TEXT, visitor INTEGER, session INTEGER, props TEXT, scroll_depth INTEGER, engaged_ms INTEGER);
      CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
      CREATE TABLE IF NOT EXISTS daily_counts (day TEXT NOT NULL, via TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, via));
    `);
  }

  private meta(key: string): string | null {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string) {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  private markDirty(day: string) {
    // The value is a version counter so a flush only clears days that didn't change while it ran.
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1",
      `dirty:${day}`,
    );
  }

  /** Returns false if the event was dropped (engagement without a live session). */
  async ingest(siteId: number, ev: SiteEvent): Promise<boolean> {
    if (this.meta("site_id") === null) this.setMeta("site_id", String(siteId));
    if (this.meta("first_event_at") === null) this.setMeta("first_event_at", String(ev.ts));

    const visitors = ev.prevVisitor !== null ? [ev.visitor, ev.prevVisitor] : [ev.visitor, ev.visitor];
    const session = this.sql
      .exec<Record<string, number | string>>(
        "SELECT * FROM sessions WHERE visitor IN (?, ?) AND last >= ? ORDER BY last DESC LIMIT 1",
        visitors[0], visitors[1], ev.ts - SESSION_TIMEOUT_S,
      )
      .toArray()[0];

    if (ev.kind === "engagement" && !session) return false;

    let sessionId: number;
    let startDay: string;
    if (session) {
      sessionId = Number(session.session);
      startDay = utcDay(Number(session.start) * 1000);
      if (ev.kind === "engagement") {
        this.sql.exec("UPDATE sessions SET last = max(last, ?) WHERE session = ?", ev.ts, sessionId);
      } else {
        const isPageview = ev.kind === "pageview";
        const pageviews = Number(session.pageviews) + (isPageview ? 1 : 0);
        const stillBounce = Number(session.bounce) === 1 && !(pageviews >= 2 || (!isPageview && ev.interactive));
        this.sql.exec(
          `UPDATE sessions SET last = max(last, ?), pageviews = ?, events = events + 1, bounce = ?,
             duration = max(duration, ? - start),
             entry_page = CASE WHEN entry_page = '' AND ? THEN ? ELSE entry_page END,
             hostname = CASE WHEN hostname = '' AND ? THEN ? ELSE hostname END,
             exit_page = CASE WHEN ? THEN ? ELSE exit_page END
           WHERE session = ?`,
          ev.ts, pageviews, stillBounce ? 1 : 0, ev.ts,
          isPageview ? 1 : 0, ev.path,
          isPageview ? 1 : 0, ev.hostname,
          isPageview ? 1 : 0, ev.path,
          sessionId,
        );
      }
    } else {
      sessionId = randomId();
      startDay = utcDay(ev.ts * 1000);
      const isPageview = ev.kind === "pageview";
      const s = ev.session;
      const row: Record<string, string | number> = {
        session: sessionId, visitor: ev.visitor, start: ev.ts, last: ev.ts,
        hostname: isPageview ? ev.hostname : "", entry_page: isPageview ? ev.path : "", exit_page: isPageview ? ev.path : "",
        pageviews: isPageview ? 1 : 0, events: 1, bounce: isPageview || !ev.interactive ? 1 : 0, duration: 0,
        ...s,
      };
      this.sql.exec(
        `INSERT INTO sessions (${SESSION_COLS.join(",")}) VALUES (${SESSION_COLS.map(() => "?").join(",")})`,
        ...SESSION_COLS.map((c) => row[c] ?? ""),
      );
    }

    this.sql.exec(
      "INSERT INTO events (ts, kind, name, hostname, path, visitor, session, props, scroll_depth, engaged_ms) VALUES (?,?,?,?,?,?,?,?,?,?)",
      ev.ts, ev.kind, ev.name, ev.hostname, ev.path, ev.visitor, sessionId,
      Object.keys(ev.props).length ? JSON.stringify(ev.props) : "",
      ev.scrollDepth ?? 0, ev.engagedMs ?? 0,
    );

    const eventDay = utcDay(ev.ts * 1000);
    this.markDirty(eventDay);
    if (startDay !== eventDay) this.markDirty(startDay);
    this.sql.exec(
      "INSERT INTO daily_counts (day, via, n) VALUES (?, ?, 1) ON CONFLICT(day, via) DO UPDATE SET n = n + 1",
      eventDay, ev.via,
    );

    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
    }
    return true;
  }

  /** Ingest a batch of events in order (imports and demo data). Returns how many were kept. */
  async ingestMany(siteId: number, evs: SiteEvent[]): Promise<number> {
    let kept = 0;
    for (const ev of evs) if (await this.ingest(siteId, ev)) kept++;
    return kept;
  }

  async alarm(): Promise<void> {
    await this.flush();
    const stillDirty = this.sql.exec("SELECT 1 FROM meta WHERE key LIKE 'dirty:%' LIMIT 1").toArray().length > 0;
    if (stillDirty) await this.ctx.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
  }

  /** Rewrite the Parquet files for every day that changed since the last flush. */
  async flush(): Promise<{ days: string[] }> {
    const siteId = Number(this.meta("site_id"));
    if (!siteId) return { days: [] };
    const dirty = this.sql
      .exec<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key LIKE 'dirty:%' ORDER BY key")
      .toArray();
    const done: string[] = [];
    for (const { key, value: version } of dirty) {
      const day = key.slice("dirty:".length);
      const start = Date.parse(`${day}T00:00:00Z`) / 1000;
      const end = start + 86_400;
      for (const table of ["sessions", "pageviews", "engagement", "custom"] as TableName[]) {
        const buf = this.buildDay(table, start, end);
        const k = dayKey(siteId, table, day);
        if (buf) await this.env.DATA.put(k, buf);
        else await this.env.DATA.delete(k);
      }
      // Only clear if nothing was ingested for this day while we were writing.
      this.sql.exec("DELETE FROM meta WHERE key = ? AND value = ?", key, version);
      done.push(day);
    }
    this.purge();
    return { days: done };
  }

  private buildDay(table: TableName, start: number, end: number): ArrayBuffer | null {
    const cols = emptyColumns(table);
    const names = COLUMNS[table].map(([c]) => c);
    const cursor =
      table === "sessions"
        ? this.sql.exec(`SELECT ${names.join(",")} FROM sessions WHERE start >= ? AND start < ? ORDER BY start`, start, end)
        : this.sql.exec(
            `SELECT ${names.join(",")} FROM events WHERE kind = ? AND ts >= ? AND ts < ? ORDER BY ts`,
            table === "pageviews" ? "pageview" : table === "engagement" ? "engagement" : "custom",
            start,
            end,
          );
    let n = 0;
    for (const row of cursor.raw()) {
      for (let i = 0; i < names.length; i++) cols[names[i]].push(row[i]);
      n++;
    }
    if (n === 0) return null;
    const w = new TableWriter(table);
    w.write(cols);
    return w.finish();
  }

  /** Drop local rows older than the retention window, unless their day is still waiting to be flushed. */
  private purge() {
    const cutoff = Math.floor(Date.now() / 1000) - LOCAL_RETENTION_S;
    const pending = new Set(
      this.sql.exec<{ key: string }>("SELECT key FROM meta WHERE key LIKE 'dirty:%'").toArray().map((r) => r.key.slice(6)),
    );
    const cutoffDay = utcDay(cutoff * 1000);
    if ([...pending].some((d) => d < cutoffDay)) return;
    this.sql.exec("DELETE FROM events WHERE ts < ?", cutoff);
    this.sql.exec("DELETE FROM sessions WHERE last < ?", cutoff);
    this.sql.exec("DELETE FROM daily_counts WHERE day < ?", utcDay(Date.now() - 60 * 86_400_000));
  }

  /**
   * Merge the day files of every closed UTC month into one month file per table, then delete them.
   * Safe to re-run: an existing month file is rebuilt with any newer day files replacing its rows for those days.
   */
  async compactClosedMonths(siteId: number): Promise<{ month: string; table: TableName; days: number; rows: number }[]> {
    const currentMonth = new Date().toISOString().slice(0, 7);
    const pendingDays = new Set(
      this.sql.exec<{ key: string }>("SELECT key FROM meta WHERE key LIKE 'dirty:%'").toArray().map((r) => r.key.slice(6)),
    );
    const done: { month: string; table: TableName; days: number; rows: number }[] = [];

    for (const table of TABLES) {
      const prefix = `${tablePrefix(siteId, table)}day/`;
      const days: R2Object[] = [];
      let cursor: string | undefined;
      do {
        const page = await this.env.DATA.list({ prefix, cursor });
        days.push(...page.objects);
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);

      const byMonth = new Map<string, R2Object[]>();
      for (const o of days) {
        const day = o.key.slice(prefix.length, prefix.length + 10);
        const month = day.slice(0, 7);
        if (month >= currentMonth || pendingDays.has(day)) continue;
        byMonth.set(month, [...(byMonth.get(month) ?? []), o]);
      }

      for (const [month, objs] of byMonth) {
        objs.sort((a, b) => a.key.localeCompare(b.key));
        const mKey = monthKey(siteId, table, month);
        const existing = await this.env.DATA.head(mKey);
        const sources: MergeSource[] = [];
        if (existing) {
          // Day files present now replace whatever the month file holds for those days.
          const skip = objs.map((o) => {
            const day = o.key.slice(prefix.length, prefix.length + 10);
            const start = Date.parse(`${day}T00:00:00Z`) / 1000;
            return [start, start + 86_400] as [number, number];
          });
          sources.push({ file: r2Buffer(this.env.DATA, mKey, existing.size), skip });
        }
        for (const o of objs) sources.push({ file: r2Buffer(this.env.DATA, o.key, o.size) });

        const merged = await mergeTable(table, sources);
        if (merged) await this.env.DATA.put(mKey, merged.buffer);
        else if (existing) await this.env.DATA.delete(mKey);
        // Only delete the day files once the month file is safely written.
        await this.env.DATA.delete(objs.map((o) => o.key));
        done.push({ month, table, days: objs.length, rows: merged?.rows ?? 0 });
      }
    }
    return done;
  }

  /** Visitors per minute for the last `minutes` minutes (oldest first). */
  private perMinute(now: number, minutes = 30): number[] {
    const start = now - minutes * 60;
    const rows = this.sql
      .exec<{ m: number; n: number }>(
        // Integer minutes: JS numbers bind as REAL, so without the cast the division gives fractional buckets.
        "SELECT CAST((ts - ?) / 60 AS INTEGER) m, COUNT(DISTINCT visitor) n FROM events WHERE ts >= ? AND kind != 'engagement' GROUP BY m",
        start, start,
      )
      .toArray();
    const out = new Array(minutes).fill(0);
    for (const r of rows) if (r.m >= 0 && r.m < minutes) out[r.m] = r.n;
    return out;
  }

  /** Live view: visitors now (5 min), per-minute history, and what people are looking at / arriving from (30 min). */
  async realtime() {
    const now = Math.floor(Date.now() / 1000);
    const since = now - 1800;
    const count = (from: number) =>
      this.sql.exec<{ n: number }>("SELECT COUNT(DISTINCT visitor) n FROM events WHERE ts >= ? AND kind != 'engagement'", from).one().n;
    const top = (col: "source" | "country", limit: number) =>
      this.sql
        .exec<{ name: string; visitors: number }>(
          `SELECT s.${col} name, COUNT(DISTINCT e.visitor) visitors FROM events e JOIN sessions s ON s.session = e.session
           WHERE e.ts >= ? AND e.kind != 'engagement' GROUP BY s.${col} ORDER BY visitors DESC LIMIT ?`,
          since, limit,
        )
        .toArray();
    return {
      visitors5m: count(now - 300),
      visitors30m: count(since),
      perMinute: this.perMinute(now),
      pages: this.sql
        .exec<{ path: string; visitors: number }>(
          "SELECT path, COUNT(DISTINCT visitor) visitors FROM events WHERE ts >= ? AND kind = 'pageview' GROUP BY path ORDER BY visitors DESC LIMIT 8",
          since,
        )
        .toArray(),
      sources: top("source", 6),
      countries: top("country", 40),
    };
  }

  /** Totals for a local day [start, end) from the live store (complete only if first_event_at <= start). */
  private dayStats(start: number, end: number) {
    const v = this.sql
      .exec<{ visitors: number; visits: number; bounces: number | null; duration_sum: number | null }>(
        "SELECT COUNT(DISTINCT visitor) visitors, COUNT(*) visits, SUM(bounce) bounces, SUM(duration) duration_sum FROM sessions WHERE start >= ? AND start < ?",
        start, end,
      )
      .one();
    const e = this.sql
      .exec<{ pageviews: number | null; events: number | null }>(
        "SELECT SUM(kind = 'pageview') pageviews, SUM(kind = 'custom') events FROM events WHERE ts >= ? AND ts < ?",
        start, end,
      )
      .one();
    return { visitors: v.visitors, visits: v.visits, bounces: v.bounces ?? 0, duration_sum: v.duration_sum ?? 0, pageviews: e.pageviews ?? 0, events: e.events ?? 0 };
  }

  /** Last event time and 14-day event counts by front door, for the admin status badges. */
  async status(): Promise<{ lastEventAt: number | null; plausible14d: number; qwa14d: number }> {
    const last = this.sql.exec<{ ts: number | null }>("SELECT MAX(ts) ts FROM events").one().ts;
    const counts = await this.ingestCounts(14);
    const sum = (via: string) => counts.filter((c) => c.via === via).reduce((n, c) => n + c.n, 0);
    return { lastEventAt: last ?? null, plausible14d: sum("plausible"), qwa14d: sum("qwa") };
  }

  /** Everything the all-sites overview needs from this site, in one call. */
  async overview(days: { day: string; start: number; end: number }[]) {
    const first = this.meta("first_event_at");
    const now = Math.floor(Date.now() / 1000);
    const status = await this.status();
    return {
      firstEventAt: first ? Number(first) : null,
      lastEventAt: status.lastEventAt,
      plausible14d: status.plausible14d,
      qwa14d: status.qwa14d,
      now: this.sql.exec<{ n: number }>("SELECT COUNT(DISTINCT visitor) n FROM events WHERE ts >= ? AND kind != 'engagement'", now - 300).one().n,
      perMinute: this.perMinute(now),
      days: days.map((d) => ({ day: d.day, complete: first !== null && Number(first) <= d.start, ...this.dayStats(d.start, d.end) })),
    };
  }

  /** Events per day split by front door (Plausible compat vs QWA tracker): tracks tracker migration. */
  async ingestCounts(days = 14): Promise<{ day: string; via: string; n: number }[]> {
    return this.sql
      .exec<{ day: string; via: string; n: number }>("SELECT day, via, n FROM daily_counts WHERE day >= ? ORDER BY day", utcDay(Date.now() - days * 86_400_000))
      .toArray();
  }
}
