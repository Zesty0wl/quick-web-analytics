import { lazy, Suspense, useMemo, useState } from "react";
import type { Metric } from "@qwa/shared";
import { useOverview, type DayStats, type Me, type OverviewSite } from "../api";
import { Busy, busyOf, Delta, deltaInfo, MinuteBars, Spark, Spinner, UpdatedAgo } from "../components/Bits";
import { Alarm, External, Search } from "../components/Icons";
import { addDays, todayIn } from "../dates";
import { ANOMALY_LABEL, change, compact, describeAnomaly, duration, whole, trackerState } from "../format";
import { globalParams, withParams, type Navigate } from "../url";

// The drill-down behind each totals card loads its code when first opened.
const Drill = lazy(() => import("./Drill").then((m) => ({ default: m.Drill })));
const DRILLS = ["visitors", "pageviews", "visit_duration", "bounce_rate", "events"] as const;
type DrillMetric = (typeof DRILLS)[number];

type Sort = "visitors" | "growth" | "decline" | "live" | "name";
type View = "cards" | "tiles" | "table";

const sum = (d: DayStats[], k: keyof Omit<DayStats, "day">) => d.reduce((n, x) => n + x[k], 0);

interface Totals { visitors: number; pageviews: number; visits: number; events: number; bounce: number; duration: number }
function totals(d: DayStats[]): Totals {
  const visits = sum(d, "visits");
  return {
    visitors: sum(d, "visitors"), pageviews: sum(d, "pageviews"), visits, events: sum(d, "events"),
    bounce: visits ? (sum(d, "bounces") / visits) * 100 : 0, duration: visits ? sum(d, "duration_sum") / visits : 0,
  };
}

interface Row { site: OverviewSite; cur: Totals; prev: Totals; growth: number }

