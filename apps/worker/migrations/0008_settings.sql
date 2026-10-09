-- Settings an admin saves from the dashboard (e.g. Google credentials entered under Admin → Google).
-- A Worker secret of the same name, if set, takes precedence.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
