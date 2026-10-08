#!/usr/bin/env bash
# Export Plausible CE events and sessions (all sites) from its ClickHouse container as Parquet.
# Usage: tools/import-ce/export.sh <ssh-host> <cutoff ISO UTC, e.g. 2026-10-08T12:00:00> <out-dir>
# The ClickHouse container defaults to the name Plausible CE's docker-compose gives it; override with CH_CONTAINER.
set -euo pipefail
HOST="$1"; CUTOFF="$2"; OUT="$3"
mkdir -p "$OUT"
CH="docker exec -i ${CH_CONTAINER:-plausible-ce-plausible_events_db-1} clickhouse-client --readonly=1"
MASK=9007199254740991   # 2^53-1: ids must stay exact as JavaScript numbers

ssh -o BatchMode=yes "$HOST" "$CH" > "$OUT/sessions.parquet" <<SQL
SELECT site_id,
  toInt64(bitAnd(session_id, $MASK)) AS session, toInt64(bitAnd(user_id, $MASK)) AS visitor,
  toInt64(toUnixTimestamp(start)) AS start, toInt64(toUnixTimestamp(timestamp)) AS last,
  hostname, entry_page, exit_page, pageviews, events, toInt32(is_bounce) AS bounce, toInt32(duration) AS duration,
  referrer, referrer_source AS source, channel, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
  replaceAll(toString(country_code), '\0', '') AS country, subdivision1_code AS region,
  browser, browser_version, operating_system AS os, operating_system_version AS os_version, screen_size AS device
FROM plausible_events_db.sessions_v2 FINAL
WHERE sign = 1 AND start < parseDateTimeBestEffort('$CUTOFF')
FORMAT Parquet
SQL

ssh -o BatchMode=yes "$HOST" "$CH" > "$OUT/events.parquet" <<SQL
SELECT site_id, name,
  toInt64(toUnixTimestamp(timestamp)) AS ts,
  toInt64(bitAnd(session_id, $MASK)) AS session, toInt64(bitAnd(user_id, $MASK)) AS visitor,
  hostname, pathname AS path, toInt32(scroll_depth) AS scroll_depth, toInt32(engagement_time) AS engaged_ms,
  if(length(\`meta.key\`) = 0, '', toJSONString(CAST((\`meta.key\`, \`meta.value\`), 'Map(String, String)'))) AS props
FROM plausible_events_db.events_v2
WHERE timestamp < parseDateTimeBestEffort('$CUTOFF')
FORMAT Parquet
SQL
ls -la "$OUT"
