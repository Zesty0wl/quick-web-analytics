// Google data on the site page: Search Console (how people find the site on Google) and speed (PageSpeed Insights
// lab tests plus the Chrome UX Report's real-user Core Web Vitals).
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, useSearch, useSearchRows, useSpeed, useStats, type CruxHistory, type SearchDay, type SearchDim, type SearchTotals, type SpeedRun } from "../api";
import { Busy, busyOf, Spark, Spinner } from "../components/Bits";
import { Close, External } from "../components/Icons";
import { LineChart } from "../components/LineChart";
import { Section, Seg } from "../components/Section";
import { addDays, daysBetween, shortDate } from "../dates";
import { ago, change, compact, countryName, flag, whole } from "../format";
import type { Ctx } from "./Site";

// ---------------------------------------------------------------------------------------------------------
// Search Console

type SMetric = keyof SearchTotals;
const S_LABEL: Record<SMetric, string> = { clicks: "Clicks", impressions: "Impressions", ctr: "Click-through rate", position: "Avg. position" };
const S_SHORT: Record<SMetric, string> = { clicks: "Clicks", impressions: "Impressions", ctr: "CTR", position: "Position" };
const sval = (m: SMetric, v: number, short = false) =>
  m === "ctr" ? `${(v * 100).toFixed(1)}%` : m === "position" ? (v ? v.toFixed(1) : "–") : short ? compact(v) : whole(v);
const DIM_LABEL: Record<SearchDim, string> = { query: "Search query", page: "Page", country: "Country", device: "Device" };

/** Change vs the comparison period; position improves as it falls, CTR moves in percentage points. */
function SearchDelta({ m, cur, prev }: { m: SMetric; cur: number; prev: number | undefined }) {
  if (prev === undefined) return null;
  let text: string, good: boolean, flat: boolean;
  if (m === "position") {
    if (!cur || !prev) return null;
    const d = prev - cur;
    flat = Math.abs(d) < 0.05;
    good = d > 0;
    text = flat ? "± 0" : `${d > 0 ? "↑" : "↓"} ${Math.abs(d).toFixed(1)} places`;
  } else if (m === "ctr") {
    const d = (cur - prev) * 100;
    flat = Math.abs(d) < 0.05;
    good = d > 0;
    text = flat ? "± 0 pts" : `${d > 0 ? "↑ +" : "↓ −"}${Math.abs(d).toFixed(1)} pts`;
  } else {
    const c = change(cur, prev);
    if (c === null) return <span className="delta flat">new</span>;
    flat = Math.abs(c) < 0.05;
    good = c > 0;
    const n = Math.abs(c) >= 1000 ? ">999" : Math.abs(c).toFixed(1);
    text = flat ? "± 0%" : c > 0 ? `↑ +${n}%` : `↓ −${n}%`;
  }
  return <span className={flat ? "delta flat" : good ? "delta good" : "delta bad"}>{text}</span>;
}

/** Every day from `from` for `n` days, with Google's numbers where it has them (days without impressions are absent). */
function dense(rows: SearchDay[], from: string, n: number): SearchDay[] {
  const by = new Map(rows.map((r) => [r.day, r]));
  const out: SearchDay[] = [];
  let last: SearchDay | undefined;
  for (let i = 0; i < n; i++) {
    const day = addDays(from, i);
    const r = by.get(day);
    // Counts are zero on a missing day; rates carry the last known value rather than dropping to zero.
    out.push(r ?? { day, clicks: 0, impressions: 0, ctr: last?.ctr ?? 0, position: last?.position ?? 0 });
    if (r) last = r;
  }
  return out;
}

export function SearchSection({ c }: { c: Ctx }) {
  const [dim, setDim] = useState<SearchDim>("query");
  return (
    <Section id="s-search" title="Google Search" sub="Searches that showed this site, from Search Console"
      right={<Seg<SearchDim> value={dim} options={[{ id: "query", label: "Queries" }, { id: "page", label: "Pages" }, { id: "country", label: "Countries" }, { id: "device", label: "Devices" }]} onChange={setDim} />}>
      {(visible) => <SearchBody c={c} dim={dim} setDim={setDim} visible={visible} />}
    </Section>
  );
}

