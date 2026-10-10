// Alert email: HTML (table layout and inline styles, so it renders in Gmail, Outlook and Apple Mail) plus plain text.
import type { AnomalyKind } from "./anomaly";

export interface DayFigures {
  day: string;
  visitors: number;
  visits: number;
  pageviews: number;
  bounces: number;
  duration_sum: number;
}

export interface Driver {
  name: string;
  /** Visitors from this source/page/country on the unusual day. */
  value: number;
  /** Its usual daily visitors over the previous four weeks. */
  usual: number;
}

export interface AlertDetail {
  siteId: number;
  domain: string;
  day: string;
  kind: AnomalyKind;
  value: number;
  expected: number;
  /** Daily figures for the 28 days ending on the unusual day (oldest first; missing days are zero). */
  history: DayFigures[];
  /** The same weekday over the previous six weeks (oldest first), the baseline. */
  baseline: DayFigures[];
  drivers?: { sources: Driver[]; pages: Driver[]; countries: Driver[] };
  /** Unix seconds of the most recent event the site's Durable Object has seen (outages). */
  lastEventAt?: number | null;
  /**
   * Set for the hourly check: `value`/`expected` are visits from midnight to `hour`:00 ("today") or in the three
   * hours before it ("last3h"); `history` is that same window on earlier same weekdays.
   */
  intraday?: {
    hour: number;
    window: "today" | "last3h";
    history: number[];
    /** Visits per local hour: today's hours so far, and the usual (median) for each of the 24 hours on this weekday. */
    hours?: { today: number[]; usual: number[] };
  };
}

const hh = (h: number) => `${String(((h % 24) + 24) % 24).padStart(2, "0")}:00`;
/** "so far today (to 14:00)" or "11:00–14:00". */
const windowText = (i: NonNullable<AlertDetail["intraday"]>) => (i.window === "today" ? `so far today (to ${hh(i.hour)})` : `${hh(i.hour - 3)}–${hh(i.hour)}`);

