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
  /** Local demo only ("1"): enables /api/admin/demo/* to seed synthetic sites and traffic. Never set in production. */
  DEMO?: string;
}

export interface Site {
  id: number;
  domain: string;
  timezone: string;
  allowed_hostnames: string[];
  ip_blocklist: string[];
}
