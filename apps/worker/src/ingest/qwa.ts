// Parses the QWA tracker payload: s site, n name, u url, r referrer, p props, h hash mode,
// i interactive, sd scroll depth, e engaged ms, and on engagement events pv (page view id) and wv (Web Vitals).
// Same rules as the Plausible format.
import { parsePlausiblePayload } from "./plausible";
import type { RawEvent, Vitals } from "./types";

export function parseQwaPayload(body: unknown): RawEvent {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const raw = parsePlausiblePayload({ n: b.n, u: b.u, d: b.s, r: b.r, p: b.p, h: b.h, i: b.i, sd: b.sd, e: b.e });
  return { ...raw, via: "qwa", vitals: raw.name === "engagement" ? parseVitals(b.pv, b.wv) : null };
}

const ms = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 120_000) : 0;
};
// Selectors and element descriptions: printable, short.
const text = (v: unknown) => (typeof v === "string" ? v.replace(/[^\x20-\x7e]/g, "").slice(0, 120) : "");

/**
 * wv: { i: INP, it: INP target selector, ty: interaction type, d: input delay, p: processing, r: presentation delay,
 *       l: LCP, le: LCP element, c: CLS (a float), t: TTFB, f: FCP }. Missing or bad values become 0 / "".
 */
export function parseVitals(pv: unknown, wv: unknown): Vitals | null {
  if (!wv || typeof wv !== "object") return null;
  const w = wv as Record<string, unknown>;
  const id = typeof pv === "number" && Number.isSafeInteger(pv) && pv > 0 ? pv : 0;
  // CLS × 1000; -1 when the browser can't measure it (0 is a valid, perfect score).
  const c = typeof w.c === "number" && Number.isFinite(w.c) && w.c >= 0 ? Math.min(Math.round(w.c * 1000), 10_000) : -1;
  const v: Vitals = {
    pv: id,
    inp: ms(w.i),
    inp_target: text(w.it),
    inp_type: text(w.ty).slice(0, 20),
    inp_delay: ms(w.d),
    inp_processing: ms(w.p),
    inp_presentation: ms(w.r),
    lcp: ms(w.l),
    lcp_element: text(w.le),
    cls: c,
    ttfb: ms(w.t),
    fcp: ms(w.f),
  };
  return v.inp || v.lcp || v.cls >= 0 || v.ttfb || v.fcp ? v : null;
}