const C = {
  bg: "#efeeec", card: "#ffffff", ink: "#201e1d", muted: "#7d7979", faint: "#a3a1a0", rule: "#e6e3e0",
  accent: "#ec3013", accentSoft: "#fdebe7", neg: "#ae1800", bar: "#dcd8d4", barSame: "#a9a4a0", good: "#1f7a3f",
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const n = (x: number) => Math.round(x).toLocaleString("en-GB");
const date = (day: string, opts: Intl.DateTimeFormatOptions) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" });
const weekday = (day: string) => date(day, { weekday: "long" });
const shortDay = (day: string) => date(day, { weekday: "short", day: "numeric", month: "short" });
const longDay = (day: string) => date(day, { weekday: "long", day: "numeric", month: "long" });
const dur = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s` : `${Math.round(s)}s`);
const addDays = (day: string, k: number) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + k)).toISOString().slice(0, 10);
};

const KIND = {
  spike: { label: "Spike", arrow: "▲", pillBg: C.ink, pillFg: "#ffffff" },
  drop: { label: "Drop", arrow: "▼", pillBg: C.accentSoft, pillFg: C.neg },
  outage: { label: "Possible outage", arrow: "⚠", pillBg: C.neg, pillFg: "#ffffff" },
} as const;

/** "2.6× a usual Monday", "64% below a usual Monday". */
export function changeText(a: Pick<AlertDetail, "kind" | "value" | "expected" | "day" | "intraday">): string {
  const ratio = a.expected ? a.value / a.expected : 0;
  const by = a.intraday ? " by now" : "";
  if (a.kind === "outage") return a.intraday ? `usually ~${n(a.expected)} by now` : `almost nothing on a ${weekday(a.day)}`;
  if (a.kind === "spike") return ratio >= 2 ? `${ratio.toFixed(1)}× a usual ${weekday(a.day)}${by}` : `${Math.round((ratio - 1) * 100)}% above a usual ${weekday(a.day)}${by}`;
  return `${Math.round((1 - ratio) * 100)}% below a usual ${weekday(a.day)}${by}`;
}

export function subjectFor(items: AlertDetail[]): string {
  if (items.length > 1) {
    const sites = [...new Set(items.map((i) => i.domain))];
    return `${items.length} unusual days: ${sites.slice(0, 2).join(", ")}${sites.length > 2 ? ` +${sites.length - 2}` : ""}`;
  }
  const a = items[0];
  if (a.intraday) {
    if (a.kind === "outage") return `⚠ ${a.domain}: ${a.value === 0 ? "no visits" : `only ${n(a.value)} visits`} since ${hh(a.intraday.hour - 3)} (usually ~${n(a.expected)}). Is the tracker still working?`;
    return `${KIND[a.kind].arrow} ${a.domain}: ${n(a.value)} visits ${windowText(a.intraday)}, ${changeText(a)}`;
  }
  if (a.kind === "outage") return `⚠ ${a.domain}: almost no visitors on ${shortDay(a.day)}. Is the tracker still working?`;
  return `${KIND[a.kind].arrow} ${a.domain}: ${n(a.value)} visitors on ${shortDay(a.day)}, ${changeText(a)}`;
}

const sum = (rows: DayFigures[], k: keyof Omit<DayFigures, "day">) => rows.reduce((t, r) => t + r[k], 0);

/** Pageviews, bounce rate and average visit on the day vs the baseline weekdays. */
function otherMetrics(a: AlertDetail) {
  const day = a.history[a.history.length - 1];
  const base = a.baseline.length ? a.baseline : [day];
  const usual = {
    pageviews: sum(base, "pageviews") / base.length,
    bounce: sum(base, "visits") ? (sum(base, "bounces") / sum(base, "visits")) * 100 : 0,
    duration: sum(base, "visits") ? sum(base, "duration_sum") / sum(base, "visits") : 0,
  };
  const now = {
    pageviews: day?.pageviews ?? 0,
    bounce: day?.visits ? (day.bounces / day.visits) * 100 : 0,
    duration: day?.visits ? day.duration_sum / day.visits : 0,
  };
  return [
    { label: "Pageviews", value: n(now.pageviews), usual: n(usual.pageviews), delta: pct(now.pageviews, usual.pageviews) },
    { label: "Bounce rate", value: `${Math.round(now.bounce)}%`, usual: `${Math.round(usual.bounce)}%`, delta: pts(now.bounce, usual.bounce) },
    { label: "Avg. visit", value: dur(now.duration), usual: dur(usual.duration), delta: pct(now.duration, usual.duration) },
  ];
}
const pct = (a: number, b: number) => (b ? `${a >= b ? "+" : "−"}${Math.abs(Math.round(((a - b) / b) * 100))}%` : "");
const pts = (a: number, b: number) => `${a >= b ? "+" : "−"}${Math.abs(Math.round(a - b))} pts`;

/** "+43%", "−60%", "3.2×", "202×", or "new" when it was next to nothing before. */
export function moverChange(r: Driver): string {
  if (r.usual < 1) return "new";
  const ratio = r.value / r.usual;
  if (ratio >= 10) return `${Math.round(ratio)}×`;
  if (ratio >= 2) return `${ratio.toFixed(1)}×`;
  return `${ratio >= 1 ? "+" : "−"}${Math.abs(Math.round((ratio - 1) * 100))}%`;
}

/** The rows that moved most in the direction of the anomaly. */
export function topMovers(rows: Driver[], kind: AnomalyKind, k = 4): Driver[] {
  const sign = kind === "spike" ? 1 : -1;
  return rows
    .filter((r) => sign * (r.value - r.usual) > Math.max(2, r.usual * 0.1))
    .sort((x, y) => sign * (y.value - y.usual) - sign * (x.value - x.usual))
    .slice(0, k);
}

// ---------- HTML ----------

const button = (href: string, label: string, primary: boolean) =>
  `<a href="${esc(href)}" style="display:inline-block;padding:11px 18px;border-radius:9px;font-weight:700;font-size:14px;text-decoration:none;${
    primary ? `background:${C.accent};color:#ffffff;` : `background:#ffffff;color:${C.ink};border:1px solid ${C.rule};`
  }">${esc(label)}</a>`;

