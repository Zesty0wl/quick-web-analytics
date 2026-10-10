import { describe, expect, it } from "vitest";
import { ResultCache } from "../src/cache";

describe("ResultCache", () => {
  it("returns what was stored and evicts the least recently used", () => {
    const c = new ResultCache<string>({ maxEntries: 2, maxBytes: 1000 });
    c.set("a", "A");
    c.set("b", "B");
    expect(c.get("a")).toBe("A"); // a is now the most recent
    c.set("c", "C");
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe("A");
    expect(c.get("c")).toBe("C");
  });
  it("keeps within its byte budget and skips answers too big to be worth it", () => {
    const c = new ResultCache<string>({ maxEntries: 100, maxBytes: 100 });
    c.set("big", "x", 30);
    expect(c.get("big")).toBeUndefined();
    for (const k of ["a", "b", "c", "d", "e"]) c.set(k, k, 20);
    expect(c.size).toBe(5);
    c.set("f", "f", 20);
    expect(c.get("a")).toBeUndefined();
    expect(c.size).toBe(5);
  });
  it("makes the same key for the same parts, and a different one when anything differs", async () => {
    const a = await ResultCache.key([1, "Europe/London", { from: "2026-10-01" }, "SELECT 1 FROM 'x?v=etag1'"]);
    expect(await ResultCache.key([1, "Europe/London", { from: "2026-10-01" }, "SELECT 1 FROM 'x?v=etag1'"])).toBe(a);
    expect(await ResultCache.key([1, "Europe/London", { from: "2026-10-01" }, "SELECT 1 FROM 'x?v=etag2'"])).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
