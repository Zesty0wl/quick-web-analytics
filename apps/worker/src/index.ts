import { Hono } from "hono";
import { api } from "./api";
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

app.route("/api", api);
app.get("/_compat/*", (c) => c.text("Not found", 404));
app.get("/_tracker/*", (c) => c.text("Not found", 404));
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