function barChart(a: AlertDetail): string {
  const dayLabel = a.intraday ? "Today so far" : shortDay(a.day);
  const max = Math.max(1, ...a.history.map((d) => d.visitors));
  const target = new Date(`${a.day}T12:00:00Z`).getUTCDay();
  const cells = a.history
    .map((d) => {
      const h = Math.max(2, Math.round((d.visitors / max) * 84));
      const isDay = d.day === a.day;
      const sameWeekday = new Date(`${d.day}T12:00:00Z`).getUTCDay() === target;
      const color = isDay ? C.accent : sameWeekday ? C.barSame : C.bar;
      return `<td valign="bottom" style="padding:0 1px;height:88px;vertical-align:bottom" title="${esc(`${shortDay(d.day)}: ${n(d.visitors)} visitors`)}"><div style="height:${h}px;line-height:${h}px;font-size:1px;background:${color};border-radius:2px 2px 0 0">&nbsp;</div></td>`;
    })
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed"><tr>${cells}</tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:6px"><tr>
<td style="font-size:11px;color:${C.faint}">${esc(shortDay(a.history[0]?.day ?? a.day))}</td>
<td align="right" style="font-size:11px;color:${C.faint}">${esc(shortDay(a.day))}</td></tr></table>
<div style="font-size:11px;color:${C.muted};margin-top:8px">
<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${C.accent};vertical-align:middle"></span>&nbsp;${esc(dayLabel)}
&nbsp;&nbsp;<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${C.barSame};vertical-align:middle"></span>&nbsp;Other ${esc(weekday(a.day))}s
&nbsp;&nbsp;<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${C.bar};vertical-align:middle"></span>&nbsp;Other days</div>`;
}

const swatch = (color: string) => `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${color};vertical-align:middle"></span>`;

/** Hourly alerts: today's visits hour by hour beside a usual day's, with the hours that set off the alert picked out. */
function hourChart(a: AlertDetail): string {
  const i = a.intraday!;
  const { today, usual } = i.hours!;
  const flagged = (h: number) => h < i.hour && (i.window === "today" || h >= i.hour - 3);
  const max = Math.max(1, ...today, ...usual);
  const bar = (v: number, color: string, title: string) => {
    const h = v > 0 ? Math.max(2, Math.round((v / max) * 84)) : 0;
    return `<td valign="bottom" width="50%" style="padding:0;vertical-align:bottom" title="${esc(title)}">${h ? `<div style="height:${h}px;line-height:${h}px;font-size:1px;background:${color};border-radius:2px 2px 0 0">&nbsp;</div>` : ""}</td>`;
  };
  const cells = Array.from({ length: 24 }, (_, h) => {
    const t = h < i.hour ? today[h] ?? 0 : 0;
    const label = `${hh(h)}–${hh(h + 1)}`;
    return `<td valign="bottom" style="padding:0 2px;height:88px;vertical-align:bottom"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed;height:88px"><tr>
${bar(t, flagged(h) ? C.accent : C.barSame, `Today ${label}: ${n(t)} visits`)}${bar(usual[h] ?? 0, C.bar, `Usual ${weekday(a.day)} ${label}: ${n(usual[h] ?? 0)} visits`)}
</tr></table></td>`;
  }).join("");
  const axis = [0, 6, 12, 18].map((h) => `<td colspan="6" style="font-size:11px;color:${C.faint};padding-top:6px">${hh(h)}</td>`).join("");
  const windowLabel = i.window === "today" ? `Today to ${hh(i.hour)}` : `Today ${hh(i.hour - 3)}–${hh(i.hour)}`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed"><tr>${cells}</tr><tr>${axis}</tr></table>
<div style="font-size:11px;color:${C.muted};margin-top:8px">
${swatch(C.accent)}&nbsp;${esc(windowLabel)}${i.window === "last3h" ? `&nbsp;&nbsp;${swatch(C.barSame)}&nbsp;Earlier today` : ""}
&nbsp;&nbsp;${swatch(C.bar)}&nbsp;Usual ${esc(weekday(a.day))} (median of ${i.history.length})</div>`;
}

function statCell(label: string, value: string, note: string, color = C.ink) {
  return `<td valign="top" style="padding:14px 16px;background:#faf9f8;border-radius:10px">
<div style="font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:${C.muted}">${esc(label)}</div>
<div style="font-size:26px;font-weight:800;line-height:1.15;margin-top:4px;color:${color}">${esc(value)}</div>
<div style="font-size:12px;color:${C.muted};margin-top:2px">${esc(note)}</div></td>`;
}

function driverTable(title: string, rows: Driver[], kind: AnomalyKind): string {
  if (!rows.length) return "";
  const body = rows
    .map((r) => {
      const change = moverChange(r);
      return `<tr>
<td style="padding:7px 0;border-top:1px solid ${C.rule};font-size:13px;color:${C.ink};word-break:break-all">${esc(r.name || "(none)")}</td>
<td align="right" width="64" style="width:64px;padding:7px 0 7px 10px;border-top:1px solid ${C.rule};font-size:13px;font-weight:700;white-space:nowrap">${n(r.value)}</td>
<td align="right" width="76" style="width:76px;padding:7px 0 7px 10px;border-top:1px solid ${C.rule};font-size:12px;color:${C.muted};white-space:nowrap">usual ${n(r.usual)}</td>
<td align="right" width="64" style="width:64px;padding:7px 0 7px 10px;border-top:1px solid ${C.rule};font-size:12px;font-weight:700;white-space:nowrap;color:${kind === "spike" ? C.ink : C.neg}">${change}</td></tr>`;
    })
    .join("");
  return `<div style="font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:${C.muted};margin:18px 0 4px">${esc(title)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${body}</table>`;
}

function anomalySection(a: AlertDetail, base: string): string {
  const k = KIND[a.kind];
  const ratio = a.expected ? a.value / a.expected : 0;
  const changeValue = a.kind === "spike" ? (ratio >= 2 ? `${ratio.toFixed(1)}×` : `+${Math.round((ratio - 1) * 100)}%`) : `−${Math.round((1 - ratio) * 100)}%`;
  const dayLink = `${base}/s/${a.siteId}?from=${a.day}&to=${a.day}`;
  const monthLink = `${base}/s/${a.siteId}?from=${addDays(a.day, -27)}&to=${a.day}`;
  const metrics = otherMetrics(a);
  const baselineList = a.intraday
    ? a.intraday.history.map((v) => n(v)).join(" · ")
    : a.baseline.map((b) => `${date(b.day, { day: "numeric", month: "short" })}: ${n(b.visitors)}`).join(" · ");
  const i = a.intraday;
  const valueLabel = i ? (i.window === "today" ? "Visits so far" : `Visits ${hh(i.hour - 3)}–${hh(i.hour)}`) : "Visitors";
  const usualLabel = i ? (i.window === "today" ? `Usual by ${hh(i.hour)}` : `Usual ${hh(i.hour - 3)}–${hh(i.hour)}`) : `Usual ${weekday(a.day)}`;
  const movers = a.drivers
    ? [
        driverTable("Sources", topMovers(a.drivers.sources, a.kind), a.kind),
        driverTable("Pages", topMovers(a.drivers.pages, a.kind), a.kind),
        driverTable("Countries", topMovers(a.drivers.countries, a.kind), a.kind),
      ].join("")
    : "";
  const last = a.lastEventAt
    ? `${new Date(a.lastEventAt * 1000).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }).replace(",", "").replace(/ (\d\d:\d\d)$/, ", $1")} UTC`
    : null;

  return `<tr><td style="padding:16px 28px 6px">
