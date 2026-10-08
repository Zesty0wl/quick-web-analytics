import { useEffect, useRef, useState } from "react";
import type { Metric } from "@qwa/shared";
import { change, LOWER_IS_BETTER } from "../format";

/** "↑ +12.4%" / "↓ −3.1%", coloured by good/bad (good = ink, bad = --neg), not by direction. */
export function deltaInfo(metric: Metric, current: number, previous: number | undefined) {
  if (previous === undefined) return null;
  const c = change(current, previous);
  if (c === null) return { text: "new", cls: "delta flat" };
  if (Math.abs(c) < 0.05) return { text: "± 0%", cls: "delta flat" };
  const good = LOWER_IS_BETTER.has(metric) ? c < 0 : c > 0;
  const n = Math.abs(c) >= 1000 ? ">999" : Math.abs(c).toFixed(1);
  return { text: c > 0 ? `↑ +${n}%` : `↓ −${n}%`, cls: good ? "delta good" : "delta bad", growing: c > 0 };
}

export function Delta({ metric, current, previous }: { metric: Metric; current: number; previous: number | undefined }) {
  const d = deltaInfo(metric, current, previous);
  return d ? <span className={d.cls}>{d.text}</span> : null;
}

/** Sparkline: 7% area, dashed comparison, 2px line (ink when growing, accent when declining). */
export function Spark({ current, comparison, growing, height = 52, width }: { current: number[]; comparison?: number[]; growing: boolean; height?: number; width?: number }) {
  const max = Math.max(1, ...current, ...(comparison ?? []));
  const path = (vals: number[]) =>
    vals.length < 2 ? "" : vals.map((v, i) => `${i ? "L" : "M"}${((i / (vals.length - 1)) * 100).toFixed(2)},${(31 - (v / max) * 29).toFixed(2)}`).join("");
  const line = path(current);
  const area = line ? `${line}L100,32L0,32Z` : "";
  return (
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" style={{ width: width ?? "100%", height, display: "block", overflow: "visible" }} aria-hidden>
      {area && <path d={area} fill="color-mix(in srgb, var(--tint) 7%, transparent)" />}
      {comparison && <path d={path(comparison)} fill="none" stroke="var(--color-neutral-500)" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
      {line && <path d={line} fill="none" stroke={growing ? "var(--color-text)" : "var(--color-accent)"} strokeWidth={2} vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

/** 30 per-minute bars: newest in accent, older in ink at 22%. */
export function MinuteBars({ values, height, fill }: { values: number[]; height?: number; fill?: boolean }) {
  const max = Math.max(1, ...values);
  return (
    <div className="minibars" style={fill ? { flex: 1, minHeight: 72 } : { height: height ?? 64 }} role="img" aria-label="Visitors per minute, last 30 minutes">
      {values.map((v, i) => (
        <div key={i} className={i === values.length - 1 ? "now" : ""} style={{ height: `${(v / max) * 100}%` }} title={`${v} visitor${v === 1 ? "" : "s"}, ${values.length - 1 - i} min ago`} />
      ))}
    </div>
  );
}

/** "updated Ns ago", counting up every second. */
export function UpdatedAgo({ at }: { at: number | undefined }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!at) return null;
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return <>updated {s < 60 ? `${s}s` : `${Math.round(s / 60)}m`} ago</>;
}

/** True once the element has scrolled near the viewport (then stays true). */
export function useInView<T extends Element>(margin = "400px"): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen || !ref.current) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: margin });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen, margin]);
  return [ref, seen];
}

interface QueryLike { isFetching: boolean; isPlaceholderData?: boolean; data?: unknown }

/** True while any of these queries is fetching data we don't have yet (first load or a changed range/filter), not on background refreshes. */
export function busyOf(...qs: QueryLike[]): boolean {
  return qs.some((q) => q.isFetching && (q.isPlaceholderData || q.data === undefined));
}

/** Seconds since `busy` turned on, or null if off or not past `delay` ms yet (so fast queries don't flicker). */
export function useBusyFor(busy: boolean, delay = 150): number | null {
  const [secs, setSecs] = useState<number | null>(null);
  useEffect(() => {
    if (!busy) { setSecs(null); return; }
    const start = Date.now();
    const show = setTimeout(() => setSecs(0), delay);
    const tick = setInterval(() => Date.now() - start >= delay && setSecs(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => { clearTimeout(show); clearInterval(tick); };
  }, [busy, delay]);
  return secs;
}

export function Spinner({ size = 12 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden />;
}

function busyText(secs: number, first: boolean): string {
  const verb = first ? "Loading" : "Updating";
  if (secs < 2) return `${verb}…`;
  if (secs < 5) return `${verb}… ${secs}s`;
  return `Still working… ${secs}s · long ranges on busy sites take a while`;
}

/** Wraps a panel: while busy, dims what's there and pins a "Loading… Ns" chip near the top of the visible part. */
export function Busy({ busy, empty, minHeight = 160, className, style, children }: {
  busy: boolean; empty?: boolean; minHeight?: number; className?: string; style?: React.CSSProperties; children: React.ReactNode;
}) {
  const secs = useBusyFor(busy);
  const on = secs !== null;
  return (
    <div className={`busy-wrap${on ? " is-busy" : ""}${className ? ` ${className}` : ""}`} aria-busy={busy} style={{ ...(busy && empty ? { minHeight } : null), ...style }}>
      {on && (
        <div className="busy-anchor">
          <div className="busy-chip" role="status"><Spinner />{busyText(secs, !!empty)}</div>
        </div>
      )}
      {children}
    </div>
  );
}
