import { afterEach, describe, expect, it, vi } from "vitest";
import type { Query } from "@tanstack/react-query";
import { FALLBACK_REFRESH_MS, isLive, loadStats, splitLines, staleLiveQueries } from "../src/api";
import { addDays, todayIn } from "../src/dates";

const TZ = "Europe/London";
const today = todayIn(TZ);

function query(to: string, opts: { version?: string; age: number; freshness?: "fast" | "slow"; fetching?: boolean }, now: number): Query {
  return {
    queryKey: ["stats", 1, { from: addDays(to, -6), to, metrics: ["visitors"] }],
    meta: { freshness: opts.freshness ?? "slow" },
    state: { data: { rows: [], meta: {}, version: opts.version }, dataUpdatedAt: now - opts.age, fetchStatus: opts.fetching ? "fetching" : "idle" },
  } as unknown as Query;
}

describe("splitLines", () => {
  it("keeps an unfinished line for the next chunk", () => {
    expect(splitLines('{"i":0}\n{"i":1}\n{"i"')).toEqual({ lines: ['{"i":0}', '{"i":1}'], rest: '{"i"' });
    expect(splitLines("\n\n")).toEqual({ lines: [], rest: "" });
  });
});

describe("isLive", () => {
  it("is true only for ranges reaching today in the site's timezone", () => {
    expect(isLive({ to: today }, TZ)).toBe(true);
    expect(isLive({ to: addDays(today, -1) }, TZ)).toBe(false);
  });
});

describe("staleLiveQueries", () => {
  const now = Date.now();
  it("refreshes a live report once the version has moved on and it's past its freshness interval", () => {
    const fast = query(today, { version: "5", age: 11_000, freshness: "fast" }, now);
    const slowTooSoon = query(today, { version: "5", age: 11_000 }, now);
    const slowDue = query(today, { version: "5", age: 31_000 }, now);
    expect(staleLiveQueries([fast, slowTooSoon, slowDue], TZ, "6", "5", now)).toEqual([fast, slowDue]);
  });
  it("leaves reports alone while nothing has changed, until the fallback interval", () => {
    const q = query(today, { version: "6", age: 60_000 }, now);
    expect(staleLiveQueries([q], TZ, "6", "5", now)).toEqual([]);
    const old = query(today, { version: "6", age: FALLBACK_REFRESH_MS }, now);
    expect(staleLiveQueries([old], TZ, "6", "5", now)).toEqual([old]);
  });
  it("never refreshes past ranges or reports already fetching", () => {
    expect(staleLiveQueries([query(addDays(today, -1), { version: "1", age: FALLBACK_REFRESH_MS }, now)], TZ, "9", "1", now)).toEqual([]);
    expect(staleLiveQueries([query(today, { version: "1", age: 60_000, fetching: true }, now)], TZ, "9", "1", now)).toEqual([]);
  });
  it("treats answers fetched before any version was known as the first version seen", () => {
    const q = query(today, { age: 60_000 }, now);
    expect(staleLiveQueries([q], TZ, "5", "5", now)).toEqual([]);
    expect(staleLiveQueries([q], TZ, "6", "5", now)).toEqual([q]);
  });
});

describe("loadStats", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends queries asked for together as one batch and resolves each from the streamed answers", async () => {
    const calls: { url: string; body: { queries: { to: string }[] } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body });
      // Answers out of order, split mid-line across chunks, with one error.
      const text = `{"i":1,"result":{"rows":[{"n":1}],"meta":{}}}\n{"i":0,"error":"bad query","status":400}\n{"i":2,"res` + `ult":{"rows":[{"n":2}],"meta":{}}}\n`;
      const chunks = [text.slice(0, 30), text.slice(30, 70), text.slice(70)];
      return new Response(new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch)); c.close(); } }));
    });
    const spec = (to: string) => ({ from: "2026-10-01", to, metrics: ["visitors" as const] });
    const [a, b, c] = await Promise.allSettled([loadStats(7, spec("2026-10-02")), loadStats(7, spec("2026-10-03")), loadStats(7, spec("2026-10-04"))]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/sites/7/batch");
    expect(calls[0].body.queries.map((q) => q.to)).toEqual(["2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(a).toMatchObject({ status: "rejected", reason: { message: "bad query", status: 400 } });
    expect(b).toMatchObject({ status: "fulfilled", value: { rows: [{ n: 1 }] } });
    expect(c).toMatchObject({ status: "fulfilled", value: { rows: [{ n: 2 }] } });
  });

  it("fails every query in the batch that got no answer", async () => {
    vi.stubGlobal("fetch", async () => new Response('{"i":0,"result":{"rows":[],"meta":{}}}\n'));
    const spec = { from: "2026-10-01", to: "2026-10-02", metrics: ["visitors" as const] };
    const [a, b] = await Promise.allSettled([loadStats(8, spec), loadStats(8, { ...spec, limit: 5 })]);
    expect(a.status).toBe("fulfilled");
    expect(b).toMatchObject({ status: "rejected", reason: { status: 502 } });
  });

  it("uses the single-query endpoint for a query on its own", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return Response.json({ rows: [{ n: 3 }], meta: {} });
    });
    await expect(loadStats(9, { from: "2026-10-01", to: "2026-10-02", metrics: ["visitors"] })).resolves.toMatchObject({ rows: [{ n: 3 }] });
    expect(urls).toEqual(["/api/sites/9/query"]);
  });
});