<span style="display:inline-block;padding:4px 10px;border-radius:999px;background:${k.pillBg};color:${k.pillFg};font-size:12px;font-weight:700">${k.arrow}&nbsp; ${k.label}</span>
<div style="font-size:24px;font-weight:800;margin:12px 0 2px;color:${C.ink}"><a href="${esc(`https://${a.domain}`)}" style="color:${C.ink};text-decoration:none">${esc(a.domain)}</a></div>
<div style="font-size:14px;color:${C.muted}">${esc(longDay(a.day))}${i ? ` · ${esc(i.window === "today" ? `so far, to ${hh(i.hour)}` : `${hh(i.hour - 3)}–${hh(i.hour)}`)}` : ""}</div>
</td></tr>
<tr><td style="padding:16px 28px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:8px 0;margin:0 -8px"><tr>
${statCell(valueLabel, n(a.value), i ? `${weekday(a.day)}, to ${hh(i.hour)}` : shortDay(a.day), a.kind === "spike" ? C.ink : C.neg)}
${statCell(usualLabel, `~${n(a.expected)}`, `median of ${i ? i.history.length : 6} ${weekday(a.day)}s`)}
${statCell("Change", changeValue, a.kind === "spike" ? "above usual" : "below usual", a.kind === "spike" ? C.ink : C.neg)}
</tr></table></td></tr>
<tr><td style="padding:22px 28px 0">
${
  i?.hours
    ? `<div style="font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:${C.muted};margin-bottom:10px">Visits by hour, today vs a usual ${esc(weekday(a.day))}</div>
${hourChart(a)}`
    : `<div style="font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:${C.muted};margin-bottom:10px">Visitors, last 4 weeks${i ? " (today so far)" : ""}</div>
${barChart(a)}`
}
${baselineList ? `<div style="font-size:12px;color:${C.muted};margin-top:12px;line-height:1.5">Previous ${esc(weekday(a.day))}s${i ? (i.window === "today" ? ` by ${hh(i.hour)}` : `, ${hh(i.hour - 3)}–${hh(i.hour)}`) : ""}: ${esc(baselineList)}</div>` : ""}
</td></tr>
${i ? "" : `<tr><td style="padding:20px 28px 0">
<div style="font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:${C.muted};margin-bottom:4px">The rest of the day</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
${metrics
  .map(
    (m) => `<tr><td style="padding:7px 0;border-top:1px solid ${C.rule};font-size:13px;color:${C.muted}">${m.label}</td>
<td align="right" width="64" style="width:64px;padding:7px 0 7px 10px;border-top:1px solid ${C.rule};font-size:13px;font-weight:700;white-space:nowrap">${esc(m.value)}</td>
<td align="right" width="76" style="width:76px;padding:7px 0 7px 10px;border-top:1px solid ${C.rule};font-size:12px;color:${C.muted};white-space:nowrap">usual ${esc(m.usual)}</td>
<td align="right" width="64" style="width:64px;padding:7px 0 7px 10px;border-top:1px solid ${C.rule};font-size:12px;font-weight:700;white-space:nowrap">${esc(m.delta)}</td></tr>`,
  )
  .join("")}
</table></td></tr>`}
<tr><td style="padding:4px 28px 0">
${
  a.kind === "outage"
    ? `<div style="margin-top:18px;padding:14px 16px;border-radius:10px;background:${C.accentSoft};color:${C.ink};font-size:13px;line-height:1.55">
<b>What to check</b><br>
1. Is the tracking snippet still on the site? Admin → Sites → ${esc(a.domain)} → Install → <i>Check installation</i>.<br>
2. Did a deploy, CMS change or consent banner remove or block it?<br>
3. ${last ? `The last event arrived ${esc(last)}.` : "No recent events have arrived."}</div>`
    : movers
      ? `<div style="font-size:15px;font-weight:800;margin-top:22px;color:${C.ink}">Where the change came from</div>
<div style="font-size:12px;color:${C.muted};margin-top:2px">${i ? `Visitors so far today vs their usual by ${hh(i.hour)} (previous 4 weeks)` : "Visitors that day vs their usual daily visitors over the previous 4 weeks"}</div>${movers}`
      : ""
}
</td></tr>
<tr><td style="padding:22px 28px 28px">
${button(dayLink, `Open ${shortDay(a.day)}`, true)}&nbsp;&nbsp;${button(monthLink, "Last 4 weeks", false)}
</td></tr>`;
}

const SPOTTED_NIGHTLY =
  "Each night, every site's visitors are compared with the same weekday over the previous six weeks. A day is flagged when it's far outside that range: at least twice the usual (a spike), half or less (a drop), or close to zero on a normally busy site (a possible outage). A run of unusual days is reported once.";
const SPOTTED_HOURLY =
  "Every hour, each site's visits so far today, and in the last three hours, are compared with the same hours on the same weekday over the previous six weeks. An alert is sent when the day so far is far above or below its usual, when the last three hours bring several times the usual visits (a burst), or when a normally busy stretch goes almost silent (a possible outage). Each site sends at most one of these a day.";

/** The explanation(s) that fit the alerts in this email. */
const howSpotted = (items: AlertDetail[]) => [
  ...(items.some((a) => !a.intraday) ? [SPOTTED_NIGHTLY] : []),
  ...(items.some((a) => a.intraday) ? [SPOTTED_HOURLY] : []),
];

export function renderAlertEmail(opts: { appHost?: string; items: AlertDetail[]; test?: boolean }): { subject: string; text: string; html: string } {
  const base = opts.appHost ? `https://${opts.appHost}` : "";
  const items = opts.items;
  const subject = `${opts.test ? "[Test] " : ""}${subjectFor(items)}`;
  const heading = items.length === 1 ? `Unusual traffic on ${items[0].domain}` : `${items.length} unusual days on your sites`;
  const preheader = items.map((a) => `${a.domain}: ${n(a.value)} visitors on ${shortDay(a.day)}, ${changeText(a)}`).join(" · ");
  const divider = `<tr><td style="padding:0 28px"><div style="border-top:1px solid ${C.rule};font-size:1px;line-height:1px">&nbsp;</div></td></tr>`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.bg}">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};font-family:${FONT};color:${C.ink}"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px">
