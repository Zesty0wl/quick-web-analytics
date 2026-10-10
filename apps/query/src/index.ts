// qwa-query: runs DuckDB-WASM over the sites' Parquet files in R2. Called by the main Worker
// over a service binding (RPC), so a memory-hungry query can never take ingestion down with it.
import { WorkerEntrypoint } from "cloudflare:workers";
import { init, DuckDB } from "@ducklings/workers";
import wasmModule from "@ducklings/workers/wasm/duckdb-workers.wasm";
import { keyRange, TABLES, tablePrefix, type QueryResult, type QuerySpec, type TableName } from "@qwa/shared";
import { buildSql } from "./sql";
import { ResultCache } from "./cache";
import { addDays, dayLabel, hourLabel, localMidnight, offsetSegments } from "./tz";

interface Env {
  DATA: R2Bucket;
  /** DuckDB buffer limit; keep well under the 128 MB isolate limit. */
  MEMORY_LIMIT?: string;
}

const FAKE_HOST = "r2.local";
const LIST_TTL_MS = 30_000;
const APPROX_AFTER_DAYS = 92;

// ---- R2 access for DuckDB: its httpfs fetch() calls to https://r2.local/<key> are served from the binding ----
let bucket: R2Bucket | undefined;
const objects = new Map<string, { at: number; list: R2Object[] }>();
const realFetch = globalThis.fetch.bind(globalThis);

/** Listings in flight for one call, so its queries share them. Never shared across requests (see "No request ever…"). */
type Listings = Map<string, Promise<R2Object[]>>;

async function listPrefix(prefix: string, listing: Listings): Promise<R2Object[]> {
  const hit = objects.get(prefix);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.list;
  let pending = listing.get(prefix);
  if (!pending) {
    pending = (async () => {
      const out: R2Object[] = [];
      let cursor: string | undefined;
      do {
        const page = await bucket!.list({ prefix, cursor });
        out.push(...page.objects);
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      objects.set(prefix, { at: Date.now(), list: out });
      return out;
    })().finally(() => listing.delete(prefix));
    listing.set(prefix, pending);
  }
  return pending;
}

function knownObject(key: string): R2Object | undefined {
  for (const { list } of objects.values()) {
    const o = list.find((x) => x.key === key);
    if (o) return o;
  }
  return undefined;
}

// Live day files handed over by the caller for one query (the site's not-yet-flushed events), by "<key>|<token>".
const liveBuffers = new Map<string, ArrayBuffer>();

function serveBuffer(buf: ArrayBuffer, method: string, init?: RequestInit): Response {
  if (method === "HEAD") return new Response(null, { headers: { "content-length": String(buf.byteLength), "accept-ranges": "bytes" } });
  const m = new Headers(init?.headers).get("range")?.match(/bytes=(\d+)-(\d+)?/);
  const start = m ? +m[1] : 0;
  const end = Math.min(m?.[2] ? +m[2] : buf.byteLength - 1, buf.byteLength - 1);
  const part = buf.slice(start, end + 1);
  return new Response(part, {
    status: m ? 206 : 200,
    headers: { "content-length": String(part.byteLength), "content-range": `bytes ${start}-${start + part.byteLength - 1}/${buf.byteLength}`, "accept-ranges": "bytes" },
  });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== FAKE_HOST || !bucket) return realFetch(input as RequestInfo, init);
  const key = decodeURIComponent(url.pathname.slice(1));
  const method = (init?.method ?? "GET").toUpperCase();
  const live = url.searchParams.get("live");
  if (live) {
    const buf = liveBuffers.get(`${key}|${live}`);
    return buf ? serveBuffer(buf, method, init) : new Response(null, { status: 404 });
  }
  const meta = knownObject(key) ?? (await bucket.head(key)) ?? undefined;
  if (!meta) return new Response(null, { status: 404 });
  if (method === "HEAD") {
    return new Response(null, {
      headers: { "content-length": String(meta.size), "accept-ranges": "bytes", etag: meta.httpEtag, "last-modified": meta.uploaded.toUTCString() },
    });
  }
  const m = new Headers(init?.headers).get("range")?.match(/bytes=(\d+)-(\d+)?/);
  const start = m ? +m[1] : 0;
  const end = m?.[2] ? +m[2] : meta.size - 1;
  // Cache key includes the etag, so a rewritten file (live day) never serves stale bytes.
  const cacheKey = new Request(`https://${FAKE_HOST}/${key}?etag=${encodeURIComponent(meta.etag)}&r=${start}-${end}`);
  const cache = caches.default;
  let buf: ArrayBuffer;
  const hit = await cache.match(cacheKey);
  if (hit) {
    buf = await hit.arrayBuffer();
  } else {
    const obj = await bucket.get(key, { range: { offset: start, length: end - start + 1 } });
    if (!obj) return new Response(null, { status: 404 });
    buf = await obj.arrayBuffer();
    await cache.put(cacheKey, new Response(buf, { headers: { "cache-control": "public, max-age=604800" } }));
  }
  return new Response(buf, {
    status: m ? 206 : 200,
    headers: { "content-length": String(buf.byteLength), "content-range": `bytes ${start}-${start + buf.byteLength - 1}/${meta.size}`, "accept-ranges": "bytes" },
  });
}) as typeof fetch;

