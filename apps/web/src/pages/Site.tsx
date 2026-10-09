import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Dimension, Filter, Metric, TimeGrain } from "@qwa/shared";
import { api, useAlerts, useAnomalies, useRealtime, useStats, type Me } from "../api";
import { Busy, busyOf, Delta, MinuteBars, Spinner, UpdatedAgo, useInView } from "../components/Bits";
import { ArrowLeft, Bell, BellOff, Close, External, Search } from "../components/Icons";
import { LineChart, type ChartMark } from "../components/LineChart";
import { SiteSwitcher } from "../components/SiteSwitcher";
import { WorldMap } from "../components/WorldMap";
import { Section, Seg } from "../components/Section";
import { SearchSection, SpeedSection } from "./Google";
import { addDays, comparisonRange, daysBetween, grainsFor, isWeekend, shortDate, weekday, type Compare } from "../dates";
import { compact, describeAnomaly, DIMENSION_LABELS, displayValue, duration, liveUrl, metricValue, METRIC_LABELS, whole } from "../format";
import { globalParams, linkHandler, readSiteState, withParams, type Navigate, type SiteState } from "../url";

export const SECTIONS = [
  { id: "s-overview", label: "Overview" },
  { id: "s-realtime", label: "Realtime" },
  { id: "s-sources", label: "Sources" },
  { id: "s-search", label: "Google Search" },
  { id: "s-pages", label: "Pages" },
  { id: "s-campaigns", label: "Campaigns" },
  { id: "s-events", label: "Events" },
  { id: "s-devices", label: "Devices" },
  { id: "s-geo", label: "Geography" },
  { id: "s-heatmap", label: "Heatmap" },
  { id: "s-speed", label: "Speed" },
  { id: "s-days", label: "Day by day" },
];

const TILES: Metric[] = ["visitors", "visits", "pageviews", "views_per_visit", "bounce_rate", "visit_duration", "time_on_page", "scroll_depth", "events"];
const TILE_LABELS: Partial<Record<Metric, string>> = { visitors: "Unique visitors", visit_duration: "Avg. visit" };
const SERIES: Metric[] = ["visitors", "visits", "pageviews", "views_per_visit", "bounce_rate", "visit_duration", "events"];
const ENGAGEMENT: Metric[] = ["scroll_depth", "time_on_page"];

// Channel colours per the design: ink, accent and neutral steps, fixed per channel (never by rank).
const CHANNEL_COLORS: Record<string, string> = {
  Direct: "var(--color-text)", "Organic Search": "var(--color-accent)", Referral: "var(--color-neutral-500)", "Organic Social": "var(--color-accent-700)",
  Email: "var(--color-neutral-700)", "Paid Search": "var(--color-accent-300)", "AI Assistants": "var(--color-neutral-300)", "Organic Video": "var(--color-accent-500)",
  "Paid Social": "var(--color-accent-200)", "Paid Video": "var(--color-neutral-400)",
};
const AUTO_EVENTS = new Set(["Outbound Link: Click", "File Download", "Form: Submission", "404", "Cloaked Link: Click"]);

export interface Ctx {
  siteId: number;
  domain: string;
  from: string;
  to: string;
  cmp: { from: string; to: string };
  filters: Filter[];
  addFilter: (f: Filter) => void;
}

type Row = Record<string, string | number | null>;

/** A breakdown plus the same breakdown for the comparison period (for change columns). */
function useBreakdown(c: Ctx, dim: Dimension, metrics: Metric[], opts: { limit?: number; enabled: boolean; compare?: boolean }) {
  const cur = useStats(c.siteId, { from: c.from, to: c.to, metrics, groupBy: dim, filters: c.filters, limit: opts.limit ?? 10 }, opts.enabled);
  const prev = useStats(c.siteId, { from: c.cmp.from, to: c.cmp.to, metrics: [metrics[0]], groupBy: dim, filters: c.filters, limit: 300 }, opts.enabled && !!opts.compare);
  const prevMap = useMemo(() => new Map((prev.data?.rows ?? []).map((r) => [String(r[dim] ?? ""), Number(r[metrics[0]] ?? 0)])), [prev.data, dim, metrics]);
  const rows = (cur.data?.rows ?? []) as Row[];
  // Old rows against a new comparison (or vice versa) would give wrong changes, so hide them until both are current.
  const changesStale = cur.isPlaceholderData || prev.isPlaceholderData;
  return { rows, prevMap: changesStale ? new Map<string, number>() : prevMap, changesStale, loading: cur.isLoading, busy: busyOf(cur, prev), empty: rows.length === 0, error: cur.error as Error | null };
}

function OpenLink({ dim, value, domain }: { dim: Dimension; value: string; domain: string }) {
  const url = liveUrl(dim, value, domain);
  if (!url) return null;
  return <a className="open" href={url} target="_blank" rel="noopener noreferrer" title={`Open ${url}`} onClick={(e) => e.stopPropagation()}><External /></a>;
}

function BarCell({ dim, value, w, mono, domain, prefix }: { dim: Dimension; value: string; w: number; mono?: boolean; domain: string; prefix?: React.ReactNode }) {
  return (
    <td className="incell">
      <div className="fill" style={{ width: `${w}%` }} />
      <div className="inner">
        {prefix}
        <span className={mono ? "txt mono" : "txt"}>{displayValue(dim, value)}</span>
        <OpenLink dim={dim} value={value} domain={domain} />
      </div>
    </td>
  );
}

