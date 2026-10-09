# Deploying Quick Web Analytics

This guide takes you from a fresh clone to a working instance on your own Cloudflare account, in about 20 minutes.

> **Using an AI agent?** Point it at [AGENTS.md](../AGENTS.md) instead. It's the same deployment as a runbook an agent can follow end to end, using the Cloudflare API for the parts this guide does in the dashboard.

**You'll end up with:**
- **One hostname** (for example `analytics.example.com`) that serves:
  - the dashboard, behind Cloudflare Access
  - the tracker script `/t.js` and the event endpoint `/e`, both public
- **Two Workers:**
  - `qwa`: ingestion, the dashboard and its API
  - `qwa-query`: DuckDB over your Parquet files
- **Storage:**
  - a D1 database for sites, users and daily totals
  - an R2 bucket for the event data
  - one Durable Object per site for live sessions

## Before you start

| You need | Notes |
|---|---|
| A Cloudflare account on the **Workers Paid** plan ($5/month) | The query Worker needs more CPU time than the free plan allows. Everything else fits in the Paid plan's included usage at small-to-medium volumes. |
| A domain on Cloudflare | The dashboard hostname must be on a zone in the same account. |
| Node.js 22 or newer, and git | |
| Cloudflare Zero Trust (free plan) | For dashboard sign-in. The free plan covers 50 users. |

Try it locally first if you like: `npm install && npm run demo` runs everything on your machine with synthetic data. No Cloudflare account is needed for that.

## 1. Get the code

```sh
git clone https://github.com/Zesty0wl/quick-web-analytics.git
cd quick-web-analytics
npm install
npx wrangler login
```

## 2. Create the storage

```sh
npx wrangler d1 create qwa            # note the database_id it prints
npx wrangler r2 bucket create qwa-data
```

## 3. Configure the Worker

```sh
cp apps/worker/wrangler.example.jsonc apps/worker/wrangler.jsonc
```

Edit `apps/worker/wrangler.jsonc`. The lines to change are marked `CHANGE`:

| Setting | Set it to |
|---|---|
| `d1_databases[0].database_id` | The id from step 2 |
| `routes[0].pattern` | Your dashboard hostname, e.g. `analytics.example.com`. Wrangler creates the DNS record and certificate for a custom domain. |
| `vars.COMPAT_ENDPOINT` | `https://<your hostname>/api/event` (only used for Plausible-compatible snippets) |

`wrangler.jsonc` is gitignored, so your IDs and hostnames stay out of the repository and `git pull` never conflicts with them.

The query Worker's config (`apps/query/wrangler.jsonc`) has nothing to change, unless you renamed the R2 bucket.

## 4. Create the database tables and deploy

```sh
cd apps/worker && npx wrangler d1 migrations apply qwa --remote && cd ../..
npm run deploy
```

`npm run deploy` builds the dashboard and tracker, deploys `qwa-query`, then `qwa`. The order matters the first time, because `qwa` binds to `qwa-query`.

If you open the hostname now, you'll see **"Access is not configured"**. That's expected: sign-in comes next.

## 5. Set up sign-in with Cloudflare Access

QWA doesn't store passwords. Cloudflare Access handles sign-in (one-time email codes, or Google/GitHub and so on), and QWA decides what each signed-in email can see.

In the Cloudflare dashboard, open **Zero Trust**. The first time, pick a team name and the Free plan. Your **team domain** is `<team-name>.cloudflareaccess.com`.

### 5a. The dashboard application

1. **Access → Applications → Add an application → Self-hosted.**
2. **Name:** `Quick Web Analytics`. **Domain:** your hostname, with no path.
3. **Policy:** add a policy named `Signed-in users` with **Action: Allow** and **Include: Emails ending in** your domain, or **Include: Everyone**.
   - "Everyone" is fine: QWA only shows data to emails it knows (step 6) and returns "No access yet" to anyone else.
   - Use a tighter rule if you don't want strangers to reach the sign-in page at all.