// ---- DuckDB: one instance per isolate; queries serialised (Asyncify can't interleave) ----
//
// No request ever awaits a promise owned by another request: the runtime cancels such requests as "hung", and if
// the request holding the lock is itself cancelled mid-query (e.g. its caller went away), its DuckDB reads never
// complete. So waiting is done by polling on the waiter's own timer, queries have a timeout, and a lock held for too
// long (its owner is gone) is taken over with a fresh DuckDB instance.
type Conn = { query: (sql: string) => Promise<Record<string, unknown>[]> };
const QUERY_TIMEOUT_MS = 50_000;
const STALE_MS = 55_000;
let instance: { conn: Conn; since: number } | null = null;
let starting: number | null = null; // when the current DuckDB start-up began
let holder: { since: number } | null = null; // the request running a query, if any

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Discard DuckDB (e.g. after a stuck query); the next query starts a new instance. */
function resetDuck(reason: string) {
  console.warn("resetting DuckDB:", reason);
  instance = null;
  starting = null;
}

async function duck(env: Env): Promise<Conn> {
  for (;;) {
    if (instance) return instance.conn;
    if (starting === null || Date.now() - starting > STALE_MS) {
      const mine = (starting = Date.now());
      try {
        await init({ wasmModule });
        const db = new DuckDB({ customConfig: { memory_limit: env.MEMORY_LIMIT ?? "96MB", threads: "1" } });
        if (starting === mine) instance = { conn: db.connect() as never, since: Date.now() };
      } finally {
        if (starting === mine) starting = null;
      }
      continue;
    }
    await sleep(15);
  }
}

async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  for (;;) {
    if (!holder) break;
    if (Date.now() - holder.since > STALE_MS) {
      resetDuck(`query lock held for ${Math.round((Date.now() - holder.since) / 1000)}s`);
      break;
    }
    await sleep(10);
  }
  const mine = (holder = { since: Date.now() });
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`query took longer than ${QUERY_TIMEOUT_MS / 1000}s`)), QUERY_TIMEOUT_MS);
      }),
    ]);
  } catch (e) {
    if ((e as Error).message.startsWith("query took longer")) resetDuck((e as Error).message);
    throw e;
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (holder === mine) holder = null;
  }
}

async function filesFor(siteId: number, table: TableName, from: number, to: number, live: { files: Record<string, ArrayBuffer | null>; token: string } | null, listing: Listings): Promise<string[]> {
  const list = await listPrefix(tablePrefix(siteId, table), listing);
  const fresh = live ? Object.entries(live.files).filter(([k]) => k.startsWith(tablePrefix(siteId, table))) : [];
  const replaced = new Set(fresh.map(([k]) => k));
  const liveUrls = fresh
    .filter(([k, buf]) => {
      const r = keyRange(k);
      return buf && r !== null && r[0] < to && r[1] > from;
    })
    .map(([k]) => `https://${FAKE_HOST}/${k}?live=${live!.token}`);
  // Day files already folded into their month file (uploaded before it) would double count.
  const monthUploaded = new Map<string, number>();
  for (const o of list) {
    const m = o.key.match(/\/month\/(\d{4}-\d{2})\.parquet$/);
    if (m) monthUploaded.set(m[1], o.uploaded.getTime());
  }
  return list
    .filter((o) => {
      const r = keyRange(o.key);
      if (r === null || r[0] >= to || r[1] <= from || o.size === 0) return false;
      const day = o.key.match(/\/day\/(\d{4}-\d{2})-\d{2}\.parquet$/);
      const merged = day ? monthUploaded.get(day[1]) : undefined;
      return (merged === undefined || o.uploaded.getTime() > merged) && !replaced.has(o.key);
    })
    // The version in the URL means a rewritten file (e.g. today's) is never read from a stale cache.
    .map((o) => `https://${FAKE_HOST}/${o.key}?v=${encodeURIComponent(o.etag)}`)
    .concat(liveUrls);
}

