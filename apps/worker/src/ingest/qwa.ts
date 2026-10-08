// Parses the QWA tracker payload: s site, n name, u url, r referrer, p props, h hash mode,
// i interactive, sd scroll depth, e engaged ms. Same rules as the Plausible format.
import { parsePlausiblePayload } from "./plausible";
import type { RawEvent } from "./types";

export function parseQwaPayload(body: unknown): RawEvent {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const raw = parsePlausiblePayload({ n: b.n, u: b.u, d: b.s, r: b.r, p: b.p, h: b.h, i: b.i, sd: b.sd, e: b.e });
  return { ...raw, via: "qwa" };
}