4. **Login methods:** One-time PIN is enabled by default. Add others under **Settings → Authentication** if you like.
5. Save, then open the application again and copy its **Application Audience (AUD) Tag** from the Overview tab.

### 5b. Let the tracker through

The tracker and event endpoint must stay public. Add a second self-hosted application with:
- **Name:** `Quick Web Analytics (public paths)`
- **Domain:** your hostname, with these paths (add a domain entry per path):
  - `/t.js`
  - `/e`
  - `/api/event` and `/js/*`, only if you'll use Plausible-compatible snippets (see [MIGRATING.md](MIGRATING.md))
- **Policy:** **Action: Bypass**, **Include: Everyone**

More specific paths win, so these paths skip sign-in while the rest of the hostname stays protected.

### 5c. Tell the Worker about Access

```sh
cd apps/worker
npx wrangler secret put ACCESS_TEAM_DOMAIN   # e.g. myteam.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD           # the AUD tag from 5a
npx wrangler secret put BOOTSTRAP_ADMINS     # your email; comma-separate several
cd ../..
```

## 6. Sign in and add a site

1. Open your hostname and sign in with a `BOOTSTRAP_ADMINS` email. Your first sign-in creates your admin account.
2. **Admin → Sites → Add a site:** enter the domain (without `www.`) and the timezone that days should follow in reports.
3. The **Install** tab shows the snippet, and a **Copy prompt for your agent** button. If the site's code is worked on with an AI coding agent, paste the prompt into it: it adds (or updates) the snippet in the right place for the site's framework, deals with a Content-Security-Policy or an old Plausible tag, and checks events arrive. Otherwise, put the snippet in every page's `<head>`:

   ```html
   <script defer src="https://analytics.example.com/t.js" data-site="example.com"></script>
   ```

4. Load a page on your site. The Install tab switches from "Waiting for the first event" to live, and the visit appears on the dashboard within seconds.

**Sharing:** under **Admin → Users & access**, add someone's email and tick the sites they may see. They sign in through Access with that email and see only those sites. Make someone an admin to give them every site and the admin pages.

## Tracker options

| Attribute or call | Effect |
|---|---|
| `data-site="example.com"` | Which site the events belong to (required) |
| `data-hash` | Count `#/route` changes as pageviews (hash-routed single-page apps) |
| `data-manual` | Don't send pageviews automatically; call `qwa("pageview")` yourself |
| `data-no-outbound`, `data-no-downloads` | Turn off automatic outbound-link and file-download events |
| `data-api="https://…/e"` | Send events somewhere else, e.g. through a first-party proxy |
| `data-local` | Also track on `localhost` (off by default) |
| `qwa("Signup", { props: { plan: "pro" } })` | Custom event with properties |
| `class="qwa-event-name=Signup qwa-event-plan=pro"` | Custom event on click, no JavaScript needed |
| `localStorage.qwa_ignore = "true"` | Stop tracking yourself in that browser |

The tracker is under 2 KB gzipped, sets no cookies and follows single-page-app navigation automatically.

**Allowed hostnames and IP blocklist** (Admin → Sites → Settings): restrict which hostnames may send events for a site (by default any), and drop events from your office IPs or CIDR ranges.

## Anomaly alerts

Every night QWA compares each site's visitors with the same weekday over the previous six weeks, and every hour (at 10 past) it compares the day so far with the same time on those weekdays, including a check for a tracker that has gone quiet for three normally busy hours, so most alerts arrive within the hour. The hourly check uses stricter thresholds (a partial day is noisier) and alerts at most once per site per day; the nightly check doesn't repeat an alert the hourly one already sent. Unusual days (a spike, a drop, or a possible outage when a busy site suddenly gets almost no visits) get an alarm icon on the site's chart and card. A run of unusual days counts once. The thresholds were calibrated on 22 real sites: busy, spiky sites get one or two alerts a month and steady sites rarely any.

