-- Daily summaries per site, in the site's local timezone: what the site page's standard reports are answered from,
-- so they don't have to read every event in the range. One row per day, dimension and value:
--   dim ''      the day's totals (key '')
--   dim 'hour'  each hour of the day (key '00'..'23')
--   otherwise   a breakdown (source, country, page, event…), each day's top rows by visitors
-- The columns are sums, so any range adds up from its days; ratios (bounce rate, time on page…) are worked out from
-- them. Filled by the hourly job (summary.ts); today and any day not yet summarised come from the events themselves.
CREATE TABLE daily_dims (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  dim TEXT NOT NULL,
  day TEXT NOT NULL,                              -- local date, YYYY-MM-DD
  key TEXT NOT NULL,
  visitors INTEGER NOT NULL DEFAULT 0,
  visits INTEGER NOT NULL DEFAULT 0,
  pageviews INTEGER NOT NULL DEFAULT 0,
  events INTEGER NOT NULL DEFAULT 0,
  bounces INTEGER NOT NULL DEFAULT 0,
  duration_sum INTEGER NOT NULL DEFAULT 0,        -- seconds, summed over visits
  session_pageviews INTEGER NOT NULL DEFAULT 0,   -- page views counted on the visits that started that day
  engaged_ms INTEGER NOT NULL DEFAULT 0,
  engaged_visitors INTEGER NOT NULL DEFAULT 0,
  scroll_sum INTEGER NOT NULL DEFAULT 0,
  scroll_n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, dim, day, key)
) WITHOUT ROWID;

-- How far each site's summaries go: every day from `from_day` to `through_day`, worked out in `timezone` (if the
-- site's timezone changes, its summaries are rebuilt).
CREATE TABLE summary_state (
  site_id INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  timezone TEXT NOT NULL,
  from_day TEXT NOT NULL,
  through_day TEXT NOT NULL
);
