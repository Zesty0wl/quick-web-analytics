# Migrating from Plausible

You can move to QWA without touching your sites on day one. QWA understands Plausible's tracker:
- it serves the same scripts (`/js/script.js` variants and per-site `/js/pa-*.js`)
- it accepts the same events at `/api/event`

Point your Plausible hostname at QWA and the existing snippets keep working. Then swap snippets for QWA's own tracker site by site, whenever it suits you.

If you only have a site or two, it's simpler to skip all this: add the sites in QWA, replace the snippet, and optionally import the history (step 4).

## How it fits together

```
 old snippets ──▶ plausible.example.com ──▶ Worker "qwa" (INGEST_HOSTS)
                                               ├─ /js/*, /api/event  → handled by QWA
                                               └─ everything else    → your Plausible server (optional)
 new snippets ──▶ analytics.example.com/t.js, /e
```

The Plausible hostname becomes an **ingest host**: a second hostname on the same Worker that only serves the tracker scripts and `/api/event`. It needs no Access application, because the dashboard isn't served there.

`ORIGIN_MODE` decides what happens to your old Plausible server during the switch:

| `ORIGIN_MODE` | QWA | Plausible | Use it for |
|---|---|---|---|
| `passthrough` | records a copy | still answers and stays the source of truth | A trial run: compare numbers for a few days |
| `mirror` | answers | still receives a copy of every event. Its dashboard and other paths keep working through the same hostname. | The switch, with a fallback |
| unset | answers | not involved | After you've turned Plausible off |

## 1. Deploy QWA

Follow [DEPLOY.md](DEPLOY.md) up to step 5 (Access), but **don't add sites by hand** if you'll import them from Plausible in step 2. Importing keeps Plausible's site ids, so the history lines up.

## 2. Import sites (self-hosted Plausible CE)

```sh
tools/import-ce/export-sites.sh my-plausible-host > sites.json
python3 -I tools/import-ce/sites_sql.py sites.json > sites.sql
(cd apps/worker && npx wrangler d1 execute qwa --remote --file ../../sites.sql)
```

This brings over each site's domain, timezone and IP block rules, plus the settings behind its `pa-*.js` snippet (outbound links, file downloads, form submissions). On Plausible Cloud, add the sites in QWA's admin instead; `pa-*.js` snippets won't be available, so use `/js/script*.js` or move straight to `/t.js`.

## 3. Route the Plausible hostname to QWA

In `apps/worker/wrangler.jsonc`:

```jsonc
"routes": [
  { "pattern": "analytics.example.com", "custom_domain": true },
  // A zone route keeps your Plausible server reachable behind the hostname (for passthrough/mirror).
  // Its DNS record must be proxied (orange cloud) and point at your Plausible server, as it probably does now.
  { "pattern": "plausible.example.com/*", "zone_name": "example.com" }
],
"vars": {
  "INGEST_HOSTS": "plausible.example.com",
  "COMPAT_ENDPOINT": "https://plausible.example.com/api/event",
  "ORIGIN_MODE": "passthrough"
}
```

Run `npm run deploy` and **note the time**: QWA records every event from this moment, which is the cutoff for the history import.

Only these Plausible tracker builds are bundled:
- `script.js`
- `script.manual.js`
- `script.outbound-links.js`
- `script.file-downloads.hash.outbound-links.js`
- `script.file-downloads.hash.outbound-links.tagged-events.js`
- per-site `pa-*.js`

Legacy names (`plausible.js`, any order of extensions) are normalised. Requests for a variant that isn't bundled return 404 and are logged. To add one, copy the build from Plausible's tracker (MIT) into `packages/tracker-compat/scripts/` and add it to `VENDORED` in `apps/worker/src/compat/scripts.ts`.

## 4. Import history

```sh
tools/import-ce/export.sh my-plausible-host <cutoff, e.g. 2026-10-08T12:27:59> ce-export/
python3 -I tools/import-ce/transform.py ce-export/ ce-import/
R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… python3 -I tools/import-ce/upload.py ce-import/ qwa-data
```

Then fill the daily totals (see [tools/import-ce/README.md](../tools/import-ce/README.md)). Compare a few days in QWA and Plausible; counts should agree closely.

## 5. Switch over

Set `"ORIGIN_MODE": "mirror"` and deploy. QWA now answers, and Plausible keeps receiving a copy, so you can still fall back by removing the route.

## 6. Move sites to the QWA tracker

For each site, replace the Plausible `<script>` with QWA's snippet (Admin → Sites → Install):

```html
<script defer src="https://analytics.example.com/t.js" data-site="example.com"></script>
```

What carries over:
- `plausible("Signup", { props: … })` calls keep working; the QWA tracker answers to `plausible()` as well as `qwa()`.
- `plausible-event-name=…` classes keep working.
- Event names are unchanged, so reports continue seamlessly.

Each site's Install tab counts the events that arrived through the Plausible script and through the QWA tracker in the last 14 days, so you can see when a site has fully moved.

## 7. Retire Plausible

When you're confident:
1. **Stop mirroring:** remove `ORIGIN_MODE` and deploy. Plausible stops receiving events; it's safe to shut it down.
2. **Remove the compatibility layer:** once no site loads the Plausible script any more (the Install tab counts drop to zero), remove the `plausible.example.com/*` route and `INGEST_HOSTS`.

To roll back at any stage before step 7, remove the route. Plausible will be exactly as it was.
