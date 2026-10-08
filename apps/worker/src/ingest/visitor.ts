// Cookieless visitor identity: hash(daily salt, site, ip, user agent).
// Salts rotate every UTC day and are deleted after two days, so a visitor can't be
// re-identified once the salt is gone, and no IP or user agent is ever stored.

const ID_MASK = (1n << 53n) - 1n; // keep ids exact as JS numbers

let cache: { day: string; current: string; previous: string | null } | null = null;

export function utcDay(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

async function salt(db: D1Database, day: string): Promise<string> {
  const row = await db.prepare("SELECT salt FROM salts WHERE day = ?").bind(day).first<{ salt: string }>();
  if (row) return row.salt;
  const fresh = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await db.prepare("INSERT OR IGNORE INTO salts (day, salt) VALUES (?, ?)").bind(day, fresh).run();
  // Re-read: another isolate may have won the race.
  const won = await db.prepare("SELECT salt FROM salts WHERE day = ?").bind(day).first<{ salt: string }>();
  return won!.salt;
}

export async function salts(db: D1Database, nowMs: number): Promise<{ current: string; previous: string | null }> {
  const day = utcDay(nowMs);
  if (cache?.day === day) return cache;
  const yesterday = utcDay(nowMs - 86_400_000);
  const current = await salt(db, day);
  const prev = await db.prepare("SELECT salt FROM salts WHERE day = ?").bind(yesterday).first<{ salt: string }>();
  cache = { day, current, previous: prev?.salt ?? null };
  return cache;
}

export async function visitorId(salt: string, siteId: number, ip: string, userAgent: string): Promise<number> {
  const data = new TextEncoder().encode(`${salt}|${siteId}|${ip}|${userAgent}`);
  const digest = new DataView(await crypto.subtle.digest("SHA-256", data));
  return Number(digest.getBigUint64(0) & ID_MASK);
}

export function randomId(): number {
  const v = new DataView(crypto.getRandomValues(new Uint8Array(8)).buffer);
  return Number(v.getBigUint64(0) & ID_MASK);
}

export async function rotateSalts(db: D1Database, nowMs: number): Promise<void> {
  await salt(db, utcDay(nowMs));
  await db.prepare("DELETE FROM salts WHERE day < ?").bind(utcDay(nowMs - 2 * 86_400_000)).run();
}
