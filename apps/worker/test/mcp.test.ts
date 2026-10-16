import { describe, expect, it, vi } from "vitest";
import { parseFilters, resolvePeriod, siteUrl } from "../src/mcp";
import { hashToken, TOKEN_PREFIX } from "../src/tokens";
import { sameTimeWindow } from "../src/tz";
import type { Site } from "../src/env";

const site: Site = { id: 2, domain: "example.com", timezone: "UTC", allowed_hostnames: [], ip_blocklist: [], daily_cap: null, gsc_property: null };

describe("resolvePeriod", () => {
  it("takes an explicit range and compares with the previous one of the same length", () => {
    expect(resolvePeriod(site, { from: "2026-09-01", to: "2026-09-30" })).toMatchObject({ from: "2026-09-01", to: "2026-09-30", cfrom: "2026-08-02", cto: "2026-08-31" });
  });
  it("compares with last year when asked", () => {
    expect(resolvePeriod(site, { from: "2024-02-29", to: "2024-03-06", compare: "year" })).toMatchObject({ cfrom: "2023-02-28", cto: "2023-03-06" });
  });
  it("compares today with yesterday up to the same time", () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 16, 14, 7, 30) });
    try {
      const p = resolvePeriod(site, { period: "today" });
      expect(p).toMatchObject({ from: "2026-10-16", cfrom: "2026-10-15", cto: "2026-10-15", csince: Date.UTC(2026, 9, 15) / 1000, cuntil: Date.UTC(2026, 9, 15, 14, 5) / 1000 });
      expect(p.since).toBeUndefined();
      expect(p.cmpLabel).toBe("yesterday up to the same time (14:05)");
      expect(resolvePeriod(site, { period: "7d" }).csince).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects bad ranges", () => {
    expect(() => resolvePeriod(site, { from: "2026-09-30", to: "2026-09-01" })).toThrow();
    expect(() => resolvePeriod(site, { period: "forever" })).toThrow();
    expect(() => resolvePeriod(site, { from: "2020-01-01", to: "2026-01-01" })).toThrow(/800 days/);
  });
});

describe("sameTimeWindow", () => {
  const at = (iso: string) => Date.parse(iso) / 1000;
  it("cuts the comparison day at the same time of day, in 5-minute steps", () => {
    expect(sameTimeWindow("Europe/London", "2026-10-16", "2026-10-16", "2026-10-15", at("2026-10-16T09:07:00Z"))).toEqual({ start: at("2026-10-14T23:00:00Z"), end: at("2026-10-15T09:05:00Z") });
    // Same day last year, in the site's own timezone.
    expect(sameTimeWindow("Australia/Sydney", "2026-10-16", "2026-10-16", "2025-10-16", at("2026-10-16T01:00:00Z"))).toEqual({ start: at("2025-10-15T13:00:00Z"), end: at("2025-10-16T01:00:00Z") });
  });
  it("covers at least the first 5 minutes just after midnight", () => {
    const w = sameTimeWindow("UTC", "2026-10-16", "2026-10-16", "2026-10-15", at("2026-10-16T00:01:00Z"))!;
    expect(w.end - w.start).toBe(300);
  });
  it("only applies to today alone", () => {
    expect(sameTimeWindow("UTC", "2026-10-10", "2026-10-16", "2026-10-09", at("2026-10-16T12:00:00Z"))).toBeNull();
    expect(sameTimeWindow("UTC", "2026-10-15", "2026-10-15", "2026-10-14", at("2026-10-16T12:00:00Z"))).toBeNull();
    // Already tomorrow in the site's timezone: the dates name a finished day.
    expect(sameTimeWindow("Pacific/Auckland", "2026-10-16", "2026-10-16", "2026-10-15", at("2026-10-16T12:00:00Z"))).toBeNull();
  });
});

describe("siteUrl", () => {
  it("accepts paths and URLs on the site or its subdomains", () => {
    expect(siteUrl(site, "/pricing")).toBe("https://example.com/pricing");
    expect(siteUrl(site, "https://www.example.com/a?b=1#x")).toBe("https://www.example.com/a?b=1");
    expect(siteUrl(site, "blog.example.com/post")).toBe("https://blog.example.com/post");
  });
  it("refuses other hosts", () => {
    expect(() => siteUrl(site, "https://evil.test/")).toThrow(/isn't part of example.com/);
    expect(() => siteUrl(site, "https://notexample.com/")).toThrow();
  });
});

describe("parseFilters", () => {
  it("turns objects into query filters, defaulting op to is", () => {
    expect(parseFilters([{ dimension: "device", value: "Desktop" }, { dimension: "page", op: "contains", value: "/blog" }])).toEqual([["device", "is", "Desktop"], ["page", "contains", "/blog"]]);
  });
  it("rejects unknown dimensions", () => {
    expect(() => parseFilters([{ dimension: "colour", value: "red" }])).toThrow(/unknown filter dimension/);
  });
});

describe("tokens", () => {
  it("hashes tokens with SHA-256", async () => {
    expect(TOKEN_PREFIX).toBe("qwa_pat_");
    expect(await hashToken("qwa_pat_x")).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashToken("qwa_pat_x")).not.toBe(await hashToken("qwa_pat_y"));
  });
});
