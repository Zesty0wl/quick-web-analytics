// OAuth 2.1 authorization server for MCP clients (the MCP authorization spec): Claude Desktop, claude.ai connectors
// and other clients that "Connect" rather than take a pasted token.
//
//   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728: which authorization server protects /mcp
//   GET  /.well-known/oauth-authorization-server       RFC 8414: endpoints and capabilities
//   POST /oauth/register                               RFC 7591: dynamic client registration (public clients)
//   GET  /oauth/authorize                              the consent page (dashboard SPA, behind Cloudflare Access)
//   POST /api/oauth/approve                            the consent page's "Allow" (Access-authenticated)
//   POST /oauth/token                                  authorization_code (+ PKCE S256) and refresh_token grants
//
// The well-known paths, /oauth/register and /oauth/token must be in the Access bypass application; /oauth/authorize
// must not be, so the person signs in to QWA as usual before approving. Tokens are read-only, like personal tokens.
import type { Env } from "./env";
import type { User } from "./auth";
import { hashToken } from "./tokens";

export const ACCESS_PREFIX = "qwa_at_";
export const REFRESH_PREFIX = "qwa_rt_";
const ACCESS_TTL = 3600;
const REFRESH_TTL = 60 * 86_400;
const CODE_TTL = 600;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const now = () => Math.floor(Date.now() / 1000);

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store", ...headers } });
const oauthError = (error: string, description: string, status = 400) => json({ error, error_description: description }, status);

/** The public origin: APP_HOST, except for local development, where it's whatever localhost address was used. */
export function originOf(env: Env, req: Request): string {
  const u = new URL(req.url);
  if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return u.origin;
  return env.APP_HOST ? `https://${env.APP_HOST}` : u.origin;
}

export function protectedResourceMetadata(env: Env, req: Request): Response {
  const origin = originOf(env, req);
  return json({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["read"],
    resource_name: "Quick Web Analytics",
  });
}

export function authorizationServerMetadata(env: Env, req: Request): Response {
  const origin = originOf(env, req);
  return json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["read"],
  });
}

/** Redirect URIs must be https, or http on the loopback interface (desktop apps). No fragments. */
function validRedirect(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length > 500) return false;
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    // Custom schemes for native apps (e.g. "cursor://…"), but never javascript:, data: and the like.
    return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !["javascript:", "data:", "file:", "vbscript:", "blob:"].includes(u.protocol);
  } catch {
    return false;
  }
}

export async function register(req: Request, env: Env): Promise<Response> {
  if (env.MCP_LIMITER && !(await env.MCP_LIMITER.limit({ key: `oauth-register:${req.headers.get("cf-connecting-ip") ?? "?"}` })).success) {
    return oauthError("slow_down", "Too many registrations; try again shortly.", 429);
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return oauthError("invalid_client_metadata", "Expected a JSON body.");
  }
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (!uris.length || uris.length > 10 || !uris.every(validRedirect)) {
    return oauthError("invalid_redirect_uri", "redirect_uris must be 1–10 https URLs (or http on localhost).");
  }
  const method = body.token_endpoint_auth_method ?? "none";
  if (method !== "none") return oauthError("invalid_client_metadata", "Only public clients (token_endpoint_auth_method none, with PKCE) are supported.");
  const name = (typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim() : new URL(uris[0] as string).host).slice(0, 100);
  const clientId = `qwa_client_${random(16)}`;
  const issued = now();
  await env.DB.prepare("INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)").bind(clientId, name, JSON.stringify(uris), issued).run();
  return json(
    { client_id: clientId, client_id_issued_at: issued, client_name: name, redirect_uris: uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: "read" },
    201,
  );
}

export interface ClientInfo {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
}

export async function getClient(env: Env, clientId: string): Promise<ClientInfo | null> {
  const row = await env.DB.prepare("SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?").bind(clientId).first<{ client_id: string; client_name: string; redirect_uris: string }>();
  return row ? { ...row, redirect_uris: JSON.parse(row.redirect_uris) as string[] } : null;
}

