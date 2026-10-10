// The overview's drill-down: click a totals card to see what's behind it. A large chart of the metric across all
// sites (click a day or week to narrow everything to it), then sortable, searchable tables by site and by the
// breakdowns that explain that metric (events by name, pages, sources…).
import { useEffect, useMemo, useRef, useState } from "react";
import type { Dimension, Filter, Metric, TimeGrain } from "@qwa/shared";
import { useCrossBreakdown, type DayStats, type OverviewSite } from "../api";
import { Busy, busyOf, Delta, deltaInfo, Spark } from "../components/Bits";
import { Close, Search } from "../components/Icons";
import { LineChart } from "../components/LineChart";
import { Seg } from "../components/Section";
import { addDays, daysBetween, shortDate } from "../dates";
import { DIMENSION_LABELS, displayValue, duration, METRIC_LABELS, metricValue, whole } from "../format";
import { globalParams, withParams, type Navigate } from "../url";

export const DRILL_METRICS = ["visitors", "pageviews", "visit_duration", "bounce_rate", "events"] as const;
export type DrillMetric = (typeof DRILL_METRICS)[number];

type Day = Omit<DayStats, "day">;
const ZERO: Day = { visitors: 0, visits: 0, pageviews: 0, events: 0, bounces: 0, duration_sum: 0 };
const add = (a: Day, b: Day): Day => ({
  visitors: a.visitors + b.visitors, visits: a.visits + b.visits, pageviews: a.pageviews + b.pageviews,
  events: a.events + b.events, bounces: a.bounces + b.bounces, duration_sum: a.duration_sum + b.duration_sum,
});
const isRate = (m: DrillMetric) => m === "visit_duration" || m === "bounce_rate";

/** The metric's value for summed daily figures (rates weighted by visits). */
function valueOf(m: DrillMetric, d: Day): number {
  if (m === "visit_duration") return d.visits ? d.duration_sum / d.visits : 0;
  if (m === "bounce_rate") return d.visits ? (d.bounces / d.visits) * 100 : 0;
  return d[m];
}

/** "+1,204", "−12s", "+3.1 pts". */
function difference(m: DrillMetric, v: number): string {
  const sign = v > 0 ? "+" : v < 0 ? "−" : "±";
  const a = Math.abs(v);
  if (m === "visit_duration") return `${sign}${duration(a)}`;
  if (m === "bounce_rate") return `${sign}${a.toFixed(1)} pts`;
  return `${sign}${whole(a)}`;
}

interface Tab { id: string; label: string; dim?: Dimension; metrics?: Metric[] }
const SITES: Tab = { id: "sites", label: "Sites" };
const TABS: Record<DrillMetric, Tab[]> = {
  visitors: [SITES, { id: "source", label: "Sources", dim: "source", metrics: ["visitors"] }, { id: "page", label: "Pages", dim: "page", metrics: ["visitors", "pageviews"] }, { id: "country", label: "Countries", dim: "country", metrics: ["visitors"] }],
  pageviews: [SITES, { id: "page", label: "Pages", dim: "page", metrics: ["pageviews", "visitors"] }, { id: "source", label: "Sources", dim: "source", metrics: ["pageviews", "visitors"] }],
  visit_duration: [SITES, { id: "source", label: "Sources", dim: "source", metrics: ["visit_duration", "visits"] }, { id: "entry", label: "Entry pages", dim: "entry_page", metrics: ["visit_duration", "visits"] }],
  bounce_rate: [SITES, { id: "source", label: "Sources", dim: "source", metrics: ["bounce_rate", "visits"] }, { id: "entry", label: "Entry pages", dim: "entry_page", metrics: ["bounce_rate", "visits"] }],
  events: [SITES, { id: "event", label: "Events", dim: "event", metrics: ["events", "visitors"] }],
};
/** Dimensions where the same value means the same thing on every site, so rows can be combined across sites. */
const COMBINABLE = new Set<Dimension>(["event", "source", "country"]);

/** One table row, whatever the tab. */
interface Row {
  id: string;
  name: string;
  /** For dimension tabs: the site it's on (undefined when combined across sites). */
  site?: OverviewSite;
  sites?: number;
  value: number;
  previous: number;
  /** The second column (e.g. unique visitors for events, visits for rates). */
  extra?: number;
  spark?: { cur: number[]; prev: number[] };
}

