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

export async function currentUser(req: Request, env: Env): Promise<User> {
  const email = await accessEmail(req, env);
  let user = await env.DB.prepare("SELECT id, email, name, role FROM users WHERE email = ?").bind(email).first<User>();
  if (!user) {
    const bootstrap = (env.BOOTSTRAP_ADMINS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (!bootstrap.includes(email)) throw new AuthError(`${email} has not been given access`, 403);
    user = await env.DB.prepare("INSERT INTO users (email, role) VALUES (?, 'admin') RETURNING id, email, name, role").bind(email).first<User>();
  }
  // Cheap "last seen", at most once a minute per user.
  await env.DB.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-1 minute'))")
    .bind(user!.id)
    .run();
  return user!;
}

export async function canViewSite(env: Env, user: User, siteId: number): Promise<boolean> {
  if (user.role === "admin") return true;
  const row = await env.DB.prepare("SELECT 1 FROM site_access WHERE user_id = ? AND site_id = ?").bind(user.id, siteId).first();
  return row !== null;
}

export async function visibleSiteIds(env: Env, user: User): Promise<number[] | "all"> {
  if (user.role === "admin") return "all";
  const { results } = await env.DB.prepare("SELECT site_id FROM site_access WHERE user_id = ?").bind(user.id).all<{ site_id: number }>();
  return results.map((r) => r.site_id);
}