export function Overview({ me, url, navigate, dates, periodText, cmpText }: {
  me: Me; url: URL; navigate: Navigate;
  dates: { from: string; to: string; cfrom: string; cto: string };
  periodText: string; cmpText: string;
}) {
  const q = useOverview(dates);
  const [search, setSearch] = useState("");
  const sort = (url.searchParams.get("s") as Sort) || "visitors";
  const view = (url.searchParams.get("v") as View) || "cards";
  const isAdmin = me.user.role === "admin";
  const setParam = (k: string, v: string, def: string) => navigate(withParams(url, { [k]: v === def ? null : v }), { replace: true });
  const open = (id: number) => navigate(`/s/${id}${globalParams(url)}`);
  const k = url.searchParams.get("k");
  const drill = DRILLS.includes(k as DrillMetric) ? (k as DrillMetric) : null;
  const setDrill = (m: DrillMetric | null) => navigate(withParams(url, { k: m }), { replace: true, keepScroll: true });

  const rows: Row[] = useMemo(
    () => (q.data?.sites ?? []).map((site) => {
      const cur = totals(site.current);
      const prev = totals(site.comparison);
      return { site, cur, prev, growth: change(cur.visitors, prev.visitors) ?? (cur.visitors ? 100 : 0) };
    }),
    [q.data],
  );

  const all = useMemo(() => {
    const t = (pick: (r: Row) => Totals) => {
      const visits = rows.reduce((n, r) => n + pick(r).visits, 0);
      return {
        visitors: rows.reduce((n, r) => n + pick(r).visitors, 0),
        pageviews: rows.reduce((n, r) => n + pick(r).pageviews, 0),
        events: rows.reduce((n, r) => n + pick(r).events, 0),
        bounce: visits ? rows.reduce((n, r) => n + (pick(r).bounce * pick(r).visits) / 100, 0) / visits * 100 : 0,
        duration: visits ? rows.reduce((n, r) => n + pick(r).duration * pick(r).visits, 0) / visits : 0,
      };
    };
    const minutes = Array.from({ length: 30 }, (_, i) => rows.reduce((n, r) => n + (r.site.perMinute[i] ?? 0), 0));
    return { cur: t((r) => r.cur), prev: t((r) => r.prev), live: rows.reduce((n, r) => n + r.site.now, 0), liveSites: rows.filter((r) => r.site.now > 0).length, minutes };
  }, [rows]);

  // Day-by-day totals across all sites, for the sparklines on the totals cards (missing days count as zero).
  const daily = useMemo(() => {
    const series = (from: string, to: string, pick: (s: OverviewSite) => DayStats[]) => {
      const by = new Map<string, Omit<DayStats, "day">>();
      for (let d = from; d <= to; d = addDays(d, 1)) by.set(d, { visitors: 0, visits: 0, pageviews: 0, events: 0, bounces: 0, duration_sum: 0 });
      for (const r of rows) {
        for (const x of pick(r.site)) {
          const t = by.get(x.day);
          if (!t) continue;
          t.visitors += x.visitors; t.visits += x.visits; t.pageviews += x.pageviews;
          t.events += x.events; t.bounces += x.bounces; t.duration_sum += x.duration_sum;
        }
      }
      return [...by.values()];
    };
    let cur = series(dates.from, dates.to, (s) => s.current);
    let prev = series(dates.cfrom, dates.cto, (s) => s.comparison);
    // Stop at yesterday: today is still filling up, so it would always look like a drop.
    if (dates.to >= todayIn() && cur.length > 2) {
      cur = cur.slice(0, -1);
      prev = prev.slice(0, -1);
    }
    // Long ranges: weekly points, counted back from the end so every point is a full week.
    const group = (list: Omit<DayStats, "day">[], size: number) => {
      if (size === 1) return list;
      const out: Omit<DayStats, "day">[] = [];
      for (let end = list.length; end - size >= 0; end -= size) {
        out.unshift(list.slice(end - size, end).reduce((a, d) => ({
          visitors: a.visitors + d.visitors, visits: a.visits + d.visits, pageviews: a.pageviews + d.pageviews,
          events: a.events + d.events, bounces: a.bounces + d.bounces, duration_sum: a.duration_sum + d.duration_sum,
        })));
      }
      return out;
    };
    const size = cur.length > 120 ? 7 : 1;
    return { cur: group(cur, size), prev: group(prev, size), weekly: size > 1 };
  }, [rows, dates.from, dates.to, dates.cfrom, dates.cto]);

  const shown = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = rows.filter((r) => !term || r.site.domain.includes(term));
    return list.sort((a, b) =>
      sort === "name" ? a.site.domain.localeCompare(b.site.domain)
      : sort === "growth" ? b.growth - a.growth
      : sort === "decline" ? a.growth - b.growth
      : sort === "live" ? b.site.now - a.site.now || b.cur.visitors - a.cur.visitors
      : b.cur.visitors - a.cur.visitors,
    );
  }, [rows, search, sort]);

  if (q.isLoading) return <div className="busy-block" style={{ minHeight: "50vh" }}><Spinner size={16} />Loading your sites…</div>;
  if (q.isError) return <div className="center error">{(q.error as Error).message}</div>;

  type Day = Omit<DayStats, "day">;
  const kpis: { label: string; metric: DrillMetric; cur: number; prev: number; fmt: (n: number) => string; perDay: (d: Day) => number; rate?: boolean }[] = [
    { label: "Visitors", metric: "visitors", cur: all.cur.visitors, prev: all.prev.visitors, fmt: whole, perDay: (d) => d.visitors },
    { label: "Pageviews", metric: "pageviews", cur: all.cur.pageviews, prev: all.prev.pageviews, fmt: whole, perDay: (d) => d.pageviews },
    { label: "Avg. visit", metric: "visit_duration", cur: all.cur.duration, prev: all.prev.duration, fmt: duration, perDay: (d) => (d.visits ? d.duration_sum / d.visits : NaN), rate: true },
    { label: "Bounce rate", metric: "bounce_rate", cur: all.cur.bounce, prev: all.prev.bounce, fmt: (n) => `${n.toFixed(1)}%`, perDay: (d) => (d.visits ? (d.bounces / d.visits) * 100 : NaN), rate: true },
    { label: "Events", metric: "events", cur: all.cur.events, prev: all.prev.events, fmt: whole, perDay: (d) => d.events },
  ];
  const liveTop = [...rows].filter((r) => r.site.now > 0).sort((a, b) => b.site.now - a.site.now).slice(0, 6);
  const liveMax = Math.max(1, ...liveTop.map((r) => r.site.now));

  return (
    <div>
      <header className="pagehead overview-head">
        <div className="titles">
          <div className="kicker">Properties</div>
          <h1 style={{ margin: 0 }}>All sites</h1>
          <div className="sub">{rows.length} properties · {periodText} compared with {cmpText}</div>
        </div>
        <Busy busy={busyOf(q)} className="kpi-strip-wrap">
          <div className="kpi-strip">
            {kpis.map((k) => (
              <button
                key={k.label}
                className={drill === k.metric ? "cell-btn kpi-mini metric-tile on" : "cell-btn kpi-mini"}
                aria-pressed={drill === k.metric}
                onClick={() => setDrill(drill === k.metric ? null : k.metric)}
                title={`${k.label}: ${k.fmt(k.cur)}, from ${k.fmt(k.prev)}. Click for the detail across all sites.`}
              >
                <div className="kpi-label">{k.label}</div>
                <div className="kpi-value">{k.fmt(k.cur)}</div>
                <div className="kpi-delta"><Delta metric={k.metric} current={k.cur} previous={k.prev} /></div>
                {daily.cur.length > 1 && (
                  <div className="kpi-spark" title={`${k.label} by ${daily.weekly ? "week" : "day"} (to yesterday), with the comparison period dashed`}>
                    <Spark current={daily.cur.map(k.perDay)} comparison={daily.prev.map(k.perDay)} growing={deltaInfo(k.metric, k.cur, k.prev)?.cls !== "delta bad"} height={26} fit={k.rate} />
                  </div>
                )}
              </button>
            ))}
          </div>
        </Busy>
      </header>

      {drill && (
        <Suspense fallback={<div className="cell drill placeholder" />}>
          <Drill metric={drill} sites={rows.map((r) => r.site)} dates={dates} periodText={periodText} cmpText={cmpText} url={url} navigate={navigate} onClose={() => setDrill(null)} />
        </Suspense>
      )}

      <Busy busy={busyOf(q)}>
      <section className="cells live-grid" style={{ marginBottom: "var(--space-8)" }}>
        <div className="cell" style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className={all.live ? "livedot" : "livedot off"} aria-hidden />
            <span className="label" style={{ color: "var(--color-text)" }}>Live now · all sites</span>
            <span className="muted" style={{ fontSize: 12, marginLeft: "auto" }}><UpdatedAgo at={q.dataUpdatedAt} /></span>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-3)" }}>
            <span className="livebig">{whole(all.live)}</span>
            <span className="muted" style={{ fontSize: 14 }}>visitors on {all.liveSites} site{all.liveSites === 1 ? "" : "s"}</span>
          </div>
          <MinuteBars values={all.minutes} fill minHeight={150} tip={(i) => <MinuteTip i={i} rows={rows} total={all.minutes[i] ?? 0} />} />
          <div className="axis-row"><span>30 min ago</span><span>now</span></div>
        </div>
        <div className="cell">
          <div className="label" style={{ color: "var(--color-text)", marginBottom: "var(--space-2)" }}>Most active right now</div>
          {liveTop.length === 0 && <div className="empty">Nobody is on any site right now.</div>}
          {liveTop.map((r) => (
            <div key={r.site.id} className="barrow clickable" onClick={() => open(r.site.id)}>
              <div className="fill" style={{ width: `${(r.site.now / liveMax) * 100}%` }} />
              <span>{r.site.domain}</span>
              <span className="v" style={{ width: 56 }}>{r.site.now}</span>
            </div>
          ))}
        </div>
      </section>

      <div className="toolbar">
        <div className="search">
          <Search />
          <input className="input" placeholder="Search sites or domains" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search sites" />
        </div>
        <select className="input" value={sort} onChange={(e) => setParam("s", e.target.value, "visitors")} aria-label="Sort">
          <option value="visitors">Sort: Visitors</option>
          <option value="growth">Sort: Fastest growing</option>
          <option value="decline">Sort: Biggest decline</option>
          <option value="live">Sort: Live now</option>
          <option value="name">Sort: Name A–Z</option>
        </select>
        <span className="muted" style={{ fontSize: 13 }}>Showing {shown.length} of {rows.length}</span>
        <div className="seg" style={{ marginLeft: "auto" }} role="group" aria-label="View">
          {(["cards", "tiles", "table"] as View[]).map((v) => (
            <button key={v} className={view === v ? "on" : ""} onClick={() => setParam("v", v, "cards")}>{v[0].toUpperCase() + v.slice(1)}</button>
          ))}
        </div>
      </div>

      {shown.length === 0 && (
        <div style={{ padding: "var(--space-8) 0", borderBottom: "2px solid var(--color-divider)" }}>
          <h4>No properties match “{search}”</h4>
          <div className="muted">Try a domain or part of one.</div>
        </div>
      )}

      {view === "cards" && (
        <div className="cells site-grid">
          {shown.map((r) => <SiteCard key={r.site.id} r={r} isAdmin={isAdmin} onOpen={() => open(r.site.id)} />)}
        </div>
      )}

      {view === "tiles" && (
        <>
          <div className="cells" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))" }}>
            {shown.map((r) => {
              const a = Math.min(Math.abs(r.growth), 60) / 60;
              const d = deltaInfo("visitors", r.cur.visitors, r.prev.visitors);
              return (
                <div
                  key={r.site.id}
                  className="cell tile cell-link"
                  title={r.site.domain}
                  onClick={() => open(r.site.id)}
                  style={{ padding: "var(--space-3)", display: "flex", flexDirection: "column", gap: 2, background: `color-mix(in srgb, ${r.growth >= 0 ? "var(--tint)" : "var(--color-accent)"} ${(3 + a * 24).toFixed(0)}%, var(--color-bg))` }}
                >
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span className="nm">{r.site.domain}</span>
                    <span className="muted" style={{ marginLeft: "auto", fontSize: 11, flex: "none" }}>{r.site.now}●</span>
                  </div>
                  <div className="vis">{compact(r.cur.visitors)}</div>
                  {d && <div className={d.cls} style={{ fontSize: 12 }}>{d.text}</div>}
                </div>
              );
            })}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: "var(--space-2)" }}>Tile tint = size of change. Ink = growth, accent = decline.</div>
        </>
      )}

      {view === "table" && (
        <div className="table-scroll table-card">
          <table className="table" style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th>Site</th>{isAdmin && <th>Tracker</th>}<th className="num">Visitors</th><th className="num">Change</th><th className="num">Pageviews</th>
                <th className="num">Bounce</th><th className="num">Avg. visit</th><th className="num">Live</th><th style={{ width: 140 }}>Trend</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.site.id} className="clickable" onClick={() => open(r.site.id)}>
                  <td>
                    <div style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
                      {r.site.domain}
                      <a className="open" href={`https://${r.site.domain}`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title={`Open ${r.site.domain}`}><External /></a>
                      <AnomalyFlag site={r.site} />
                    </div>
                  </td>
                  {isAdmin && <td><TrackerTag site={r.site} /></td>}
                  <td className="num" style={{ fontWeight: 700 }}>{whole(r.cur.visitors)}</td>
                  <td className="num"><Delta metric="visitors" current={r.cur.visitors} previous={r.prev.visitors} /></td>
                  <td className="num">{whole(r.cur.pageviews)}</td>
                  <td className="num">{r.cur.visits ? `${Math.round(r.cur.bounce)}%` : "–"}</td>
                  <td className="num">{r.cur.visits ? duration(r.cur.duration) : "–"}</td>
                  <td className="num">{r.site.now}</td>
                  <td><SiteSpark r={r} height={28} width={130} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </Busy>
    </div>
  );
}

