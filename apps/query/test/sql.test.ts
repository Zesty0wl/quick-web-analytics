import { describe, expect, it } from "vitest";
import { validateSpec } from "@qwa/shared";
import { buildSql } from "../src/sql";
import { localMidnight, offsetSegments, offsetAt, localTimeSql } from "../src/tz";

const files = { sessions: ["https://r2.local/s.parquet"], pageviews: ["https://r2.local/p.parquet"], engagement: [], custom: [] };

describe("timezones", () => {
  it("finds local midnight across BST", () => {
    expect(localMidnight("Europe/London", "2026-07-01")).toBe(Date.UTC(2026, 5, 30, 23) / 1000);
    expect(localMidnight("Europe/London", "2026-12-01")).toBe(Date.UTC(2026, 11, 1) / 1000);
    expect(localMidnight("UTC", "2026-04-06")).toBe(Date.UTC(2026, 3, 6) / 1000);
  });
  it("detects the DST transition inside a range", () => {
    const from = localMidnight("Europe/London", "2026-03-20");
    const to = localMidnight("Europe/London", "2026-04-05");
    const segs = offsetSegments("Europe/London", from, to);
    expect(segs.length).toBe(2);
    expect(segs[1]).toEqual([Date.UTC(2026, 2, 29, 1) / 1000, 3600]);
    expect(offsetAt("Europe/London", segs[1][0] - 1)).toBe(0);
    expect(localTimeSql("ts", segs)).toContain("CASE WHEN ts <");
  });
});

describe("SQL builder", () => {
  const base = { from: 0, to: 86_400, segments: [[0, 0]] as [number, number][], files, approximate: false };
  it("builds a summary across tables", () => {
    const spec = validateSpec({ from: "2026-10-01", to: "2026-10-07", metrics: ["visitors", "pageviews", "bounce_rate", "events"] });
    const { sql } = buildSql({ ...base, spec });
    expect(sql).toContain("m_sessions AS");
    expect(sql).toContain("m_pageviews AS");
    expect(sql).toContain("CROSS JOIN m_custom");
    expect(sql).toContain("WHERE false"); // custom has no files → empty relation
  });
  it("groups by a session dimension and joins event tables through sessions", () => {
    const spec = validateSpec({ from: "2026-10-01", to: "2026-10-07", metrics: ["visitors", "pageviews"], groupBy: "source", limit: 10 });
    const { sql } = buildSql({ ...base, spec });
    expect(sql).toContain("t.source AS k");
    expect(sql).toContain("JOIN (SELECT * FROM src_sessions");
    expect(sql).toContain("LIMIT 10");
  });
  it("applies page filters to sessions via a semi-join", () => {
    const spec = validateSpec({ from: "2026-10-01", to: "2026-10-01", metrics: ["visitors"], filters: [["page", "is", "/"]] });
    const { sql } = buildSql({ ...base, spec });
    expect(sql).toContain("t.session IN (SELECT session FROM src_pageviews p");
    expect(sql).toContain("p.path IN ('/')");
  });
  it("escapes quotes in filter values", () => {
    const spec = validateSpec({ from: "2026-10-01", to: "2026-10-01", metrics: ["visitors"], filters: [["country", "is", "x' OR 1=1 --"]] });
    expect(buildSql({ ...base, spec }).sql).toContain("'x'' OR 1=1 --'");
  });
  it("rejects metrics that don't fit the grouping", () => {
    expect(() => validateSpec({ from: "2026-10-01", to: "2026-10-02", metrics: ["bounce_rate"], groupBy: "page" })).toThrow();
    expect(() => validateSpec({ from: "2026-10-02", to: "2026-10-01", metrics: ["visitors"] })).toThrow();
  });
});
