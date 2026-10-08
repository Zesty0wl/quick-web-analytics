// Serves Plausible's (MIT) tracker scripts for sites that haven't moved to the QWA tracker yet.
import type { Env } from "../env";

const BASE_NAMES = new Set(["script", "plausible", "analytics"]);
const IGNORED = new Set(["js", "pageleave"]);
const PLACEHOLDER = '"<%= @config_js %>"';
// Only the variants our sites use are vendored (see packages/tracker-compat/README.md).
const VENDORED = new Set([
  "plausible.js",
  "plausible.outbound-links.js",
  "plausible.file-downloads.hash.outbound-links.js",
  "plausible.file-downloads.hash.outbound-links.tagged-events.js",
  "plausible.manual.js",
]);

const SCRIPT_HEADERS = {
  "content-type": "application/javascript; charset=utf-8",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "cross-origin",
  "access-control-allow-origin": "*",
};

/** "script.outbound-links.hash.js" → "plausible.hash.outbound-links.js" (features sorted). */
export function legacyFile(requested: string): string | null {
  const parts = requested.split(".");
  if (parts.length < 2 || parts.at(-1) !== "js" || !BASE_NAMES.has(parts[0])) return null;
  const features = parts.slice(1).filter((p) => !IGNORED.has(p)).sort();
  return ["plausible", ...features, "js"].join(".");
}

export async function serveCompatScript(req: Request, env: Env, filename: string): Promise<Response> {
  if (filename.startsWith("pa-") && filename.endsWith(".js")) return servePaScript(req, env, filename.slice(0, -3));
  const file = legacyFile(filename);
  if (!file || !VENDORED.has(file)) return notFound(filename);
  const asset = await env.ASSETS.fetch(new URL(`/_compat/${file}`, req.url));
  if (!asset.ok) return notFound(filename);
  return new Response(asset.body, { headers: { ...SCRIPT_HEADERS, "cache-control": "public, max-age=86400" } });
}

async function servePaScript(req: Request, env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT s.domain, c.outbound_links, c.file_downloads, c.form_submissions FROM compat_scripts c JOIN sites s ON s.id = c.site_id WHERE c.id = ?",
  )
    .bind(id)
    .first<{ domain: string; outbound_links: number; file_downloads: number; form_submissions: number }>();
  if (!row) return notFound(`${id}.js`);
  const template = await env.ASSETS.fetch(new URL("/_compat/plausible-web.js", req.url));
  if (!template.ok) return notFound(`${id}.js`);
  // Same shape Plausible injects: string values JSON-encoded, booleans as !0, false omitted.
  const entries = [
    `domain:${JSON.stringify(row.domain)}`,
    `endpoint:${JSON.stringify(env.COMPAT_ENDPOINT)}`,
    row.outbound_links ? "outboundLinks:!0" : "",
    row.file_downloads ? "fileDownloads:!0" : "",
    row.form_submissions ? "formSubmissions:!0" : "",
  ].filter(Boolean);
  const body = (await template.text()).replace(PLACEHOLDER, `{${entries.join(",")}}`);
  return new Response(body, { headers: { ...SCRIPT_HEADERS, "cache-control": "public, max-age=300" } });
}

function notFound(filename: string): Response {
  console.warn("compat script not found", filename);
  return new Response("Not found", { status: 404 });
}
