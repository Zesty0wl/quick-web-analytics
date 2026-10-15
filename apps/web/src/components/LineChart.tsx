import { useEffect, useMemo, useRef, useState } from "react";
import type { Metric, TimeGrain } from "@qwa/shared";
import { bucketLabel, bucketTitle } from "../dates";
import { ANOMALY_LABEL, change, METRIC_LABELS, metricValue } from "../format";
import { Alarm } from "./Icons";

export interface ChartMark {
  index: number;
  kind: "spike" | "drop" | "outage";
  text: string;
  /** The unusual day (for `onMark`). */
  day?: string;
  /** Where several fall on one point, the highest is the alarm drawn (the others are listed in the tooltip). */
  rank?: number;
}

interface Props {
  keys: string[];
  current: number[];
  compareKeys?: string[];
  compare?: number[];
  metric: Metric;
  grain: TimeGrain;
  height?: number;
  onSelect?: (index: number) => void;
  /** Anomalies: an alarm icon above the point, explained in the tooltip. */
  marks?: ChartMark[];
  /** Makes the alarms buttons, e.g. to open an explanation of that day. */
  onMark?: (m: ChartMark) => void;
  /** For values that aren't dashboard metrics (e.g. Search Console's CTR): label and formatting. */
  fmt?: { label: string; value: (v: number) => string; count?: boolean };
}

/**
 * The alarms to draw: one per point (the highest-ranked of any there), each lifted clear of an alarm on a nearby
 * point that would otherwise cover it, so every alarm can be clicked.
 */
function placeMarks(marks: ChartMark[], px: (index: number) => number): { m: ChartMark; lift: number }[] {
  const best = new Map<number, ChartMark>();
  for (const m of marks) {
    const had = best.get(m.index);
    if (!had || (m.rank ?? 0) > (had.rank ?? 0)) best.set(m.index, m);
  }
  const placed: { m: ChartMark; lift: number }[] = [];
  for (const m of [...best.values()].sort((a, b) => a.index - b.index)) {
    let lift = 0;
    while (placed.some((p) => Math.abs(px(p.m.index) - px(m.index)) < 24 && p.lift === lift)) lift += 26;
    placed.push({ m, lift });
  }
  return placed;
}

