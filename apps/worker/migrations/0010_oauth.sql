-- OAuth 2.1 for MCP clients that connect with a "Connect" button (Claude Desktop, claude.ai connectors…):
-- dynamically registered clients, short-lived authorization codes, and grants holding the current access and refresh
-- tokens. Only SHA-256 hashes of codes and tokens are stored.
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,      -- JSON array
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,     -- PKCE S256
  sites TEXT,                       -- JSON array of site ids, NULL = all the user can see
  expires_at INTEGER NOT NULL
);

CREATE TABLE oauth_grants (
  id INTEGER PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sites TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  access_hash TEXT UNIQUE,
  access_expires_at INTEGER,
  refresh_hash TEXT UNIQUE,
  refresh_expires_at INTEGER,
  previous_refresh_hash TEXT        -- the one before: presenting it again means a copy exists, so the grant is revoked
);
CREATE INDEX oauth_grants_user ON oauth_grants (user_id);
