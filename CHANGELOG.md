# Changelog

All notable changes to Quick Web Analytics. Dates are UTC. Database changes ship as D1 migrations in
`apps/worker/migrations`; apply them before deploying (`npx wrangler d1 migrations apply qwa --remote`).

## [Unreleased]

### Added

- **The dashboard updates itself.** You never need to reload to see new data.
  - **Pushed live:** a site's page keeps a WebSocket open to that site's Durable Object, which pushes the realtime panel at most every 2 seconds while events arrive. Hibernation means an idle connection costs nothing, and the page asks for a fresh snapshot after 25 quiet seconds so "visitors now" falls when traffic stops.
  - **Reports follow:** each push carries a data version. Reports that include today refresh when it moves on, the headline numbers and chart within about 10 seconds and the sections within 30, and only while they're on screen. Past ranges never refetch.
  - **Hidden tabs:** the connection closes while the tab is hidden and catches up when you return. If it can't connect, the page polls every 10 seconds instead.
  - **Midnight:** "Today", "Last 7 days" and the other presets move on at midnight in the site's timezone in a tab left open.
- **Google Search section** on each site's page, from Search Console:
  - clicks, impressions, click-through rate and average position, with change against the comparison period and a daily chart
  - top queries, pages, countries and devices; click a query to see which pages Google showed for it
  - read live (cached at the edge for 3 hours, a day for settled ranges), following the date range and a page filter
- **Speed section**, from PageSpeed Insights and the Chrome UX Report:
  - nightly tests of each active site's home page on mobile and desktop
  - Lighthouse score with its history, lab metrics and the biggest suggested fixes
  - real Chrome visitors' Core Web Vitals (LCP, INP, CLS) against Google's thresholds, and a six-month weekly trend
  - admins can test on demand
- **Core Web Vitals measured by QWA itself** on every page view, on every site, with no Google account needed:
  - **What's measured:** INP, LCP, CLS, TTFB and FCP. For INP, the element behind the slowest interaction (e.g. `nav > button.menu-toggle`), the interaction type, and its input delay, processing and presentation times. For LCP, the element (and image file name). Only element descriptions are sent, never text.
  - **Queries:** new metrics (p75 `inp`, `lcp`, `cls`, `ttfb`, `fcp`, the three INP parts, `measured_views`) and dimensions (`inp_target`, `inp_type`, `lcp_element`).
  - **Dashboard:** the Speed section leads with real visits: p75s against Google's thresholds, the slowest interactions, and pages busiest first. It switches between mobile and desktop and follows the date range and filters.
  - **Agents:** new MCP tools `web_vitals` and `slow_interactions`; `get_summary` includes Web Vitals; the `investigate_inp` prompt starts from this data.
  - **Tracker size:** grows from about 2 KB to 3 KB gzipped.
