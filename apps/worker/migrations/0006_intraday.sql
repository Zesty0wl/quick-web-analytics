-- Hourly ("so far today") anomaly check: extra detail on anomaly rows, and each site's baseline for the day.
ALTER TABLE anomalies ADD COLUMN detail TEXT;          -- JSON, e.g. {"hour":14,"window":"today"} for metric 'intraday'
CREATE TABLE intraday_baselines (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  day TEXT NOT NULL,                                   -- site-local date the baseline is for
  hourly TEXT NOT NULL,                                -- JSON: visits per local hour on each earlier same weekday
  PRIMARY KEY (site_id, day)
);
