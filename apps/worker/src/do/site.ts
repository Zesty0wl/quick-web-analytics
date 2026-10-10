// One Durable Object per site: sessionises incoming events, keeps the last few days in
// SQLite (realtime + safety margin) and rewrites each live UTC day's Parquet files in R2.
import { DurableObject } from "cloudflare:workers";
import { COLUMNS, dayKey, monthKey, TABLES, tablePrefix, type TableName } from "@qwa/shared";
import type { Env } from "../env";
import type { SiteEvent, Vitals } from "../ingest/types";
import { emptyColumns, TableWriter } from "../storage/parquet";
import { mergeTable, r2Buffer, type MergeSource } from "../storage/compact";
import { randomId, utcDay } from "../ingest/visitor";
import { forViewer } from "../realtime";

const SESSION_TIMEOUT_S = 30 * 60;
const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
const LOCAL_RETENTION_S = 3 * 86_400;
/** How often live day files for queries may be rebuilt (per day), while events keep arriving. */
const LIVE_REBUILD_MS = 5_000;
/** Dashboards watching this site get at most one live update per this interval while events arrive. */
const PUSH_INTERVAL_MS = 2_000;
/** Web Vitals columns on the local events table (engagement events), matching the engagement Parquet columns. */
const VITAL_EVENT_COLUMNS: [keyof Vitals, "INTEGER" | "TEXT"][] = [
  ["pv", "INTEGER"], ["inp", "INTEGER"], ["inp_target", "TEXT"], ["inp_type", "TEXT"], ["inp_delay", "INTEGER"], ["inp_processing", "INTEGER"],
  ["inp_presentation", "INTEGER"], ["lcp", "INTEGER"], ["lcp_element", "TEXT"], ["cls", "INTEGER"], ["ttfb", "INTEGER"], ["fcp", "INTEGER"],
];

const SESSION_COLS = COLUMNS.sessions.map(([c]) => c);

/** What happened to an ingested event. "capped-first" is returned once per day, when the daily cap is first hit. */
export type IngestResult = "ok" | "dropped" | "capped" | "capped-first";

export type Realtime = ReturnType<SiteDO["snapshot"]>;