function SearchBody({ c, dim, setDim, visible }: { c: Ctx; dim: SearchDim; setDim: (d: SearchDim) => void; visible: boolean }) {
  const [metric, setMetric] = useState<SMetric>("clicks");
  const [query, setQuery] = useState<string | null>(null);
  // Only a single "page is …" filter maps onto Search Console; anything else can't be applied to Google's data.
  const isPage = (f: Ctx["filters"][number]) => f[0] === "page" && f[1] === "is" && typeof f[2] === "string";
  const pf = c.filters.find(isPage);
  const page = pf ? (pf[2] as string) : undefined;
  const ignored = c.filters.some((f) => !isPage(f));
  const params = { from: c.from, to: c.to, cfrom: c.cmp.from, cto: c.cmp.to, page, query: query ?? undefined };
  const s = useSearch(c.siteId, params, visible);
  const ok = s.data?.status === "ok" ? s.data : null;
  const rows = useSearchRows(c.siteId, { ...params, dim, limit: 10 }, visible && !!ok);

  const chart = useMemo(() => {
    if (!ok) return null;
    // Google trails by a day or two: end the line at its newest day rather than dropping to zero.
    const end = ok.latest && ok.latest < c.to ? ok.latest : c.to;
    const n = Math.max(1, daysBetween(c.from, end));
    return { cur: dense(ok.series, c.from, n), prev: dense(ok.prevSeries, c.cmp.from, n) };
  }, [ok, c.from, c.to, c.cmp.from]);

  if (s.error) return <p className="error">{(s.error as Error).message}</p>;
  if (s.data?.status === "not-connected") {
    return <div className="empty">Search Console isn't connected. Add a Google service account to see the searches that bring people here (docs/DEPLOY.md → Google data).</div>;
  }
  if (s.data?.status === "no-property") {
    return (
      <div className="empty">
        No Search Console property for {c.domain}. In Search Console, open this site's property → Settings → Users and permissions, and add <span className="mono">{s.data.account}</span> as a Restricted user.
      </div>
    );
  }

  const t = ok?.totals;
  const p = ok?.previous;
  const stale = s.isPlaceholderData;
  const rowData = rows.data?.rows ?? [];
  const max = Math.max(1, ...rowData.map((r) => r.clicks));
  const pick = (r: (typeof rowData)[number]) => {
    if (dim === "query") {
      setQuery(r.key);
      setDim("page");
    } else if (dim === "page" && r.local) c.addFilter(["page", "is", r.key]);
  };

  return (
    <div>
      {(query || page || ignored) && (
        <div className="filters" style={{ margin: "0 0 var(--space-4)" }}>
          {query && (
            <span className="fchip">
              <span className="k">Search query</span><span className="op" style={{ cursor: "default" }}>is</span><span className="v">“{query}”</span>
              <button className="x" onClick={() => setQuery(null)} aria-label="Remove search query filter"><Close /></button>
            </span>
          )}
          {page && <span className="muted" style={{ fontSize: 13 }}>Showing searches that led to <span className="mono">{page}</span>.</span>}
          {ignored && <span className="muted" style={{ fontSize: 13 }}>Google doesn't know your other filters, so they aren't applied here.</span>}
        </div>
      )}
      <Busy busy={busyOf(s)}>
        <div className="cells tiles-row" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 160px), 1fr))" }}>
          {(Object.keys(S_LABEL) as SMetric[]).map((m) => (
            <button key={m} className={metric === m ? "cell-btn metric-tile on" : "cell-btn metric-tile"} onClick={() => setMetric(m)} aria-pressed={metric === m}>
              <span className="kpi-label">{S_LABEL[m]}</span>
              <span className="v">{t ? sval(m, t[m]) : <Spinner size={18} />}</span>
              <span style={{ fontSize: 12 }}>
                {t && p && !stale && <SearchDelta m={m} cur={t[m]} prev={p[m]} />}{" "}
                {t && p && !stale && (m !== "position" || p[m] > 0) && <span className="muted" style={{ whiteSpace: "nowrap" }}>from {sval(m, p[m], true)}</span>}
              </span>
            </button>
          ))}
        </div>
        <div className="chart-box joined">
          <div className="legend">
            <span className="ttl">{S_LABEL[metric]}{metric === "position" && <span className="muted" style={{ fontWeight: 400 }}> · lower is better</span>}</span>
            <span className="k"><span className="line" />This period</span>
            <span className="k"><span className="dash" />Comparison</span>
            {ok?.latest && <span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>Google's data runs to {shortDate(ok.latest)}</span>}
          </div>
          {chart && chart.cur.length > 1 ? (
            <LineChart
              keys={chart.cur.map((d) => d.day)}
              current={chart.cur.map((d) => d[metric])}
              compareKeys={chart.prev.map((d) => d.day)}
              compare={chart.prev.map((d) => d[metric])}
              metric="visitors"
              grain="day"
              height={220}
              fmt={{ label: S_LABEL[metric], value: (v) => sval(metric, v, true), count: metric === "clicks" || metric === "impressions" }}
            />
          ) : (
            <div className="busy-block" style={{ height: 248 }}>{ok ? <span className="muted">Not enough days to draw a line. Pick a longer range.</span> : null}</div>
          )}
        </div>
      </Busy>

      <div style={{ marginTop: "var(--space-6)" }}>
        <Busy busy={busyOf(rows)} empty={rowData.length === 0}>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>{DIM_LABEL[dim]}</th>
                  {(["clicks", "impressions", "ctr", "position"] as SMetric[]).map((m) => <th key={m} className="num">{S_SHORT[m]}</th>)}
                  <th className="num">Change</th>
                </tr>
              </thead>
              <tbody>
                {rowData.map((r) => {
                  const clickable = dim === "query" || (dim === "page" && r.local);
                  const label = dim === "country" ? (r.key ? `${flag(r.key)} ${countryName(r.key)}` : "Unknown") : r.key;
                  return (
                    <tr key={r.url ?? r.key} className={clickable ? "clickable" : undefined} onClick={clickable ? () => pick(r) : undefined}
                      title={dim === "query" ? "Show the pages Google showed for this search" : dim === "page" && r.local ? `Filter: Page is ${r.key}` : undefined}>
                      <td className="incell">
                        <div className="fill" style={{ width: `${(r.clicks / max) * 100}%` }} />
                        <div className="inner">
                          <span className={dim === "page" ? "txt mono" : "txt"}>{label}</span>
                          {r.url && <a className="open" href={r.url} target="_blank" rel="noopener noreferrer" title={`Open ${r.url}`} onClick={(e) => e.stopPropagation()}><External /></a>}
                        </div>
                      </td>
                      <td className="num strong">{compact(r.clicks)}</td>
                      <td className="num">{compact(r.impressions)}</td>
                      <td className="num">{sval("ctr", r.ctr)}</td>
                      <td className="num">{sval("position", r.position)}</td>
                      <td className="num">{rows.isPlaceholderData ? <span className="muted">…</span> : <SearchDelta m="clicks" cur={r.clicks} prev={r.prevClicks} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!busyOf(rows) && rowData.length === 0 && <div className="empty">No Google searches showed this site in this period.</div>}
        </Busy>
        <p className="muted" style={{ fontSize: 12, marginTop: "var(--space-3)" }}>
          From Google Search Console{ok ? <> ({ok.property.replace(/^sc-domain:/, "")})</> : null}. Google counts days in Pacific Time, trails by a day or two, and leaves out rare queries for privacy.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Speed

type Vital = "lcp" | "inp" | "cls" | "fcp" | "ttfb" | "tbt" | "si";
type Status = "good" | "ni" | "poor";
// Google's thresholds: good up to the first number, poor above the second.
const LIMITS: Record<Vital, [number, number]> = { lcp: [2500, 4000], inp: [200, 500], cls: [0.1, 0.25], fcp: [1800, 3000], ttfb: [800, 1800], tbt: [200, 600], si: [3400, 5800] };
const V_LABEL: Record<Vital, string> = {
  lcp: "Largest Contentful Paint", inp: "Interaction to Next Paint", cls: "Cumulative Layout Shift", fcp: "First Contentful Paint",
  ttfb: "Time to First Byte", tbt: "Total Blocking Time", si: "Speed Index",
};
const V_HINT: Partial<Record<Vital, string>> = {
  lcp: "How long until the main content shows", inp: "How quickly the page responds to taps and clicks", cls: "How much the layout jumps while loading",
  tbt: "How long the page is too busy to respond", fcp: "How long until anything shows", ttfb: "How long the server takes to start replying",
};
const STATUS_LABEL: Record<Status, string> = { good: "Good", ni: "Needs work", poor: "Poor" };

const status = (v: Vital, x: number): Status => (x <= LIMITS[v][0] ? "good" : x <= LIMITS[v][1] ? "ni" : "poor");
const scoreStatus = (s: number): Status => (s >= 90 ? "good" : s >= 50 ? "ni" : "poor");
const vfmt = (v: Vital, x: number) => (v === "cls" ? x.toFixed(2) : x < 1000 ? `${Math.round(x)} ms` : `${(x / 1000).toFixed(1)} s`);

function StatusTag({ s, text, dot }: { s: Status; text?: string; dot?: boolean }) {
  if (dot) return <span className={`vital vital-${s}`} title={STATUS_LABEL[s]} role="img" aria-label={STATUS_LABEL[s]}><i aria-hidden /></span>;
  return <span className={`vital vital-${s}`}><i aria-hidden />{text ?? STATUS_LABEL[s]}</span>;
}

function VitalRow({ v, x, big }: { v: Vital; x: number | null; big?: boolean }) {
  const s = x === null ? null : status(v, x);
  // Marker position on a good / needs work / poor scale (each band a third; poor runs to 1.5× its threshold).
  const [g, p] = LIMITS[v];
  const pos = x === null ? 0 : x <= g ? (x / g) / 3 : x <= p ? 1 / 3 + ((x - g) / (p - g)) / 3 : Math.min(1, 2 / 3 + ((x - p) / (p * 0.5)) / 3);
  return (
    <div className={big ? "vrow big" : "vrow"} title={V_HINT[v]}>
      <div className="vrow-h">
        <span className="vname">{V_LABEL[v]}</span>
        <span className="vval">{x === null ? <span className="muted">–</span> : vfmt(v, x)}</span>
        {s && <StatusTag s={s} />}
      </div>
      {big && (
        <div className="vscale" aria-hidden>
          <span className="b good" /><span className="b ni" /><span className="b poor" />
          {x !== null && <span className="m" style={{ left: `${pos * 100}%` }} />}
        </div>
      )}
    </div>
  );
}

function ScoreRing({ score }: { score: number | null }) {
  const r = 26;
  const len = 2 * Math.PI * r;
  const s = score === null ? null : scoreStatus(score);
  return (
    <div className="score-ring">
      <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden>
        <circle cx="32" cy="32" r={r} fill="none" stroke="var(--color-divider)" strokeWidth="5" />
        {score !== null && <circle cx="32" cy="32" r={r} fill="none" stroke={`var(--status-${s})`} strokeWidth="5" strokeDasharray={`${(score / 100) * len} ${len}`} transform="rotate(-90 32 32)" />}
      </svg>
      <span className="n">{score ?? "–"}</span>
    </div>
  );
}

const VERDICT: Record<string, { s: Status; text: string }> = {
  FAST: { s: "good", text: "Passes Core Web Vitals" },
  AVERAGE: { s: "ni", text: "Doesn't pass: needs work" },
  SLOW: { s: "poor", text: "Doesn't pass: poor" },
};

export function SpeedSection({ c, admin }: { c: Ctx; admin: boolean }) {
  const [strategy, setStrategy] = useState<"mobile" | "desktop">("mobile");
  return (
    <Section id="s-speed" title="Speed" sub="Core Web Vitals from real visits, plus Google PageSpeed Insights"
      right={<Seg value={strategy} options={[{ id: "mobile", label: "Mobile" }, { id: "desktop", label: "Desktop" }]} onChange={setStrategy} />}>
      {(visible) => (
        <>
          <RealVisitors c={c} strategy={strategy} visible={visible} />
          <h4 className="speed-sub">Google's view</h4>
          <SpeedBody c={c} admin={admin} strategy={strategy} visible={visible} />
        </>
      )}
    </Section>
  );
}

type Row = Record<string, string | number | null>;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Web Vitals the QWA tracker measured on real visits, for the period and device, with attribution. */
function RealVisitors({ c, strategy, visible }: { c: Ctx; strategy: "mobile" | "desktop"; visible: boolean }) {
  const device = strategy === "mobile" ? "Mobile" : "Desktop";
  const filters = [...c.filters.filter((f) => f[0] !== "device"), ["device", "is", device] as Ctx["filters"][number]];
  const base = { from: c.from, to: c.to, filters };
  const totals = useStats(c.site, { ...base, metrics: ["measured_views", "inp", "lcp", "cls", "ttfb", "fcp", "inp_delay", "inp_processing", "inp_presentation"] }, { enabled: visible });
  const targets = useStats(c.site, { ...base, metrics: ["measured_views", "inp", "inp_delay", "inp_processing", "inp_presentation"], groupBy: "inp_target", limit: 6 }, { enabled: visible });
  const pages = useStats(c.site, { ...base, metrics: ["measured_views", "inp", "lcp", "cls"], groupBy: "page", limit: 8 }, { enabled: visible });
  const t = (totals.data?.rows[0] ?? {}) as Row;
  const measured = Number(t.measured_views ?? 0);
  const tRows = (targets.data?.rows ?? []) as Row[];
  const pRows = ((pages.data?.rows ?? []) as Row[]).filter((r) => Number(r.measured_views) > 0);
  const tag = (v: Vital, x: unknown) => (num(x) === null ? null : <StatusTag s={status(v, Number(x))} dot />);

  return (
    <Busy busy={busyOf(totals, targets, pages)} minHeight={200}>
      {!totals.data ? null : !measured ? (
        <div className="empty">
          No Web Vitals measured on {device.toLowerCase()} in this period yet. The QWA tracker measures them on every page view from 9 October 2026 (Safari doesn't report INP or CLS); sites still on the old Plausible script aren't measured.
        </div>
      ) : (
        <div className="cells" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))" }}>
          <div className="cell">
            <h6>Real visits · measured by QWA · {measured.toLocaleString("en-GB")} {device.toLowerCase()} page views</h6>
            <div style={{ marginTop: "var(--space-3)" }}>
              <VitalRow v="inp" x={num(t.inp)} big />
              <VitalRow v="lcp" x={num(t.lcp)} big />
              <VitalRow v="cls" x={num(t.cls)} big />
              <div className="vminor">
                <VitalRow v="ttfb" x={num(t.ttfb)} />
                <VitalRow v="fcp" x={num(t.fcp)} />
              </div>
            </div>
            {num(t.inp) !== null && (
              <p className="muted" style={{ fontSize: 12, marginTop: "var(--space-3)" }}>
                Where slow interactions spend their time (p75): input delay {vfmt("inp", Number(t.inp_delay ?? 0))}, processing {vfmt("inp", Number(t.inp_processing ?? 0))}, presentation {vfmt("inp", Number(t.inp_presentation ?? 0))}.
              </p>
            )}
          </div>
          <div className="cell">
            <h6>Slowest interactions · what visitors were using</h6>
            {tRows.length ? (
              <table className="table compact" style={{ marginTop: "var(--space-3)" }}>
                <thead><tr><th>Element</th><th className="num">Views</th><th className="num">INP</th><th className="num" title="Input delay / processing / presentation">Delay · Proc · Pres</th></tr></thead>
                <tbody>
                  {tRows.map((r) => (
                    <tr key={String(r.inp_target)}>
                      <td className="mono" title={String(r.inp_target)} style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(r.inp_target) || "(removed element)"}</td>
                      <td className="num">{compact(Number(r.measured_views))}</td>
                      <td className="num">{vfmt("inp", Number(r.inp))} {tag("inp", r.inp)}</td>
                      <td className="num muted">{[r.inp_delay, r.inp_processing, r.inp_presentation].map((x) => vfmt("inp", Number(x ?? 0))).join(" · ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted" style={{ fontSize: 13, marginTop: "var(--space-3)" }}>No interactions measured.</p>
            )}
            <p className="muted" style={{ fontSize: 12, marginTop: "var(--space-3)" }}>Input delay: the page was busy before the handler ran. Processing: the handler itself. Presentation: drawing the result.</p>
          </div>
        </div>
      )}
      {totals.data && measured > 0 && pRows.length > 0 && (
        <div className="cells" style={{ marginTop: 2 }}>
            <div className="cell">
              <h6>By page · busiest first</h6>
              <table className="table compact" style={{ marginTop: "var(--space-3)" }}>
                <thead><tr><th>Page</th><th className="num">Views measured</th><th className="num">INP</th><th className="num">LCP</th><th className="num">CLS</th></tr></thead>
                <tbody>
                  {pRows.map((r) => (
                    <tr key={String(r.page)} className="clickable" onClick={() => c.addFilter(["page", "is", String(r.page)])} title={`Filter: Page is ${r.page}`}>
                      <td className="mono">{String(r.page)}</td>
                      <td className="num">{compact(Number(r.measured_views))}</td>
                      <td className="num">{num(r.inp) === null ? "–" : vfmt("inp", Number(r.inp))} {tag("inp", r.inp)}</td>
                      <td className="num">{num(r.lcp) === null ? "–" : vfmt("lcp", Number(r.lcp))} {tag("lcp", r.lcp)}</td>
                      <td className="num">{num(r.cls) === null ? "–" : vfmt("cls", Number(r.cls))} {tag("cls", r.cls)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
        </div>
      )}
    </Busy>
  );
}

function SpeedBody({ c, admin, strategy, visible }: { c: Ctx; admin: boolean; strategy: "mobile" | "desktop"; visible: boolean }) {
  const qc = useQueryClient();
  const q = useSpeed(c.siteId, visible);
  const test = useMutation({
    mutationFn: () => api<{ errors: string[] }>(`/sites/${c.siteId}/speed/test`, { method: "POST", body: "{}", signal: AbortSignal.timeout(300_000) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["speed", c.siteId] }),
  });
  const [cruxMetric, setCruxMetric] = useState<"lcp" | "inp" | "cls">("lcp");

  if (q.error) return <p className="error">{(q.error as Error).message}</p>;
  if (q.data?.status === "not-connected") {
    return <div className="empty">PageSpeed isn't connected. Add a Google API key to test this site's speed every night (docs/DEPLOY.md → Google data).</div>;
  }
  const data = q.data?.status === "ok" ? q.data : null;
  const runs = (data?.runs ?? []).filter((r) => r.strategy === strategy);
  const last: SpeedRun | undefined = runs[runs.length - 1];
  const crux: CruxHistory | null = data ? (strategy === "mobile" ? data.crux.phone : data.crux.desktop) : null;
  const verdict = last?.field?.verdict ? VERDICT[last.field.verdict] : null;
  const scores = runs.map((r) => r.score ?? NaN);

  return (
    <Busy busy={busyOf(q)} minHeight={240}>
      <div className="speed-bar">
        <span className="muted" style={{ fontSize: 13 }}>
          {last ? <>Tested {ago(last.runAt)} · <a href={last.url} target="_blank" rel="noopener noreferrer">{last.url.replace(/^https?:\/\//, "")}</a></> : data ? "Not tested yet. Tests run every night." : null}
        </span>
        {admin && data && (
          <button className="btn btn-secondary" disabled={test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? <><Spinner /> Testing (up to a minute)…</> : "Test now"}
          </button>
        )}
      </div>
      {test.error && <p className="error">{(test.error as Error).message}</p>}
      {test.data && test.data.errors.length > 0 && <p className="hint">One of the two tests failed on Google's side ({test.data.errors[0]}); the other was saved. Try again in a few minutes.</p>}

      {last && (
        <div className="cells" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))" }}>
          <div className="cell">
            <h6>Real visitors · Chrome, last 28 days</h6>
            {last.field ? (
              <>
                <div style={{ margin: "var(--space-3) 0 var(--space-4)" }}>
                  {verdict ? <StatusTag s={verdict.s} text={verdict.text} /> : <span className="muted">No verdict</span>}
                  {last.field.scope === "origin" && <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>Whole site (too few visits to this page alone)</span>}
                </div>
                <VitalRow v="lcp" x={last.field.lcp} big />
                <VitalRow v="inp" x={last.field.inp} big />
                <VitalRow v="cls" x={last.field.cls} big />
                <div className="vminor">
                  <VitalRow v="fcp" x={last.field.fcp} />
                  <VitalRow v="ttfb" x={last.field.ttfb} />
                </div>
                <p className="muted" style={{ fontSize: 12, marginTop: "var(--space-3)" }}>The 75th percentile: three in four visits were at least this fast. This is what Google uses in search rankings.</p>
              </>
            ) : (
              <p className="muted" style={{ fontSize: 13, marginTop: "var(--space-3)" }}>Chrome doesn't have enough visits to this site yet to report real-user speed. The lab test is still a good guide.</p>
            )}
          </div>

          <div className="cell">
            <h6>Lab test · Lighthouse, simulated {strategy === "mobile" ? "mid-range phone on 4G" : "desktop"}</h6>
            <div className="score-head">
              <ScoreRing score={last.score} />
              <div>
                <div className="kpi-label">Performance score</div>
                {last.score !== null && <StatusTag s={scoreStatus(last.score)} />}
              </div>
              {scores.filter(Number.isFinite).length > 1 && (
                <div className="score-spark" title="Score over the last six months">
                  <Spark current={scores} growing={(scores[scores.length - 1] || 0) >= (scores[0] || 0)} height={40} fit />
                  <span className="muted">{runs.length} tests since {shortDate(new Date(runs[0].runAt * 1000).toISOString().slice(0, 10))}</span>
                </div>
              )}
            </div>
            <VitalRow v="lcp" x={last.lab.lcp} />
            <VitalRow v="tbt" x={last.lab.tbt} />
            <VitalRow v="cls" x={last.lab.cls} />
            <VitalRow v="fcp" x={last.lab.fcp} />
            <VitalRow v="si" x={last.lab.si} />
            {last.opportunities.length > 0 && (
              <>
                <h6 style={{ marginTop: "var(--space-4)" }}>Biggest wins</h6>
                <ul className="wins">
                  {last.opportunities.map((o) => (
                    <li key={o.id}><span>{o.title}</span><span className="muted">saves ~{vfmt("lcp", o.savingsMs)}</span></li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      )}

      {crux && crux.dates.length > 1 && (
        <div className="chart-box" style={{ marginTop: "var(--space-6)" }}>
          <div className="legend">
            <span className="ttl">Real-visitor trend · {V_LABEL[cruxMetric]}</span>
            <span className="muted" style={{ fontSize: 12 }}>Whole site, {strategy}, 75th percentile of each 28-day window</span>
            <span style={{ marginLeft: "auto" }} />
            <Seg value={cruxMetric} options={[{ id: "lcp", label: "LCP" }, { id: "inp", label: "INP" }, { id: "cls", label: "CLS" }]} onChange={setCruxMetric} />
          </div>
          <LineChart
            keys={crux.dates}
            current={crux[cruxMetric].map((v) => v ?? 0)}
            metric="visitors"
            grain="day"
            height={180}
            fmt={{ label: `p75 ${cruxMetric.toUpperCase()}`, value: (v) => vfmt(cruxMetric, v) }}
          />
          <p className="muted" style={{ fontSize: 12, marginTop: "var(--space-2)" }}>
            Good is under {vfmt(cruxMetric, LIMITS[cruxMetric][0])}; poor is over {vfmt(cruxMetric, LIMITS[cruxMetric][1])}.
          </p>
        </div>
      )}
    </Busy>
  );
}