- **Agent access (MCP)** at `/mcp`, so AI agents can read your analytics:
  - **Tokens:** personal access tokens, created under the new **Account → Agent access** page. They're read-only, can be limited to some sites, can expire, and show when they were last used. The page has setup snippets for Claude Code, Cursor and Codex.
  - **Tools:** `list_sites`, `get_summary`, `breakdown`, `timeseries`, `realtime`, `anomalies`, `search_console`, `speed`, `speed_test` (PageSpeed on any page) and `crux` (Chrome's real-user Core Web Vitals for any URL).
  - **Prompts:** `investigate_inp` and `weekly_review`.
  - **Numbers:** tools use the dashboard's own routes as the token's owner, so they always match.
  - **OAuth sign-in** for clients that "Connect", such as Claude Desktop and claude.ai custom connectors. This is the MCP authorization spec: protected-resource and authorization-server metadata, dynamic client registration, PKCE (S256), rotating refresh tokens with reuse detection, and a consent page behind your normal sign-in where you can limit the connection to some sites. Connected apps are listed under Account → Agent access, and can be disconnected there.
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
- **Admin → Sites → Install: "Copy prompt for your agent".** A prompt for the site's coding agent that adds or updates the snippet in the right place for the framework (Next.js, Astro, WordPress, static generators…). It also handles a Content-Security-Policy, replaces an old Plausible tag when the site is migrating, offers custom events, and verifies events arrive.

### Changed

- **The hourly jobs run on a Durable Object alarm instead of a cron trigger.** These are the "so far today" anomaly check and the overnight PageSpeed tests.
  - The hourly cron added in 0.2.0 never fired on our production account, while the nightly crons on the same Worker ran normally.
  - The new `Scheduler` Durable Object books its next run each time it runs, and the Worker re-arms it if it ever stops.
  - Admin → Alerts shows when the hourly check last ran.
- **Hourly alert emails chart the hours that matter.** Instead of four weeks of daily totals, where a partial "today" looked small, they show today's visits hour by hour beside a usual day for that weekday, with the hours that set off the alert in red. Their "How this was spotted" note now describes the hourly check, not the nightly one.
- **The hourly check also catches bursts:** 4× the usual for the last three hours, at least 200 extra visits, and the same strength threshold.
  - Until now it only compared the day so far, which dilutes a sharp rise. On issinfo.net, a pass of the ISS sent Melbourne's searchers to the site and produced 10.7× the usual visits in three hours. The day as a whole was only 2.9×.
  - Tested against 30 days of all 22 sites, it adds about one alert a month.
- **"Today" is live everywhere.** Site pages, breakdowns and agent tools include events from the last few minutes, not only what's been written to storage, which happens every 5 minutes. For ranges reaching today, the site's Durable Object hands the query Worker fresh copies of its not-yet-written day files, rebuilt at most every 5 seconds, which replace the stored copies for that query.
- **Line charts scale to what's drawn.** With a partial "today", the comparison line is only drawn as far as today goes, and its later values (e.g. a busy evening yesterday) no longer stretch the axis.
- **Realtime layout:** the visitors-per-minute bars fill the space beside the live lists, and live list rows inset their text like table rows.
- **Tracker badges reflect the last 48 hours** instead of 14 days. "QWA + Plausible" becomes "QWA tracker" two days after the last event from the old Plausible script. While a few still arrive (e.g. from cached pages), the site card and Admin → Sites say when the last one came.
- **Tracker badge on each site's page** (admins): next to the timezone, it shows whether events are arriving through the QWA tracker, the Plausible script, or both, with the same 48-hour rule and "last seen" tooltip as the site cards.
- **Faster, cheaper report loading:**
  - **Batched queries:** a site's page sends its reports' queries together, one request per moment rather than one per report (about 26 requests became 7). The server checks sign-in once, fetches the Durable Object's live data once, and streams each answer back as soon as it's ready.
  - **Cached answers:** the query Worker keeps answers in memory, keyed by the query and every file it reads (R2 ETags and a tag for the live data). An answer is reused until the data behind it changes, and never served stale. The browser also keeps answers for past ranges for good.
  - **Fewer D1 round trips:** signed-in users and their site grants are cached for 30 seconds per Worker isolate, and the "last seen" write no longer holds up the response. Changes to users apply at once in the isolate that made them and within 30 seconds elsewhere.
  - **Shared map data:** the Geography country table reuses the map's query.
- **Smaller, faster dashboard:**
  - **Code splitting:** the first page load fetches about 96 KB gzipped instead of 169 KB. The site page, Admin, Account and the Google sections load their code when first opened.
  - **Precomputed map:** the world map's shapes are projected at build time (`npm run map -w apps/web`) instead of in the browser on every load.
  - **Asset caching:** hashed assets are served `immutable`, so browsers never re-check them.
- **The overview and Admin poll less.** The overview's D1 reads run in parallel, and closed days' totals are reused for 5 minutes, so each 30-second poll only asks the sites for today. Admin → Sites checks every site every 30 seconds instead of 15, and catches up when you switch back to the tab.
- The top bar and section bar line up with the page's content column on wide screens.
- The accent colour picker moved from the top bar to the Admin page.
- PageSpeed tests are spread over 02:10–07:10 UTC, six sites per hour, so no single run is long. A failed test is retried once, and one strategy failing no longer loses the other.

### Upgrade notes

- **Add the Scheduler to `apps/worker/wrangler.jsonc`** (see `wrangler.example.jsonc`). Add `{ "name": "SCHEDULER", "class_name": "Scheduler" }` to `durable_objects.bindings`, add `{ "tag": "v2", "new_sqlite_classes": ["Scheduler"] }` to `migrations`, and remove `"10 * * * *"` from `triggers.crons`.
- Apply migrations `0007_google` (adds `sites.gsc_property` and the `speed_runs` table), `0008_settings` (credentials saved from the dashboard), `0009_api_tokens` and `0010_oauth`.
- **Live updates need nothing new in Cloudflare.** The WebSocket (`/api/sites/<id>/live`) is a dashboard path, behind the same Access application. Deploy both Workers together with `npm run deploy`, which deploys the query Worker first.
- **Deploy both Workers** (`npm run deploy`): the query Worker reads the new Web Vitals columns. Older Parquet files keep working as they are.
- **Add `<hostname>/mcp`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`, `/oauth/register` and `/oauth/token` to the public-paths (bypass) Access application,** and the `MCP_LIMITER` rate-limit binding from `wrangler.example.jsonc`.

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
