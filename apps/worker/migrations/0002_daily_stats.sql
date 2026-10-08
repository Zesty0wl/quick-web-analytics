-- Per-site daily totals in the site's local timezone: powers the all-sites overview without DuckDB.
-- Closed days are written by the nightly rollup; today (and yesterday until it's rolled up) come live from the SiteDO.
CREATE TABLE daily_stats (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  day TEXT NOT NULL,                 -- local date, YYYY-MM-DD
  visitors INTEGER NOT NULL,
  visits INTEGER NOT NULL,
  pageviews INTEGER NOT NULL,
  events INTEGER NOT NULL,
  bounces INTEGER NOT NULL,
  duration_sum INTEGER NOT NULL,     -- seconds, summed over visits
  PRIMARY KEY (site_id, day)
);
