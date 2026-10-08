import { UAParser } from "ua-parser-js";
import { isbot } from "isbot";
import { classify } from "./referrers";
import type { RawEvent, SessionAttrs } from "./types";

const CLICK_IDS = ["gclid", "gbraid", "wbraid", "msclkid", "fbclid", "twclid", "ttclid", "li_fat_id"];

export function isBot(userAgent: string): boolean {
  if (!userAgent || userAgent.length < 10) return true;
  if (/HeadlessChrome|Lighthouse|PhantomJS|Puppeteer|Playwright/i.test(userAgent)) return true;
  return isbot(userAgent);
}

export function pagePath(raw: RawEvent): string {
  let path = raw.url.pathname || "/";
  if (raw.hashMode && raw.url.hash) path += raw.url.hash;
  return path.slice(0, 2000);
}

export function sessionAttrs(raw: RawEvent, userAgent: string, cf: IncomingRequestCfProperties | undefined): SessionAttrs {
  const q = raw.url.searchParams;
  const utm = {
    source: q.get("utm_source") ?? q.get("source") ?? q.get("ref") ?? "",
    medium: q.get("utm_medium") ?? "",
  };
  const clickId = CLICK_IDS.find((p) => q.has(p)) ?? null;
  const src = classify({ referrer: raw.referrer, pageHost: raw.url.hostname, utm, clickId });

  const ua = new UAParser(userAgent).getResult();
  const deviceType = ua.device.type;
  const device = deviceType === "mobile" || deviceType === "wearable" ? "Mobile" : deviceType === "tablet" ? "Tablet" : "Desktop";

  const cc = typeof cf?.country === "string" ? (cf.country as string) : "";
  const country = cc && cc !== "T1" && cc !== "XX" ? cc : "";
  const regionCode = typeof cf?.regionCode === "string" ? cf.regionCode : "";

  return {
    referrer: src.referrer,
    source: src.source.slice(0, 120),
    channel: src.channel,
    utm_source: utm.source.slice(0, 200),
    utm_medium: utm.medium.slice(0, 200),
    utm_campaign: (q.get("utm_campaign") ?? "").slice(0, 200),
    utm_content: (q.get("utm_content") ?? "").slice(0, 200),
    utm_term: (q.get("utm_term") ?? "").slice(0, 200),
    country,
    region: country && regionCode ? `${country}-${regionCode}` : "",
    city: typeof cf?.city === "string" ? cf.city : "",
    browser: normaliseBrowser(ua.browser.name ?? ""),
    browser_version: majorMinor(ua.browser.version),
    os: normaliseOs(ua.os.name ?? ""),
    os_version: majorMinor(ua.os.version),
    device,
  };
}

function majorMinor(v: string | undefined): string {
  return v ? v.split(".").slice(0, 2).join(".") : "";
}

function normaliseBrowser(name: string): string {
  const map: Record<string, string> = {
    "Mobile Safari": "Safari",
    "Mobile Chrome": "Chrome",
    "Chrome WebView": "Chrome WebView",
    "Mobile Firefox": "Firefox",
    "Samsung Browser": "Samsung Internet",
    "Edge": "Microsoft Edge",
    "Opera Mobi": "Opera",
    "Opera Mini": "Opera",
  };
  return map[name] ?? name;
}

function normaliseOs(name: string): string {
  if (name === "Mac OS") return "macOS";
  if (name === "Chromium OS") return "ChromeOS";
  return name;
}