Anyone can opt in to email for a site with the **Alerts** bell on its page. Admins can also pick sites from a checklist, or choose **Every site** (including sites added later), under **Admin → Alerts**. Each email shows the day's visitors against the usual for that weekday, a four-week chart, the other metrics for the day, and which sources, pages and countries drove the change (or what to check, for a possible outage).

To send email:

1. In the Cloudflare dashboard, **Email Service → Email Sending → Onboard Domain**, and pick the domain (or a subdomain) to send from. It adds bounce records under `cf-bounce` and a DMARC record. If the domain already has email elsewhere (e.g. Microsoft 365 or Google), review the DMARC record before you confirm, or onboard a subdomain such as `alerts.example.com` instead.
2. In `apps/worker/wrangler.jsonc`, uncomment `"send_email": [{ "name": "EMAIL" }]` and set `"ALERT_FROM": "Quick Web Analytics <alerts@your-domain>"`.
3. `npm run deploy`, then **Admin → Alerts → Send me a test email**.

## Google data (optional)

The site page can show two Google sections:

- **Google Search:** clicks, impressions, click-through rate and average position from Search Console, with the queries, pages, countries and devices behind them. It's read live from Google (cached for a few hours) and follows the date range and a page filter. Click a query to see the pages Google showed for it.
- **Speed:** a nightly PageSpeed Insights test of each site's home page on mobile and desktop (Lighthouse score, lab metrics and the biggest suggested fixes), the Core Web Vitals of real Chrome visitors that come with it, and a six-month trend from the Chrome UX Report.

Both are free. To set them up, open **Admin → Google** in the dashboard and follow the four steps. Everything happens in your browser, with links to the right Google pages:

1. **Turn on the APIs.** One link turns on the Search Console, PageSpeed Insights and Chrome UX Report APIs in a Google Cloud project (create one if you need to).
2. **Connect Search Console.** Create a service account (a read-only robot Google account), download its JSON key, and upload it. It's checked with Google before it's saved.
3. **Give it access to each site.** Search Console only shares a site with accounts its owner adds. Each site has an *Open in Search Console* link: choose **Add user**, paste the service account's address (there's a copy button), and pick **Restricted**. Sites are matched to their property automatically; pick another property or turn one off in the same table.
4. **Connect PageSpeed.** Create an API key restricted to the PageSpeed Insights and Chrome UX Report APIs, and paste it in.

