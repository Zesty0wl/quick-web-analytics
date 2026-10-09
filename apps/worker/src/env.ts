import type { SiteDO } from "./do/site";
import type { QueryService } from "../../query/src/index";

export interface Env {
  DB: D1Database;
  DATA: R2Bucket;
  ASSETS: Fetcher;
  SITE: DurableObjectNamespace<SiteDO>;
  QUERY: Service<QueryService>;

  /** Hostnames that only serve Plausible-compatible ingestion (scripts + /api/event). */
  INGEST_HOSTS: string;
  /** Public URL of the event endpoint injected into `pa-*.js` scripts. */
  COMPAT_ENDPOINT: string;
  /** Cloudflare Access: team domain (e.g. "myteam.cloudflareaccess.com") and application AUD tag. */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** Comma-separated emails that are made admins on first login. */
  BOOTSTRAP_ADMINS?: string;
  /** Local development only: act as this email without Access. Never set in production. */
  DEV_USER_EMAIL?: string;
  /**
   * How the ingest hosts treat the old Plausible origin during migration:
   *  - "mirror": QWA answers; every event is also copied to the origin in the background, and any
   *    non-ingest path (the old dashboard, plugin API…) is passed through to the origin.
   *  - "passthrough": the origin answers (shadow mode); QWA keeps a copy.
   *  - unset: the origin is not involved.
   */
  ORIGIN_MODE?: "mirror" | "passthrough";
  /** The dashboard's canonical hostname, e.g. "analytics.example.com". Used for redirects and links in emails. */
  APP_HOST?: string;
  /**
   * Old dashboard hostnames, comma-separated. They keep serving the tracker (/t.js, /e and the Plausible-compat
   * paths) so existing snippets carry on working, and redirect everything else to APP_HOST.
   */
  LEGACY_APP_HOSTS?: string;
  /** Cloudflare Email Sending binding, for anomaly alerts (optional). */
  EMAIL?: SendEmail;
  /** Sender for alert emails, e.g. "Quick Web Analytics <alerts@example.com>". Its domain must be onboarded to Email Sending. */
  ALERT_FROM?: string;
  /** Optional Reply-To for alert emails, e.g. a monitored inbox (the sending subdomain itself can't receive mail). */
  ALERT_REPLY_TO?: string;
  /** Daily events per site before ingestion pauses until midnight UTC (default 3,000,000). A site's own cap wins. */
  DEFAULT_DAILY_CAP?: string;
  /** "1" = emergency stop: accept and discard every tracking event without touching storage. */
  INGEST_PAUSED?: string;
  /** Local demo only ("1"): enables /api/admin/demo/* to seed synthetic sites and traffic. Never set in production. */
  DEMO?: string;
}

export interface Site {
  id: number;
  domain: string;
  timezone: string;
  allowed_hostnames: string[];
  ip_blocklist: string[];
  /** Daily event cap: null = default, 0 = none. */
  daily_cap: number | null;
}
