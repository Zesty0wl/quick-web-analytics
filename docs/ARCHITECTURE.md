# Architecture

QWA is two Workers and three kinds of storage. This page explains what each piece does and why it's built that way.

```
  Tracked sites                                         Dashboard users
       │ POST /e (public)                                     │ Cloudflare Access
       ▼                                                      ▼
 ┌───────────────────────────── Worker "qwa" (Hono) ─────────────────────────────┐
 │ /t.js, /e            tracker + event endpoint                                  │
 │ /js/*, /api/event    Plausible-compatible scripts and endpoint (optional)      │
 │ /api/*               dashboard API (per-site authorisation)                    │
 │ /*                   dashboard (static assets)                                 │
 │ cron                 salt rotation · monthly compaction · daily totals         │
 └──────┬──────────────────────────────┬─────────────────────────────┬───────────┘
        ▼                              ▼                             ▼
  SiteDO (one per site)          Worker "qwa-query"              D1 "qwa"
  SQLite: live sessions,         DuckDB-WASM, reads only the     sites, users, grants,
  last 3 days of events,         Parquet it needs from R2        salts, daily totals
                                                                 and summaries
  realtime, "today"                      ▲
        │ every 15 minutes               │
        └──────────▶ R2 "qwa-data": Parquet per site / table / day → month
```

## Ingestion

Each event goes through these steps:

1. **Parse.** The tracker's payload (`/e`) and Plausible's (`/api/event`) are mapped to the same internal event.
2. **Validate.** The site must exist, the page's hostname must be allowed for it, and the IP must not be in its blocklist.
3. **Drop bots** by user agent (`isbot`).
4. **Enrich** the event:
   - browser, OS and device from the user agent (`ua-parser-js` 1.x, MIT)
   - country, region and city from Cloudflare's `request.cf`, with no GeoIP database to maintain
   - source and channel from the referrer and UTM tags
5. **Identify the visitor without cookies:** `SHA-256(daily salt | site | IP | user agent)`, truncated to 53 bits.
   - Salts rotate at midnight UTC. The previous day's salt is still checked briefly so a session that crosses midnight carries on, and salts are deleted after two days, so a visitor can't be linked across days.
   - "Unique visitors" over a range is the sum of each day's distinct hashes, as Plausible counts it.
   - IPs and user agents are never stored.
6. **Sessionise** in the site's Durable Object.
   - A session ends after 30 minutes without activity. It records entry and exit page, pageviews, bounce and duration.
   - Engagement pings (scroll depth, time on page, and Web Vitals from the QWA tracker) extend a session but never start one.

One Durable Object per site keeps ingestion simple and strongly consistent. A single object handles about 1,000 requests a second, far beyond what a typical site sends.

## Storage

The Durable Object writes every day that changed to R2 as Parquet, every 15 minutes, then keeps about three days locally for "today" and realtime. Nothing waits for that write: reports read unwritten events straight from the Durable Object (below).

```
sites/<site>/<table>/day/<YYYY-MM-DD>.parquet     UTC day, rewritten while it's live
sites/<site>/<table>/month/<YYYY-MM>.parquet      settled days, merged nightly (the current month so far, and closed months)
sites/<site>/<table>/import/<YYYY-MM>.parquet     imported history (e.g. from Plausible CE)
tables: sessions · pageviews · engagement · custom
```

- **One file per event type.** Most reports read only one of them.
- **Web Vitals live on the engagement table.** These are INP and its attribution, LCP and its element, CLS, TTFB and FCP, plus `pv`, a page-view id.
  - A page view can report more than once, so queries take each page view's latest report, then 75th percentiles.
  - Files written before these columns existed are read with `union_by_name`, and compaction fills the missing columns with defaults.
- **Sorted by time, 256k-row groups.** DuckDB skips row groups outside the date range.
- **Month files after compaction.** A 12-month query reads about 12 files per table, not 365.
  - Each night, day files more than two days old are folded into their month's file, for the current month as well as closed ones. Younger days can still change (the Durable Object keeps three days of rows), so they stay as day files.
  - A month file's metadata records the last day it holds (`through`), so the query side knows which day files it has replaced.
  - Compaction streams one row group at a time and is idempotent.
  - While a merge is in progress, the query side ignores day files already folded into a month file, so nothing is counted twice.