type SortKey = "name" | "site" | "value" | "previous" | "change" | "diff" | "extra";
const PAGE = 50;

export function Drill({ metric, sites, dates, periodText, cmpText, url, navigate, onClose }: {
  metric: DrillMetric;
  sites: OverviewSite[];
  dates: { from: string; to: string; cfrom: string; cto: string };
  periodText: string;
  cmpText: string;
  url: URL;
  navigate: Navigate;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), [metric]);
  const [tabId, setTabId] = useState("sites");
  const tabs = TABS[metric];
  const tab = tabs.find((t) => t.id === tabId) ?? SITES;
  const [focus, setFocus] = useState<number | null>(null);
  useEffect(() => setFocus(null), [metric, dates.from, dates.to, dates.cfrom, dates.cto]);

  // The chart: every site's days summed, by day (or by week for long ranges), today included.
  const span = daysBetween(dates.from, dates.to);
  const grain: TimeGrain = span > 120 ? "week" : "day";
  const step = grain === "week" ? 7 : 1;
  // Weeks are counted back from the end of the range, so every point is a whole week; a few days left over at the start
  // are left off the chart (they'd look like a dip). The tables still cover the whole range.
  const buckets = useMemo(() => {
    const out: { from: string; to: string; cfrom: string; cto: string }[] = [];
    for (let end = span - 1; end - step + 1 >= 0; end -= step) {
      const start = end - step + 1;
      out.unshift({ from: addDays(dates.from, start), to: addDays(dates.from, end), cfrom: addDays(dates.cfrom, start), cto: [addDays(dates.cfrom, end), dates.cto].sort()[0] });
    }
    return out;
  }, [dates.from, dates.cfrom, dates.cto, span, step]);
  const sum = (list: DayStats[], from: string, to: string) => list.reduce((t, d) => (d.day >= from && d.day <= to ? add(t, d) : t), ZERO);
  const chart = useMemo(() => {
    const cur = buckets.map((b) => sites.reduce((t, s) => add(t, sum(s.current, b.from, b.to)), ZERO));
    const prev = buckets.filter((b) => b.cfrom <= dates.cto).map((b) => sites.reduce((t, s) => add(t, sum(s.comparison, b.cfrom, b.cto)), ZERO));
    return { cur: cur.map((d) => valueOf(metric, d)), prev: prev.map((d) => valueOf(metric, d)) };
  }, [buckets, sites, metric, dates.cto]);

  // The period the tables show: the whole range, or the bucket clicked on the chart (against the same bucket before).
  const range = focus !== null && buckets[focus] ? buckets[focus] : dates;
  const totals = useMemo(() => {
    const cur = sites.reduce((t, s) => add(t, sum(s.current, range.from, range.to)), ZERO);
    const prev = sites.reduce((t, s) => add(t, sum(s.comparison, range.cfrom, range.cto)), ZERO);
    return { cur: valueOf(metric, cur), prev: valueOf(metric, prev) };
  }, [sites, metric, range.from, range.to, range.cfrom, range.cto]);

  const label = metric === "visit_duration" ? "Avg. visit" : METRIC_LABELS[metric];
  const fmt = (v: number) => metricValue(metric, v);
  const rangeText = focus !== null
    ? `${range.from === range.to ? shortDate(range.from) : `${shortDate(range.from)} – ${shortDate(range.to)}`} compared with ${range.cfrom === range.cto ? shortDate(range.cfrom) : `${shortDate(range.cfrom)} – ${shortDate(range.cto)}`}`
    : `${periodText} compared with ${cmpText}`;

  return (
    <section ref={ref} className="cell drill" aria-label={`${label} across all sites`} style={{ scrollMarginTop: 120 }}>
      <div className="drill-head">
        <div>
          <div className="kicker">All sites</div>
          <h3 style={{ margin: 0 }}>{label}</h3>
          <div className="muted" style={{ fontSize: 13 }}>{rangeText}</div>
        </div>
        <div className="drill-total">
          <span className="kpi-value">{fmt(totals.cur)}</span>
          <Delta metric={metric} current={totals.cur} previous={totals.prev} />
          <span className="muted" style={{ fontSize: 12 }}>from {fmt(totals.prev)}</span>
        </div>
        <button className="btn btn-secondary btn-icon drill-close" onClick={onClose} aria-label="Close"><Close /></button>
      </div>

      <div className="chart-box joined" style={{ marginTop: "var(--space-4)" }}>
        <LineChart
          keys={buckets.map((b) => b.from)}
          current={chart.cur}
          compareKeys={buckets.slice(0, chart.prev.length).map((b) => b.cfrom)}
          compare={chart.prev}
          metric={metric}
          grain={grain}
          height={220}
          onSelect={(i) => setFocus(i === focus ? null : i)}
        />
      </div>
      <div className="drill-bar">
        <Seg value={tab.id} options={tabs.map((t) => ({ id: t.id, label: t.label }))} onChange={setTabId} />
        {focus !== null ? (
          <button className="fchip" onClick={() => setFocus(null)} title="Show the whole period again">
            <span className="k" style={{ paddingRight: 6 }}>{grain === "week" ? "Week" : "Day"}</span>
            <span className="v">{range.from === range.to ? shortDate(range.from) : `${shortDate(range.from)} – ${shortDate(range.to)}`}</span>
            <span className="x"><Close /></span>
          </button>
        ) : (
          <span className="muted" style={{ fontSize: 12 }}>Click a {grain} on the chart to see what was behind it</span>
        )}
      </div>

      {tab.id === "sites"
        ? <SitesTable metric={metric} sites={sites} range={range} chartRange={dates} url={url} navigate={navigate} focus={focus !== null} />
        : <DimTable key={tab.id} metric={metric} tab={tab} sites={sites} range={range} url={url} navigate={navigate} focus={focus !== null} />}
    </section>
  );
}

