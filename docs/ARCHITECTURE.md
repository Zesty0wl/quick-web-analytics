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
  realtime, "today"                      ▲
        │ every 5 minutes                │
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

The Durable Object writes every day that changed to R2 as Parquet, every 5 minutes, then keeps about three days locally for "today" and realtime.

```
sites/<site>/<table>/day/<YYYY-MM-DD>.parquet     UTC day, rewritten while it's live
sites/<site>/<table>/month/<YYYY-MM>.parquet      closed months, merged nightly
sites/<site>/<table>/import/<YYYY-MM>.parquet     imported history (e.g. from Plausible CE)
tables: sessions · pageviews · engagement · custom
```

- **One file per event type.** Most reports read only one of them.
- **Web Vitals live on the engagement table.** These are INP and its attribution, LCP and its element, CLS, TTFB and FCP, plus `pv`, a page-view id.
  - A page view can report more than once, so queries take each page view's latest report, then 75th percentiles.
  - Files written before these columns existed are read with `union_by_name`, and compaction fills the missing columns with defaults.
- **Sorted by time, 256k-row groups.** DuckDB skips row groups outside the date range.
- **Month files after compaction.** A 12-month query reads about 12 files per table, not 365.
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

### Daily totals

The all-sites overview never touches DuckDB.
- **Past days:** a nightly job writes one row per site per local day to D1's `daily_stats` table: visitors, visits, pageviews, events, bounces and total duration.
- **Today and the live numbers** come from each site's Durable Object.

So the overview loads instantly for any range, however many sites there are.

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
| 03:30 | Merge closed months' day files into month files, then fill `daily_stats` up to yesterday |

## Why not…

- **ClickHouse, Postgres or a VPS?** The goal is nothing to run or patch. Cloudflare's per-request pricing means a small instance costs nothing beyond the Workers Paid plan.
- **Durable Object SQLite only?** It's fast for live data, but long-range queries over millions of rows were too slow, and each object has a 10 GB cap. Parquet plus DuckDB keeps history cheap and fast to query.
- **DuckDB in a Container?** It was faster once warm, but it needs about 40 seconds to start from cold, or about $28/month to keep running. DuckDB-WASM inside a Worker is fast enough and free.
- **Workers Analytics Engine?** Its sampling and retention limits don't fit exact, long-term site analytics.
