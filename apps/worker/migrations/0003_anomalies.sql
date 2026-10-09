-- Unusual days found by the nightly anomaly check (first day of each episode only; see src/anomaly.ts).
CREATE TABLE anomalies (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  day TEXT NOT NULL,                 -- site-local date
  metric TEXT NOT NULL,              -- 'visitors'
  kind TEXT NOT NULL,                -- 'spike' | 'drop' | 'outage'
  value REAL NOT NULL,
  expected REAL NOT NULL,
  score REAL NOT NULL,
  notified_at TEXT,                  -- when alert emails went out (or 'history' for backfilled days)
  PRIMARY KEY (site_id, day, metric)
);

-- Who wants an email when one of their sites has an unusual day.
CREATE TABLE alert_subscriptions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, site_id)
);
