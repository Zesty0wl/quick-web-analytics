import { describe, expect, it } from "vitest";
import { canSplit, componentsFor, mergeParts, partSpec, summaryDimFor, validateSpec } from "@qwa/shared";
import { buildSql } from "../src/sql";

const spec = (q: object) => validateSpec({ from: "2026-11-01", to: "2026-11-14", ...q });

describe("answers assembled from parts", () => {
  it("asks each part for the sums behind the metrics, ranked by the first", () => {
    expect(componentsFor(["bounce_rate", "visitors", "visit_duration"])).toEqual(["bounces", "visits", "visitors", "duration_sum"]);
    const part = partSpec(spec({ metrics: ["visitors", "bounce_rate"], groupBy: "source", limit: 10 }), { from: "2026-11-01", to: "2026-11-13", noLive: true });
    expect(part).toMatchObject({ from: "2026-11-01", to: "2026-11-13", metrics: ["visitors", "bounces", "visits"], groupBy: "source", noLive: true });
    expect(part.limit).toBeGreaterThan(10); // the cut to 10 happens after the parts are added up
  });

  it("adds totals and works the ratios out afterwards", () => {
    const s = spec({ metrics: ["visitors", "visits", "bounce_rate", "visit_duration", "views_per_visit", "time_on_page", "scroll_depth"] });
    const rows = mergeParts(s, [
      [{ visitors: 90, visits: 100, bounces: 40, duration_sum: 6000, session_pageviews: 250, engaged_ms: 900_000, engaged_visitors: 50, scroll_sum: 3000, scroll_n: 60 }],
      [{ visitors: 10, visits: 20, bounces: 20, duration_sum: 600, session_pageviews: 50, engaged_ms: 100_000, engaged_visitors: 50, scroll_sum: 1000, scroll_n: 20 }],
    ]);
    expect(rows).toEqual([{ visitors: 100, visits: 120, bounce_rate: 50, visit_duration: 55, views_per_visit: 2.5, time_on_page: 10, scroll_depth: 50 }]);
  });

  it("gives zeros, not an empty answer, when no part has anything", () => {
    expect(mergeParts(spec({ metrics: ["visitors", "bounce_rate"] }), [[], []])).toEqual([{ visitors: 0, bounce_rate: 0 }]);
  });

  it("ranks a breakdown after adding up, and applies the limit last", () => {
    const s = spec({ metrics: ["visitors"], groupBy: "source", limit: 2 });
    const rows = mergeParts(s, [
      [{ source: "Google", visitors: 5 }, { source: "Bing", visitors: 4 }],
      [{ source: "Direct", visitors: 8 }, { source: "Bing", visitors: 3 }, { source: "Google", visitors: 1 }],
    ]);
    expect(rows).toEqual([{ source: "Direct", visitors: 8 }, { source: "Bing", visitors: 7 }]);
  });

  it("fills every day of the range and merges the day both parts touch", () => {
    const s = validateSpec({ from: "2026-11-12", to: "2026-11-14", metrics: ["visitors"], groupBy: "day" });
    const rows = mergeParts(s, [[{ day: "2026-11-12", visitors: 3 }, { day: "2026-11-13", visitors: 1 }], [{ day: "2026-11-13", visitors: 2 }]]);
    expect(rows).toEqual([{ day: "2026-11-12", visitors: 3 }, { day: "2026-11-13", visitors: 3 }, { day: "2026-11-14", visitors: 0 }]);
  });

  it("groups stored days into weeks from Monday", () => {
    const s = validateSpec({ from: "2026-11-02", to: "2026-11-15", metrics: ["pageviews"], groupBy: "week" });
    expect(mergeParts(s, [[{ week: "2026-11-02", pageviews: 5 }], [{ week: "2026-11-09", pageviews: 7 }, { week: "2026-11-02", pageviews: 1 }]])).toEqual([
      { week: "2026-11-02", pageviews: 6 }, { week: "2026-11-09", pageviews: 7 },
    ]);
  });

  it("never splits Web Vitals (percentiles don't add up)", () => {
    expect(canSplit(spec({ metrics: ["lcp", "measured_views"] }))).toBe(false);
    expect(canSplit(spec({ metrics: ["measured_views"], groupBy: "lcp_element" }))).toBe(false);
    expect(canSplit(spec({ metrics: ["visitors"], groupBy: "hour", filters: [["country", "is", "GB"]] }))).toBe(true);
  });

  it("knows which reports the daily summaries can answer", () => {
    expect(summaryDimFor(spec({ metrics: ["visitors", "bounce_rate", "time_on_page"] }))).toBe("");
    expect(summaryDimFor(spec({ metrics: ["visitors"], groupBy: "week" }))).toBe("");
    expect(summaryDimFor(spec({ metrics: ["visitors"], groupBy: "weekhour" }))).toBe("hour");
    expect(summaryDimFor(spec({ metrics: ["visitors", "bounce_rate"], groupBy: "source" }))).toBe("source");
    expect(summaryDimFor(spec({ metrics: ["pageviews", "visitors", "time_on_page", "scroll_depth"], groupBy: "page" }))).toBe("page");
    expect(summaryDimFor(spec({ metrics: ["visitors"], groupBy: "utm_campaign", filters: [["utm_campaign", "is_not", ""]] }))).toBe("utm_campaign");
    // Not stored: page views by source, hourly charts, filtered reports, groupings off the site page, exact bounds.
    expect(summaryDimFor(spec({ metrics: ["pageviews"], groupBy: "source" }))).toBeNull();
    expect(summaryDimFor(spec({ metrics: ["visitors"], groupBy: "hour" }))).toBeNull();
    expect(summaryDimFor(spec({ metrics: ["visitors"], filters: [["country", "is", "GB"]] }))).toBeNull();
    expect(summaryDimFor(spec({ metrics: ["visitors"], groupBy: "region" }))).toBeNull();
    expect(summaryDimFor(spec({ metrics: ["visitors"], since: 1_794_000_000, until: 1_794_086_400 }))).toBeNull();
  });
});

describe("SQL for parts and summaries", () => {
  const files = { sessions: ["https://r2.local/s.parquet"], pageviews: ["https://r2.local/p.parquet"], engagement: ["https://r2.local/e.parquet"], custom: [] };
  const base = { from: 0, to: 86_400, segments: [[0, 0]] as [number, number][], files, approximate: false };

  it("selects the sums behind the ratios", () => {
    const { sql } = buildSql({ ...base, spec: { from: "2026-11-01", to: "2026-11-01", metrics: ["visits", "bounces", "duration_sum", "session_pageviews", "engaged_ms", "engaged_visitors", "scroll_sum", "scroll_n"] } });
    expect(sql).toContain("SUM(t.bounce) AS bounces");
    expect(sql).toContain("SUM(t.duration) AS duration_sum");
    expect(sql).toContain("COUNT(DISTINCT t.visitor) AS engaged_visitors");
    expect(sql).toContain("COUNT(nullif(t.scroll_depth, 0)) AS scroll_n");
  });

  it("groups by local day as well for the daily summaries, keeping each day's top rows", () => {
    const { sql, key } = buildSql({ ...base, spec: { from: "2026-11-01", to: "2026-11-30", metrics: ["visitors", "pageviews", "scroll_sum"], groupBy: "page", perDay: 500 } });
    expect(key).toBe("perday");
    expect(sql).toContain("GROUP BY 1, 2");
    expect(sql).toContain("USING (d, k)");
    expect(sql).toContain("PARTITION BY d ORDER BY visitors DESC NULLS LAST, k) <= 500");
    expect(sql).not.toContain("LIMIT");
  });
});