<tr><td style="padding:0 6px 14px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="font-size:15px;font-weight:800;color:${C.ink}"><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${C.accent};vertical-align:-1px"></span>&nbsp; Quick Web Analytics</td>
<td align="right" style="font-size:12px;color:${C.muted}">${opts.test ? "Test alert" : "Traffic alert"}</td></tr></table></td></tr>
<tr><td style="background:${C.card};border-radius:16px;border:1px solid ${C.rule}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td style="padding:26px 28px 0">
<div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${C.accent};font-weight:700">${opts.test ? "Test alert · from your data" : "Anomaly detected"}</div>
${items.length > 1 ? `<div style="font-size:22px;font-weight:800;margin-top:6px;line-height:1.25">${esc(heading)}</div>
<div style="font-size:14px;color:${C.muted};margin-top:6px">${esc(items.map((a) => `${a.domain} (${KIND[a.kind].label.toLowerCase()}, ${shortDay(a.day)})`).join(", "))}</div>` : ""}
</td></tr>
${items.map((a) => anomalySection(a, base)).join(divider)}
</table></td></tr>
<tr><td style="padding:18px 14px 0;font-size:12px;line-height:1.6;color:${C.muted}">
${howSpotted(items)
  .map((t) => `<b style="color:${C.ink}">How this was spotted.</b> ${t}<br><br>`)
  .join("")}