export class SiteDO extends DurableObject<Env> {
  private sql: SqlStorage;
  // Kept in memory and written once per flush, so each event costs as few SQLite row writes as possible.
  private dirtyVersion = new Map<string, number>(); // UTC day → events since the last flush
  private liveCache = new Map<string, { version: number; at: number; files: Record<string, ArrayBuffer | null> }>();
  /** Last event time per front door ("qwa" | "plausible"), kept in memory and loaded once per wake. */
  private lastSeen: Map<string, number> | null = null;
  private persistedDirty = new Set<string>(); // days with a dirty:<day> marker in storage (survives eviction)
  private today: { day: string; n: number } | null = null; // events counted so far today (UTC), for the cap
  private siteKnown = false;
  private cappedDay: string | null | undefined; // day this site is marked capped (undefined = not looked up yet)
  // Data version: the id of the newest stored event. Dashboards refresh reports that include today when it changes.
  private seq: number | null = null;
  private lastPush = 0;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      for (const r of this.sql.exec<{ key: string }>("SELECT key FROM meta WHERE key LIKE 'dirty:%'").toArray()) this.persistedDirty.add(r.key.slice(6));
    });
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
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
        hostname TEXT, path TEXT, visitor INTEGER, session INTEGER, props TEXT, scroll_depth INTEGER, engaged_ms INTEGER, via TEXT);
      CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
      CREATE TABLE IF NOT EXISTS daily_counts (day TEXT NOT NULL, via TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, via));
      CREATE TABLE IF NOT EXISTS counts_carried (day TEXT NOT NULL, via TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, via));
    `);
    // One-off rebuild of the events table: no AUTOINCREMENT (it writes an extra bookkeeping row per insert) and a
    // `via` column, so daily counts can be recomputed from the events themselves instead of counted per event.
    const def = this.sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'").toArray()[0]?.sql ?? "";
    if (def.includes("AUTOINCREMENT") || !/\bvia\b/.test(def)) {
      // Events stored so far have no `via`; keep their counts as they were (exact) and add new events on top.
      this.sql.exec("INSERT OR REPLACE INTO counts_carried (day, via, n) SELECT day, via, n FROM daily_counts WHERE day >= ?", utcDay(Date.now() - (LOCAL_RETENTION_S + 86_400) * 1000));
      this.sql.exec(`
        CREATE TABLE events_new (
          id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
          hostname TEXT, path TEXT, visitor INTEGER, session INTEGER, props TEXT, scroll_depth INTEGER, engaged_ms INTEGER, via TEXT);
        INSERT INTO events_new (id, ts, kind, name, hostname, path, visitor, session, props, scroll_depth, engaged_ms)
          SELECT id, ts, kind, name, hostname, path, visitor, session, props, scroll_depth, engaged_ms FROM events;
        DROP TABLE events;
        ALTER TABLE events_new RENAME TO events;
        CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
      `);
    }
    // Web Vitals on engagement events (added October 2026): add any missing columns in place.
    const have = new Set(this.sql.exec<{ name: string }>("PRAGMA table_info(events)").toArray().map((c) => c.name));
    for (const [name, type] of VITAL_EVENT_COLUMNS) if (!have.has(name)) this.sql.exec(`ALTER TABLE events ADD COLUMN ${name} ${type} NOT NULL DEFAULT ${type === "TEXT" ? "''" : "0"}`);
  }

  private meta(key: string): string | null {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string) {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  /** Note that a day's Parquet needs rewriting. Storage is only touched the first time per flush. */
  private markDirty(day: string) {
    this.dirtyVersion.set(day, (this.dirtyVersion.get(day) ?? 0) + 1);
    if (!this.persistedDirty.has(day)) {
      this.sql.exec("INSERT INTO meta (key, value) VALUES (?, '1') ON CONFLICT(key) DO NOTHING", `dirty:${day}`);
      this.persistedDirty.add(day);
    }
  }

  /** Events stored today (UTC), for the cap: counted once when the object wakes, then kept in memory. */
  private todayCount(day: string): number {
    if (this.today?.day !== day) {
      const start = Date.parse(`${day}T00:00:00Z`) / 1000;
      this.today = { day, n: this.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM events WHERE ts >= ? AND ts < ?", start, start + 86_400).one().n };
    }
    return this.today.n;
  }

  /** Recompute a day's per-front-door counts from its stored events (plus counts carried over from before). */
  private recount(day: string) {
    const start = Date.parse(`${day}T00:00:00Z`) / 1000;
    this.sql.exec(
      `INSERT OR REPLACE INTO daily_counts (day, via, n)
       SELECT ?1, via, SUM(n) FROM (
         SELECT via, COUNT(*) n FROM events WHERE ts >= ?2 AND ts < ?3 AND via IS NOT NULL GROUP BY via
         UNION ALL SELECT via, n FROM counts_carried WHERE day = ?1
       ) GROUP BY via`,
      day, start, start + 86_400,
    );
  }

  /**
   * Sessionise and store one event. `cap` is the site's daily event limit (0 = none): past it, events are refused
   * until midnight UTC so a flood or a runaway site can't run up costs.
   */
  async ingest(siteId: number, ev: SiteEvent, cap = 0): Promise<IngestResult> {
    const eventDay = utcDay(ev.ts * 1000);
    if (this.cappedDay === undefined) this.cappedDay = this.meta(`capped:${eventDay}`) !== null ? eventDay : null;
    if (cap > 0 && this.todayCount(eventDay) >= cap) {
      if (this.cappedDay === eventDay) return "capped";
      this.setMeta(`capped:${eventDay}`, String(Math.floor(Date.now() / 1000)));
      this.cappedDay = eventDay;
      this.schedulePush();
      return "capped-first";
    }
    if (this.cappedDay === eventDay) {
      // The limit was raised: recording resumes, so clear the "paused" marker.
      this.sql.exec("DELETE FROM meta WHERE key = ?", `capped:${eventDay}`);
      this.cappedDay = null;
    }
    if (!this.siteKnown) {
      if (this.meta("site_id") === null) this.setMeta("site_id", String(siteId));
      if (this.meta("first_event_at") === null) this.setMeta("first_event_at", String(ev.ts));
      this.siteKnown = true;
    }

    const visitors = ev.prevVisitor !== null ? [ev.visitor, ev.prevVisitor] : [ev.visitor, ev.visitor];
    const session = this.sql
      .exec<Record<string, number | string>>(
        "SELECT * FROM sessions WHERE visitor IN (?, ?) AND last >= ? ORDER BY last DESC LIMIT 1",
        visitors[0], visitors[1], ev.ts - SESSION_TIMEOUT_S,
      )
      .toArray()[0];

    if (ev.kind === "engagement" && !session) return "dropped";

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

    const v = ev.kind === "engagement" ? ev.vitals : null;
    this.sql.exec(
      `INSERT INTO events (ts, kind, name, hostname, path, visitor, session, props, scroll_depth, engaged_ms, via, ${VITAL_EVENT_COLUMNS.map(([c]) => c).join(", ")})
       VALUES (?,?,?,?,?,?,?,?,?,?,?, ${VITAL_EVENT_COLUMNS.map(() => "?").join(",")})`,
      ev.ts, ev.kind, ev.name, ev.hostname, ev.path, ev.visitor, sessionId,
      Object.keys(ev.props).length ? JSON.stringify(ev.props) : "",
      ev.scrollDepth ?? 0, ev.engagedMs ?? 0, ev.via,
      ...VITAL_EVENT_COLUMNS.map(([c, type]) => (v ? v[c] : type === "TEXT" ? "" : 0)),
    );

    if (this.seq !== null) this.seq++;
    this.schedulePush();
    this.markDirty(eventDay);
    if (startDay !== eventDay) this.markDirty(startDay);
    if (this.today?.day === eventDay) this.today.n++;
    if (this.lastSeen && ev.via && ev.ts > (this.lastSeen.get(ev.via) ?? 0)) this.lastSeen.set(ev.via, ev.ts);

    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
    }
    return "ok";
  }

  /** Ingest a batch of events in order (imports and demo data). Returns how many were kept. */
  async ingestMany(siteId: number, evs: SiteEvent[]): Promise<number> {
    let kept = 0;
    for (const ev of evs) if ((await this.ingest(siteId, ev)) === "ok") kept++;
    return kept;
  }

  async alarm(): Promise<void> {
    await this.flush();
    if (this.persistedDirty.size > 0) await this.ctx.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
  }

  /**
   * Fresh Parquet for every day with changes not yet flushed to R2, keyed by R2 key (null = the table has no rows that
   * day, so any R2 copy is stale). The query worker reads these instead of R2's copies, so queries covering today
   * include events from the last few minutes. Rebuilt at most every few seconds per day, and only if something changed.
   * `tag` names this exact content, so query results built from it can be cached until it changes.
   */
  async liveFiles(): Promise<{ files: Record<string, ArrayBuffer | null>; tag: string }> {
    const siteId = Number(this.meta("site_id"));
    if (!siteId) return { files: {}, tag: "" };
    const out: Record<string, ArrayBuffer | null> = {};
    const tag: string[] = [];
    for (const day of this.persistedDirty) {
      const version = this.dirtyVersion.get(day) ?? 0;
      let hit = this.liveCache.get(day);
      if (!hit || (hit.version !== version && Date.now() - hit.at > LIVE_REBUILD_MS)) {
        const start = Date.parse(`${day}T00:00:00Z`) / 1000;
        const files: Record<string, ArrayBuffer | null> = {};
        for (const table of TABLES) files[dayKey(siteId, table, day)] = this.buildDay(table, start, start + 86_400);
        hit = { version, at: Date.now(), files };
        this.liveCache.set(day, hit);
      }
      Object.assign(out, hit.files);
      tag.push(`${day}@${hit.version}.${hit.at}`);
    }
    for (const day of this.liveCache.keys()) if (!this.persistedDirty.has(day)) this.liveCache.delete(day);
    return { files: out, tag: tag.sort().join(",") };
  }

  /** Rewrite the Parquet files for every day that changed since the last flush. */
  async flush(): Promise<{ days: string[] }> {
    const siteId = Number(this.meta("site_id"));
    if (!siteId) return { days: [] };
    const done: string[] = [];
    for (const day of [...this.persistedDirty].sort()) {
      const version = this.dirtyVersion.get(day) ?? 0;
      const start = Date.parse(`${day}T00:00:00Z`) / 1000;
      const end = start + 86_400;
      for (const table of ["sessions", "pageviews", "engagement", "custom"] as TableName[]) {
        const buf = this.buildDay(table, start, end);
        const k = dayKey(siteId, table, day);
        if (buf) await this.env.DATA.put(k, buf);
        else await this.env.DATA.delete(k);
      }
      this.recount(day);
      // Only clear if nothing was ingested for this day while we were writing.
      if ((this.dirtyVersion.get(day) ?? 0) === version) {
        this.sql.exec("DELETE FROM meta WHERE key = ?", `dirty:${day}`);
        this.persistedDirty.delete(day);
        this.dirtyVersion.delete(day);
      }
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
    this.sql.exec("DELETE FROM counts_carried WHERE day < ?", utcDay(cutoff * 1000 - 86_400_000));
    this.sql.exec("DELETE FROM meta WHERE key LIKE 'capped:%' AND key < ?", `capped:${utcDay(Date.now() - 60 * 86_400_000)}`);
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
    return this.snapshot();
  }

  /** The data version: changes whenever an event is stored. */
  private dataVersion(): number {
    if (this.seq === null) this.seq = this.sql.exec<{ v: number }>("SELECT COALESCE(MAX(id), 0) v FROM events").one().v;
    return this.seq;
  }

  snapshot() {
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
    const capped = this.meta(`capped:${utcDay(Date.now())}`);
    const seen = this.lastSeenByVia();
    return {
      version: String(this.dataVersion()),
      cappedAt: capped ? Number(capped) : null,
      plausibleLastAt: seen.get("plausible") ?? null,
      qwaLastAt: seen.get("qwa") ?? null,
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

  // ---- Live updates for dashboards: hibernatable WebSockets, so an idle watcher costs nothing ----

  /** Upgrade to a WebSocket (the Worker has already checked who's asking). `?admin=1` includes admin-only fields. */
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket upgrade", { status: 426 });
    const admin = new URL(req.url).searchParams.get("admin") === "1";
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ admin });
    server.send(this.liveMessage(this.snapshot(), admin));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** The dashboard asks for a fresh snapshot now and then, so "visitors now" falls when traffic stops. */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message !== "refresh") return;
    ws.send(this.liveMessage(this.snapshot(), this.isAdmin(ws)));
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      // already closed
    }
  }

  async webSocketError() {}

  private isAdmin(ws: WebSocket): boolean {
    return (ws.deserializeAttachment() as { admin?: boolean } | null)?.admin === true;
  }

  private liveMessage(snap: Realtime, admin: boolean): string {
    return JSON.stringify({ type: "live", ...(admin ? snap : forViewer(snap)) });
  }

  /** Push a snapshot to watching dashboards soon: at most one per PUSH_INTERVAL_MS, always including the latest event. */
  private schedulePush() {
    if (this.pushTimer || this.ctx.getWebSockets().length === 0) return;
    const wait = Math.max(0, this.lastPush + PUSH_INTERVAL_MS - Date.now());
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.lastPush = Date.now();
      const sockets = this.ctx.getWebSockets();
      if (!sockets.length) return;
      const snap = this.snapshot();
      const msgs = { admin: this.liveMessage(snap, true), viewer: this.liveMessage(snap, false) };
      for (const ws of sockets) {
        try {
          ws.send(this.isAdmin(ws) ? msgs.admin : msgs.viewer);
        } catch {
          // closing; the runtime tidies it up
        }
      }
    }, wait);
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

  /**
   * When each front door last sent an event: exact from the local events (the last three days), else the end of the
   * last day with any in the daily counts (60 days).
   */
  private lastSeenByVia(): Map<string, number> {
    if (this.lastSeen) return this.lastSeen;
    const seen = new Map<string, number>();
    for (const r of this.sql.exec<{ via: string; ts: number }>("SELECT via, MAX(ts) ts FROM events WHERE via IS NOT NULL GROUP BY via").toArray()) seen.set(r.via, r.ts);
    for (const r of this.sql.exec<{ via: string; day: string }>("SELECT via, MAX(day) day FROM daily_counts WHERE n > 0 GROUP BY via").toArray()) {
      if (!seen.has(r.via)) seen.set(r.via, Math.floor(Date.parse(`${r.day}T23:59:59Z`) / 1000));
    }
    this.lastSeen = seen;
    return seen;
  }

  /** Last event time, 14-day event counts and last-seen times by front door, for the tracker badges. */
  async status(): Promise<{ lastEventAt: number | null; plausible14d: number; qwa14d: number; plausibleLastAt: number | null; qwaLastAt: number | null; cappedAt: number | null; eventsToday: number }> {
    const last = this.sql.exec<{ ts: number | null }>("SELECT MAX(ts) ts FROM events").one().ts;
    const counts = await this.ingestCounts(14);
    const sum = (via: string) => counts.filter((c) => c.via === via).reduce((n, c) => n + c.n, 0);
    const today = utcDay(Date.now());
    const capped = this.meta(`capped:${today}`);
    const seen = this.lastSeenByVia();
    return {
      lastEventAt: last ?? null,
      plausible14d: sum("plausible"),
      qwa14d: sum("qwa"),
      plausibleLastAt: seen.get("plausible") ?? null,
      qwaLastAt: seen.get("qwa") ?? null,
      cappedAt: capped ? Number(capped) : null,
      eventsToday: this.todayCount(today),
    };
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
      plausibleLastAt: status.plausibleLastAt,
      qwaLastAt: status.qwaLastAt,
      cappedAt: status.cappedAt,
      now: this.sql.exec<{ n: number }>("SELECT COUNT(DISTINCT visitor) n FROM events WHERE ts >= ? AND kind != 'engagement'", now - 300).one().n,
      perMinute: this.perMinute(now),
      days: days.map((d) => ({ day: d.day, complete: first !== null && Number(first) <= d.start, ...this.dayStats(d.start, d.end) })),
    };
  }

  /** Events per day split by front door (Plausible compat vs QWA tracker): tracks tracker migration. */
  async ingestCounts(days = 14): Promise<{ day: string; via: string; n: number }[]> {
    const rows = this.sql
      .exec<{ day: string; via: string; n: number }>("SELECT day, via, n FROM daily_counts WHERE day >= ? ORDER BY day", utcDay(Date.now() - days * 86_400_000))
      .toArray();
    return rows;
  }
}
