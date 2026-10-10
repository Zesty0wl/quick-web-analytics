import { Hono } from "hono";
import { api } from "./api";
import { handleMcp } from "./mcp";
import { authorizationServerMetadata, preflight, protectedResourceMetadata, register, token } from "./oauth";
import { serveCompatScript } from "./compat/scripts";
import type { Env } from "./env";
import { corsPreflight, handlePlausibleEvent, handleQwaEvent } from "./ingest/handler";
import { rotateSalts } from "./ingest/visitor";
import { allSites } from "./sites";
import { anomalyJob } from "./alerts";
import { rollupSite } from "./rollup";

export { SiteDO } from "./do/site";
export { Scheduler } from "./do/scheduler";

const app = new Hono<{ Bindings: Env }>();

// The hourly jobs run on the Scheduler's alarm, which re-arms itself. Make sure it's armed, once per isolate.
let schedulerChecked = false;
const ensureScheduler = (env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) => {
  if (schedulerChecked || !env.SCHEDULER) return;
  schedulerChecked = true;
  ctx.waitUntil(env.SCHEDULER.get(env.SCHEDULER.idFromName("global")).ensure().catch((e) => {
    schedulerChecked = false;
    console.error("scheduler ensure failed", e);
  }));
};
app.use("*", async (c, next) => {
  ensureScheduler(c.env, c.executionCtx);
  await next();
});

const isIngestHost = (env: Env, host: string) =>
  env.INGEST_HOSTS.split(",").map((h) => h.trim().toLowerCase()).includes(host.toLowerCase());

// Plausible-compatible ingestion: served on every host (the app host too, which is handy for testing).
app.options("/api/event", () => corsPreflight());
app.post("/api/event", async (c) => {
  const onIngestHost = isIngestHost(c.env, new URL(c.req.url).hostname);
  const forOrigin = onIngestHost && c.env.ORIGIN_MODE ? c.req.raw.clone() : null;
  const res = await handlePlausibleEvent(c.req.raw, c.env, c.executionCtx);
  if (forOrigin && c.env.ORIGIN_MODE === "passthrough") return fetch(forOrigin);
  if (forOrigin && c.env.ORIGIN_MODE === "mirror") {
    c.executionCtx.waitUntil(fetch(forOrigin).then((r) => r.body?.cancel()).catch((e) => console.warn("origin mirror failed", e)));
  }
  return res;
});
app.get("/js/:file{.+\\.js}", (c) => serveCompatScript(c.req.raw, c.env, c.req.param("file")));

// The QWA tracker and its endpoint (public; bypassed in Cloudflare Access).
app.options("/e", () => corsPreflight());
app.post("/e", (c) => handleQwaEvent(c.req.raw, c.env, c.executionCtx));
app.get("/t.js", async (c) => {
  const asset = await c.env.ASSETS.fetch(new URL("/_tracker/t.js", c.req.url));
  if (!asset.ok) return c.text("Not found", 404);
  return new Response(asset.body, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
      "x-content-type-options": "nosniff",
    },
  });
});

// Ingest-only hosts expose nothing else (during migration, everything else goes to the old origin).
app.use("*", async (c, next) => {
  if (isIngestHost(c.env, new URL(c.req.url).hostname)) {
    return c.env.ORIGIN_MODE ? fetch(c.req.raw) : c.text("Not found", 404);
  }
  await next();
});

// Old dashboard hostnames: the tracker routes above still answer there; everything else moves to APP_HOST.
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  const legacy = (c.env.LEGACY_APP_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (c.env.APP_HOST && legacy.includes(url.hostname.toLowerCase())) {
    const method = c.req.method;
    return c.redirect(`https://${c.env.APP_HOST}${url.pathname}${url.search}`, method === "GET" || method === "HEAD" ? 301 : 308);
  }
  await next();
});

// MCP server for AI agents (token-authenticated; the path is in the Access bypass application).
app.all("/mcp", (c) => handleMcp(c.req.raw, c.env, c.executionCtx as ExecutionContext));
// OAuth for MCP clients that "Connect" (oauth.ts). These paths are in the Access bypass; /oauth/authorize isn't.
app.on(["GET", "OPTIONS"], ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (c) => (c.req.method === "OPTIONS" ? preflight() : protectedResourceMetadata(c.env, c.req.raw)));
app.on(["GET", "OPTIONS"], "/.well-known/oauth-authorization-server", (c) => (c.req.method === "OPTIONS" ? preflight() : authorizationServerMetadata(c.env, c.req.raw)));
app.options("/oauth/register", () => preflight());
app.post("/oauth/register", (c) => register(c.req.raw, c.env));
app.options("/oauth/token", () => preflight());
app.post("/oauth/token", (c) => token(c.req.raw, c.env));
// The consent page is the dashboard SPA; never let it be framed (clickjacking).
app.get("/oauth/authorize", async (c) => {
  const res = await c.env.ASSETS.fetch(new Request(new URL("/", c.req.url), c.req.raw));
  const out = new Response(res.body, res);
  out.headers.set("x-frame-options", "DENY");
  out.headers.set("content-security-policy", "frame-ancestors 'none'");
  return out;
});
app.route("/api", api);
app.get("/_compat/*", (c) => c.text("Not found", 404));
app.get("/_tracker/*", (c) => c.text("Not found", 404));
// Vite's build output: file names carry a content hash, so browsers may keep them for good and never re-check.
app.get("/assets/*", async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  // A missing file gets the SPA's index.html (not-found handling), which must never be cached for good.
  if (res.status !== 200 || res.headers.get("content-type")?.includes("text/html")) return res;
  const out = new Response(res.body, res);
  out.headers.set("cache-control", "public, max-age=31536000, immutable");
  return out;
});
// Everything else is the dashboard SPA.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

/** Nightly: fold finished months' day files into month files, one site at a time. */
async function compactAll(env: Env) {
  for (const site of await allSites(env)) {
    try {
      const done = await env.SITE.get(env.SITE.idFromName(String(site.id))).compactClosedMonths(site.id);
      if (done.length) console.log("compacted", site.domain, JSON.stringify(done));
    } catch (err) {
      console.error("compaction failed", site.domain, err);
    }
  }
}

/** Nightly: daily totals for the overview, after compaction. */
async function rollupAll(env: Env) {
  for (const site of await allSites(env)) {
    try {
      const r = await rollupSite(env, site);
      if (r.days) console.log("rolled up", site.domain, JSON.stringify(r));
    } catch (err) {
      console.error("rollup failed", site.domain, err);
    }
  }
}

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    if (event.cron === "5 0 * * *") ctx.waitUntil(rotateSalts(env.DB, Date.now()));
    ensureScheduler(env, ctx); // the hourly jobs (see do/scheduler.ts)
    if (event.cron === "30 3 * * *") ctx.waitUntil(compactAll(env).then(() => rollupAll(env)).then(async () => anomalyJob(env, await allSites(env))));
  },
} satisfies ExportedHandler<Env>;