/** Hover detail for one minute of the live chart: the sites that made up the bar. */
function MinuteTip({ i, rows, total }: { i: number; rows: Row[]; total: number }) {
  const at = new Date(Date.now() - (29 - i) * 60_000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const parts = rows
    .map((r) => ({ domain: r.site.domain, v: r.site.perMinute[i] ?? 0 }))
    .filter((p) => p.v > 0)
    .sort((a, b) => b.v - a.v);
  return (
    <>
      <div className="mb-tip-h">
        <span>{i === 29 ? `${at} (this minute)` : at}</span>
        <b>{whole(total)} visitor{total === 1 ? "" : "s"}</b>
      </div>
      {parts.length === 0 && <div className="muted-tip">Nobody</div>}
      {parts.slice(0, 8).map((p) => (
        <div key={p.domain} className="mb-tip-r"><span>{p.domain}</span><b>{whole(p.v)}</b></div>
      ))}
      {parts.length > 8 && <div className="muted-tip">+{parts.length - 8} more sites</div>}
    </>
  );
}

function TrackerTag({ site }: { site: OverviewSite }) {
  const t = trackerState(site);
  return <span className={t.qwaOnly ? "tag tag-accent" : "tag tag-neutral"} title={t.plausibleNote ?? undefined}>{t.label}</span>;
}

function SiteSpark({ r, height = 52, width }: { r: Row; height?: number; width?: number }) {
  const cur = r.site.current.map((d) => d.visitors);
  if (cur.length < 2) return <MinuteBars values={r.site.perMinute} height={height} />;
  return <Spark current={cur} comparison={r.site.comparison.map((d) => d.visitors)} growing={r.growth >= 0} height={height} width={width} />;
}

/** The most recent unusual day in the last week, as a small flag. */
function AnomalyFlag({ site }: { site: OverviewSite }) {
  const since = addDays(todayIn(site.timezone), -7);
  const a = [...(site.anomalies ?? [])].reverse().find((x) => x.day >= since);
  if (!a) return null;
  const label = { spike: "Spike", drop: "Drop", outage: "Outage?" }[a.kind];
  return (
    <span className={`anomaly-flag ${a.kind}`} title={`${ANOMALY_LABEL[a.kind]} on ${a.day}: ${describeAnomaly(a)}`}>
      <Alarm size={11} />{label}
    </span>
  );
}

function lastSeen(site: OverviewSite): string {
  if (site.now > 0) return "Online now";
  if (site.lastEventAt) {
    const m = Math.round((Date.now() / 1000 - site.lastEventAt) / 60);
    return m < 60 ? `Last visit ${m} min ago` : m < 1440 ? `Last visit ${Math.round(m / 60)} h ago` : `Last visit ${Math.round(m / 1440)} days ago`;
  }
  if (site.lastActiveDay) {
    const d = Math.round((Date.now() - Date.parse(`${site.lastActiveDay}T12:00:00Z`)) / 86_400_000);
    return d <= 0 ? "Visited today" : d === 1 ? "Last visit yesterday" : `Last visit ${d} days ago`;
  }
  return "No data yet";
}

function SiteCard({ r, isAdmin, onOpen }: { r: Row; isAdmin: boolean; onOpen: () => void }) {
  return (
    <div className="cell cell-link site-card" role="link" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === "Enter" && onOpen()} aria-label={`${r.site.domain}: ${whole(r.cur.visitors)} visitors`}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <span className="nm">{r.site.domain}</span>
        <a className="muted" style={{ display: "inline-flex" }} href={`https://${r.site.domain}`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title={`Open ${r.site.domain}`} aria-label={`Open ${r.site.domain}`}><External size={13} /></a>
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, fontSize: 12, flex: "none" }}>
          <span className={r.site.now ? "livedot sm" : "livedot sm off"} aria-hidden />{r.site.now} live
        </span>
      </div>
      <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", fontSize: 12 }}>
        <span className="muted" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{lastSeen(r.site)}</span>
        <AnomalyFlag site={r.site} />
        {r.site.cappedAt && <span className="anomaly-flag" title="This site hit its daily event limit; recording is paused until midnight UTC. Raise it in Admin → Sites → Settings.">Capped</span>}
        {isAdmin && <span style={{ marginLeft: "auto", flex: "none" }}><TrackerTag site={r.site} /></span>}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
        <span className="vis">{whole(r.cur.visitors)}</span>
        <span className="muted" style={{ fontSize: 12 }}>visitors</span>
        <span style={{ marginLeft: "auto", fontSize: 14 }}><Delta metric="visitors" current={r.cur.visitors} previous={r.prev.visitors} /></span>
      </div>
      <SiteSpark r={r} />
      <div className="foot">
        <div><span className="muted">Pageviews</span><b>{compact(r.cur.pageviews)}</b></div>
        <div><span className="muted">Bounce</span><b>{r.cur.visits ? `${Math.round(r.cur.bounce)}%` : "–"}</b></div>
        <div><span className="muted">Avg. visit</span><b>{r.cur.visits ? duration(r.cur.duration) : "–"}</b></div>
      </div>
    </div>
  );
}
