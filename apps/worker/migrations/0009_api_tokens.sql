-- Personal access tokens for agents (the MCP server at /mcp) and other API clients. Read-only.
-- Only a SHA-256 hash of each token is stored; the token itself is shown once, when it's created.
CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  hint TEXT NOT NULL,              -- the last four characters, to tell tokens apart
  sites TEXT,                      -- JSON array of site ids it's limited to; NULL = every site the user can see
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER               -- NULL = doesn't expire
);
CREATE INDEX api_tokens_user ON api_tokens (user_id);
