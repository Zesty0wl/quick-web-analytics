import { describe, expect, it } from "vitest";
import { parseFilters, resolvePeriod, siteUrl } from "../src/mcp";
import { hashToken, TOKEN_PREFIX } from "../src/tokens";
import type { Site } from "../src/env";

const site: Site = { id: 2, domain: "example.com", timezone: "UTC", allowed_hostnames: [], ip_blocklist: [], daily_cap: null, gsc_property: null };

describe("resolvePeriod", () => {
  it("takes an explicit range and compares with the previous one of the same length", () => {
    expect(resolvePeriod(site, { from: "2026-09-01", to: "2026-09-30" })).toMatchObject({ from: "2026-09-01", to: "2026-09-30", cfrom: "2026-08-02", cto: "2026-08-31" });
  });
  it("compares with last year when asked", () => {
    expect(resolvePeriod(site, { from: "2024-02-29", to: "2024-03-06", compare: "year" })).toMatchObject({ cfrom: "2023-02-28", cto: "2023-03-06" });
  });
  it("rejects bad ranges", () => {
    expect(() => resolvePeriod(site, { from: "2026-09-30", to: "2026-09-01" })).toThrow();
    expect(() => resolvePeriod(site, { period: "forever" })).toThrow();
    expect(() => resolvePeriod(site, { from: "2020-01-01", to: "2026-01-01" })).toThrow(/800 days/);
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