Credentials saved this way are stored in the D1 database and only ever used by the Worker; the dashboard never shows them again. If you'd rather keep them as Worker secrets, set `GOOGLE_SERVICE_ACCOUNT` (the key file's contents: `npx wrangler secret put GOOGLE_SERVICE_ACCOUNT < key.json`) and `GOOGLE_API_KEY`. Secrets take precedence over saved credentials. An agent with the `gcloud` CLI can create everything except the per-site access; see [AGENTS.md](../AGENTS.md#phase-7-google-data-optional).

Search Console data trails by a day or two and uses Pacific Time days, so its totals won't match QWA's visitor counts exactly. Chrome only reports real-visitor speed for sites with enough Chrome traffic; smaller sites show the lab test alone. If Google says service account key creation is blocked by an organisation policy, your Google Workspace has turned off downloadable keys: use a project under a personal Google account, or ask your Workspace admin.

## Moving to a new hostname

1. Add the new hostname as a route (keep the old one) and set `APP_HOST` to the new one and `LEGACY_APP_HOSTS` to the old one.
2. In Cloudflare Access, move the dashboard application to the new hostname, add the new hostname's `/t.js` and `/e` to the bypass application, and add the whole old hostname to the bypass application (it only redirects now).
3. Deploy. The old hostname keeps serving `/t.js` and `/e` (so existing snippets work unchanged) and redirects everything else, keeping the path. Update snippets to the new hostname when convenient.

## Updating

```sh
git pull
npm install
cd apps/worker && npx wrangler d1 migrations apply qwa --remote && cd ../..
npm run deploy
```

Migrations are additive and safe to re-run; already-applied ones are skipped.

## Scheduled jobs

These run automatically, from the cron triggers in `wrangler.jsonc`:

| When (UTC) | Job |
|---|---|
| 00:05 | Rotate the daily salt used for cookieless visitor hashing. Salts older than two days are deleted. |
| 03:30 | Merge last month's day files into one month file per table, compute daily totals for the overview, then run the nightly anomaly check. |
| Every hour at :10 | The "so far today" anomaly check (emails straight away). |
| 04:10 | PageSpeed tests of each active site's home page, if `GOOGLE_API_KEY` is set (on the hourly trigger). |

To fill daily totals straight away (for example after importing history), send `POST /api/admin/rollup` with a JSON body from a signed-in admin session, e.g. from the browser console on the dashboard: `fetch("/api/admin/rollup", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })`.

## Costs

At small-to-medium volumes (up to a few million events a month), everything fits within the Workers Paid plan's included usage. Usage is billed through the normal Workers, Durable Objects, R2 and D1 meters.

The heaviest parts are:
- **Durable Object requests:** one per event.
- **Query Worker CPU time:** when people use the dashboard.

R2 storage is small: Parquet takes roughly 20 bytes per event, so a site with 4.5 million events of history uses about 80 MB.

## Keeping costs bounded

Cloudflare has no hard spending cap for Workers, and every tracking request that reaches the Worker is billed (roughly $5 per million events beyond the Workers Paid allowances, most of it Durable Object row writes). These brakes keep a flood or a runaway site from becoming an expensive surprise:

- **Daily limit per site** (built in). A site that sends more than 3,000,000 events in a UTC day stops recording until midnight. Admins get an email, the site's card and page say recording is paused, and further events are dropped before they reach storage. Change the limit per site in Admin → Sites → Settings (0 = no limit), or the default with `DEFAULT_DAILY_CAP`.
- **Emergency stop.** Set `"INGEST_PAUSED": "1"` in `vars` and deploy: tracking requests are answered but nothing is stored.
- **Rate limit at the edge** (recommended). Requests blocked by a Cloudflare rate-limiting rule never reach the Worker, so they cost nothing. The Free plan includes one rule per zone; for example *Security → WAF → Rate limiting rules*: when `http.host eq "analytics.example.com" and http.request.method eq "POST" and http.request.uri.path in {"/e" "/api/event"}`, allow 100 requests per 10 seconds per IP, then block for 10 seconds. A real visitor sends a handful of events per page.
- **Billing alerts.** In *Notifications*, add *Billing Budget Alerts* (e.g. at $25, $50 and $100 of usage-based spend this month) so you hear about unusual usage early.

The Worker also skips Cloudflare's automatic per-request log line (`invocation_logs: false`) while keeping every error and warning, since Workers Logs are billed per line at high volume.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Access is not configured" | `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` isn't set (step 5c). |
| "invalid Access token" | The AUD tag doesn't match the dashboard application, or the team domain is wrong. |
| "No access yet" after signing in | That email isn't a QWA user. Add it under Admin → Users, or to `BOOTSTRAP_ADMINS` for an admin. |
| The tracker loads but no events arrive | In the browser's network tab, `POST /e` should return `202`. A redirect to `cloudflareaccess.com` means the bypass application doesn't cover `/e`. A `202` with no data means the event was dropped: check the `data-site` value matches the site's domain, the page's hostname is in the site's allowed hostnames, and your IP isn't in its blocklist. |
| Events from `localhost` are ignored | Intended. Add `data-local` to the script tag while testing. |
| Dashboard panels say "Still working…" for long ranges | Big date ranges on busy sites can take several seconds. R2 reads are cached, so repeat loads are quicker. Requests stop after 60 seconds. |
| `wrangler secret put` hangs | Run it in an interactive terminal, or pipe the value in: `printf %s "$VALUE" \| npx wrangler secret put NAME`. |

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit together, and [MIGRATING.md](MIGRATING.md) for moving from Plausible.
