# Changelog

All notable changes to Quick Web Analytics. Dates are UTC. Database changes ship as D1 migrations in
`apps/worker/migrations`; apply them before deploying (`npx wrangler d1 migrations apply qwa --remote`).

## [Unreleased]

### Added

- **Google Search section** on each site's page, from Search Console:
  - clicks, impressions, click-through rate and average position, with change against the comparison period and a daily chart
  - top queries, pages, countries and devices; click a query to see which pages Google showed for it
  - read live (cached at the edge for 3 hours, a day for settled ranges), following the date range and a page filter
- **Speed section**, from PageSpeed Insights and the Chrome UX Report:
  - nightly tests of each active site's home page on mobile and desktop
  - Lighthouse score with its history, lab metrics and the biggest suggested fixes
  - real Chrome visitors' Core Web Vitals (LCP, INP, CLS) against Google's thresholds, and a six-month weekly trend
  - admins can test on demand
- **Admin → Google:** guided setup in the browser:
  - links to turn on the APIs and create the service account
  - upload its key file and paste the API key, each checked with Google before it's saved
  - grant access per site, with an *Open in Search Console* link for each and a live connected status
  - choose a different Search Console property per site, or turn it off
- Credentials can also be set as the Worker secrets `GOOGLE_SERVICE_ACCOUNT` and `GOOGLE_API_KEY`, which take precedence.
- **AGENTS.md:** a deployment runbook for AI coding agents, now the recommended way to deploy. It covers:
  - the Cloudflare API token's permissions
  - every step with a check
  - the points where the agent must ask the person
  - Access setup through the API
  - cost brakes, alert emails and Google data (including a `gcloud` route)
- `CLAUDE.md` points Claude Code at `AGENTS.md`.

### Upgrade notes

- Apply migrations `0007_google` (adds `sites.gsc_property` and the `speed_runs` table) and `0008_settings` (credentials saved from the dashboard).

## [0.2.0] - 2026-10-09

### Added
- **Anomaly alerts.**
  - **Nightly check:** each site's visitors are compared with the same weekday over the previous six weeks. Spikes, drops and possible outages (a busy site suddenly getting almost no visits) are flagged, and a run of unusual days counts once. The thresholds were calibrated on real sites to give about two alerts a week across 22 sites.
  - **Hourly "so far today" check:** at 10 past each hour, the day so far is compared with the same time on those weekdays. It also checks for a tracker that has gone quiet for three normally busy hours, so most alerts arrive within the hour. It uses stricter thresholds, alerts at most once per site per day, and the nightly check doesn't repeat what it already sent.
  - **On the dashboard:** an alarm icon on the site chart, with the reason in the tooltip, and a Spike/Drop/Outage tag on site cards.
- **Alert emails through Cloudflare Email Sending.** Each email covers:
  - visitors against the usual for that weekday, and a four-week bar chart that renders in Gmail and Outlook
  - the baseline weekdays and the day's other metrics
  - the sources, pages and countries that drove the change, or a what-to-check list for a possible outage
- **Choosing who gets alerts:** an Alerts bell on each site page. Admins also get an Admin → Alerts panel with an "every site" switch, a site checklist, a test email built from real data, and a "check now" button.
- **Cost brakes.**
  - A daily event limit per site (default 3,000,000; set in Admin → Sites → Settings, 0 = none). Past it, recording pauses until midnight UTC, admins get an email, and the dashboard says so. Further events are dropped before they reach storage.
  - `INGEST_PAUSED` emergency stop.
  - Docs for an edge rate-limit rule and billing alerts.
- **Moving to a new hostname without breaking snippets:** `APP_HOST` and `LEGACY_APP_HOSTS`. Old hostnames keep serving `/t.js` and `/e`, and redirect everything else, keeping the path.
- **Site switcher:** the site name on the site page and in the header is a searchable dropdown.
- **Overview:**
  - compact totals with sparklines beside the heading
  - a larger live chart where hovering a minute shows which sites made it up
- **Look and feel:**
  - card look by default, with the flat grid kept as an option
  - brighter in-row table bars
  - loading indicators with elapsed time
- `npm run demo`: a local demo with eight synthetic sites, about 13 months of history and live traffic. Screenshots are generated from it.

### Changed
- **Fewer storage writes per event** (the main cost at scale):
  - the events table no longer uses `AUTOINCREMENT`, rebuilt once per site automatically
  - daily per-tracker counts are recomputed from stored events at each flush instead of updated on every event
  - "day needs rewriting" markers are written once per flush
- **Logging:** the main Worker no longer writes Cloudflare's automatic per-request log line. Every error and warning is still kept.
- **Plausible-compat docs and the installation check** work with any old or new dashboard hostname.

### Fixed
- **Live "visitors per minute" bars were mostly empty:** fractional minute buckets were being dropped.
- **Dashboard queries could fail in bursts with "the Workers runtime canceled this request because it detected that your Worker's code had hung".** A query cut off by its caller (e.g. a closed tab) left DuckDB waiting forever, and every query queued behind it was cancelled. Queries now always run to completion (`waitUntil`). Waiting is done on each request's own timer, and a stuck query lock is reset after 55 seconds.
- **While a new date range loaded,** tiles and tables briefly compared old results with new ones, and the chart drew old buckets with new labels.
- The chart's y-axis no longer mixes number formats ("10k" next to "7,500").

### Upgrade notes
- **Apply migrations 0003–0006.**
- **For alert emails:**
  - Onboard a domain or subdomain in Cloudflare Email Sending.
  - Add `"send_email": [{ "name": "EMAIL" }]` and set `ALERT_FROM`, plus optionally `ALERT_REPLY_TO` and `APP_HOST`, in `apps/worker/wrangler.jsonc`.
  - Then use Admin → Alerts → Send me a test email.
- **Add the hourly cron** `"10 * * * *"` to `triggers.crons` (see `wrangler.example.jsonc`).
- **Logging (optional):** to stop the per-request log line, set `observability.logs.invocation_logs` to `false` (also in the example config).

## [0.1.0] - 2026-10-08

First public release.

- **Tracking and ingestion:**
  - cookieless tracking with a daily-rotating salted visitor hash
  - a 2 KB tracker (`/t.js`, `/e`) with custom events, outbound links, file downloads and engagement
- **Storage and queries:**
  - per-site Durable Objects for sessions and realtime
  - Parquet in R2 with monthly compaction
  - DuckDB-WASM queries in a separate Worker
- **Dashboard:**
  - an all-sites overview and a detailed per-site page with filters, comparisons, realtime map, sources, pages, campaigns, events, devices, geography, heatmap and day by day
- **Access and sharing:**
  - Cloudflare Access sign-in with per-site sharing
- **Migration from Plausible:**
  - Plausible-compatible ingestion, with mirror and passthrough modes
  - history import from Plausible CE
- **Docs:**
  - deployment, architecture and migration guides

[0.2.0]: https://github.com/Zesty0wl/quick-web-analytics/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Zesty0wl/quick-web-analytics/releases/tag/v0.1.0