You're getting this because alerts are on for ${esc([...new Set(items.map((a) => a.domain))].join(", "))}. Change which sites in ${base ? `<a href="${esc(base)}/admin" style="color:${C.muted}">Admin → Alerts</a>` : "Admin → Alerts"}, or with the <b>Alerts</b> bell on a site's page.
</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    opts.test ? "TEST ALERT (sample from your data)" : "Quick Web Analytics: traffic alert",
    "",
    heading,
    "",
    ...items.flatMap((a) => {
      const m = otherMetrics(a);
      const movers = a.drivers
        ? (["sources", "pages", "countries"] as const).flatMap((key) => {
            const rows = topMovers(a.drivers![key], a.kind);
            return rows.length ? [`  ${key[0].toUpperCase()}${key.slice(1)}: ${rows.map((r) => `${r.name || "(none)"} ${n(r.value)} (usual ${n(r.usual)})`).join("; ")}`] : [];
          })
        : [];
      return [
        `${KIND[a.kind].label.toUpperCase()}: ${a.domain}, ${longDay(a.day)}`,
        a.intraday
          ? `  Visits ${windowText(a.intraday)}: ${n(a.value)} (usual ~${n(a.expected)}): ${changeText(a)}`
          : `  Visitors: ${n(a.value)} (usual ${weekday(a.day)} ~${n(a.expected)}): ${changeText(a)}`,
        ...m.map((x) => `  ${x.label}: ${x.value} (usual ${x.usual}) ${x.delta}`),
        a.intraday
          ? `  Previous ${weekday(a.day)}s, ${a.intraday.window === "today" ? `by ${hh(a.intraday.hour)}` : `${hh(a.intraday.hour - 3)}–${hh(a.intraday.hour)}`}: ${a.intraday.history.map((v) => n(v)).join(", ")}`
          : a.baseline.length ? `  Previous ${weekday(a.day)}s: ${a.baseline.map((b) => n(b.visitors)).join(", ")}` : "",
        ...(movers.length ? ["  Where the change came from:", ...movers] : []),
        a.kind === "outage" ? "  Check the tracking snippet is still installed (Admin > Sites > Install > Check installation)." : "",
        `  Open the day: ${base}/s/${a.siteId}?from=${a.day}&to=${a.day}`,
        "",
      ].filter(Boolean);
    }),
    ...howSpotted(items).map((t) => `How this was spotted: ${t}`),
    "Change which sites send alerts in Admin > Alerts, or with the Alerts bell on a site's page.",
  ].join("\n");

  return { subject, text, html };
}

