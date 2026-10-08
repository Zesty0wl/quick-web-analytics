-- Quick Web Analytics: app database (D1)

CREATE TABLE sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL UNIQUE,                 -- the `data-domain` / `d` value clients send
  timezone TEXT NOT NULL DEFAULT 'UTC',
  allowed_hostnames TEXT NOT NULL DEFAULT '[]', -- JSON array; empty = accept any hostname
  ip_blocklist TEXT NOT NULL DEFAULT '[]',     -- JSON array of IPs or CIDRs
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-site settings for Plausible's `/js/pa-<id>.js` snippet (compat layer only).
CREATE TABLE compat_scripts (
  id TEXT PRIMARY KEY,                         -- 'pa-…'
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  outbound_links INTEGER NOT NULL DEFAULT 0,
  file_downloads INTEGER NOT NULL DEFAULT 0,
  form_submissions INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'viewer')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT
);

CREATE TABLE site_access (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  granted_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, site_id)
);

-- Daily rotating salts for cookieless visitor hashing. Rows older than 2 days are deleted.
CREATE TABLE salts (
  day TEXT PRIMARY KEY,                        -- UTC date, YYYY-MM-DD
  salt TEXT NOT NULL
);