const num = (v: unknown) => (typeof v === "bigint" ? Number(v) : v);

/**
 * Fresh Parquet for days with events not yet flushed to R2, by R2 key (null = no rows that day), from the site's
 * Durable Object, and a tag naming that exact content. Older callers send just the files.
 */
export type LiveFiles = { files: Record<string, ArrayBuffer | null>; tag: string };
type Live = { files: Record<string, ArrayBuffer | null>; token: string; tag: string };

function normaliseLive(live: LiveFiles | Record<string, ArrayBuffer | null> | undefined): LiveFiles | null {
  if (!live) return null;
  const l = "files" in live && "tag" in live && typeof live.tag === "string" ? (live as LiveFiles) : { files: live as Record<string, ArrayBuffer | null>, tag: "" };
  return Object.keys(l.files).length ? l : null;
}

// Answers keyed by everything they depend on: the query, the timezone, every file read (R2 URLs carry the ETag) and the
// live data's tag. New events or a rewritten file change the key, so a cached answer is never stale.
const results = new ResultCache<QueryResult>({ maxEntries: 400, maxBytes: 8 * 1024 * 1024 });

const encoder = new TextEncoder();

export class QueryService extends WorkerEntrypoint<Env> {
  /**
   * Always let a query run to completion, even if the caller goes away (a closed tab cancels the request chain).
   * A query cut off mid-read leaves DuckDB's single WebAssembly module waiting forever and wedges the isolate.
   * `live` replaces R2's copies of the days it covers, so a range covering today includes the last few minutes.
   */
  async query(siteId: number, timezone: string, spec: QuerySpec, live?: LiveFiles | Record<string, ArrayBuffer | null>): Promise<QueryResult> {
    const l = this.register(normaliseLive(live));
    const run = this.run(siteId, timezone, spec, l);
    this.ctx.waitUntil(run.catch(() => undefined).then(() => this.release(l)));
    return run;
  }

  /**
   * Several queries for one site, answered as NDJSON lines (`{"i":…,"result":…}` or `{"i":…,"error":…}`) as each is
   * ready: cached answers first, then the rest in the order given.
   */
  async queryMany(siteId: number, timezone: string, items: { i: number; spec: QuerySpec }[], live?: LiveFiles): Promise<ReadableStream<Uint8Array>> {
    const l = this.register(normaliseLive(live));
    const { readable, writable } = new IdentityTransformStream();
    const writer = writable.getWriter();
    let gone = false;
    const send = async (line: object) => {
      if (gone) return;
      try {
        await writer.write(encoder.encode(`${JSON.stringify(line)}\n`));
      } catch {
        gone = true; // the caller went away: finish the query in hand, start no more
      }
    };
    const work = (async () => {
      try {
        const listing: Listings = new Map();
        const plans = await Promise.all(items.map(async (x) => ({ ...x, plan: await this.plan(siteId, timezone, x.spec, l, listing).catch((e: Error) => e) })));
        const misses = [];
        for (const p of plans) {
          if (p.plan instanceof Error) await send({ i: p.i, error: p.plan.message });
          else if (p.plan.cached) await send({ i: p.i, result: p.plan.cached });
          else misses.push(p);
        }
        for (const p of misses) {
          if (gone) break;
          if (p.plan instanceof Error) continue;
          try {
            await send({ i: p.i, result: await this.execute(p.plan) });
          } catch (e) {
            await send({ i: p.i, error: `query failed: ${(e as Error).message}` });
          }
        }
      } finally {
        this.release(l);
        if (!gone) await writer.close().catch(() => undefined);
      }
    })();
    this.ctx.waitUntil(work.catch((e) => console.error("queryMany failed", e)));
    return readable;
  }

