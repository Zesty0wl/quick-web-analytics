// Anomaly detection on daily visitors: each day is compared with the same weekday over the previous weeks.
//
// Baseline = median of up to 6 earlier same-weekday values (at least 4 needed). Spread = 1.4826 × MAD (a robust
// standard deviation), floored by the Poisson noise √median and 10% of the median, so quiet or very regular sites
// don't alarm on noise. A day is flagged when it is far from the baseline both statistically and in practical terms.

export type AnomalyKind = "spike" | "drop" | "outage";

export interface Anomaly {
  day: string;
  metric: "visitors";
  kind: AnomalyKind;
  value: number;
  expected: number;
  /** Robust z-score (how many spreads from the baseline). */
  score: number;
}

// Calibrated on 22 real sites over 15 months: about two alerts a week across all of them, each a genuine event.
export const ANOMALY_RULES = {
  weeks: 6,
  minWeeks: 4,
  /** Robust z-score needed to flag a spike or drop. */
  z: 5,
  /** And the day must be at least this far from the baseline in visitors… */
  minDelta: 40,
  /** …and at least this ratio above (spike) or below (drop) the baseline. */
  spikeRatio: 2,
  dropRatio: 0.5,
  /** Outage: almost nothing on a day that normally has at least `outageMin` visitors. */
  outageMin: 20,
  outageRatio: 0.05,
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Find anomalies in a daily series (ascending, one entry per day; missing days count as 0). */
export function detectAnomalies(series: { day: string; value: number }[], rules = ANOMALY_RULES): Anomaly[] {
  const byDay = new Map(series.map((p) => [p.day, p.value]));
  const out: Anomaly[] = [];
  for (const { day, value } of series) {
    const history: number[] = [];
    for (let w = 1; w <= rules.weeks; w++) {
      const d = shift(day, -7 * w);
      if (byDay.has(d)) history.push(byDay.get(d)!);
    }
    if (history.length < rules.minWeeks) continue;
    const expected = median(history);
    const mad = median(history.map((x) => Math.abs(x - expected)));
    const spread = Math.max(1.4826 * mad, Math.sqrt(expected), 0.1 * expected, 1);
    const score = (value - expected) / spread;
    const delta = value - expected;
    let kind: AnomalyKind | null = null;
    if (expected >= rules.outageMin && value <= expected * rules.outageRatio) kind = "outage";
    else if (score >= rules.z && delta >= rules.minDelta && value >= expected * rules.spikeRatio) kind = "spike";
    else if (score <= -rules.z && -delta >= rules.minDelta && value <= expected * rules.dropRatio) kind = "drop";
    if (kind) out.push({ day, metric: "visitors", kind, value, expected: Math.round(expected), score: Math.round(score * 10) / 10 });
  }
  return out;
}

function shift(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * Keep only the first day of each episode: a flagged day within 2 days of an earlier one of the same kind is the
 * same event carrying on (a viral week, a broken tracker), so it isn't reported again.
 */
export function episodes(list: Anomaly[]): Anomaly[] {
  return list.filter((a, i) => {
    const prev = list.slice(0, i).reverse().find((p) => p.kind === a.kind);
    return !prev || (Date.parse(a.day) - Date.parse(prev.day)) / 86_400_000 > 2;
  });
}

/** Fill gaps so every day between the first and last has a value (missing days are 0 visitors). */
export function denseSeries(rows: { day: string; value: number }[]): { day: string; value: number }[] {
  if (!rows.length) return [];
  const by = new Map(rows.map((r) => [r.day, r.value]));
  const out: { day: string; value: number }[] = [];
  for (let d = rows[0].day; d <= rows[rows.length - 1].day; d = shift(d, 1)) out.push({ day: d, value: by.get(d) ?? 0 });
  return out;
}

/** One-line description, e.g. "Visitors 3.1× the usual Tuesday (2,410 vs about 780)". */
export function describe(a: Pick<Anomaly, "kind" | "value" | "expected" | "day">): string {
  const weekday = new Date(`${a.day}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  const n = (x: number) => Math.round(x).toLocaleString("en-GB");
  if (a.kind === "outage") return `Almost no visitors (${n(a.value)}) on a ${weekday} that usually has about ${n(a.expected)}. Is the tracker still installed?`;
  if (a.kind === "spike") {
    const ratio = a.expected ? a.value / a.expected : 0;
    return `Visitors ${ratio >= 2 ? `${ratio.toFixed(1)}×` : `+${Math.round((ratio - 1) * 100)}% on`} the usual ${weekday} (${n(a.value)} vs about ${n(a.expected)})`;
  }
  return `Visitors ${Math.round((1 - a.value / Math.max(1, a.expected)) * 100)}% below the usual ${weekday} (${n(a.value)} vs about ${n(a.expected)})`;
}

// ---------- intraday (hourly) check ----------

/**
 * Stricter than the nightly rules: a partial day is noisier. Calibrated on 22 real sites over 30 days: about eight
 * alerts a month across all of them (the same rate as the nightly check), each hours earlier than the nightly one.
 * The burst rule catches a sharp rise in the last three hours that the day so far dilutes (e.g. a pass of the ISS
 * sending a city's searchers to one page): 4× the usual for those hours, +200 visits and the same z. On the same
 * data it adds about one alert a month.
 */
export const INTRADAY_RULES = { ...ANOMALY_RULES, z: 6, spikeRatio: 2.5, dropRatio: 0.4, minDelta: 75, burstRatio: 4, burstMinDelta: 200 };
/** Spikes and drops only from this local hour (early-morning counts are too small to judge). */
export const INTRADAY_MIN_HOUR = 6;

export interface IntradayResult {
  kind: AnomalyKind;
  /** "today": visits from midnight to the last full hour; "last3h": visits in the last three full hours. */
  window: "today" | "last3h";
  value: number;
  expected: number;
  score: number;
}

/** Robust baseline (median and spread) of the same window on earlier same weekdays. */
function baseline(history: number[]) {
  const expected = median(history);
  const mad = median(history.map((x) => Math.abs(x - expected)));
  return { expected, spread: Math.max(1.4826 * mad, Math.sqrt(expected), 0.1 * expected, 1) };
}

/**
 * Today so far vs the same point on earlier same weekdays (visits, which add up hour by hour). A broken tracker
 * (nothing in the last three hours of a normally busy stretch) is checked first, then a spike or drop in the day so
 * far, then a burst in the last three hours.
 */
export function detectIntraday(
  input: { today: number; last3h: number; history: { today: number; last3h: number }[]; hour?: number },
  rules = INTRADAY_RULES,
): IntradayResult | null {
  if (input.history.length < rules.minWeeks) return null;
  const recent = baseline(input.history.map((h) => h.last3h));
  if (recent.expected >= 30 && input.last3h <= recent.expected * rules.outageRatio) {
    return { kind: "outage", window: "last3h", value: input.last3h, expected: Math.round(recent.expected), score: Math.round(((input.last3h - recent.expected) / recent.spread) * 10) / 10 };
  }
  if (input.hour !== undefined && input.hour < INTRADAY_MIN_HOUR) return null;
  const day = baseline(input.history.map((h) => h.today));
  const score = (input.today - day.expected) / day.spread;
  const delta = input.today - day.expected;
  let kind: AnomalyKind | null = null;
  if (score >= rules.z && delta >= rules.minDelta && input.today >= day.expected * rules.spikeRatio) kind = "spike";
  else if (score <= -rules.z && -delta >= rules.minDelta && input.today <= day.expected * rules.dropRatio) kind = "drop";
  if (kind) return { kind, window: "today", value: input.today, expected: Math.round(day.expected), score: Math.round(score * 10) / 10 };
  // A burst: the last three hours far above the same hours on earlier same weekdays.
  const burst = (input.last3h - recent.expected) / recent.spread;
  if (burst >= rules.z && input.last3h - recent.expected >= rules.burstMinDelta && input.last3h >= recent.expected * rules.burstRatio) {
    return { kind: "spike", window: "last3h", value: input.last3h, expected: Math.round(recent.expected), score: Math.round(burst * 10) / 10 };
  }
  return null;
}