export interface AuthorizeRequest {
  client_id: string;
  redirect_uri?: string;
  response_type: string;
  code_challenge: string;
  code_challenge_method?: string;
  state?: string;
  scope?: string;
  resource?: string;
}

/** Check an authorization request (shared by the consent page's preview and its approval). */
export async function checkAuthorize(env: Env, req: Request, q: AuthorizeRequest): Promise<{ client: ClientInfo; redirectUri: string } | { error: string }> {
  const client = await getClient(env, String(q.client_id ?? ""));
  if (!client) return { error: "This app isn't registered with this QWA instance. Remove and re-add the connection in the app." };
  const redirectUri = q.redirect_uri || (client.redirect_uris.length === 1 ? client.redirect_uris[0] : "");
  if (!client.redirect_uris.includes(redirectUri)) return { error: "The app's redirect address doesn't match its registration." };
  if (q.response_type !== "code") return { error: "Unsupported response_type (only code)." };
  if (!q.code_challenge || (q.code_challenge_method ?? "S256") !== "S256") return { error: "PKCE with S256 is required." };
  if (q.resource && q.resource.replace(/\/$/, "") !== `${originOf(env, req)}/mcp`) return { error: `This server only grants access to ${originOf(env, req)}/mcp.` };
  return { client, redirectUri };
}

