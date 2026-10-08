import type { Env } from "../env";
import { siteByDomain } from "../sites";
import { isBot, pagePath, sessionAttrs } from "./enrich";
import { clientIp, hostnameAllowed, ipBlocked } from "./ip";
import { parsePlausiblePayload, PayloadError } from "./plausible";
import { parseQwaPayload } from "./qwa";
import type { RawEvent, SiteEvent } from "./types";
import { salts, visitorId } from "./visitor";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: { ...CORS, "access-control-max-age": "86400" } });
}

type Ctx = { waitUntil(p: Promise<unknown>): void };

/** POST /api/event: Plausible-compatible endpoint. */
export const handlePlausibleEvent = (req: Request, env: Env, ctx: Ctx) => handleEvent(req, env, ctx, parsePlausiblePayload);

/** POST /e: the QWA tracker's endpoint. */
export const handleQwaEvent = (req: Request, env: Env, ctx: Ctx) => handleEvent(req, env, ctx, parseQwaPayload);

/** Always answers fast; processing continues in waitUntil. */
async function handleEvent(req: Request, env: Env, ctx: Ctx, parse: (body: unknown) => RawEvent): Promise<Response> {
  let raw: RawEvent;
  try {
    raw = parse(JSON.parse(await req.text()));
  } catch (e) {
    const msg = e instanceof PayloadError ? e.message : "invalid JSON";
    return new Response(JSON.stringify({ errors: { request: msg } }), { status: 400, headers: { ...CORS, "content-type": "application/json" } });
  }
  ctx.waitUntil(ingest(raw, req, env).catch((err) => console.error("ingest failed", err)));
  return new Response("ok", { status: 202, headers: CORS });
}

/** Shared by both front doors (compat and, later, the QWA tracker). */
export async function ingest(raw: RawEvent, req: Request, env: Env): Promise<void> {
  const ua = req.headers.get("user-agent") ?? "";
  if (isBot(ua)) return;
  const ip = clientIp(req);
  const nowMs = Date.now();
  const { current, previous } = await salts(env.DB, nowMs);
  const kind = raw.name === "pageview" ? "pageview" : raw.name === "engagement" ? "engagement" : "custom";
  const cf = req.cf as IncomingRequestCfProperties | undefined;
  const session = sessionAttrs(raw, ua, cf);

  for (const domain of raw.domains.slice(0, 5)) {
    const site = await siteByDomain(env, domain);
    if (!site) continue;
    if (!hostnameAllowed(raw.url.hostname, site.allowed_hostnames)) continue;
    if (ipBlocked(ip, site.ip_blocklist)) continue;

    const ev: SiteEvent = {
      ts: Math.floor(nowMs / 1000),
      kind,
      name: raw.name,
      hostname: raw.url.hostname.toLowerCase(),
      path: pagePath(raw),
      props: raw.props,
      scrollDepth: raw.scrollDepth,
      engagedMs: raw.engagedMs,
      interactive: raw.interactive,
      visitor: await visitorId(current, site.id, ip, ua),
      prevVisitor: previous ? await visitorId(previous, site.id, ip, ua) : null,
      via: raw.via,
      session,
    };
    await env.SITE.get(env.SITE.idFromName(String(site.id))).ingest(site.id, ev);
  }
}