/** A "nice" axis maximum: 1, 2, 2.5 or 5 × 10^n. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

const axisFmt = new Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 });
const NON_COUNT = new Set<Metric>(["bounce_rate", "scroll_depth", "visit_duration", "time_on_page", "views_per_visit", "inp", "lcp", "cls", "ttfb", "fcp", "inp_delay", "inp_processing", "inp_presentation"]);

const W = 1000;
const H = 300;

export function LineChart({ keys, current, compareKeys, compare, metric, grain, height = 320, onSelect, marks = [], onMark, fmt }: Props) {
  const label = fmt?.label ?? METRIC_LABELS[metric];
  const show = (v: number) => (fmt ? fmt.value(v) : metricValue(metric, v));
  const plot = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  // The plot's width, to keep alarms on neighbouring points from covering each other.
  const [plotWidth, setPlotWidth] = useState(1000);
  useEffect(() => {
    if (!plot.current) return;
    const ro = new ResizeObserver(([e]) => setPlotWidth(e.contentRect.width || 1000));
    ro.observe(plot.current);
    return () => ro.disconnect();
  }, []);
  const n = keys.length;
  const hasCmp = !!compare && compare.length > 0;
  // Scale to what's drawn: the comparison is only drawn as far as the current period goes (e.g. yesterday's evening
  // isn't shown against this morning), so its later values mustn't stretch the axis.
  const max = useMemo(() => niceMax(Math.max(0, ...current, ...(hasCmp ? compare!.slice(0, n) : []))), [current, compare, hasCmp, n]);
  const x = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => H - (v / max) * H;
  const path = (vals: number[]) => vals.slice(0, n).map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const line = path(current);
  const area = n ? `${line}L${x(n - 1).toFixed(1)},${H}L${x(0).toFixed(1)},${H}Z` : "";
  // One format for the whole axis: compact (2.5k, 10k) once the top tick reaches 10k, so labels don't mix styles.
  const isCount = fmt ? !!fmt.count : !NON_COUNT.has(metric);
  const tick = (v: number) => (max >= 10_000 && isCount ? axisFmt.format(v) : fmt ? fmt.value(v) : metricValue(metric, v, { compact: true }));
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ top: (1 - f) * 100, label: tick(max * f), base: f === 0 }));
  const xl = n <= 1 ? [0] : Array.from({ length: Math.min(6, n) }, (_, k) => Math.round((k * (n - 1)) / (Math.min(6, n) - 1)));

  const onMove = (e: React.MouseEvent) => {
    const r = plot.current!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    setHover(n <= 1 ? 0 : Math.round(f * (n - 1)));
  };

  const h = hover;
  const hx = h === null ? 0 : (x(h) / W) * 100;
  const cur = h === null ? 0 : current[h] ?? 0;
  const prev = h !== null && hasCmp ? compare![h] : undefined;
  const ch = prev === undefined ? null : change(cur, prev);
  const flip = hx > 70;
  const hoverMarks = h === null ? [] : marks.filter((m) => m.index === h);

  return (
    <>
      <div className="chart">
        <div className="ylab" style={{ height }}>
          {grid.map((g) => <span key={g.top} style={{ top: `${g.top}%` }}>{g.label}</span>)}
        </div>
        <div
          className="plot"
          ref={plot}
          style={{ height }}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
          onClick={() => h !== null && onSelect?.(h)}
          role="img"
          aria-label={`${label} over time`}
        >
          {grid.map((g) => <div key={g.top} className={g.base ? "grid base" : "grid"} style={{ top: `${g.top}%` }} />)}
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
            {area && <path d={area} fill="color-mix(in srgb, var(--color-accent) 10%, transparent)" />}
            {hasCmp && <path d={path(compare!)} fill="none" stroke="var(--color-neutral-500)" strokeWidth={1.5} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />}
            {line && <path d={line} fill="none" stroke="var(--color-accent)" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />}
          </svg>
          {placeMarks(marks, (i) => (x(i) / W) * plotWidth).map(({ m, lift }) => {
            const top = (y(current[m.index] ?? 0) / H) * 100;
            const style = { left: `${(x(m.index) / W) * 100}%`, top: top < 12 ? `calc(${top}% + ${10 + lift}px)` : `calc(${top}% - ${30 + lift}px)` };
            if (onMark) {
              return (
                <button
                  key={`${m.index}-${m.kind}`}
                  className={`chart-mark ${m.kind}`}
                  style={style}
                  onClick={(e) => {
                    e.stopPropagation();
                    onMark(m);
                  }}
                  onMouseMove={(e) => e.stopPropagation()}
                  title={`${ANOMALY_LABEL[m.kind]}: see why`}
                  aria-label={`${ANOMALY_LABEL[m.kind]}: ${m.text}. See why`}
                >
                  <Alarm size={13} />
                </button>
              );
            }
            return (
              <div
                key={`${m.index}-${m.kind}`}
                className={`chart-mark ${m.kind}`}
                style={{ left: `${(x(m.index) / W) * 100}%`, top: top < 12 ? `calc(${top}% + 10px)` : `calc(${top}% - 30px)` }}
                aria-label={`${ANOMALY_LABEL[m.kind]}: ${m.text}`}
                role="img"
              >
                <Alarm size={13} />
              </div>
            );
          })}
          {h !== null && (
            <>
              <div className="xh" style={{ left: `${hx}%` }} />
              <div className="mk" style={{ left: `${hx}%`, top: `${(y(cur) / H) * 100}%` }} />
              <div className="tip" style={{ left: `${hx}%`, transform: flip ? "translateX(calc(-100% - 12px))" : "translateX(12px)" }}>
                <div className="d">{bucketTitle(keys[h], grain)}</div>
                <div className="r"><span>{label}</span><b>{show(cur)}</b></div>
                {prev !== undefined && (
                  <div className="r p"><span>{compareKeys?.[h] ? bucketTitle(compareKeys[h], grain) : "Comparison"}</span><span>{show(prev)}</span></div>
                )}
                {ch !== null && <div className="ch">{ch > 0 ? "+" : ch < 0 ? "−" : ""}{Math.abs(ch).toFixed(1)}%</div>}
                {hoverMarks.map((m) => (
                  <div key={`${m.day ?? m.index}-${m.kind}`} className={`an ${m.kind}`}><Alarm size={12} /><span><b>{ANOMALY_LABEL[m.kind]}.</b> {m.text}</span></div>
                ))}
                {onMark && hoverMarks.length > 0 && <div className="hint">Click the alarm to see why</div>}
                {onSelect && grain !== "hour" && grain !== "quarter_hour" && <div className="hint">Click to zoom in</div>}
              </div>
            </>
          )}
        </div>
      </div>
      <div className="xlabels">
        <div />
        <div className="row">
          {xl.map((i, k) => (
            <span key={i} style={{ left: `${(x(i) / W) * 100}%`, transform: k === 0 ? "none" : k === xl.length - 1 ? "translateX(-100%)" : "translateX(-50%)" }}>
              {keys[i] ? bucketLabel(keys[i], grain) : ""}
            </span>
          ))}
        </div>
      </div>
    </>
  );
}