function ChangeCell({ metric, cur, prev, stale }: { metric: Metric; cur: number; prev: number | undefined; stale?: boolean }) {
  return <td className="num">{stale ? <span className="muted">…</span> : <Delta metric={metric} current={cur} previous={prev ?? 0} />}</td>;
}

/** Breakdown table with in-cell bars, filter on click, optional change column and a "show all" dialog. */
function BreakdownTable({ c, dim, metrics, columns, mono, compare, limit = 10, enabled, empty, showAll = true, prefix }: {
  c: Ctx; dim: Dimension; metrics: Metric[]; columns?: { label: string; render: (r: Row) => React.ReactNode }[]; mono?: boolean; compare?: boolean;
  limit?: number; enabled: boolean; empty?: string; showAll?: boolean; prefix?: (value: string) => React.ReactNode;
}) {
  const b = useBreakdown(c, dim, metrics, { limit, enabled, compare });
  const [open, setOpen] = useState(false);
  const max = Math.max(1, ...b.rows.map((r) => Number(r[metrics[0]] ?? 0)));
  const cols = columns ?? metrics.map((m) => ({ label: METRIC_LABELS[m], render: (r: Row) => metricValue(m, r[m] as number, { compact: true }) }));
  if (b.error) return <p className="error">{b.error.message}</p>;
  return (
    <div>
      <Busy busy={b.busy} empty={b.empty}>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>{DIMENSION_LABELS[dim]}</th>
              {cols.map((col) => <th key={col.label} className="num">{col.label}</th>)}
              {compare && <th className="num">Change</th>}
            </tr>
          </thead>
          <tbody>
            {b.rows.map((r) => {
              const v = String(r[dim] ?? "");
              return (
                <tr key={v} className="clickable" onClick={() => c.addFilter([dim, "is", v])} title={`Filter: ${DIMENSION_LABELS[dim]} is ${displayValue(dim, v)}`}>
                  <BarCell dim={dim} value={v} w={(Number(r[metrics[0]] ?? 0) / max) * 100} mono={mono} domain={c.domain} prefix={prefix?.(v)} />
                  {cols.map((col, i) => <td key={col.label} className={i === 0 ? "num strong" : "num"}>{col.render(r)}</td>)}
                  {compare && <ChangeCell metric={metrics[0]} cur={Number(r[metrics[0]] ?? 0)} prev={b.prevMap.get(v)} stale={b.changesStale} />}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!b.busy && b.rows.length === 0 && <div className="empty">{empty ?? "No data for this period."}</div>}
      </Busy>
      {showAll && b.rows.length >= limit && <button className="btn btn-ghost" style={{ marginTop: 8 }} onClick={() => setOpen(true)}>Show all</button>}
      {open && <AllRows c={c} dim={dim} metrics={metrics} mono={mono} onClose={() => setOpen(false)} />}
    </div>
  );
}

function AllRows({ c, dim, metrics, mono, onClose }: { c: Ctx; dim: Dimension; metrics: Metric[]; mono?: boolean; onClose: () => void }) {
  const [text, setText] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => { const t = setTimeout(() => setTerm(text.trim()), 250); return () => clearTimeout(t); }, [text]);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  const filters: Filter[] = term ? [...c.filters, [dim, "contains", term]] : c.filters;
  const q = useStats(c.siteId, { from: c.from, to: c.to, metrics, groupBy: dim, filters, limit: 300 });
  const rows = (q.data?.rows ?? []) as Row[];
  const max = Math.max(1, ...rows.map((r) => Number(r[metrics[0]] ?? 0)));
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={DIMENSION_LABELS[dim]} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h4 style={{ margin: 0, marginRight: "auto" }}>{DIMENSION_LABELS[dim]}</h4>
          <div className="search" style={{ maxWidth: 260 }}><Search /><input className="input" autoFocus placeholder="Search" value={text} onChange={(e) => setText(e.target.value)} /></div>
          <button className="btn btn-secondary btn-icon" onClick={onClose} aria-label="Close"><Close /></button>
        </div>
        <div className="scroll">
          <Busy busy={busyOf(q)} empty={rows.length === 0}>
          <table className="table">
            <thead><tr><th>{DIMENSION_LABELS[dim]}</th>{metrics.map((m) => <th key={m} className="num">{METRIC_LABELS[m]}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => {
                const v = String(r[dim] ?? "");
                return (
                  <tr key={v} className="clickable" onClick={() => { c.addFilter([dim, "is", v]); onClose(); }}>
                    <BarCell dim={dim} value={v} w={(Number(r[metrics[0]] ?? 0) / max) * 100} mono={mono} domain={c.domain} />
                    {metrics.map((m, i) => <td key={m} className={i === 0 ? "num strong" : "num"}>{metricValue(m, r[m] as number, { compact: true })}</td>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!busyOf(q) && rows.length === 0 && <div className="empty">Nothing matches.</div>}
          </Busy>
        </div>
      </div>
    </div>
  );
}

export function Site({ me, url, navigate, dates, compare, periodText, cmpText }: {
  me: Me; url: URL; navigate: Navigate; dates: { from: string; to: string }; compare: Compare; periodText: string; cmpText: string;
}) {
  const state = readSiteState(url);
  const site = me.sites.find((s) => s.id === state?.siteId);
  if (!state || !site) {
    return (
      <div className="center">
        <h3>Site not found</h3>
        <p className="muted">It may have been removed, or you don't have access to it.</p>
        <a className="btn btn-secondary" href="/" onClick={linkHandler(navigate, "/")}>All sites</a>
      </div>
    );
  }
  return <Detail key={site.id} admin={me.user.role === "admin"} sites={me.sites} site={site} state={state} url={url} navigate={navigate} dates={dates} compare={compare} periodText={periodText} cmpText={cmpText} />;
}

function Detail({ admin, sites, site, state, url, navigate, dates, compare, periodText, cmpText }: {
  admin: boolean; sites: Me["sites"]; site: Me["sites"][number]; state: SiteState; url: URL; navigate: Navigate; dates: { from: string; to: string }; compare: Compare; periodText: string; cmpText: string;
}) {
  const { from, to } = dates;
  const { allowed, auto } = grainsFor(from, to);
  const grain: TimeGrain = state.grain && allowed.includes(state.grain) ? state.grain : auto;
  const cmp = comparisonRange(from, to, compare);
  const filters = state.filters;
  const span = daysBetween(from, to);

  const set = (changes: Record<string, string | null>, opts: { replace?: boolean; keepScroll?: boolean } = { keepScroll: true }) => navigate(withParams(url, changes), opts);
  const setFilters = (f: Filter[]) => set({ f: f.length ? JSON.stringify(f) : null });
  const addFilter = (f: Filter) => setFilters([...filters.filter((x) => x[0] !== f[0]), f]);
  const zoomTo = (a: string, b: string) => set({ range: null, from: a, to: b, g: null });
  const c: Ctx = { siteId: site.id, domain: site.domain, from, to, cmp, filters, addFilter };

  const seriesMetrics = ENGAGEMENT.includes(state.metric) ? [...SERIES, state.metric] : SERIES;
  const totals = useStats(site.id, { from, to, metrics: TILES, filters });
  const cmpTotals = useStats(site.id, { from: cmp.from, to: cmp.to, metrics: TILES, filters });
  const series = useStats(site.id, { from, to, metrics: seriesMetrics, groupBy: grain, filters });
  const cmpSeries = useStats(site.id, { from: cmp.from, to: cmp.to, metrics: seriesMetrics, groupBy: grain, filters });
  const rt = useRealtime(site.id);
  const anomalies = useAnomalies(site.id, from, to);

  const t = totals.data?.rows[0] ?? {};
  const p = cmpTotals.data?.rows[0];
  // While a new range/filter loads, queries finish at different times. Never mix old and new results:
  // deltas wait until both totals are current, and the chart draws rows with the grain they were fetched with.
  const tilesStale = totals.isPlaceholderData || cmpTotals.isPlaceholderData;
  const rows = series.data?.rows ?? [];
  const dataGrain = grainOf(rows) ?? grain;
  const keys = rows.map((r) => String(r[dataGrain]));
  const cmpRows = grainOf(cmpSeries.data?.rows ?? []) === dataGrain ? cmpSeries.data!.rows : [];
  // Anomalies (daily) placed on whichever bucket contains their day; none on the hourly view.
  const marks: ChartMark[] = useMemo(() => {
    if (dataGrain === "hour") return [];
    return (anomalies.data?.anomalies ?? []).flatMap((a) => {
      const index = keys.findIndex((k, i) =>
        dataGrain === "day" ? k === a.day : dataGrain === "week" ? k <= a.day && a.day < (keys[i + 1] ?? addDays(k, 7)) : k.slice(0, 7) === a.day.slice(0, 7),
      );
      return index < 0 ? [] : [{ index, kind: a.kind, text: dataGrain === "day" ? describeAnomaly(a) : `${weekday(a.day)} ${shortDate(a.day)}: ${describeAnomaly(a)}` }];
    });
  }, [anomalies.data, keys, dataGrain]);
  const chartBusy = (!!totals.data && busyOf(totals, cmpTotals)) || (rows.length > 0 && busyOf(series, cmpSeries));

  const onBucket = (i: number) => {
    const k = keys[i];
    if (!k || dataGrain === "hour" || series.isPlaceholderData) return;
    const today = new Date().toISOString().slice(0, 10);
    if (dataGrain === "day") zoomTo(k, k);
    else if (dataGrain === "week") zoomTo(k, [addDays(k, 6), today].sort()[0]);
    else {
      const [y, m] = k.split("-").map(Number);
      zoomTo(k, [new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10), today].sort()[0]);
    }
  };
  const home = `/${globalParams(url)}`;

  return (
    <div>
      <header id="s-overview" className="pagehead" style={{ scrollMarginTop: 120 }}>
        <div className="titles">
          <a className="btn btn-ghost" href={home} onClick={linkHandler(navigate, home)} style={{ paddingLeft: 0, marginBottom: "var(--space-2)", fontSize: 13 }}><ArrowLeft />All sites</a>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
            <h1 style={{ margin: 0 }}><SiteSwitcher variant="title" sites={sites} currentId={site.id} url={url} navigate={navigate} dates={{ from, to, cfrom: cmp.from, cto: cmp.to }} /></h1>
            <a href={`https://${site.domain}`} target="_blank" rel="noopener noreferrer" title={`Open ${site.domain}`} aria-label={`Open ${site.domain}`} style={{ display: "inline-flex", color: "var(--muted)" }}><External size={18} /></a>
            <span className="tag tag-neutral">{site.timezone}</span>
          </div>
          <div className="sub">{site.domain} · {periodText} compared with {cmpText}</div>
        </div>
        <AlertBell siteId={site.id} />
        <div className="livebox" aria-live="polite">
          <span className={rt.data?.visitors5m ? "livedot" : "livedot off"} aria-hidden />
          <b>{rt.data?.visitors5m ?? "–"}</b>
          <span className="muted" style={{ fontSize: 13 }}>visitors now</span>
        </div>
      </header>

      {rt.data?.cappedAt && (
        <div className="callout cap-banner">
          <b>Recording paused for today.</b> {site.domain} hit its daily event limit at{" "}
          {new Date(rt.data.cappedAt * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC, so today's numbers stop there. It restarts at midnight UTC, or as soon as an admin raises the limit (Admin → Sites → Settings).
        </div>
      )}
      {filters.length > 0 && (
        <div className="filters">
          {filters.map(([dim, op, value], i) => {
            const v = Array.isArray(value) ? value.join(", ") : value;
            return (
              <span className="fchip" key={`${dim}-${i}`}>
                <span className="k">{DIMENSION_LABELS[dim]}</span>
                <button className="op" title="Toggle is / is not" onClick={() => setFilters(filters.map((x, j) => (j === i ? [dim, op === "is" ? "is_not" : op === "is_not" ? "is" : op, value] : x)))}>
                  {op === "is" ? "is" : op === "is_not" ? "is not" : "contains"}
                </button>
                <span className="v" title={v}>{op === "contains" ? `“${v}”` : displayValue(dim, v)}</span>
                <button className="x" onClick={() => setFilters(filters.filter((_, j) => j !== i))} aria-label={`Remove ${DIMENSION_LABELS[dim]} filter`}><Close /></button>
              </span>
            );
          })}
          {filters.length > 1 && <button className="btn btn-ghost btn-chip" onClick={() => setFilters([])}>Clear all</button>}
        </div>
      )}

      <Busy busy={chartBusy}>
      <div className="cells tiles-row" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 136px), 1fr))" }}>
        {TILES.map((m) => (
          <button key={m} className={state.metric === m ? "cell-btn metric-tile on" : "cell-btn metric-tile"} onClick={() => set({ m: m === "visitors" ? null : m }, { replace: true, keepScroll: true })} aria-pressed={state.metric === m}>
            <span className="kpi-label">{TILE_LABELS[m] ?? METRIC_LABELS[m]}</span>
            <span className="v">{totals.data ? metricValue(m, t[m] as number) : <Spinner size={18} />}</span>
            <span style={{ fontSize: 12 }}>
              {!tilesStale && <Delta metric={m} current={Number(t[m] ?? 0)} previous={p ? Number(p[m] ?? 0) : undefined} />}{" "}
              {p && !tilesStale && <span className="muted" style={{ whiteSpace: "nowrap" }}>from {metricValue(m, p[m] as number)}</span>}
            </span>
          </button>
        ))}
      </div>
      <div className="chart-box joined">
        <div className="legend">
          <span className="ttl">{METRIC_LABELS[state.metric]}</span>
          <span className="k"><span className="line" />{periodText}</span>
          <span className="k"><span className="dash" />{cmpText[0].toUpperCase() + cmpText.slice(1)}</span>
          <span style={{ marginLeft: "auto" }} />
          <Seg<TimeGrain>
            value={grain}
            options={(["hour", "day", "week", "month"] as TimeGrain[]).filter((g) => allowed.includes(g)).map((g) => ({ id: g, label: g === "hour" ? "Hourly" : g === "day" ? "Daily" : g === "week" ? "Weekly" : "Monthly" }))}
            onChange={(g) => set({ g: g === auto ? null : g }, { replace: true, keepScroll: true })}
          />
        </div>
        {rows.length > 0 ? (
          <LineChart keys={keys} current={rows.map((r) => Number(r[state.metric] ?? 0))} compareKeys={cmpRows.map((r) => String(r[dataGrain]))} compare={cmpRows.map((r) => Number(r[state.metric] ?? 0))} metric={state.metric} grain={dataGrain} onSelect={dataGrain === "hour" ? undefined : onBucket} marks={marks} />
        ) : (
          <ChartPlaceholder busy={busyOf(series)} error={series.error as Error | null} />
        )}
      </div>
      </Busy>

      <section id="s-realtime" className="section">
        <div className="section-head"><h3>Realtime</h3><span className="muted">Visitors active in the last 5 minutes · <UpdatedAgo at={rt.dataUpdatedAt} /></span></div>
        <div className="rt-grid">
          <div className="wide">
            <WorldMap data={(rt.data?.countries ?? []).map((x) => ({ code: x.name, visitors: x.visitors }))} caption="Live visitors by country · last 30 minutes" onPick={(code) => addFilter(["country", "is", code])} />
            <MinuteBars values={rt.data?.perMinute ?? new Array(30).fill(0)} height={64} />
            <div className="axis-row"><span>Visitors per minute · 30 min ago</span><span>now</span></div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)", minWidth: 0 }}>
            <LiveList title="Active pages" rows={(rt.data?.pages ?? []).map((x) => ({ name: x.path, val: x.visitors }))} accent dim="page" c={c} />
            <LiveList title="Arriving from" rows={(rt.data?.sources ?? []).map((x) => ({ name: x.name, val: x.visitors }))} dim="source" c={c} />
          </div>
        </div>
      </section>

      <SourcesSection c={c} />
      <SearchSection c={c} />
      <PagesSection c={c} />
      <CampaignsSection c={c} />
      <EventsSection c={c} />
      <DevicesSection c={c} />
      <GeoSection c={c} />
      <HeatmapSection c={c} />
      <SpeedSection c={c} admin={admin} />
      {span > 1 && span <= 120 && <DaysSection c={c} onDay={(d) => zoomTo(d, d)} />}
    </div>
  );
}

/** Per-user, per-site switch for anomaly emails. */
function AlertBell({ siteId }: { siteId: number }) {
  const alerts = useAlerts();
  const qc = useQueryClient();
  const all = alerts.data?.all ?? false;
  const on = all || (alerts.data?.sites.includes(siteId) ?? false);
  const toggle = useMutation({
    mutationFn: (next: boolean) => api(`/sites/${siteId}/alerts`, { method: "PUT", body: JSON.stringify({ on: next }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }),
  });
  if (!alerts.data) return null;
  const title = all
    ? "You get alerts for every site. Change this in Admin → Alerts."
    : on
    ? "You'll get an email when this site has an unusual day. Click to stop."
    : alerts.data.email
      ? "Email me when this site has an unusual day (a spike, a drop or a possible outage)"
      : "Email me about unusual days (email isn't set up on this server yet, so nothing will be sent until it is)";
  return (
    <button className={on ? "btn btn-secondary bell on" : "btn btn-secondary bell"} onClick={() => toggle.mutate(!on)} disabled={toggle.isPending || all} aria-pressed={on} title={title}>
      {on ? <Bell /> : <BellOff />}
      <span style={{ fontSize: 13, fontWeight: 600 }}>{on ? "Alerts on" : "Alerts off"}</span>
    </button>
  );
}

function LiveList({ title, rows, accent, dim, c }: { title: string; rows: { name: string; val: number }[]; accent?: boolean; dim: Dimension; c: Ctx }) {
  const max = Math.max(1, ...rows.map((r) => r.val));
  return (
    <div>
      <h6 style={{ marginBottom: "var(--space-2)" }}>{title}</h6>
      {rows.length === 0 && <div className="muted" style={{ fontSize: 13, padding: "6px 0" }}>Nobody right now</div>}
      {rows.map((r) => (
        <div key={r.name} className="barrow clickable" style={{ fontSize: 13, padding: "6px 0" }} onClick={() => c.addFilter([dim, "is", r.name])}>
          <div className={accent ? "fill accent" : "fill"} style={{ top: 3, bottom: 3, width: `${(r.val / max) * 100}%` }} />
          <span style={{ display: "flex", gap: 6, alignItems: "center" }}><span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{displayValue(dim, r.name)}</span><OpenLink dim={dim} value={r.name} domain={c.domain} /></span>
          <span className="v">{r.val}</span>
        </div>
      ))}
    </div>
  );
}

function SourcesSection({ c }: { c: Ctx }) {
  const [ref, seen] = useInView<HTMLElement>();
  const ch = useBreakdown(c, "channel", ["visitors"], { limit: 20, enabled: seen, compare: true });
  const [refDim, setRefDim] = useState<Dimension>("source");
  const total = ch.rows.reduce((n, r) => n + Number(r.visitors ?? 0), 0) || 1;
  return (
    <section id="s-sources" className="section" ref={ref}>
      <div className="section-head"><h3>Sources &amp; referrers</h3><span className="muted">Where visits started</span></div>
      {!seen ? <div className="placeholder" /> : (
        <>
          <Busy busy={ch.busy} empty={ch.empty}>
          <div className="stack-bar" role="img" aria-label="Visitors by channel">
            {ch.rows.map((r) => {
              const name = String(r.channel ?? "");
              return <div key={name} title={`${name} ${((Number(r.visitors) / total) * 100).toFixed(1)}%`} style={{ width: `${(Number(r.visitors) / total) * 100}%`, background: CHANNEL_COLORS[name] ?? "var(--color-neutral-400)" }} onClick={() => c.addFilter(["channel", "is", name])} />;
            })}
          </div>
          </Busy>
          <div className="twocol" style={{ marginTop: "var(--space-4)" }}>
            <Busy busy={ch.busy} empty={ch.empty} className="table-scroll">
              <table className="table">
                <thead><tr><th>Channel</th><th className="num">Visitors</th><th className="num">Share</th><th className="num">Change</th></tr></thead>
                <tbody>
                  {ch.rows.map((r) => {
                    const name = String(r.channel ?? "");
                    const v = Number(r.visitors ?? 0);
                    return (
                      <tr key={name} className="clickable" onClick={() => c.addFilter(["channel", "is", name])}>
                        <td><span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><span className="swatch-sq" style={{ background: CHANNEL_COLORS[name] ?? "var(--color-neutral-400)" }} />{name || "Unknown"}</span></td>
                        <td className="num strong">{whole(v)}</td>
                        <td className="num">{((v / total) * 100).toFixed(1)}%</td>
                        <ChangeCell metric="visitors" cur={v} prev={ch.prevMap.get(name)} stale={ch.changesStale} />
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!ch.busy && ch.rows.length === 0 && <div className="empty">No data for this period.</div>}
            </Busy>
            <div>
              <div style={{ marginBottom: 8 }}><Seg<Dimension> value={refDim} options={[{ id: "source", label: "Source" }, { id: "referrer", label: "Referrer URL" }]} onChange={setRefDim} /></div>
              <BreakdownTable
                key={refDim}
                c={c}
                dim={refDim}
                metrics={["visitors", "bounce_rate"]}
                columns={[{ label: "Visitors", render: (r) => compact(Number(r.visitors)) }, { label: "Bounce", render: (r) => `${Math.round(Number(r.bounce_rate))}%` }]}
                compare
                enabled
              />
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function PagesSection({ c }: { c: Ctx }) {
  const [tab, setTab] = useState<"page" | "entry_page" | "exit_page">("page");
  const sub = { page: "Most viewed pages", entry_page: "Where visits started", exit_page: "Where visits ended" }[tab];
  return (
    <Section id="s-pages" title="Pages" sub={sub} right={<Seg value={tab} options={[{ id: "page", label: "Top pages" }, { id: "entry_page", label: "Entry" }, { id: "exit_page", label: "Exit" }]} onChange={setTab} />}>
      {(visible) =>
        tab === "page" ? (
          <BreakdownTable key="p" c={c} dim="page" mono enabled={visible} limit={12} metrics={["pageviews", "visitors", "time_on_page", "scroll_depth"]}
            columns={[{ label: "Pageviews", render: (r) => compact(Number(r.pageviews)) }, { label: "Unique", render: (r) => compact(Number(r.visitors)) }, { label: "Avg. time", render: (r) => duration(Number(r.time_on_page)) }, { label: "Scroll", render: (r) => (Number(r.scroll_depth) ? `${Math.round(Number(r.scroll_depth))}%` : "–") }]} />
        ) : tab === "entry_page" ? (
          <BreakdownTable key="e" c={c} dim="entry_page" mono enabled={visible} limit={12} metrics={["visits", "visitors", "bounce_rate", "visit_duration"]}
            columns={[{ label: "Entries", render: (r) => compact(Number(r.visits)) }, { label: "Visitors", render: (r) => compact(Number(r.visitors)) }, { label: "Bounce", render: (r) => `${Math.round(Number(r.bounce_rate))}%` }, { label: "Avg. visit", render: (r) => duration(Number(r.visit_duration)) }]} />
        ) : (
          <BreakdownTable key="x" c={c} dim="exit_page" mono enabled={visible} limit={12} metrics={["visits", "visitors", "visit_duration"]}
            columns={[{ label: "Exits", render: (r) => compact(Number(r.visits)) }, { label: "Visitors", render: (r) => compact(Number(r.visitors)) }, { label: "Avg. visit", render: (r) => duration(Number(r.visit_duration)) }]} />
        )
      }
    </Section>
  );
}

function CampaignsSection({ c }: { c: Ctx }) {
  const [dim, setDim] = useState<Dimension>("utm_campaign");
  return (
    <Section id="s-campaigns" title="Campaigns" sub="UTM-tagged traffic"
      right={<Seg<Dimension> value={dim} options={[{ id: "utm_campaign", label: "Campaign" }, { id: "utm_source", label: "Source" }, { id: "utm_medium", label: "Medium" }, { id: "utm_content", label: "Content" }, { id: "utm_term", label: "Term" }]} onChange={setDim} />}>
      {(visible) => (
        <BreakdownTable key={dim} c={{ ...c, filters: [...c.filters.filter((f) => f[0] !== dim), [dim, "is_not", ""]] }} dim={dim} enabled={visible} compare metrics={["visitors", "visits", "bounce_rate", "visit_duration"]}
          empty="No UTM-tagged visits in this period."
          columns={[{ label: "Visitors", render: (r) => compact(Number(r.visitors)) }, { label: "Visits", render: (r) => compact(Number(r.visits)) }, { label: "Bounce", render: (r) => `${Math.round(Number(r.bounce_rate))}%` }, { label: "Avg. visit", render: (r) => duration(Number(r.visit_duration)) }]} />
      )}
    </Section>
  );
}

function EventsSection({ c }: { c: Ctx }) {
  return (
    <Section id="s-events" title="Events" sub="Custom and automatic events">
      {(visible) => (
        <BreakdownTable c={c} dim="event" mono enabled={visible} compare limit={12} metrics={["events", "visitors"]}
          empty='No events in this period. Send them with qwa("Name") or a qwa-event-name class.'
          prefix={(v) => <span className={AUTO_EVENTS.has(v) ? "tag tag-neutral" : "tag tag-accent"} style={{ order: 2 }}>{AUTO_EVENTS.has(v) ? "Auto" : "Custom"}</span>}
          columns={[{ label: "Total", render: (r) => compact(Number(r.events)) }, { label: "Unique visitors", render: (r) => compact(Number(r.visitors)) }, { label: "Per visitor", render: (r) => (Number(r.visitors) ? (Number(r.events) / Number(r.visitors)).toFixed(2) : "–") }]} />
      )}
    </Section>
  );
}

function TechCell({ c, dim, title, enabled }: { c: Ctx; dim: Dimension; title: string; enabled: boolean }) {
  const b = useBreakdown(c, dim, ["visitors"], { limit: 6, enabled });
  const total = b.rows.reduce((n, r) => n + Number(r.visitors ?? 0), 0) || 1;
  const max = Math.max(1, ...b.rows.map((r) => Number(r.visitors ?? 0)));
  return (
    <div className="cell">
      <h6 style={{ marginBottom: "var(--space-3)" }}>{title}</h6>
      <Busy busy={b.busy} empty={b.empty} minHeight={120}>
      {b.rows.map((r, i) => {
        const v = Number(r.visitors ?? 0);
        const name = String(r[dim] ?? "");
        return (
          <div key={name} className="techrow" onClick={() => c.addFilter([dim, "is", name])} title={`Filter: ${DIMENSION_LABELS[dim]} is ${displayValue(dim, name)}`}>
            <div className="t"><span className="nmv">{displayValue(dim, name)}</span><span className="muted" style={{ marginLeft: "auto" }}>{compact(v)}</span><span style={{ fontWeight: 700, width: 48, textAlign: "right" }}>{((v / total) * 100).toFixed(0)}%</span></div>
            <div className="track"><div style={{ width: `${(v / max) * 100}%`, background: i === 0 ? "var(--color-accent)" : "var(--color-text)" }} /></div>
          </div>
        );
      })}
      {!b.busy && b.rows.length === 0 && <div className="muted" style={{ fontSize: 13 }}>No data</div>}
      </Busy>
    </div>
  );
}

function DevicesSection({ c }: { c: Ctx }) {
  return (
    <Section id="s-devices" title="Devices, browsers & OS">
      {(visible) => (
        <div className="cells" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))" }}>
          <TechCell c={c} dim="device" title="Device" enabled={visible} />
          <TechCell c={c} dim="browser" title="Browser" enabled={visible} />
          <TechCell c={c} dim="os" title="Operating system" enabled={visible} />
          <TechCell c={c} dim="os_version" title="OS version" enabled={visible} />
        </div>
      )}
    </Section>
  );
}

function GeoSection({ c }: { c: Ctx }) {
  const [ref, seen] = useInView<HTMLElement>();
  const countries = useBreakdown(c, "country", ["visitors"], { limit: 300, enabled: seen });
  return (
    <section id="s-geo" className="section" ref={ref}>
      <div className="section-head"><h3>Geography</h3><span className="muted">{countries.rows.length ? `${countries.rows.length} countries` : ""}</span></div>
      {!seen ? <div className="placeholder" /> : (
        <>
          <Busy busy={countries.busy} style={{ marginBottom: "var(--space-6)" }}>
            <WorldMap data={countries.rows.map((r) => ({ code: String(r.country ?? ""), visitors: Number(r.visitors ?? 0) }))} caption="Visitors by country · selected period" onPick={(code) => c.addFilter(["country", "is", code])} />
          </Busy>
          <div className="twocol">
            <BreakdownTable c={c} dim="country" enabled compare metrics={["visitors"]} limit={12}
              prefix={(v) => <span className="muted mono" style={{ fontSize: 12, width: 22, flex: "none" }}>{v || "–"}</span>}
              columns={[{ label: "Visitors", render: (r) => compact(Number(r.visitors)) }]} />
            <BreakdownTable c={c} dim="city" enabled metrics={["visitors", "visit_duration"]} limit={12}
              columns={[{ label: "Visitors", render: (r) => compact(Number(r.visitors)) }, { label: "Avg. visit", render: (r) => duration(Number(r.visit_duration)) }]} />
          </div>
        </>
      )}
    </section>
  );
}

/** The time grain a series result was fetched with (its rows carry that column). */
function grainOf(rows: Row[]): TimeGrain | undefined {
  return (["hour", "day", "week", "month"] as TimeGrain[]).find((g) => rows[0] && g in rows[0]);
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function HeatmapSection({ c }: { c: Ctx }) {
  const [ref, seen] = useInView<HTMLElement>();
  const q = useStats(c.siteId, { from: c.from, to: c.to, metrics: ["visitors"], groupBy: "weekhour", filters: c.filters }, seen);
  // Average per occurrence of each weekday in the range.
  const occurrences = useMemo(() => {
    const n = new Array(7).fill(0);
    for (let d = c.from; d <= c.to; d = addDays(d, 1)) n[(new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7]++;
    return n;
  }, [c.from, c.to]);
  const grid = useMemo(() => {
    const g = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const r of q.data?.rows ?? []) {
      const k = Number(r.weekhour);
      const day = Math.floor(k / 24);
      if (day >= 0 && day < 7) g[day][k % 24] = Number(r.visitors ?? 0) / Math.max(1, occurrences[day]);
    }
    return g;
  }, [q.data, occurrences]);
  const max = Math.max(0, ...grid.flat());
  let peak = "–";
  if (max > 0) {
    const flat = grid.flat();
    const i = flat.indexOf(max);
    peak = `${DAYS[Math.floor(i / 24)]} ${String(i % 24).padStart(2, "0")}:00`;
  }
  return (
    <section id="s-heatmap" className="section" ref={ref}>
      <div className="section-head"><h3>Hourly heatmap</h3><span className="muted">Average visitors by weekday and hour (site local time) · peak {peak}</span></div>
      {!seen ? <div className="placeholder" /> : q.error ? <p className="error">{(q.error as Error).message}</p> : (
        <>
          <Busy busy={busyOf(q)} className="table-scroll">
            <div className="heat">
              <span />
              {Array.from({ length: 24 }, (_, h) => <span key={h} className="muted" style={{ textAlign: "center" }}>{h % 3 === 0 ? String(h).padStart(2, "0") : ""}</span>)}
              {grid.map((row, d) => [
                <span key={`d${d}`} style={{ fontWeight: 600, alignSelf: "center" }}>{DAYS[d]}</span>,
                ...row.map((v, h) => (
                  <span key={`${d}-${h}`} className="c" title={`${DAYS[d]} ${String(h).padStart(2, "0")}:00 · ${v < 10 ? v.toFixed(1) : Math.round(v)} visitors on average`}
                    style={{ background: `color-mix(in srgb, var(--color-accent) ${max ? (4 + (v / max) * 96).toFixed(0) : 4}%, var(--color-bg))` }} />
                )),
              ])}
            </div>
          </Busy>
          <div className="heat-legend"><span>Fewer</span><span style={{ width: 120, height: 8, background: "linear-gradient(90deg, color-mix(in srgb, var(--color-accent) 4%, var(--color-bg)), var(--color-accent))" }} /><span>More</span></div>
        </>
      )}
    </section>
  );
}

const DAY_METRICS: Metric[] = ["visitors", "visits", "pageviews", "bounce_rate", "visit_duration", "events"];

function DaysSection({ c, onDay }: { c: Ctx; onDay: (d: string) => void }) {
  const [ref, seen] = useInView<HTMLElement>();
  const q = useStats(c.siteId, { from: addDays(c.from, -7), to: c.to, metrics: DAY_METRICS, groupBy: "day", filters: c.filters }, seen);
  const days = useMemo(() => {
    const all = q.data?.rows ?? [];
    const by = new Map(all.map((r) => [String(r.day), r]));
    const shown = all.filter((r) => String(r.day) >= c.from);
    const max = Math.max(1, ...shown.map((r) => Number(r.visitors ?? 0)));
    return shown.map((r) => ({ r, prev: by.get(addDays(String(r.day), -1)), week: by.get(addDays(String(r.day), -7)), w: Number(r.visitors ?? 0) / max })).reverse();
  }, [q.data, c.from]);
  return (
    <section id="s-days" className="section" ref={ref}>
      <div className="section-head"><h3>Day by day</h3><span className="muted">Click a day to focus on it · change vs the day before and the same day last week</span></div>
      {!seen ? <div className="placeholder" /> : (
        <Busy busy={busyOf(q)} empty={days.length === 0} className="table-scroll">
          <table className="table" style={{ minWidth: 820 }}>
            <thead><tr><th>Day</th><th className="num">Visitors</th><th className="num">vs day before</th><th className="num">vs last week</th>{DAY_METRICS.slice(1).map((m) => <th key={m} className="num">{METRIC_LABELS[m]}</th>)}</tr></thead>
            <tbody>
              {days.map(({ r, prev, week, w }) => {
                const d = String(r.day);
                return (
                  <tr key={d} className="clickable" onClick={() => onDay(d)} title={`Focus on ${d}`}>
                    <td className="incell" style={{ width: "28%" }}>
                      <div className="fill" style={{ width: `${w * 100}%` }} />
                      <div className="inner"><span style={{ fontWeight: isWeekend(d) ? 400 : 600 }}>{weekday(d)} {shortDate(d)}</span></div>
                    </td>
                    <td className="num strong">{whole(Number(r.visitors))}</td>
                    <td className="num">{prev ? <Delta metric="visitors" current={Number(r.visitors)} previous={Number(prev.visitors)} /> : <span className="muted">–</span>}</td>
                    <td className="num">{week ? <Delta metric="visitors" current={Number(r.visitors)} previous={Number(week.visitors)} /> : <span className="muted">–</span>}</td>
                    {DAY_METRICS.slice(1).map((m) => <td key={m} className="num">{metricValue(m, r[m] as number)}</td>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Busy>
      )}
    </section>
  );
}

function ChartPlaceholder({ busy, error }: { busy: boolean; error: Error | null }) {
  return (
    <div className="busy-block" style={{ height: 348 }}>
      {busy ? <><Spinner size={16} /><BusyLabel /></> : error ? <span className="error">{error.message}</span> : "No data for this period."}
    </div>
  );
}

/** "Loading chart… 4s", counting while mounted. */
function BusyLabel() {
  const [secs, setSecs] = useState(0);
  useEffect(() => { const t = setInterval(() => setSecs((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  return <span>{secs < 2 ? "Loading chart…" : secs < 5 ? `Loading chart… ${secs}s` : `Still working… ${secs}s · long ranges on busy sites take a while`}</span>;
}