type Range = { from: string; to: string; cfrom: string; cto: string };

/** Open a site's page for this period, optionally filtered to one value and showing this metric. */
function siteHref(url: URL, siteId: number, metric: DrillMetric, range: Range, focused: boolean, filter?: Filter): string {
  const base = new URL(`/s/${siteId}${globalParams(url)}`, location.origin);
  return withParams(base, {
    m: metric === "visitors" ? null : metric,
    f: filter ? JSON.stringify([filter]) : null,
    ...(focused ? { range: null, from: range.from, to: range.to } : {}),
  });
}

function SitesTable({ metric, sites, range, chartRange, url, navigate, focus }: {
  metric: DrillMetric; sites: OverviewSite[]; range: Range; chartRange: Range; url: URL; navigate: Navigate; focus: boolean;
}) {
  const rows = useMemo<Row[]>(() => sites.map((s) => {
    const within = (list: DayStats[], from: string, to: string) => list.filter((d) => d.day >= from && d.day <= to);
    const cur = within(s.current, range.from, range.to).reduce(add, ZERO);
    const prev = within(s.comparison, range.cfrom, range.cto).reduce(add, ZERO);
    return {
      id: String(s.id), name: s.domain, site: s,
      value: valueOf(metric, cur), previous: valueOf(metric, prev), extra: cur.visits,
      spark: {
        cur: within(s.current, chartRange.from, chartRange.to).map((d) => (isRate(metric) && !d.visits ? NaN : valueOf(metric, d))),
        prev: within(s.comparison, chartRange.cfrom, chartRange.cto).map((d) => (isRate(metric) && !d.visits ? NaN : valueOf(metric, d))),
      },
    };
  }), [sites, metric, range.from, range.to, range.cfrom, range.cto, chartRange.from, chartRange.to, chartRange.cfrom, chartRange.cto]);
  return (
    <DrillTable
      metric={metric} rows={rows} nameLabel="Site" extraLabel={isRate(metric) ? "Visits" : undefined} showSite={false} trend
      onRow={(r) => navigate(siteHref(url, r.site!.id, metric, range, focus))}
    />
  );
}

