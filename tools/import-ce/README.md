# Import from Plausible CE

These scripts copy sites and history from a self-hosted Plausible Community Edition (Docker) into QWA. They only read from Plausible; nothing there is changed.

The whole migration, including keeping existing snippets working, is described in [docs/MIGRATING.md](../../docs/MIGRATING.md). This page covers the scripts themselves.

## You need

- **ssh access** to the machine running Plausible CE, as a user that can run `docker exec`.
- **Python 3** with `duckdb` and `boto3`: `pip install duckdb boto3`.
- **An R2 API token** with write access to your `qwa-data` bucket (R2 → Manage API tokens). Note its Access Key ID and Secret, and your account ID.

The container names default to what Plausible CE's `docker-compose.yml` creates. If yours differ, set `PG_CONTAINER` and `CH_CONTAINER`.

## Steps

```sh
# 1. Sites, pa-* snippet settings and IP block rules → D1 (keeps Plausible's site ids)
tools/import-ce/export-sites.sh my-plausible-host > sites.json
python3 -I tools/import-ce/sites_sql.py sites.json > sites.sql
(cd apps/worker && npx wrangler d1 execute qwa --remote --file ../../sites.sql)

# 2. History up to the cutoff → Parquet (the cutoff is when QWA started recording; see MIGRATING.md)
tools/import-ce/export.sh my-plausible-host 2026-10-08T12:00:00 ce-export/
python3 -I tools/import-ce/transform.py ce-export/ ce-import/

# 3. Upload to R2
R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… python3 -I tools/import-ce/upload.py ce-import/ qwa-data
```

Then fill the overview's daily totals (otherwise they fill at the next nightly run). As an admin, run this in the browser console on the dashboard:

```js
fetch("/api/admin/rollup", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.json())
```

## What's imported

| Plausible | QWA |
|---|---|
| `sessions_v2` | `sessions`: entry/exit pages, bounce, duration, sources, UTMs, country and region, browser, OS and device |
| `events_v2` pageviews | `pageviews`, with custom properties |
| `events_v2` engagement | `engagement`: scroll depth and engaged time |
| other `events_v2` names | `custom` events, with properties |

**Normalised during import:**
- Plausible's source names are renamed to QWA's, e.g. `twitter` becomes `X`.
- Channels are derived the same way live ingestion does it. Plausible CE doesn't store a channel.

**Not available from Plausible:** cities, because CE stores a numeric GeoNames id, not a name.

Files land under `sites/<id>/<table>/import/<YYYY-MM>.parquet`. Live data never overlaps them, as long as the cutoff matches the moment QWA started recording.

**Re-running is safe:** uploading again replaces the same keys. To redo an import with a different cutoff, delete the old `import/` files first.
