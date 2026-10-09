export type EventKind = "pageview" | "engagement" | "custom";

/** Raw event after parsing a tracker payload, before enrichment. Source-agnostic. */
export interface RawEvent {
  domains: string[];
  name: string;
  url: URL;
  referrer: string | null;
  props: Record<string, string>;
  hashMode: boolean;
  interactive: boolean;
  scrollDepth: number | null;
  engagedMs: number | null;
  /** Which front door the event came through, e.g. "plausible" (compat) or "qwa". */
  via: "plausible" | "qwa";
  /** Web Vitals for the page view (QWA tracker engagement events only). */
  vitals?: Vitals | null;
}

/** A page view's Web Vitals, as measured by the QWA tracker. Times in ms; cls is CLS × 1000. 0 / "" = not measured. */
export interface Vitals {
  pv: number;
  inp: number;
  inp_target: string;
  inp_type: string;
  inp_delay: number;
  inp_processing: number;
  inp_presentation: number;
  lcp: number;
  lcp_element: string;
  cls: number;
  ttfb: number;
  fcp: number;
}

/** Fully enriched event, as handed to the site's Durable Object. */
export interface SiteEvent {
  ts: number; // unix seconds
  kind: EventKind;
  name: string;
  hostname: string;
  path: string;
  props: Record<string, string>;
  scrollDepth: number | null;
  engagedMs: number | null;
  interactive: boolean;
  visitor: number;
  prevVisitor: number | null;
  via: "plausible" | "qwa";
  vitals?: Vitals | null;
  session: SessionAttrs;
}

/** Attributes captured when a session starts. */
export interface SessionAttrs {
  referrer: string;
  source: string;
  channel: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  utm_term: string;
  country: string;
  region: string;
  city: string;
  browser: string;
  browser_version: string;
  os: string;
  os_version: string;
  device: string;
}
