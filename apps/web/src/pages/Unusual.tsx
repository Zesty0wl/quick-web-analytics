// Why a day was unusual: opened from an alarm on a site's chart. The same analysis as the alert emails.
import { useAnomalies, useAnomalyExplained, type Anomaly, type AnomalyExplained, type DayFigures, type Me, type Mover } from "../api";
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
  // Unusual days in the fortnight either side, so they're marked on that chart and one click away.
  const ctx = q.data ? (q.data.detail.around?.length ? q.data.detail.around : q.data.detail.history) : [];
  const around = useAnomalies(site.id, ctx[0]?.day ?? day, ctx[ctx.length - 1]?.day ?? day);
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
        <div className="section-head"><h3>What happened</h3></div>
        <div className="unusual-summary">
          {summary(a, i, movers, hourly).map((p, k) => <p key={k}>{p}</p>)}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h3>Why it was flagged</h3>
          <span className="muted">
            {i ? `${hourly ? `Visits ${hourly}` : "Visits"} on this ${weekday(a.day)} against the same hours of the ${i.history.length} before` : `Visitors on this ${weekday(a.day)} against the ${d.baseline.length} before`} · dashed line: the usual, ~{whole(a.expected)} (their median)
          </span>
        </div>
        <WeekdayBars
          bars={[
            ...(i ? i.history.map((v, k) => ({ label: `${i.history.length - k} wk ago`, value: v })) : d.baseline.map((b) => ({ label: shortDate(b.day), value: b.visitors }))),
            { label: shortDate(a.day), value: a.value, current: true },
          ]}
          expected={a.expected}
          kind={a.kind}
        />
      </section>

      {i?.hours && (
        <section className="section">
          <div className="section-head">
            <h3>Hour by hour</h3>
            <span className="muted">
              {i.hours.today.length < 24 ? "Today" : `${weekday(a.day)} ${shortDate(a.day)}`} against a usual {weekday(a.day)} (shaded) · flagged hours in colour
            </span>
          </div>
          <HourBars today={i.hours.today} usual={i.hours.usual} flagged={[i.window === "today" ? 0 : i.hour - 3, i.hour]} />
        </section>
      )}

      <section className="section">
        <div className="section-head"><h3>Around it</h3><span className="muted">Visitors per day, two weeks either side · unusual days have an alarm: click one to see why</span></div>
        <DayBars history={ctx} baseline={d.baseline.map((b) => b.day)} day={a.day} kind={a.kind} flagged={around.data?.anomalies ?? []} onPick={openDay} />
      </section>

      {a.kind === "outage" ? (
        <section className="section">
          <div className="section-head"><h3>What to check</h3></div>
          <p>
            {/* Resumed: an event in the last 15 minutes, or any since the end of that day. */}
            {d.lastEventAt && (Date.now() / 1000 - d.lastEventAt < 15 * 60 || d.lastEventAt * 1000 > Date.parse(`${a.day}T23:59:59Z`) + 14 * 3_600_000)
              ? <>Visits have come in since: the latest arrived {new Date(d.lastEventAt * 1000).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}. If it happens again, check that</>
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
          <div className="section-head"><h3>Where the change came from</h3><span className="muted">{i && hourly ? `Visitors ${hourly} against the same hours of a usual ${weekday(a.day)}` : `Visitors that day against a usual ${weekday(a.day)} (the average of the ${d.baseline.length || 6} before)`} · biggest changes first</span></div>
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

const signed = (n: number) => `${n >= 0 ? "+" : "−"}${whole(Math.abs(n))}`;
const fullWeekday = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });

/** The page's answer in words: how far off usual, where the change came from, and how much of it that explains. */
function summary(a: Anomaly, i: AnomalyExplained["detail"]["intraday"], movers: AnomalyExplained["movers"], hourly: string | null): string[] {
  const unit = i ? "visits" : "visitors";
  const when = i && hourly ? `${hourly} on ${fullWeekday(a.day)} ${shortDate(a.day)}` : `on ${fullWeekday(a.day)} ${shortDate(a.day)}`;
  const diff = a.value - a.expected;
  const ratio = a.expected ? a.value / a.expected : 0;
  const out: string[] = [];
  if (a.kind === "outage") {
    out.push(`${a.value === 0 ? "No" : `Only ${whole(a.value)}`} ${unit} ${when}, when a usual ${fullWeekday(a.day)} has about ${whole(a.expected)}. That usually means the tracker stopped reporting rather than people staying away.`);
    return out;
  }
  out.push(
    a.kind === "spike"
      ? `${whole(a.value)} ${unit} ${when}, against about ${whole(a.expected)} on a usual ${fullWeekday(a.day)}: ${whole(diff)} more than usual${ratio >= 2 ? ` (${ratio.toFixed(1)}×)` : ""}.`
      : `${whole(a.value)} ${unit} ${when}, against about ${whole(a.expected)} on a usual ${fullWeekday(a.day)}: ${whole(-diff)} fewer than usual (${Math.round((1 - ratio) * 100)}% down).`,
  );
  if (!movers) return out;
  const fmt = (rows: Mover[]) => rows.slice(0, 3).map((m) => `${m.name || "(none)"} (${signed(m.value - m.usual)})`).join(", ");
  const parts = [
    movers.countries.length ? `by country, ${fmt(movers.countries)}` : "",
    movers.sources.length ? `by source, ${fmt(movers.sources)}` : "",
    movers.pages.length ? `by page, ${fmt(movers.pages)}` : "",
  ].filter(Boolean);
  if (!parts.length) {
    out.push("No single source, page or country stands out: the change was spread thinly across the site's traffic.");
    return out;
  }
  out.push(`${a.kind === "spike" ? "Where the extra came from" : "Where the fall was"}: ${parts.join("; ")}.`);
  // Countries and sources each split visitors into separate groups, so their changes add up towards the total.
  const covered = Math.max(...[movers.countries, movers.sources].map((rows) => rows.reduce((n, m) => n + Math.abs(m.value - m.usual), 0)));
  if (Math.abs(diff) > 0 && covered < Math.abs(diff) * 0.5) {
    out.push(`Those account for only about ${whole(covered)} of the ${whole(Math.abs(diff))}: the rest came in ones and twos, with no other source, page or country changing by more than 2.`);
  }
  return out;
}

/** This weekday against the ones it was judged by: the usual dashed, this one in colour with its alarm. */
function WeekdayBars({ bars, expected, kind }: { bars: { label: string; value: number; current?: boolean }[]; expected: number; kind: Anomaly["kind"] }) {
  const max = Math.max(1, expected, ...bars.map((b) => b.value));
  return (
    <div className="wdbars">
      <div className="xbars" role="img" aria-label="This day against the same weekdays before it">
        <div className="xbars-usual" style={{ bottom: `${(expected / max) * 100}%` }} />
        {bars.map((b, k) => (
          <div key={k} className="xbars-col" title={`${b.label}: ${whole(b.value)}`}>
            <span className="wdbars-v" style={{ bottom: `calc(${(b.value / max) * 100}% + 4px)` }}>{whole(b.value)}</span>
            <div className={b.current ? "xbars-bar on" : "xbars-bar same"} style={{ height: `${(b.value / max) * 100}%` }} />
            {b.current && <span className={`chart-mark ${kind} wdbars-mark`} style={{ bottom: `calc(${(b.value / max) * 100}% + 24px)` }}><Alarm size={12} /></span>}
          </div>
        ))}
      </div>
      <div className="wdbars-labels">{bars.map((b, k) => <span key={k} className={b.current ? "current" : undefined}>{b.label}</span>)}</div>
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
              <b style={up ? undefined : { color: "var(--neg)" }}>{signed(r.value - r.usual)}</b>{" "}
              <span className="muted">{whole(r.value)} vs ~{whole(r.usual)} · {r.change}</span>
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
 * Daily visitors around the day: the day itself in colour with its alarm (it's the one this page explains), the
 * weekdays it was compared against shaded, and other unusual days with an alarm that opens their own explanation.
 */
function DayBars({ history, baseline, day, kind, flagged, onPick }: {
  history: DayFigures[]; baseline: string[]; day: string; kind: Anomaly["kind"]; flagged: Anomaly[]; onPick: (day: string) => void;
}) {
  const max = Math.max(1, ...history.map((h) => h.visitors));
  const same = new Set(baseline);
  // The most unusual flag on each other day (a day can have the nightly and the hourly check's).
  const flags = new Map<string, Anomaly>();
  for (const f of flagged) if (f.day !== day && Math.abs(f.score ?? 0) >= Math.abs(flags.get(f.day)?.score ?? -1)) flags.set(f.day, f);
  const at = (v: number) => `calc(${(v / max) * 100}% + 6px)`;
  return (
    <>
      <div className="xbars" role="img" aria-label="Visitors per day, two weeks either side">
        {history.map((h) => {
          const f = flags.get(h.day);
          const label = `${weekday(h.day)} ${shortDate(h.day)}: ${whole(h.visitors)} visitors`;
          if (h.day === day) {
            return (
              <div key={h.day} className="xbars-col this" title={`${label} (the day explained here)`}>
                <div className="xbars-bar on" style={{ height: `${(h.visitors / max) * 100}%` }} />
                <span className={`chart-mark ${kind}`} style={{ bottom: at(h.visitors) }}><Alarm size={12} /></span>
              </div>
            );
          }
          const bar = <div className={same.has(h.day) ? "xbars-bar same" : "xbars-bar"} style={{ height: `${(h.visitors / max) * 100}%` }} />;
          if (!f) return <div key={h.day} className="xbars-col" title={label}>{bar}</div>;
          return (
            <button key={h.day} className="xbars-col flagged" onClick={() => onPick(h.day)} title={`${weekday(h.day)} ${shortDate(h.day)}: ${describeAnomaly(f)}. Click to see why`}>
              {bar}
              <span className={`chart-mark ${f.kind}`} style={{ bottom: at(h.visitors) }}><Alarm size={12} /></span>
            </button>
          );
        })}
      </div>
      <div className="xbars-days">
        {history.map((h) => <span key={h.day} className={h.day === day ? "this" : undefined}>{h.day === day || h === history[0] || h === history[history.length - 1] ? shortDate(h.day) : ""}</span>)}
      </div>
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