/** A realistic made-up alert, for previews and for the test email when there's no real anomaly yet. */
export function sampleAlert(day = "2026-10-05"): AlertDetail {
  const history: DayFigures[] = Array.from({ length: 28 }, (_, i) => {
    const d = addDays(day, i - 27);
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    const v = Math.round((dow === 0 || dow === 6 ? 620 : 980) * (1 + 0.08 * Math.sin(i * 1.3)));
    return { day: d, visitors: v, visits: Math.round(v * 1.12), pageviews: Math.round(v * 2.6), bounces: Math.round(v * 0.45), duration_sum: Math.round(v * 1.12 * 118) };
  });
  const last = history[27];
  Object.assign(last, { visitors: 2410, visits: 2690, pageviews: 5120, bounces: 1480, duration_sum: 2690 * 94 });
  const baseline = [6, 5, 4, 3, 2, 1].map((w) => ({ ...history[27 - 7 * w] ?? history[0], day: addDays(day, -7 * w) })).filter((d) => d.day >= history[0].day);
  return {
    siteId: 0, domain: "example.com", day, kind: "spike", value: 2410, expected: 980, history, baseline,
    drivers: {
      sources: [{ name: "news.ycombinator.com", value: 1210, usual: 6 }, { name: "Google", value: 640, usual: 590 }, { name: "Reddit", value: 180, usual: 22 }, { name: "Direct", value: 260, usual: 240 }],
      pages: [{ name: "/blog/how-we-cut-costs", value: 1330, usual: 12 }, { name: "/", value: 520, usual: 410 }, { name: "/pricing", value: 210, usual: 96 }],
      countries: [{ name: "United States", value: 1020, usual: 300 }, { name: "Germany", value: 210, usual: 70 }, { name: "United Kingdom", value: 300, usual: 210 }],
    },
  };
}

/** Sent once when a site hits its daily event cap and stops recording until midnight UTC. */
export function renderCapEmail(opts: { appHost?: string; domain: string; siteId: number; cap: number; day: string }): { subject: string; text: string; html: string } {
  const base = opts.appHost ? `https://${opts.appHost}` : "";
  const subject = `⚠ ${opts.domain} hit its daily limit of ${n(opts.cap)} events. Recording paused until midnight UTC`;
  const admin = `${base}/admin`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.bg}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};font-family:${FONT};color:${C.ink}"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px">
<tr><td style="padding:0 6px 14px;font-size:15px;font-weight:800"><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${C.accent};vertical-align:-1px"></span>&nbsp; Quick Web Analytics</td></tr>
<tr><td style="background:${C.card};border-radius:16px;border:1px solid ${C.rule};padding:28px">
<span style="display:inline-block;padding:4px 10px;border-radius:999px;background:${C.neg};color:#fff;font-size:12px;font-weight:700">⚠&nbsp; Daily limit reached</span>
<div style="font-size:24px;font-weight:800;margin:12px 0 4px">${esc(opts.domain)}</div>
<div style="font-size:14px;color:${C.muted}">${esc(longDay(opts.day))} (UTC)</div>
<p style="font-size:15px;line-height:1.6;margin:18px 0 0">The site sent <b>${n(opts.cap)} events</b> today, its daily limit, so Quick Web Analytics has <b>stopped recording it until midnight UTC</b>. This limit is a brake on Cloudflare costs. Events beyond it are dropped before they're stored.</p>
<div style="margin-top:18px;padding:14px 16px;border-radius:10px;background:#faf9f8;font-size:13px;line-height:1.6">
<b>If this is real traffic</b> (a launch, a big link), raise the limit: Admin → Sites → ${esc(opts.domain)} → Settings → Daily event limit. Recording resumes as soon as you save.<br>
<b>If it isn't</b> (a bot or a flood), leave it. Today's numbers for this site will be incomplete, and recording restarts at midnight UTC.</div>
<div style="margin-top:22px">${button(admin, "Open site settings", true)}&nbsp;&nbsp;${button(`${base}/s/${opts.siteId}?range=today`, "See today", false)}</div>
</td></tr>
<tr><td style="padding:18px 14px 0;font-size:12px;line-height:1.6;color:${C.muted}">You're getting this because you're an admin or have alerts on for ${esc(opts.domain)}. It's sent at most once per site per day.</td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    `${opts.domain} hit its daily limit of ${n(opts.cap)} events on ${longDay(opts.day)} (UTC).`,
    "Quick Web Analytics has stopped recording it until midnight UTC (a brake on Cloudflare costs).",
    "",
    `If it's real traffic, raise the limit: Admin > Sites > ${opts.domain} > Settings > Daily event limit (${admin}). Recording resumes as soon as you save.`,
    "If it isn't (a bot or a flood), leave it: today's numbers will be incomplete and recording restarts at midnight UTC.",
  ].join("\n");
  return { subject, text, html };
}
