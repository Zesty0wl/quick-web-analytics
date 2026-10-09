// Personal access tokens: read-only bearer tokens for agents (MCP) and other API clients.
// "qwa_pat_" + 43 base64url characters (256 random bits); only the SHA-256 hash is stored.
import type { Env } from "./env";
import type { User } from "./auth";

export const TOKEN_PREFIX = "qwa_pat_";

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface TokenRow {
  id: number;
  name: string;
  hint: string;
  sites: number[] | null;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
}

type DbRow = Omit<TokenRow, "sites"> & { sites: string | null };
const toRow = (r: DbRow): TokenRow => ({ ...r, sites: r.sites ? (JSON.parse(r.sites) as number[]) : null });

export async function createToken(env: Env, userId: number, opts: { name: string; sites: number[] | null; expiresInDays: number | null }): Promise<{ token: string; row: TokenRow }> {
  const token = TOKEN_PREFIX + b64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Math.floor(Date.now() / 1000);
  const expires = opts.expiresInDays ? now + opts.expiresInDays * 86_400 : null;
  const row = await env.DB.prepare(
    "INSERT INTO api_tokens (user_id, name, token_hash, hint, sites, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id, name, hint, sites, created_at, last_used_at, expires_at",
  )
    .bind(userId, opts.name, await hashToken(token), token.slice(-4), opts.sites ? JSON.stringify(opts.sites) : null, now, expires)
    .first<DbRow>();
  return { token, row: toRow(row!) };
}

export async function listTokens(env: Env, userId: number): Promise<TokenRow[]> {
  const { results } = await env.DB.prepare("SELECT id, name, hint, sites, created_at, last_used_at, expires_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC")
    .bind(userId)
    .all<DbRow>();
  return results.map(toRow);
}

export async function revokeToken(env: Env, userId: number, id: number): Promise<boolean> {
  const r = await env.DB.prepare("DELETE FROM api_tokens WHERE id = ? AND user_id = ?").bind(id, userId).run();
  revoked.add(id);
  return (r.meta.changes ?? 0) > 0;
}

export interface TokenAuth {
  tokenId: number;
  user: User;
  /** Site ids the token is limited to, or null for every site the user can see. */
  sites: number[] | null;
}

// Successful lookups are cached briefly per isolate; revocation in this isolate takes effect at once.
const cache = new Map<string, { at: number; auth: TokenAuth; expires: number | null }>();
const revoked = new Set<number>();
const CACHE_MS = 60_000;

/** Forget a revoked OAuth grant in this isolate straight away (other isolates within the cache time). */
export const forgetGrant = (grantId: number) => revoked.add(-grantId);

/**
 * Check an `Authorization: Bearer …` header: a personal token (qwa_pat_…) or an OAuth access token (qwa_at_…).
 * Returns null for a missing, unknown, expired or revoked token. OAuth grants get negative ids in TokenAuth.tokenId.
 */
export async function authenticateToken(env: Env, header: string | null): Promise<TokenAuth | null> {
  const token = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token || token.length > 100 || !(token.startsWith(TOKEN_PREFIX) || token.startsWith("qwa_at_"))) return null;
  const hash = await hashToken(token);
  const now = Math.floor(Date.now() / 1000);
  const hit = cache.get(hash);
  if (hit && Date.now() - hit.at < CACHE_MS && !revoked.has(hit.auth.tokenId) && (hit.expires === null || hit.expires > now)) return hit.auth;
  if (token.startsWith("qwa_at_")) return authenticateOAuth(env, hash, now);
  const row = await env.DB.prepare(
    `SELECT t.id, t.sites, t.expires_at, t.last_used_at, u.id AS user_id, u.email, u.name, u.role
     FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
  )
    .bind(hash)
    .first<{ id: number; sites: string | null; expires_at: number | null; last_used_at: number | null; user_id: number; email: string; name: string | null; role: "admin" | "viewer" }>();
  if (!row || (row.expires_at !== null && row.expires_at <= now)) {
    cache.delete(hash);
    return null;
  }
  // "Last used", at most once a minute.
  if (!row.last_used_at || now - row.last_used_at > 60) await env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(now, row.id).run();
  const auth: TokenAuth = {
    tokenId: row.id,
    user: { id: row.user_id, email: row.email, name: row.name, role: row.role },
    sites: row.sites ? (JSON.parse(row.sites) as number[]) : null,
  };
  revoked.delete(row.id);
  cache.set(hash, { at: Date.now(), auth, expires: row.expires_at });
  return auth;
}

async function authenticateOAuth(env: Env, hash: string, now: number): Promise<TokenAuth | null> {
  const row = await env.DB.prepare(
    `SELECT g.id, g.sites, g.access_expires_at, g.last_used_at, u.id AS user_id, u.email, u.name, u.role
     FROM oauth_grants g JOIN users u ON u.id = g.user_id WHERE g.access_hash = ?`,
  )
    .bind(hash)
    .first<{ id: number; sites: string | null; access_expires_at: number; last_used_at: number | null; user_id: number; email: string; name: string | null; role: "admin" | "viewer" }>();
  if (!row || row.access_expires_at <= now) {
    cache.delete(hash);
    return null;
  }
  if (!row.last_used_at || now - row.last_used_at > 60) await env.DB.prepare("UPDATE oauth_grants SET last_used_at = ? WHERE id = ?").bind(now, row.id).run();
  const auth: TokenAuth = { tokenId: -row.id, user: { id: row.user_id, email: row.email, name: row.name, role: row.role }, sites: row.sites ? (JSON.parse(row.sites) as number[]) : null };
  revoked.delete(-row.id);
  cache.set(hash, { at: Date.now(), auth, expires: row.access_expires_at });
  return auth;
}
