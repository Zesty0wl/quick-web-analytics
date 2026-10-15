// Why a day was unusual: opened from an alarm on a site's chart. The same analysis as the alert emails.
import { useAnomalies, useAnomalyExplained, type Anomaly, type DayFigures, type Me, type Mover } from "../api";
import { Spinner } from "../components/Bits";
import { Alarm, ArrowLeft } from "../components/Icons";
import { longDate, shortDate, weekday, type Period } from "../dates";
import { ANOMALY_LABEL, describeAnomaly, duration, whole } from "../format";
import { globalParams, linkHandler, withParams, type Navigate } from "../url";

const hh = (h: number) => `${String(((h % 24) + 24) % 24).padStart(2, "0")}:00`;
const pct = (a: number, b: number) => (b ? `${a >= b ? "+" : "−"}${Math.abs(Math.round(((a - b) / b) * 100))}%` : "–");
const sum = (list: DayFigures[], k: keyof Omit<DayFigures, "day">) => list.reduce((n, d) => n + d[k], 0);

export function Unusual({ site, day, url, navigate, period, periodText }: {
  site: Me["sites"][number]; day: string; url: URL; navigate: Navigate; period: Period; periodText: string;
}) {
  const q = useAnomalyExplained(site.id, day);
  // Every unusual day in the selected range, to step between them.
  const inRange = useAnomalies(site.id, period.from, period.to);
  // Other unusual days in the four weeks shown, so they're marked on the chart and one click away.
  const first = q.data?.detail.history[0]?.day;
  const around = useAnomalies(site.id, first ?? day, day);
  const openDay = (d: string) => navigate(`/s/${site.id}/unusual/${d}${globalParams(url)}`);
  const back = `/s/${site.id}${globalParams(url)}`;
  // The site's page for just that day, optionally filtered to one source or page.
  const dayHref = (filter?: [string, string]) =>
    withParams(new URL(`/s/${site.id}`, location.origin), { from: day, to: day, f: filter ? JSON.stringify([[filter[0], "is", filter[1]]]) : null });

  const head = (
    <a className="btn btn-ghost" href={back} onClick={linkHandler(navigate, back)} style={{ paddingLeft: 0, marginBottom: "var(--space-2)", fontSize: 13 }}>
      <ArrowLeft />{site.domain}
    </a>
  );
  if (q.isLoading) return <div>{head}<div className="busy-block" style={{ minHeight: "40vh" }}><Spinner size={16} />Working out what happened…</div></div>;
  if (q.isError || !q.data) {
    return (
      <div>
        {head}
        <div className="center">
          <h3>Nothing to explain</h3>
          <p className="muted">{(q.error as Error | null)?.message ?? "Nothing unusual was recorded for this site on that day."}</p>
          <a className="btn btn-secondary" href={dayHref()} onClick={linkHandler(navigate, dayHref())}>See {shortDate(day)} in the dashboard</a>
        </div>
      </div>
    );
  }

  const { anomaly: a, detail: d, movers } = q.data;
  const i = d.intraday;
  const up = a.kind === "spike";
  const valueLabel = i ? (i.window === "today" ? "Visits so far" : `Visits ${hh(i.hour - 3)}–${hh(i.hour)}`) : "Visitors";
  const usualLabel = i ? (i.window === "today" ? `Usual by ${hh(i.hour)}` : `Usual ${hh(i.hour - 3)}–${hh(i.hour)}`) : `Usual ${weekday(a.day)}`;
  const hourly = a.metric === "intraday" && a.detail
    ? a.detail.window === "today" ? `the day so far, to ${hh(a.detail.hour)}` : `${hh(a.detail.hour - 3)}–${hh(a.detail.hour)}`
    : null;

  // Pageviews, bounce rate and average visit on the day against the baseline weekdays.
  const today = d.history[d.history.length - 1];
  const base = d.baseline.length ? d.baseline : today ? [today] : [];
  const others = today && base.length
    ? [
        { label: "Pageviews", value: whole(today.pageviews), usual: whole(sum(base, "pageviews") / base.length), change: pct(today.pageviews, sum(base, "pageviews") / base.length) },
        {
          label: "Bounce rate",
          value: `${today.visits ? Math.round((today.bounces / today.visits) * 100) : 0}%`,
          usual: `${sum(base, "visits") ? Math.round((sum(base, "bounces") / sum(base, "visits")) * 100) : 0}%`,
          change: null,
        },
        {
          label: "Avg. visit",
          value: duration(today.visits ? today.duration_sum / today.visits : 0),
          usual: duration(sum(base, "visits") ? sum(base, "duration_sum") / sum(base, "visits") : 0),
          change: pct(today.visits ? today.duration_sum / today.visits : 0, sum(base, "visits") ? sum(base, "duration_sum") / sum(base, "visits") : 0),
        },
      ]
    : [];
  const anyMovers = movers && (movers.sources.length || movers.pages.length || movers.countries.length);

  return (
    <div className="unusual">
      <header className="pagehead">
        <div className="titles">
          {head}
          <div><span className={`anomaly-flag ${a.kind}`}><Alarm size={11} />{ANOMALY_LABEL[a.kind]}</span></div>
          <h1 style={{ margin: "var(--space-2) 0 0" }}>{longDate(a.day)}</h1>
          <div className="sub">{site.domain}{hourly ? ` · flagged by the hourly check for ${hourly}` : ""} · {describeAnomaly(a)}</div>
        </div>
        <a className="btn btn-secondary" href={dayHref()} onClick={linkHandler(navigate, dayHref())}>Open this day in the dashboard</a>
      </header>

      <UnusualDays list={inRange.data?.anomalies ?? []} day={a.day} periodText={periodText} onPick={openDay} />

      <div className="cells tiles-row" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))" }}>
        <div className="cell"><span className="kpi-label">{valueLabel}</span><div className="kpi-value" style={up ? undefined : { color: "var(--neg)" }}>{whole(a.value)}</div><span className="muted" style={{ fontSize: 13 }}>{i ? `${weekday(a.day)}, to ${hh(i.hour)}` : shortDate(a.day)}</span></div>
        <div className="cell"><span className="kpi-label">{usualLabel}</span><div className="kpi-value">~{whole(a.expected)}</div><span className="muted" style={{ fontSize: 13 }}>median of {i ? i.history.length : d.baseline.length || 6} {weekday(a.day)}s</span></div>
        <div className="cell"><span className="kpi-label">Change</span><div className="kpi-value" style={up ? undefined : { color: "var(--neg)" }}>{pct(a.value, a.expected)}</div><span className="muted" style={{ fontSize: 13 }}>{up ? "above usual" : "below usual"}</span></div>
      </div>

      <section className="section">
        {i?.hours ? (
          <>
            <div className="section-head">
              <h3>Visits by hour</h3>
              <span className="muted">
                {i.hours.today.length < 24 ? "Today" : `${weekday(a.day)} ${shortDate(a.day)}`} against a usual {weekday(a.day)} (shaded) · flagged hours in colour
              </span>
            </div>
            <HourBars today={i.hours.today} usual={i.hours.usual} flagged={[i.window === "today" ? 0 : i.hour - 3, i.hour]} />
          </>
        ) : (
          <>
            <div className="section-head"><h3>The last four weeks</h3><span className="muted">Visitors per day · {weekday(a.day)}s compared against are shaded · other unusual days have an alarm: click one to see why</span></div>
            <DayBars history={d.history} baseline={d.baseline.map((b) => b.day)} day={a.day} expected={i ? undefined : a.expected} flagged={first ? around.data?.anomalies ?? [] : []} onPick={openDay} />
          </>
        )}
      </section>

      {a.kind === "outage" ? (
        <section className="section">
          <div className="section-head"><h3>What to check</h3></div>
          <p>
            {d.lastEventAt && Date.now() / 1000 - d.lastEventAt < 15 * 60
              ? <>Visits are coming in again: the latest arrived at {new Date(d.lastEventAt * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}. If it happens again, check that</>
              : <>
                  {d.lastEventAt ? <>The last event arrived {new Date(d.lastEventAt * 1000).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}. </> : null}
                  Visits stopped or nearly stopped. Check that
                </>} {site.domain} is up, that the tracking snippet is still on its pages
            (Admin → Sites → Install shows when the tracker was last seen), and that nothing such as a new consent banner or
            content security policy is blocking it.
          </p>
        </section>
      ) : (
        <section className="section">
          <div className="section-head"><h3>Where the change came from</h3><span className="muted">{i && hourly ? `Visitors ${hourly} against usual for those hours` : "Visitors that day against usual"}</span></div>
          {!movers ? (
            <p className="muted">The breakdown couldn't be worked out just now. Try again in a minute.</p>
          ) : !anyMovers ? (
            <p className="muted">No single source, page or country stands out: the change was spread across the site's traffic.</p>
          ) : (
            <div className="grid-3">
              <MoverTable title="Sources" rows={movers.sources} up={up} href={(m) => dayHref(["source", m.name])} navigate={navigate} />
              <MoverTable title="Pages" rows={movers.pages} up={up} href={(m) => dayHref(["page", m.name])} navigate={navigate} />
              <MoverTable title="Countries" rows={movers.countries} up={up} navigate={navigate} />
            </div>
          )}
        </section>
      )}

      {others.length > 0 && !i && (
        <section className="section">
          <div className="section-head"><h3>Other measures that day</h3><span className="muted">Against the {d.baseline.length} {weekday(a.day)}s before</span></div>
          <div className="cells" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))" }}>
            {others.map((o) => (
              <div key={o.label} className="cell">
                <span className="kpi-label">{o.label}</span>
                <div className="kpi-value" style={{ fontSize: 26 }}>{o.value}</div>
                <span className="muted" style={{ fontSize: 13 }}>usually {o.usual}{o.change ? ` · ${o.change}` : ""}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** The selected range's unusual days, newest first, the one shown highlighted: one click to step between them. */
function UnusualDays({ list, day, periodText, onPick }: { list: Anomaly[]; day: string; periodText: string; onPick: (day: string) => void }) {
  // One per day (the nightly and the hourly check can both flag a day): the more unusual.
  const byDay = new Map<string, Anomaly>();
  for (const a of list) if (Math.abs(a.score ?? 0) >= Math.abs(byDay.get(a.day)?.score ?? -1)) byDay.set(a.day, a);
  const days = [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
  if (days.length < 2 && days[0]?.day === day) return null;
  const label = { spike: "Spike", drop: "Drop", outage: "Outage?" } as const;
  return (
    <nav className="unusual-days" aria-label="Unusual days in this range">
      <span className="kpi-label">{days.length} unusual day{days.length === 1 ? "" : "s"} · {periodText}</span>
      <div className="unusual-days-list">
        {days.map((a) => (
          <button
            key={a.day}
            type="button"
            className={`anomaly-flag ${a.kind}${a.day === day ? " current" : ""}`}
            aria-current={a.day === day ? "page" : undefined}
            onClick={() => a.day !== day && onPick(a.day)}
            title={describeAnomaly(a)}
          >
            <Alarm size={11} />{label[a.kind]} · {weekday(a.day)} {shortDate(a.day)}
          </button>
        ))}
        {!byDay.has(day) && <span className="hint">The day shown is outside this range.</span>}
      </div>
    </nav>
  );
}

function MoverTable({ title, rows, up, href, navigate }: { title: string; rows: Mover[]; up: boolean; href?: (m: Mover) => string; navigate: Navigate }) {
  const max = Math.max(1, ...rows.map((r) => Math.max(r.value, r.usual)));
  return (
    <div>
      <h6 style={{ marginBottom: "var(--space-2)" }}>{title}</h6>
      {rows.length === 0 && <div className="muted" style={{ fontSize: 13, padding: "6px 0" }}>Nothing stands out</div>}
      {rows.map((r) => {
        const body = (
          <>
            <div className={up ? "fill accent" : "fill neg"} style={{ top: 3, bottom: 3, width: `${(r.value / max) * 100}%` }} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }} title={r.name}>{r.name || "(none)"}</span>
            <span className="v" title={`${whole(r.value)} visitors, usually about ${whole(r.usual)}`}>
              {whole(r.value)} <span className="muted">vs ~{whole(r.usual)}</span> <b style={up ? undefined : { color: "var(--neg)" }}>{r.change}</b>
            </span>
          </>
        );
        const link = href?.(r);
        return link
          ? <a key={r.name} className="barrow clickable" href={link} onClick={linkHandler(navigate, link)} style={{ fontSize: 13, paddingTop: 6, paddingBottom: 6, color: "inherit", textDecoration: "none" }}>{body}</a>
          : <div key={r.name} className="barrow" style={{ fontSize: 13, paddingTop: 6, paddingBottom: 6 }}>{body}</div>;
      })}
    </div>
  );
}

/**
 * 28 days of visitors: the unusual day in accent, the weekdays it was compared with shaded, usual dashed. Other
 * unusual days carry an alarm and open their own explanation.
 */
function DayBars({ history, baseline, day, expected, flagged, onPick }: {
  history: DayFigures[]; baseline: string[]; day: string; expected?: number; flagged: Anomaly[]; onPick: (day: string) => void;
}) {
  const max = Math.max(1, expected ?? 0, ...history.map((h) => h.visitors));
  const same = new Set(baseline);
  // The most unusual flag on each day (a day can have the nightly and the hourly check's).
  const flags = new Map<string, Anomaly>();
  for (const f of flagged) if (f.day !== day && Math.abs(f.score ?? 0) >= Math.abs(flags.get(f.day)?.score ?? -1)) flags.set(f.day, f);
  return (
    <>
      <div className="xbars" role="img" aria-label="Visitors per day over the last four weeks">
        {expected !== undefined && <div className="xbars-usual" style={{ bottom: `${(expected / max) * 100}%` }}><span>usual ~{whole(expected)}</span></div>}
        {history.map((h) => {
          const f = flags.get(h.day);
          const bar = <div className={h.day === day ? "xbars-bar on" : same.has(h.day) ? "xbars-bar same" : "xbars-bar"} style={{ height: `${(h.visitors / max) * 100}%` }} />;
          if (!f) return <div key={h.day} className="xbars-col" title={`${weekday(h.day)} ${shortDate(h.day)}: ${whole(h.visitors)} visitors`}>{bar}</div>;
          return (
            <button key={h.day} className="xbars-col flagged" onClick={() => onPick(h.day)} title={`${weekday(h.day)} ${shortDate(h.day)}: ${describeAnomaly(f)}. Click to see why`}>
              {bar}
              <span className={`chart-mark ${f.kind}`} style={{ bottom: `calc(${(h.visitors / max) * 100}% + 6px)` }}><Alarm size={12} /></span>
            </button>
          );
        })}
      </div>
      <div className="axis-row"><span>{history[0] ? shortDate(history[0].day) : ""}</span><span>{shortDate(day)}</span></div>
    </>
  );
}

/**
 * Visits per hour that day over the usual for each hour on this weekday (shaded): the flagged hours [from, to) in
 * accent, the rest of the day lighter. Today only has the hours so far.
 */
function HourBars({ today, usual, flagged }: { today: number[]; usual: number[]; flagged: [number, number] }) {
  const max = Math.max(1, ...today, ...usual);
  const upTo = today.length;
  return (
    <>
      <div className="xbars" role="img" aria-label="Visits per hour today against usual">
        {usual.map((u, h) => (
          <div key={h} className={h >= flagged[0] && h < flagged[1] ? "xbars-col window" : "xbars-col"} title={`${hh(h)}–${hh(h + 1)}: ${h < upTo ? `${whole(today[h] ?? 0)} visits, usually ` : "usually "}${whole(u)}`}>
            <div className="xbars-bar same" style={{ height: `${(u / max) * 100}%`, width: "100%" }} />
            {h < upTo && <div className={h >= flagged[0] && h < flagged[1] ? "xbars-bar on overlay" : "xbars-bar day overlay"} style={{ height: `${((today[h] ?? 0) / max) * 100}%` }} />}
          </div>
        ))}
      </div>
      <div className="axis-row"><span>00:00</span><span>12:00</span><span>23:00</span></div>
    </>
  );
}