function DimTable({ metric, tab, sites, range, url, navigate, focus }: {
  metric: DrillMetric; tab: Tab; sites: OverviewSite[]; range: Range; url: URL; navigate: Navigate; focus: boolean;
}) {
  const dim = tab.dim!;
  const q = useCrossBreakdown({ ...range, metrics: tab.metrics!, groupBy: dim, limit: 100 }, true);
  const [siteFilter, setSiteFilter] = useState<number | "all">("all");
  const canCombine = COMBINABLE.has(dim) && !isRate(metric);
  const [combine, setCombine] = useState(false);
  const byId = useMemo(() => new Map(sites.map((s) => [s.id, s])), [sites]);
  const extraMetric = tab.metrics![1];

  const rows = useMemo<Row[]>(() => {
    const list = (q.data?.rows ?? []).filter((r) => byId.has(r.site) && (siteFilter === "all" || r.site === siteFilter));
    if (combine && canCombine) {
      const m = new Map<string, Row>();
      for (const r of list) {
        const x = m.get(r.key) ?? { id: r.key, name: r.key, sites: 0, value: 0, previous: 0, extra: 0 };
        x.value += r.values[tab.metrics![0]] ?? 0;
        x.previous += r.previous;
        x.extra! += r.values[extraMetric] ?? 0;
        x.sites! += 1;
        m.set(r.key, x);
      }
      return [...m.values()];
    }
    return list.map((r) => ({
      id: `${r.site}|${r.key}`, name: r.key, site: byId.get(r.site),
      value: r.values[tab.metrics![0]] ?? 0, previous: r.previous, extra: r.values[extraMetric],
    }));
  }, [q.data, byId, siteFilter, combine, canCombine, tab.metrics, extraMetric]);

  const truncated = (q.data?.truncated ?? []).filter((id) => siteFilter === "all" || id === siteFilter);
  return (
    <>
      <div className="drill-tools">
        <select className="input" value={siteFilter} onChange={(e) => setSiteFilter(e.target.value === "all" ? "all" : Number(e.target.value))} aria-label="Site">
          <option value="all">All sites</option>
          {[...sites].sort((a, b) => a.domain.localeCompare(b.domain)).map((s) => <option key={s.id} value={s.id}>{s.domain}</option>)}
        </select>
        {canCombine && siteFilter === "all" && (
          <label className="check"><input type="checkbox" checked={combine} onChange={(e) => setCombine(e.target.checked)} /> Combine sites</label>
        )}
      </div>
      {q.error ? <p className="error">{(q.error as Error).message}</p> : (
        <Busy busy={busyOf(q)} empty={!q.data}>
          <DrillTable
            metric={metric} rows={rows} nameLabel={DIMENSION_LABELS[dim]} dim={dim} extraLabel={extraMetric ? METRIC_LABELS[extraMetric] : undefined}
            showSite={!(combine && canCombine)}
            onRow={(r) => r.site && navigate(siteHref(url, r.site.id, metric, range, focus, [dim, "is", r.name]))}
          />
        </Busy>
      )}
      {(truncated.length > 0 || (q.data?.failed.length ?? 0) > 0) && (
        <div className="muted" style={{ fontSize: 12, marginTop: "var(--space-2)" }}>
          {truncated.length > 0 && `Showing the top ${q.data!.limit} per site for ${truncated.map((id) => byId.get(id)?.domain).filter(Boolean).join(", ")}. `}
          {(q.data?.failed.length ?? 0) > 0 && `Couldn't load ${q.data!.failed.join(", ")}.`}
        </div>
      )}
    </>
  );
}

