// Authentication via Cloudflare Access: verify the Access JWT, map its email to a QWA user.
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./env";

export interface User {
  id: number;
  email: string;
  name: string | null;
  role: "admin" | "viewer";
}

const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export class AuthError extends Error {
  constructor(message: string, readonly status: 401 | 403) {
    super(message);
  }
}

async function accessEmail(req: Request, env: Env): Promise<string> {
  const url = new URL(req.url);
  if (env.DEV_USER_EMAIL && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) return env.DEV_USER_EMAIL;
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw new AuthError("Access is not configured", 401);

  const token =
    req.headers.get("cf-access-jwt-assertion") ??
    req.headers.get("cookie")?.match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1];
  if (!token) throw new AuthError("not signed in", 401);

  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  let keys = jwks.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwks.set(issuer, keys);
  }
  try {
    const { payload } = await jwtVerify(token, keys, { issuer, audience: env.ACCESS_AUD });
    if (typeof payload.email !== "string") throw new Error("no email claim");
    return payload.email.toLowerCase();
  } catch {
    throw new AuthError("invalid Access token", 401);
  }
}

// Per-isolate caches, so a page of dashboard calls doesn't make D1 round trips for every one of them. Changes made in
// another isolate (a new role, revoked access) apply within USER_TTL_MS; this isolate's own changes apply at once.
const USER_TTL_MS = 30_000;
const users = new Map<string, { user: User; at: number }>();
const grants = new Map<number, { ids: number[]; at: number }>();
const lastSeenWritten = new Map<number, number>();

/** Forget cached users and site grants (after changing them). */
export function forgetUsers() {
  users.clear();
  grants.clear();
}

export async function currentUser(req: Request, env: Env, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<User> {
  const email = await accessEmail(req, env);
  const hit = users.get(email);
  let user = hit && Date.now() - hit.at < USER_TTL_MS ? hit.user : null;
  if (!user) {
    user = await env.DB.prepare("SELECT id, email, name, role FROM users WHERE email = ?").bind(email).first<User>();
    if (!user) {
      const bootstrap = (env.BOOTSTRAP_ADMINS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
      if (!bootstrap.includes(email)) throw new AuthError(`${email} has not been given access`, 403);
      user = await env.DB.prepare("INSERT INTO users (email, role) VALUES (?, 'admin') RETURNING id, email, name, role").bind(email).first<User>();
    }
    users.set(email, { user: user!, at: Date.now() });
  }
  // Cheap "last seen": at most once a minute per user, off the request's critical path.
  if (Date.now() - (lastSeenWritten.get(user!.id) ?? 0) > 60_000) {
    lastSeenWritten.set(user!.id, Date.now());
    const write = env.DB.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-1 minute'))")
      .bind(user!.id)
      .run()
      .catch((e) => console.warn("last seen update failed", e));
    if (ctx) ctx.waitUntil(write);
    else await write;
  }
  return user!;
}

async function grantedSites(env: Env, userId: number): Promise<number[]> {
  const hit = grants.get(userId);
  if (hit && Date.now() - hit.at < USER_TTL_MS) return hit.ids;
  const { results } = await env.DB.prepare("SELECT site_id FROM site_access WHERE user_id = ?").bind(userId).all<{ site_id: number }>();
  const ids = results.map((r) => r.site_id);
  grants.set(userId, { ids, at: Date.now() });
  return ids;
}

export async function canViewSite(env: Env, user: User, siteId: number): Promise<boolean> {
  if (user.role === "admin") return true;
  return (await grantedSites(env, user.id)).includes(siteId);
}

export async function visibleSiteIds(env: Env, user: User): Promise<number[] | "all"> {
  if (user.role === "admin") return "all";
  return grantedSites(env, user.id);
}
