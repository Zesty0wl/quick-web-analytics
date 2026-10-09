# Instructions for AI agents

This file is for AI coding agents (Claude Code, Codex, Cursor, Copilot and others) working in this repository. Most
people deploy Quick Web Analytics (QWA) by asking an agent to do it, so the deployment runbook comes first. If you're
here to change the code, skip to [Working on the code](#working-on-the-code).

## Deploying QWA

Your job: take this repository to a working QWA instance on the person's Cloudflare account, optionally with Google
Search Console and PageSpeed data, and leave them with a dashboard they can sign in to.

### Ground rules

- **Never print, echo, log or commit a secret.** That covers the Cloudflare API token, Access values, Google key files and
  the Google API key. Read them from environment variables or files, and pipe them straight into the command that needs
  them, e.g. `npx wrangler secret put NAME < file`.
- **Never commit** `apps/worker/wrangler.jsonc`, `.dev.vars`, key files or anything containing account IDs or hostnames.
  `.gitignore` already covers `apps/worker/wrangler.jsonc`, `google-service-account.json` and `google-api-key.txt`.
- **Be idempotent.** Before creating anything, check whether it exists (a D1 database, R2 bucket, Access application,
  rate-limit rule). If it exists, reuse it. Never delete or overwrite something you didn't create in this session
  without asking.
- **Stop and ask at the checkpoints below** (marked **ASK**). They are the places where the person's choice or their own
  browser sign-in is needed.
- **Verify each phase** with the check given before moving on. If a check fails, use the Troubleshooting table in
  [docs/DEPLOY.md](docs/DEPLOY.md#troubleshooting) before trying anything creative.
- Prefer `wrangler` for Workers, D1 and R2. Use the Cloudflare REST API (`https://api.cloudflare.com/client/v4`, with
  `Authorization: Bearer $CLOUDFLARE_API_TOKEN`) for Access, rate limits and notifications, which wrangler can't do.

### What the person provides

**ASK** for these first, in one message:

1. **The dashboard hostname**, e.g. `analytics.example.com`. Its domain must be a zone on their Cloudflare account. It must not
   already be serving something else, so check with `curl -sI https://<hostname>/`; if it answers, ask before taking it over.
2. **Admin email address(es)**: who can sign in as an admin. They sign in with a one-time code sent to that address.
3. **The sites to track**, e.g. `example.com`, each with a timezone for its reports (e.g. `Europe/London`). Optional: sites
   can be added later in the dashboard.
4. **Whether they want Google data** (Search Console + PageSpeed). Optional: it can be added later.
5. **Whether to add cost brakes**: an edge rate limit, and billing alerts to an email address. Recommended.

And this access, which the person sets up themselves. Never ask them to paste a token into the chat:

- **A Cloudflare API token** in the environment as `CLOUDFLARE_API_TOKEN`, plus `CLOUDFLARE_ACCOUNT_ID`. They create it at
  *dash.cloudflare.com → My Profile → API Tokens → Create Token → Create Custom Token*, with these permissions:

  | Scope | Permission | Used for |
  |---|---|---|
  | Account | Workers Scripts: Edit | deploying the two Workers, secrets |
  | Account | D1: Edit | the database |
  | Account | Workers R2 Storage: Edit | the event store |
  | Account | Access: Apps and Policies: Edit | dashboard sign-in |
  | Account | Access: Organizations, Identity Providers, and Groups: Read | finding the Access team domain |
  | Account | Account Settings: Read | wrangler |
  | Account | Notifications: Edit | billing alerts (optional) |
  | Account | Email Sending: Edit | alert emails (optional) |
  | Zone (the hostname's zone) | Zone: Read, Workers Routes: Edit, DNS: Edit | the custom domain |
  | Zone (the hostname's zone) | Zone WAF: Edit | the edge rate limit (optional) |

  Tell them to start the agent from a shell where both variables are exported, or to put them in a gitignored env file
  your tooling loads. Check the token with `npx wrangler whoami`, which should list the account.
- **Workers Paid plan** ($5/month) on that account. The query Worker needs it. You can't check this reliably, so **ASK** them
  to confirm.
- **Node.js 22+**. Run `npm install` in the repository root.

### Phase 1: storage and config

```sh
npx wrangler d1 list --json        # reuse a database named "qwa" if present
npx wrangler d1 create qwa         # otherwise; note the database_id
npx wrangler r2 bucket list        # reuse "qwa-data" if present
npx wrangler r2 bucket create qwa-data
cp apps/worker/wrangler.example.jsonc apps/worker/wrangler.jsonc   # only if it doesn't exist yet
```

Edit `apps/worker/wrangler.jsonc`. It's JSONC, so keep the comments. The values marked `CHANGE`:

- `d1_databases[0].database_id`: the database ID
- `routes[0].pattern`: the hostname, with `"custom_domain": true`; wrangler creates the DNS record and certificate
- `vars.COMPAT_ENDPOINT`: `https://<hostname>/api/event`
- `vars.APP_HOST`: the hostname

Leave `apps/query/wrangler.jsonc` alone.

**Check:** `npx wrangler deploy --dry-run -c apps/worker/wrangler.jsonc` succeeds.

### Phase 2: database and deploy

```sh
(cd apps/worker && npx wrangler d1 migrations apply qwa --remote)
npm run deploy        # builds the dashboard and tracker, deploys qwa-query first, then qwa
```

**Check:** `curl -s -o /dev/null -w "%{http_code}" https://<hostname>/t.js` returns `200`. The custom domain's certificate can
take a minute or two on first deploy, so retry a few times before investigating.

### Phase 3: sign-in with Cloudflare Access

1. **Find the Access team domain:** `GET /accounts/$CLOUDFLARE_ACCOUNT_ID/access/organizations` returns `result.auth_domain`
   (e.g. `myteam.cloudflareaccess.com`).
   - If the call fails or has no `auth_domain`, Zero Trust hasn't been set up on the account. **ASK** the person to open
     *dash.cloudflare.com → Zero Trust* once, pick a team name and choose the Free plan, then continue.
2. **Create the dashboard application**, unless one already exists for the hostname (`GET /access/apps`). It protects the whole hostname:
   ```json
   POST /accounts/{account_id}/access/apps
   {
     "name": "Quick Web Analytics",
     "type": "self_hosted",
     "domain": "<hostname>",
     "session_duration": "24h",
     "policies": [{ "name": "QWA admins", "decision": "allow", "include": [{ "email": { "email": "<admin email>" } }] }]
   }
   ```
   - Add one `include` entry per admin email. To let anyone sign in and have QWA decide who sees what (people are
     added under Admin → Users), use `"include": [{ "everyone": {} }]` instead. **ASK** which they prefer if they
     mentioned other users.
   - Keep `result.aud` from the response. It's a value for a secret: don't print it.
3. **Create the public-paths application.** It keeps the tracker reachable without sign-in. More specific paths win over the
   dashboard application:
   ```json
   POST /accounts/{account_id}/access/apps
   {
     "name": "Quick Web Analytics (public paths)",
     "type": "self_hosted",
     "domain": "<hostname>/t.js",
     "destinations": [
       { "type": "public", "uri": "<hostname>/t.js" },
       { "type": "public", "uri": "<hostname>/e" }
     ],
     "policies": [{ "name": "Public", "decision": "bypass", "include": [{ "everyone": {} }] }]
   }
   ```
   Also add `<hostname>/api/event` and `<hostname>/js/*` only if they are moving from Plausible and will keep its snippets
   (see [docs/MIGRATING.md](docs/MIGRATING.md)).
4. **Tell the Worker,** piping each value in without printing it:
   ```sh
   cd apps/worker
   printf %s "$TEAM_DOMAIN" | npx wrangler secret put ACCESS_TEAM_DOMAIN
   printf %s "$AUD"         | npx wrangler secret put ACCESS_AUD
   printf %s "$ADMINS"      | npx wrangler secret put BOOTSTRAP_ADMINS   # comma-separated emails
   ```

**Check:**
- `curl -sI https://<hostname>/` redirects (302) to `…cloudflareaccess.com`.
- `/t.js` still returns `200`.
- `curl -s -o /dev/null -w "%{http_code}" -X POST https://<hostname>/e -H "content-type: text/plain" -A "Mozilla/5.0" -d '{"n":"pageview","u":"https://example.com/","s":"example.com"}'` returns `202`.

### Phase 4: sites

- Add each site to the database. Domain without `www.`, lowercase:
  ```sh
  (cd apps/worker && npx wrangler d1 execute qwa --remote --command "INSERT INTO sites (domain, timezone) VALUES ('example.com', 'Europe/London') ON CONFLICT(domain) DO NOTHING")
  ```
- Give the person the snippet for each site, to go in every page's `<head>`:
  ```html
  <script defer src="https://<hostname>/t.js" data-site="example.com"></script>
  ```
  If the site's code is in a repository you can edit, offer to add it, but ask first.
- **ASK** them to open `https://<hostname>/`, sign in with the code emailed to them, and confirm the dashboard loads. Their
  first sign-in creates their admin account. **Admin → Sites → Install** shows when the first event arrives.

### Phase 5: cost brakes (recommended)

- **Edge rate limit.** Requests it blocks never reach the Worker, so they cost nothing.
  - First, `GET /zones/{zone_id}/rulesets/phases/http_ratelimit/entrypoint`.
  - The `PUT` below replaces every rule in that phase, so include any existing rules in your `rules` array. The Free plan allows
    one rate-limit rule per zone: if one already exists, **ASK** before replacing it.
  ```json
  PUT /zones/{zone_id}/rulesets/phases/http_ratelimit/entrypoint
  { "rules": [{
      "description": "QWA tracker: max 100 events / 10s per IP (cost brake)",
      "expression": "(http.host eq \"<hostname>\" and http.request.method eq \"POST\" and http.request.uri.path in {\"/e\" \"/api/event\"})",
      "action": "block",
      "ratelimit": { "characteristics": ["cf.colo.id", "ip.src"], "period": 10, "requests_per_period": 100, "mitigation_timeout": 10 }
  }] }
  ```
- **Billing alerts:** one per threshold, emailed to the address they gave. **ASK** for the thresholds if they didn't give any;
  $25, $50 and $100 are sensible.
  ```json
  POST /accounts/{account_id}/alerting/v3/policies
  { "name": "Cloudflare spend reached $25 this month (QWA)", "alert_type": "billing_budget_alert", "enabled": true,
    "filters": { "total_spend_dollars": ["25"] }, "mechanisms": { "email": [{ "id": "<email>" }] } }
  ```
- The per-site daily event limit (3,000,000 by default) is built in; nothing to do.

### Phase 6: alert emails (optional)

Anomaly alerts need Cloudflare Email Sending.

- **Onboarding** adds DNS records and needs a human decision about DMARC on domains that already send mail. So **ASK** the
  person to onboard a domain or subdomain (e.g. `alerts.example.com`) in *dash.cloudflare.com → Email Service → Email
  Sending*.
- **Then:**
  1. In `wrangler.jsonc`, uncomment `"send_email": [{ "name": "EMAIL" }]` and set `ALERT_FROM` (e.g. `"Quick Web Analytics
     <alerts@alerts.example.com>"`).
  2. Optionally set `ALERT_REPLY_TO` to a monitored inbox.
  3. Run `npm run deploy`.
- **Check:** the person uses Admin → Alerts → Send me a test email.

### Phase 7: Google data (optional)

This adds two sections to each site's page: Google Search (Search Console) and Speed (PageSpeed Insights + Chrome UX
Report). It needs a Google Cloud project with three APIs turned on, a service account with a JSON key, an API key, and
the service account added as a user on each Search Console property. That last step has no API: it must be done in
Search Console in a browser.

Pick the route that matches your tools.

**Route A: you have the `gcloud` CLI.**

1. **ASK** the person to run `gcloud auth login` themselves; it opens a browser. They can type `! gcloud auth login` in Claude Code.
2. Create the project, APIs and credentials. Choose a project ID that's free, such as `qwa-<random 6 chars>`:
   ```sh
   gcloud projects create "$PROJECT" --name="Quick Web Analytics"
   gcloud services enable searchconsole.googleapis.com pagespeedonline.googleapis.com chromeuxreport.googleapis.com apikeys.googleapis.com --project="$PROJECT"
   gcloud iam service-accounts create qwa-reader --display-name="QWA Search Console reader" --project="$PROJECT"
   gcloud iam service-accounts keys create google-service-account.json --iam-account="qwa-reader@$PROJECT.iam.gserviceaccount.com"
   gcloud services api-keys create --display-name="QWA PageSpeed and CrUX" --project="$PROJECT" \
     --api-target=service=pagespeedonline.googleapis.com --api-target=service=chromeuxreport.googleapis.com
   gcloud services api-keys list --project="$PROJECT" --format="value(name)"        # find the key's name
   gcloud services api-keys get-key-string "<name>" --format="value(keyString)" > google-api-key.txt
   ```
   - If key creation fails with an organisation policy error (`iam.disableServiceAccountKeyCreation`), the person's Google
     Workspace blocks downloadable keys. **ASK** them to use a personal Google account's project, or to ask their Workspace admin.
3. Store both as Worker secrets, then delete the local files. The secrets are the copies that matter:
   ```sh
   (cd apps/worker && npx wrangler secret put GOOGLE_SERVICE_ACCOUNT < ../../google-service-account.json)
   (cd apps/worker && tr -d '[:space:]' < ../../google-api-key.txt | npx wrangler secret put GOOGLE_API_KEY)
   rm google-service-account.json google-api-key.txt
   ```

**Route B: no `gcloud`.** Send the person to **Admin → Google** in their dashboard. It walks them through the same steps in the
browser, with links to the right Google pages. It checks each credential with Google before saving it, so there's nothing
to store.

**Then, either route: grant access per site.**

- The service account's email is `qwa-reader@<project>.iam.gserviceaccount.com`, or shown in Admin → Google.
- **If you can drive a browser** the person is signed in to Google with, do this for each property: open
  `https://search.google.com/search-console/users?resource_id=sc-domain:<domain>`, choose **Add user**, enter the email,
  set **Permission** to **Restricted** and click **Add**.
- **Otherwise,** hand the person Admin → Google: each site there has an *Open in Search Console* link and a *Copy address*
  button.
- Sites that aren't in Search Console yet must first be added and verified there by the person (a Domain property, verified
  with a DNS TXT record). If the domain is on Cloudflare and they ask you to, you can add the TXT record Google shows them.

**Check:** Admin → Google shows each site as *Connected*. A newly granted site can take a few minutes to appear; use *Check
again*.
- The first PageSpeed tests run overnight (between 02:00 and 08:00 UTC), or an admin can press **Test now** in a site's Speed section.
- Search Console data trails by a day or two.

### Finish

Tell the person:
- the dashboard URL and that they sign in with an emailed code
- the snippet for each site
- what's on: Access, cost brakes, alerts, Google
- anything left for them to do, such as installing snippets or granting Search Console access

Don't commit or push anything unless they ask.

### Updating an existing instance

```sh
git pull
npm install
(cd apps/worker && npx wrangler d1 migrations apply qwa --remote)   # already-applied migrations are skipped
npm run deploy
```

Read the new entries in [CHANGELOG.md](CHANGELOG.md) first; "Upgrade notes" list anything beyond this, such as new
optional settings. **Check:** `/t.js` returns `200` and `/` redirects to Access.

## Working on the code

- **Layout:**
  - `apps/worker`: the main Worker (Hono). Ingestion, the dashboard API, cron jobs, and a Durable Object per site
    (`src/do/site.ts`).
  - `apps/query`: DuckDB-WASM over the Parquet files in R2, reached over RPC.
  - `apps/web`: the dashboard (React, Vite).
  - `packages/tracker`: `t.js`.
  - `packages/shared`: schemas and the query spec.
  - Migrations are in `apps/worker/migrations`.
- **Run it:** `npm run demo` starts everything locally with synthetic sites (no Cloudflare account needed) at
  `http://localhost:8787`, signed in as an admin.
- **Before finishing a change:** run `npm test` and `npm run typecheck`. Match the surrounding style. User-facing text is
  plain British English.
- **Database changes:** add a new numbered migration; never edit an applied one. Mention it under "Upgrade notes" in CHANGELOG.md.
- **More:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how data flows; [CONTRIBUTING.md](CONTRIBUTING.md) has the rest.