/** The consent page's "Allow": store a code and return where to send the browser. */
export async function approve(env: Env, req: Request, user: User, q: AuthorizeRequest & { sites?: number[] | null }): Promise<{ redirect: string } | { error: string }> {
  const checked = await checkAuthorize(env, req, q);
  if ("error" in checked) return checked;
  const code = random();
  await env.DB.prepare("INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, sites, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(await hashToken(code), checked.client.client_id, user.id, checked.redirectUri, q.code_challenge, q.sites?.length ? JSON.stringify(q.sites) : null, now() + CODE_TTL)
    .run();
  const url = new URL(checked.redirectUri);
  url.searchParams.set("code", code);
  if (q.state) url.searchParams.set("state", q.state);
  url.searchParams.set("iss", originOf(env, req));
  return { redirect: url.toString() };
}

async function s256(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

async function issue(env: Env, grantId: number | null, base: { client_id: string; user_id: number; sites: string | null }, previousRefresh: string | null) {
  const access = ACCESS_PREFIX + random();
  const refresh = REFRESH_PREFIX + random();
  const t = now();
  if (grantId === null) {
    await env.DB.prepare(
      "INSERT INTO oauth_grants (client_id, user_id, sites, created_at, last_used_at, access_hash, access_expires_at, refresh_hash, refresh_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(base.client_id, base.user_id, base.sites, t, t, await hashToken(access), t + ACCESS_TTL, await hashToken(refresh), t + REFRESH_TTL)
      .run();
  } else {
    await env.DB.prepare("UPDATE oauth_grants SET access_hash = ?, access_expires_at = ?, refresh_hash = ?, refresh_expires_at = ?, previous_refresh_hash = ?, last_used_at = ? WHERE id = ?")
      .bind(await hashToken(access), t + ACCESS_TTL, await hashToken(refresh), t + REFRESH_TTL, previousRefresh, t, grantId)
      .run();
  }
  await env.DB.prepare("UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?").bind(t, base.client_id).run();
  return json({ access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: "read" });
}

export async function token(req: Request, env: Env): Promise<Response> {
  if (env.MCP_LIMITER && !(await env.MCP_LIMITER.limit({ key: `oauth-token:${req.headers.get("cf-connecting-ip") ?? "?"}` })).success) {
    return oauthError("slow_down", "Too many requests; try again shortly.", 429);
  }
  const type = req.headers.get("content-type") ?? "";
  let p: Record<string, string>;
  try {
    p = type.includes("application/json") ? ((await req.json()) as Record<string, string>) : Object.fromEntries(new URLSearchParams(await req.text()));
  } catch {
    return oauthError("invalid_request", "Couldn't read the request body.");
  }

  if (p.grant_type === "authorization_code") {
    if (!p.code || !p.code_verifier || !p.client_id) return oauthError("invalid_request", "code, code_verifier and client_id are required.");
    const hash = await hashToken(p.code);
    // Single use: delete as we read.
    const code = await env.DB.prepare("DELETE FROM oauth_codes WHERE code_hash = ? RETURNING client_id, user_id, redirect_uri, code_challenge, sites, expires_at")
      .bind(hash)
      .first<{ client_id: string; user_id: number; redirect_uri: string; code_challenge: string; sites: string | null; expires_at: number }>();
    if (!code || code.expires_at < now()) return oauthError("invalid_grant", "The authorization code is invalid or has expired.");
    if (code.client_id !== p.client_id) return oauthError("invalid_grant", "The code was issued to a different client.");
    if (p.redirect_uri && p.redirect_uri !== code.redirect_uri) return oauthError("invalid_grant", "redirect_uri doesn't match the authorization request.");
    if ((await s256(p.code_verifier)) !== code.code_challenge) return oauthError("invalid_grant", "PKCE verification failed.");
    return issue(env, null, { client_id: code.client_id, user_id: code.user_id, sites: code.sites }, null);
  }

  if (p.grant_type === "refresh_token") {
    if (!p.refresh_token?.startsWith(REFRESH_PREFIX)) return oauthError("invalid_grant", "Invalid refresh token.");
    const hash = await hashToken(p.refresh_token);
    const grant = await env.DB.prepare("SELECT id, client_id, user_id, sites, refresh_expires_at FROM oauth_grants WHERE refresh_hash = ?")
      .bind(hash)
      .first<{ id: number; client_id: string; user_id: number; sites: string | null; refresh_expires_at: number }>();
    if (!grant) {
      // A refresh token that was already rotated away: someone has a copy. Revoke that grant entirely.
      const reused = await env.DB.prepare("DELETE FROM oauth_grants WHERE previous_refresh_hash = ? RETURNING id").bind(hash).first<{ id: number }>();
      if (reused) console.warn("oauth refresh token reuse: grant revoked", reused.id);
      return oauthError("invalid_grant", "The refresh token is invalid, expired or was revoked. Connect again.");
    }
    if (grant.refresh_expires_at < now()) {
      await env.DB.prepare("DELETE FROM oauth_grants WHERE id = ?").bind(grant.id).run();
      return oauthError("invalid_grant", "The refresh token has expired. Connect again.");
    }
    if (p.client_id && p.client_id !== grant.client_id) return oauthError("invalid_grant", "The token was issued to a different client.");
    return issue(env, grant.id, grant, hash);
  }

  return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: { ...CORS, "access-control-max-age": "86400" } });
}

// ---------- for the Account page ----------

export interface GrantRow {
  id: number;
  client_name: string;
  redirect_host: string;
  sites: number[] | null;
  created_at: number;
  last_used_at: number | null;
}

export async function listGrants(env: Env, userId: number): Promise<GrantRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT g.id, c.client_name, c.redirect_uris, g.sites, g.created_at, g.last_used_at
     FROM oauth_grants g JOIN oauth_clients c ON c.client_id = g.client_id WHERE g.user_id = ? ORDER BY g.created_at DESC`,
  )
    .bind(userId)
    .all<{ id: number; client_name: string; redirect_uris: string; sites: string | null; created_at: number; last_used_at: number | null }>();
  return results.map((r) => {
    let host = "";
    try {
      host = new URL((JSON.parse(r.redirect_uris) as string[])[0]).host;
    } catch {}
    return { id: r.id, client_name: r.client_name, redirect_host: host, sites: r.sites ? (JSON.parse(r.sites) as number[]) : null, created_at: r.created_at, last_used_at: r.last_used_at };
  });
}

export async function revokeGrant(env: Env, userId: number, id: number): Promise<boolean> {
  const r = await env.DB.prepare("DELETE FROM oauth_grants WHERE id = ? AND user_id = ?").bind(id, userId).run();
  return (r.meta.changes ?? 0) > 0;
}
