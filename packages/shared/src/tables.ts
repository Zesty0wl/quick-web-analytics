// Event storage layout shared by the writer (SiteDO) and the reader (query worker).
//
// r2://<bucket>/sites/<siteId>/<table>/day/<YYYY-MM-DD>.parquet   (UTC day, rewritten while the day is live)
// r2://<bucket>/sites/<siteId>/<table>/month/<YYYY-MM>.parquet    (closed months, compacted)
// r2://<bucket>/sites/<siteId>/<table>/import/<YYYY-MM>.parquet   (history imported from Plausible CE; never
//                                                                   overlaps live data: cut off when live ingestion began)

export type TableName = "sessions" | "pageviews" | "engagement" | "custom";
export const TABLES: TableName[] = ["sessions", "pageviews", "engagement", "custom"];

export type ColumnType = "INT64" | "INT32" | "STRING";

export const COLUMNS: Record<TableName, [string, ColumnType][]> = {
  sessions: [
    ["session", "INT64"], ["visitor", "INT64"], ["start", "INT64"], ["last", "INT64"],
    ["hostname", "STRING"], ["entry_page", "STRING"], ["exit_page", "STRING"],
    ["pageviews", "INT32"], ["events", "INT32"], ["bounce", "INT32"], ["duration", "INT32"],
    ["referrer", "STRING"], ["source", "STRING"], ["channel", "STRING"],
    ["utm_source", "STRING"], ["utm_medium", "STRING"], ["utm_campaign", "STRING"], ["utm_content", "STRING"], ["utm_term", "STRING"],
    ["country", "STRING"], ["region", "STRING"], ["city", "STRING"],
    ["browser", "STRING"], ["browser_version", "STRING"], ["os", "STRING"], ["os_version", "STRING"], ["device", "STRING"],
  ],
  pageviews: [["ts", "INT64"], ["session", "INT64"], ["visitor", "INT64"], ["hostname", "STRING"], ["path", "STRING"], ["props", "STRING"]],
  engagement: [["ts", "INT64"], ["session", "INT64"], ["visitor", "INT64"], ["path", "STRING"], ["scroll_depth", "INT32"], ["engaged_ms", "INT32"]],
  custom: [["ts", "INT64"], ["session", "INT64"], ["visitor", "INT64"], ["name", "STRING"], ["path", "STRING"], ["props", "STRING"]],
};

/** Column holding each table's timestamp (unix seconds). Sessions are partitioned by start. */
export const TIME_COLUMN: Record<TableName, string> = { sessions: "start", pageviews: "ts", engagement: "ts", custom: "ts" };

export const ROW_GROUP_SIZE = 262_144;

export const dayKey = (siteId: number, table: TableName, day: string) => `sites/${siteId}/${table}/day/${day}.parquet`;
export const monthKey = (siteId: number, table: TableName, month: string) => `sites/${siteId}/${table}/month/${month}.parquet`;
export const importKey = (siteId: number, table: TableName, month: string) => `sites/${siteId}/${table}/import/${month}.parquet`;
export const tablePrefix = (siteId: number, table: TableName) => `sites/${siteId}/${table}/`;

/** Parse "…/day/2026-10-08.parquet", "…/month/2026-10.parquet" or "…/import/2026-10.parquet" into a covered [start, end) range in unix seconds. */
export function keyRange(key: string): [number, number] | null {
  const day = key.match(/\/day\/(\d{4})-(\d{2})-(\d{2})\.parquet$/);
  if (day) {
    const s = Date.UTC(+day[1], +day[2] - 1, +day[3]) / 1000;
    return [s, s + 86_400];
  }
  const month = key.match(/\/(?:month|import)\/(\d{4})-(\d{2})\.parquet$/);
  if (month) {
    return [Date.UTC(+month[1], +month[2] - 1, 1) / 1000, Date.UTC(+month[1], +month[2], 1) / 1000];
  }
  return null;
}
