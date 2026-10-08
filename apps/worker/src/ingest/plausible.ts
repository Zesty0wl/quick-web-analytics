// Parses the event payload sent by Plausible's tracker (compat layer).
// Fields: n name, u url, d domain(s), r referrer, p/m props, h hash mode,
// i interactive, sd scroll depth, e engagement ms, v version, $ revenue (ignored).
import type { RawEvent } from "./types";

const MAX_NAME = 120;
const MAX_PROPS = 30;
const MAX_PROP_LEN = 300;

export class PayloadError extends Error {}

export function parsePlausiblePayload(body: unknown): RawEvent {
  if (!body || typeof body !== "object") throw new PayloadError("invalid payload");
  const b = body as Record<string, unknown>;

  const name = typeof b.n === "string" ? b.n.trim() : "";
  if (!name || name.length > MAX_NAME) throw new PayloadError("invalid event name");

  if (typeof b.u !== "string") throw new PayloadError("missing url");
  let url: URL;
  try {
    url = new URL(b.u);
  } catch {
    throw new PayloadError("invalid url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "file:" && url.protocol !== "app:") {
    throw new PayloadError("invalid url scheme");
  }

  const domains = (typeof b.d === "string" ? b.d : "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  if (domains.length === 0) throw new PayloadError("missing domain");

  const props = parseProps(b.p ?? b.props ?? b.m ?? b.meta);

  const scrollDepth = toInt(b.sd, 0, 100);
  const engagedMs = toInt(b.e, 0, 30 * 60 * 1000);
  if (name === "engagement" && scrollDepth === null && engagedMs === null) {
    throw new PayloadError("engagement event without sd or e");
  }

  return {
    domains,
    name,
    url,
    referrer: typeof b.r === "string" && b.r ? b.r : null,
    props,
    hashMode: b.h === 1 || b.h === true || b.h === "1",
    interactive: b.i !== false,
    scrollDepth,
    engagedMs,
    via: "plausible",
  };
}

function parseProps(raw: unknown): Record<string, string> {
  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj).slice(0, MAX_PROPS)) {
    if (v === null || v === undefined || typeof v === "object") continue;
    const key = String(k).slice(0, MAX_PROP_LEN);
    const val = String(v).slice(0, MAX_PROP_LEN);
    if (key && val) out[key] = val;
  }
  return out;
}

function toInt(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}