/** Sortable, searchable table of rows with current, previous, change and difference. */
function DrillTable({ metric, rows, nameLabel, dim, extraLabel, showSite, trend, onRow }: {
  metric: DrillMetric; rows: Row[]; nameLabel: string; dim?: Dimension; extraLabel?: string; showSite: boolean; trend?: boolean; onRow: (r: Row) => void;
}) {
  const [term, setTerm] = useState("");
  // Counts: biggest movers first, in the direction the total moved. Rates: busiest first.
  const total = rows.reduce((n, r) => n + r.value - r.previous, 0);
  // Until a header is clicked, the default follows the data (it isn't known until the rows arrive).
  const [chosen, setSort] = useState<{ key: SortKey; desc: boolean } | null>(null);
  const sort = chosen ?? (isRate(metric) ? { key: "extra" as const, desc: true } : { key: "diff" as const, desc: total >= 0 });
  const [shown, setShown] = useState(PAGE);
  const fmt = (v: number) => metricValue(metric, v, { compact: true });
  const name = (r: Row) => (dim ? displayValue(dim, r.name) : r.name) || "(none)";

  const list = useMemo(() => {
    const t = term.trim().toLowerCase();
    const filtered = t ? rows.filter((r) => name(r).toLowerCase().includes(t) || r.name.toLowerCase().includes(t) || r.site?.domain.includes(t)) : rows;
    const val = (r: Row): number | string => {
      switch (sort.key) {
        case "name": return name(r).toLowerCase();
        case "site": return r.site?.domain ?? "";
        case "value": return r.value;
        case "previous": return r.previous;
        case "change": return r.previous ? (r.value - r.previous) / r.previous : r.value ? Infinity : 0;
        case "diff": return r.value - r.previous;
        case "extra": return r.extra ?? 0;
      }
    };
    return [...filtered].sort((a, b) => {
      const x = val(a), y = val(b);
      const c = typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number);
      return sort.desc ? -c : c;
    });
  }, [rows, term, sort, dim]);

  const th = (key: SortKey, label: string, num = true) => (
    <th className={num ? "num" : undefined} aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button className="th-sort" onClick={() => setSort({ key, desc: sort.key === key ? !sort.desc : num })}>
        {label}{sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}
      </button>
    </th>
  );

  return (
    <div>
      <div className="search" style={{ maxWidth: 320, margin: "var(--space-3) 0" }}>
        <Search />
        <input className="input" placeholder={`Search ${nameLabel.toLowerCase()}s${showSite ? " or sites" : ""}`} value={term} onChange={(e) => { setTerm(e.target.value); setShown(PAGE); }} aria-label="Search" />
      </div>
      <div className="table-scroll">
        <table className="table" style={{ minWidth: 760 }}>
          <thead>
            <tr>
              {th("name", nameLabel, false)}
              {showSite && dim && th("site", "Site", false)}
              {th("value", metric === "visit_duration" ? "Avg. visit" : METRIC_LABELS[metric])}
              {th("previous", "Before")}
              {th("change", "Change")}
              {th("diff", "Difference")}
              {extraLabel && th("extra", extraLabel)}
              {trend && <th style={{ width: 130 }}>Trend</th>}
            </tr>
          </thead>
          <tbody>
            {list.slice(0, shown).map((r) => (
              <tr key={r.id} className={r.site ? "clickable" : undefined} onClick={() => onRow(r)} title={r.site ? `Open ${r.site.domain}${dim ? ` filtered to ${name(r)}` : ""}` : undefined}>
                <td className={dim === "page" || dim === "entry_page" || dim === "event" ? "mono" : undefined} style={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: dim ? 400 : 700 }}>{name(r)}</td>
                {showSite && dim && <td className="muted">{r.site?.domain ?? (r.sites ? `${r.sites} sites` : "")}</td>}
                <td className="num strong">{fmt(r.value)}</td>
                <td className="num muted">{fmt(r.previous)}</td>
                <td className="num"><Delta metric={metric} current={r.value} previous={r.previous} /></td>
                <td className="num"><span className={diffClass(metric, r.value - r.previous)}>{difference(metric, r.value - r.previous)}</span></td>
                {extraLabel && <td className="num">{whole(r.extra ?? 0)}</td>}
                {trend && r.spark && (
                  <td><Spark current={r.spark.cur} comparison={r.spark.prev} growing={deltaInfo(metric, r.value, r.previous)?.cls !== "delta bad"} height={24} width={120} fit={isRate(metric)} /></td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length === 0 && <div className="empty">{term ? "Nothing matches." : "No data for this period."}</div>}
      <div className="muted" style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 12, marginTop: "var(--space-2)" }}>
        <span>{list.length > shown ? `Showing ${shown} of ${list.length}` : `${list.length} row${list.length === 1 ? "" : "s"}`}</span>
        {list.length > shown && <button className="btn btn-ghost" onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, list.length - shown)} more</button>}
      </div>
    </div>
  );
}

/** Colour a difference by whether it's good news for this metric. */
function diffClass(metric: DrillMetric, d: number): string {
  if (Math.abs(d) < 1e-9) return "delta flat";
  const good = metric === "bounce_rate" ? d < 0 : d > 0;
  return good ? "delta good" : "delta bad";
}
