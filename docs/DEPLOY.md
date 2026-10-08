# Deploying Quick Web Analytics

This guide takes you from a fresh clone to a working instance on your own Cloudflare account, in about 20 minutes.

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
3. The **Install** tab shows the snippet. Put it in every page's `<head>`:

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
| 03:30 | Merge last month's day files into one month file per table, then compute daily totals for the overview. |

To fill daily totals straight away (for example after importing history), send `POST /api/admin/rollup` with a JSON body from a signed-in admin session, e.g. from the browser console on the dashboard: `fetch("/api/admin/rollup", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })`.

## Costs

At small-to-medium volumes (up to a few million events a month), everything fits within the Workers Paid plan's included usage. Usage is billed through the normal Workers, Durable Objects, R2 and D1 meters.

The heaviest parts are:
- **Durable Object requests:** one per event.
- **Query Worker CPU time:** when people use the dashboard.

R2 storage is small: Parquet takes roughly 20 bytes per event, so a site with 4.5 million events of history uses about 80 MB.

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
