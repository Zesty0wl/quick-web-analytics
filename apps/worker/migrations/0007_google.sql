-- Google data. Search Console is read live (and cached); PageSpeed results are stored, one row per test.
-- gsc_property: NULL = find the matching property automatically, '' = don't show Search Console for this site,
-- anything else = that property (e.g. "sc-domain:example.com" or "https://example.com/").
ALTER TABLE sites ADD COLUMN gsc_property TEXT;

CREATE TABLE speed_runs (
  id INTEGER PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  strategy TEXT NOT NULL,          -- mobile | desktop
  run_at INTEGER NOT NULL,         -- unix seconds
  score INTEGER,                   -- Lighthouse performance score, 0-100
  lab TEXT NOT NULL,               -- JSON: lcp, cls, tbt, fcp, si, ttfb (ms, CLS unitless)
  field TEXT,                      -- JSON: Chrome UX Report p75s for the page (or its origin) and Google's verdict
  opportunities TEXT NOT NULL      -- JSON: biggest suggested fixes [{id, title, savingsMs}]
);
CREATE INDEX speed_runs_site ON speed_runs (site_id, run_at);
