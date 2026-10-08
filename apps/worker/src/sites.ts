import type { Env, Site } from "./env";

// Small in-isolate cache: ingestion looks a site up on every event.
const TTL_MS = 60_000;
let cache: { at: number; byDomain: Map<string, Site>; byId: Map<number, Site> } | null = null;

interface SiteRow {
  id: number;
  domain: string;
  timezone: string;
  allowed_hostnames: string;
  ip_blocklist: string;
}

function toSite(r: SiteRow): Site {
  return { ...r, allowed_hostnames: JSON.parse(r.allowed_hostnames), ip_blocklist: JSON.parse(r.ip_blocklist) };
}

async function load(env: Env) {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  const { results } = await env.DB.prepare("SELECT id, domain, timezone, allowed_hostnames, ip_blocklist FROM sites").all<SiteRow>();
  const sites = results.map(toSite);
  cache = { at: Date.now(), byDomain: new Map(sites.map((s) => [s.domain, s])), byId: new Map(sites.map((s) => [s.id, s])) };
  return cache;
}

const MISS_RELOAD_MS = 10_000;

export async function siteByDomain(env: Env, domain: string): Promise<Site | undefined> {
  const find = (c: Awaited<ReturnType<typeof load>>) =>
    c.byDomain.get(domain.toLowerCase().replace(/^www\./, "")) ?? c.byDomain.get(domain.toLowerCase());
  const c = await load(env);
  const hit = find(c);
  // A site added moments ago (possibly in another isolate) shouldn't wait for the cache TTL.
  if (!hit && Date.now() - c.at > MISS_RELOAD_MS) {
    cache = null;
    return find(await load(env));
  }
  return hit;
}

export async function siteById(env: Env, id: number): Promise<Site | undefined> {
  return (await load(env)).byId.get(id);
}

export async function allSites(env: Env): Promise<Site[]> {
  return [...(await load(env)).byId.values()].sort((a, b) => a.domain.localeCompare(b.domain));
}

export function invalidateSites() {
  cache = null;
}
