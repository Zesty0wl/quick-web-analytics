// Dev helper (skipped unless GEN_SQL_OUT is set): emits SQL for real specs against local Parquet
// files, so they can be run with native DuckDB and compared with Plausible CE's numbers.
import { readdirSync, writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import { keyRange, TABLES, validateSpec, type TableName } from "@qwa/shared";
import { buildSql } from "../src/sql";
import { addDays, localMidnight, offsetSegments } from "../src/tz";

const out = process.env.GEN_SQL_OUT;
const root = process.env.GEN_SQL_DATA ?? "";
const site = Number(process.env.GEN_SQL_SITE ?? 2);
const tz = "Europe/London";

const SPECS: Record<string, unknown> = {
  summary: { from: "2026-04-01", to: "2026-04-30", metrics: ["visitors", "visits", "pageviews", "views_per_visit", "bounce_rate", "visit_duration", "events", "scroll_depth", "time_on_page"] },
  daily: { from: "2026-04-01", to: "2026-04-10", metrics: ["visitors", "visits", "pageviews"], groupBy: "day" },
  sources: { from: "2026-04-01", to: "2026-04-30", metrics: ["visitors", "visits", "bounce_rate"], groupBy: "source", limit: 5 },
  pages: { from: "2026-04-01", to: "2026-04-30", metrics: ["visitors", "pageviews", "scroll_depth", "time_on_page"], groupBy: "page", limit: 5 },
  events: { from: "2026-04-01", to: "2026-04-30", metrics: ["visitors", "events"], groupBy: "event", limit: 5 },
  page_filter: { from: "2026-04-01", to: "2026-04-30", metrics: ["visitors", "visits", "pageviews"], filters: [["page", "is", "/"]] },
  country_pages: { from: "2026-04-01", to: "2026-04-30", metrics: ["visitors", "pageviews"], groupBy: "page", filters: [["country", "is", "US"]], limit: 3 },
  weekly: { from: "2026-03-23", to: "2026-04-19", metrics: ["visitors", "pageviews"], groupBy: "week" },
  monthly: { from: "2026-01-01", to: "2026-06-30", metrics: ["visitors", "pageviews"], groupBy: "month" },
  hourly_peak: { from: "2026-04-06", to: "2026-04-06", metrics: ["visitors", "pageviews"], groupBy: "hour" },
};

describe.skipIf(!out)("generate SQL", () => {
  it("writes SQL", () => {
    const result: Record<string, string> = {};
    for (const [name, raw] of Object.entries(SPECS)) {
      const spec = validateSpec(raw);
      const from = localMidnight(tz, spec.from);
      const to = localMidnight(tz, addDays(spec.to, 1));
      const files = Object.fromEntries(
        TABLES.map((t) => {
          const dir = `${root}/sites/${site}/${t}/import`;
          const fs = readdirSync(dir).map((f) => `${dir}/${f}`).filter((p) => {
            const r = keyRange(p.replace("/import/", "/month/"));
            return r && r[0] < to + 86_400 && r[1] > from - 86_400;
          });
          return [t, fs];
        }),
      ) as Record<TableName, string[]>;
      const days = Math.round((to - from) / 86_400);
      result[name] = buildSql({ spec, from, to, segments: offsetSegments(tz, from, to), files, approximate: days > 92 }).sql;
    }
    writeFileSync(out!, JSON.stringify(result, null, 1));
  });
});