  /** Make live buffers readable by this isolate's DuckDB for the duration of a call. */
  private register(live: LiveFiles | null): Live | null {
    if (!live) return null;
    const token = crypto.randomUUID();
    for (const [k, buf] of Object.entries(live.files)) if (buf) liveBuffers.set(`${k}|${token}`, buf);
    return { ...live, token };
  }

  private release(live: Live | null) {
    if (live) for (const k of Object.keys(live.files)) liveBuffers.delete(`${k}|${live.token}`);
  }

  private async run(siteId: number, timezone: string, spec: QuerySpec, live: Live | null): Promise<QueryResult> {
    const plan = await this.plan(siteId, timezone, spec, live, new Map());
    return plan.cached ?? this.execute(plan);
  }

  /** Work out which files a query reads and its SQL, and look for a cached answer. */
  private async plan(siteId: number, timezone: string, spec: QuerySpec, live: Live | null, listing: Listings) {
    bucket = this.env.DATA;
    const started = Date.now();
    const from = localMidnight(timezone, spec.from);
    const to = localMidnight(timezone, addDays(spec.to, 1));
    const days = Math.round((to - from) / 86_400);
    const segments = offsetSegments(timezone, from, to);

    const files = Object.fromEntries(
      await Promise.all(TABLES.map(async (t) => [t, await filesFor(siteId, t, from - 86_400, to + 86_400, live, listing)] as const)),
    ) as Record<TableName, string[]>;

    const { sql, key } = buildSql({ spec, from, to, segments, files, approximate: days > APPROX_AFTER_DAYS });
    // Live files' URLs carry a per-call token; the tag names their content. Without a tag (an older caller), no caching.
    const cacheKey = live && !live.tag ? null : await ResultCache.key([siteId, timezone, spec, live ? sql.replaceAll(live.token, live.tag) : sql]);
    const hit = cacheKey ? results.get(cacheKey) : undefined;
    const cached = hit ? { ...hit, meta: { ...hit.meta, ms: Date.now() - started, cached: true } } : null;
    return { siteId, spec, sql, key, cacheKey, started, timezone, files, cached };
  }

  private async execute({ spec, sql, key, cacheKey, started, timezone, files }: Awaited<ReturnType<QueryService["plan"]>>): Promise<QueryResult> {
    const raw = await exclusive(async () => (await duck(this.env)).query(sql));

    let rows = raw.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, num(v)]))) as Record<string, string | number | null>[];
    if (key === "hour") {
      rows = rows.map((r) => ({ ...r, hour: hourLabel(Number(r.hour)) }));
    } else if (key === "day" || key === "week" || key === "month") {
      rows = rows.map((r) => ({ ...r, [key]: dayLabel(Number(r[key])) }));
      rows = fillPeriods(rows, spec, key);
    }
    const result: QueryResult = {
      rows,
      meta: { from: spec.from, to: spec.to, timezone, ms: Date.now() - started, files: Object.values(files).reduce((n, f) => n + f.length, 0) },
    };
    if (cacheKey) results.set(cacheKey, result);
    return result;
  }
}

/** Ensure every period in the range has a row (zeros where there was no traffic). */
function fillPeriods(rows: Record<string, string | number | null>[], spec: QuerySpec, key: "day" | "week" | "month") {
  const byKey = new Map(rows.map((r) => [r[key] as string, r]));
  const out = [];
  for (let d = periodStart(spec.from, key); d <= spec.to; d = nextPeriod(d, key)) {
    out.push(byKey.get(d) ?? { [key]: d, ...Object.fromEntries(spec.metrics.map((m) => [m, 0])) });
  }
  return out;
}

function periodStart(date: string, key: "day" | "week" | "month"): string {
  if (key === "month") return `${date.slice(0, 7)}-01`;
  if (key === "week") {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
    return addDays(date, -((dow + 6) % 7));
  }
  return date;
}

function nextPeriod(date: string, key: "day" | "week" | "month"): string {
  if (key === "day") return addDays(date, 1);
  if (key === "week") return addDays(date, 7);
  const [y, m] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

export default {
  async fetch() {
    return new Response("qwa-query is only reachable via its service binding", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