Queries whose range reaches today ask the site's Durable Object for its not-yet-flushed day files (`liveFiles()`, rebuilt at most every 5 seconds). The query Worker reads those in place of R2's copies, so "today" is live in every report, not up to 5 minutes behind.

Parquet is small: roughly 20 bytes per event, so a site with 4.5 million events of history takes about 80 MB. R2 storage costs and limits are effectively irrelevant.

## Queries

The dashboard sends a small JSON query spec (`packages/shared/src/query.ts`), for example:

```json
{ "from": "2026-09-01", "to": "2026-09-30", "metrics": ["visitors", "bounce_rate"], "groupBy": "source", "filters": [["country", "is", "GB"]] }
```

The query Worker turns it into DuckDB SQL (`apps/query/src/sql.ts`) and runs it in DuckDB-WASM.

**Reading from R2:**
- R2 reads go through the binding. DuckDB's HTTP reads are intercepted and served from R2.
- **Small files are loaded whole, in parallel, before a batch runs.** DuckDB asks for a Parquet file as many small byte ranges, one at a time, which made a cold start slow (about 200 reads in sequence for a 30-day page). Files up to 2 MB that DuckDB hasn't read yet are fetched whole, six at a time, up to 8 MB per call, and their ranges served from memory. Larger files are still read by range.
- A Cache API layer holds the byte ranges DuckDB asks for.
- File URLs carry the object's ETag, so a rewritten file is never served stale.

**Fitting in a Worker:**
- **Timezones.** DuckDB-WASM has no ICU, so local days are computed from a list of UTC-offset segments for the range, generated in JavaScript.
- **Memory.** DuckDB is capped at 96 MB inside the 128 MB isolate, and queries run one at a time per isolate.

**Speed:** measured live on Cloudflare for a real site with 4.5 million events of history, loading every report on the page:

| Range | Whole dashboard |
|---|---|
| 30 days | up to 1.7 s |
| A busy month (about 3M events) | 0.5–2.0 s |
| 12 months | 2.3–4.1 s |

### Answering from parts

Every traffic metric is built from sums and counts, so a report over a range can be worked out for pieces of the range and added up (`packages/shared/src/partial.ts`). The main Worker (`apps/worker/src/answer.ts`) answers each report the cheapest way it allows:

| How | Which reports | Where the data comes from |
|---|---|---|
| `summary` | No filters, grouped by nothing, day/week/month, weekday-hour, or a breakdown the site page shows | Closed days from D1's daily summaries; only the days after them (today, usually) from the events |
| `split` | Anything else that adds up: filtered reports, hourly charts, other groupings | The closed days as one query, whose answer the query Worker keeps until the files change, plus the days still receiving events |
| `direct` | Web Vitals (percentiles don't add up), and ranges with no closed day in them | One query over the events |

**Daily summaries** (`daily_dims` in D1, written by `summary.ts`):
- One row per site, local day, dimension and value: the day's totals, its hours, and its top 500 rows by visitors for each breakdown the site page shows.
- The columns are sums (visits, bounces, total duration, engaged time…), and ratios such as bounce rate are worked out after adding up.
- The hourly job summarises each day once it has been over for two hours, and a site's history a month at a time, oldest first. A report is only answered from summaries for the days they cover; the rest comes from the events.
- If a site's timezone changes, its summaries are rebuilt.

**Unique visitors** are added across days. Visitor hashes change every UTC day, so that equals a count over the range, except that a visitor active either side of a local midnight that isn't a UTC midnight is counted in both local days. The overview's daily totals have always counted this way.

Each answer's `meta` carries `source` and, when the query Worker ran, `perf` (DuckDB time, R2 reads, cache hits, files loaded, whether DuckDB had to start). `?direct=1` on the batch or query endpoint answers everything as one query each, for comparison.

### Batching and caching

- **Batches:** the dashboard sends the queries a page asks for at the same moment as one `POST /api/sites/<id>/batch`. The main Worker checks sign-in and fetches the live day files once, then passes the batch to the query Worker, which streams NDJSON answers back as each finishes, cached ones first.
- **Answer cache:** each query Worker isolate keeps recent answers in memory (an LRU of 400 answers or 8 MB). The key covers the query, the timezone, every file it reads (R2 URLs carry the ETag) and the live data's tag, so new events or a rewritten file make a new key, and an answer is never stale.
  - **Why memory, not the Cache API:** the Cache API isn't available to Workers behind Cloudflare Access.
- **In the browser:** answers for ranges that end before yesterday are kept for good, and ranges ending yesterday for an hour. Ranges reaching today are refreshed by live updates (below).

### Daily totals

The all-sites overview never touches DuckDB.
- **Past days:** a nightly job writes one row per site per local day to D1's `daily_stats` table: visitors, visits, pageviews, events, bounces and total duration.
- **Today and the live numbers** come from each site's Durable Object.

So the overview loads instantly for any range, however many sites there are.

## Live updates

A site's page opens a WebSocket to `/api/sites/<id>/live`. The Worker checks sign-in, the site grant and the Origin, then hands the socket to the site's Durable Object.

- **Hibernation:** the object accepts it with the WebSocket Hibernation API, so an open but quiet connection costs nothing.
- **Pushes:** when events arrive, the object pushes a realtime snapshot, at most every 2 seconds. The snapshot carries a data version (the newest event's id).
- **Refreshing reports:** reports that include today refetch when the version has moved past the one they were fetched at: the headline numbers and chart after at least a minute, sections after 5 minutes. Only on-screen reports refetch, as a batch.
- **Quiet periods:** after 25 seconds without a push, the page asks for a fresh snapshot, so "visitors now" falls when traffic stops.
- **Hidden tabs:** the socket closes and reopens on return.
- **Fallback:** if it can't connect, the page polls `/api/sites/<id>/realtime` (which carries the same version) every 10 seconds.

## Authentication and access

**Sign-in:** Cloudflare Access sits in front of the dashboard. The Worker verifies Access's JWT (`Cf-Access-Jwt-Assertion`) against your team's public keys and audience tag, and maps the email to a QWA user in D1. QWA never sees or stores passwords.

**What each user sees:**
- **Admins** see everything and manage sites and users.
- **Viewers** see only the sites they've been granted (`site_access`). Every `/api/sites/:id/*` call checks this.
- **Bootstrapping:** emails in `BOOTSTRAP_ADMINS` become admins on their first sign-in. Any other unknown email gets "No access yet".

**Public paths:** `/t.js`, `/e` and the Plausible-compatible paths stay public through an Access bypass application.

**Write requests:** API calls that change something must be same-origin JSON, which blocks cross-site form posts.

## Scheduled jobs

| UTC | Job |
|---|---|
| 00:05 | Rotate the visitor-hash salt; delete salts older than two days |
| 03:30 | Merge settled day files into month files, then fill `daily_stats` up to yesterday |
| hh:10 | Hourly jobs (a Durable Object alarm): the "so far today" anomaly check, daily summaries for days that have closed, and overnight the PageSpeed tests |

## Why not…

- **ClickHouse, Postgres or a VPS?** The goal is nothing to run or patch. Cloudflare's per-request pricing means a small instance costs nothing beyond the Workers Paid plan.
- **Durable Object SQLite only?** It's fast for live data, but long-range queries over millions of rows were too slow, and each object has a 10 GB cap. Parquet plus DuckDB keeps history cheap and fast to query.
- **DuckDB in a Container?** It was faster once warm, but it needs about 40 seconds to start from cold, or about $28/month to keep running. DuckDB-WASM inside a Worker is fast enough and free.
- **Workers Analytics Engine?** Its sampling and retention limits don't fit exact, long-term site analytics.
