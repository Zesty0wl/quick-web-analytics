#!/usr/bin/env bash
# Export Plausible CE sites, their pa-* script settings and IP block rules from CE's Postgres, as JSON.
# Usage: tools/import-ce/export-sites.sh <ssh-host> > sites.json
# The Postgres container defaults to the name Plausible CE's docker-compose gives it; override with PG_CONTAINER.
set -euo pipefail
HOST="$1"
ssh -o BatchMode=yes "$HOST" "docker exec -i ${PG_CONTAINER:-plausible-ce-plausible_db-1} psql -U postgres -d plausible_db -At" <<'SQL'
SELECT json_build_object('sites', (
  SELECT json_agg(json_build_object(
    'ce_id', s.id, 'domain', s.domain, 'timezone', s.timezone, 'created_at', s.inserted_at,
    'tracker', (SELECT row_to_json(t) FROM (
      SELECT id, outbound_links, file_downloads, form_submissions FROM tracker_script_configuration WHERE site_id = s.id) t),
    'ip_blocklist', (SELECT coalesce(json_agg(r.inet::text), '[]') FROM shield_rules_ip r WHERE r.site_id = s.id AND r.action = 'deny')
  ) ORDER BY s.id) FROM sites s));
SQL
