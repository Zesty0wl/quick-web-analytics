import { useMemo, useRef, useState } from "react";
import type { Metric, TimeGrain } from "@qwa/shared";
import { bucketLabel, bucketTitle } from "../dates";
import { change, METRIC_LABELS, metricValue } from "../format";

interface Props {
  keys: string[];
  current: number[];
  compareKeys?: string[];
  compare?: number[];
  metric: Metric;
  grain: TimeGrain;
  height?: number;
  onSelect?: (index: number) => void;
}

/** A "nice" axis maximum: 1, 2, 2.5 or 5 × 10^n. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

const axisFmt = new Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 });
const NON_COUNT = new Set<Metric>(["bounce_rate", "scroll_depth", "visit_duration", "time_on_page", "views_per_visit"]);

const W = 1000;
const H = 300;

export function LineChart({ keys, current, compareKeys, compare, metric, grain, height = 320, onSelect }: Props) {
  const plot = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const n = keys.length;
  const hasCmp = !!compare && compare.length > 0;
  const max = useMemo(() => niceMax(Math.max(0, ...current, ...(hasCmp ? compare! : []))), [current, compare, hasCmp]);
  const x = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => H - (v / max) * H;
  const path = (vals: number[]) => vals.slice(0, n).map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const line = path(current);
  const area = n ? `${line}L${x(n - 1).toFixed(1)},${H}L${x(0).toFixed(1)},${H}Z` : "";
  // One format for the whole axis: compact (2.5k, 10k) once the top tick reaches 10k, so labels don't mix styles.
  const tick = (v: number) => (max >= 10_000 && !NON_COUNT.has(metric) ? axisFmt.format(v) : metricValue(metric, v, { compact: true }));
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
          aria-label={`${METRIC_LABELS[metric]} over time`}
        >
          {grid.map((g) => <div key={g.top} className={g.base ? "grid base" : "grid"} style={{ top: `${g.top}%` }} />)}
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
            {area && <path d={area} fill="color-mix(in srgb, var(--color-accent) 10%, transparent)" />}
            {hasCmp && <path d={path(compare!)} fill="none" stroke="var(--color-neutral-500)" strokeWidth={1.5} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />}
            {line && <path d={line} fill="none" stroke="var(--color-accent)" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />}
          </svg>
          {h !== null && (
            <>
              <div className="xh" style={{ left: `${hx}%` }} />
              <div className="mk" style={{ left: `${hx}%`, top: `${(y(cur) / H) * 100}%` }} />
              <div className="tip" style={{ left: `${hx}%`, transform: flip ? "translateX(calc(-100% - 12px))" : "translateX(12px)" }}>
                <div className="d">{bucketTitle(keys[h], grain)}</div>
                <div className="r"><span>{METRIC_LABELS[metric]}</span><b>{metricValue(metric, cur)}</b></div>
                {prev !== undefined && (
                  <div className="r p"><span>{compareKeys?.[h] ? bucketTitle(compareKeys[h], grain) : "Comparison"}</span><span>{metricValue(metric, prev)}</span></div>
                )}
                {ch !== null && <div className="ch">{ch > 0 ? "+" : ch < 0 ? "−" : ""}{Math.abs(ch).toFixed(1)}%</div>}
                {onSelect && grain !== "hour" && <div className="hint">Click to zoom in</div>}
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
