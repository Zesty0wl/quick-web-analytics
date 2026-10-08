import { describe, expect, it } from "vitest";
import { parsePlausiblePayload, PayloadError } from "../src/ingest/plausible";
import { classify, lookupHost } from "../src/ingest/referrers";
import { hostnameAllowed, ipBlocked, ipMatches } from "../src/ingest/ip";
import { legacyFile } from "../src/compat/scripts";
import { isBot, pagePath } from "../src/ingest/enrich";

describe("Plausible payload", () => {
  it("parses a pageview", () => {
    const e = parsePlausiblePayload({ n: "pageview", u: "https://example.com/tracker?utm_source=x", d: "example.com", r: "https://www.google.com/", v: 30 });
    expect(e.name).toBe("pageview");
    expect(e.domains).toEqual(["example.com"]);
    expect(e.url.pathname).toBe("/tracker");
    expect(e.interactive).toBe(true);
  });
  it("supports multiple domains and props as JSON string", () => {
    const e = parsePlausiblePayload({ n: "Signup", u: "https://a.com/", d: "a.com, b.com", m: '{"plan":"pro","n":3}' });
    expect(e.domains).toEqual(["a.com", "b.com"]);
    expect(e.props).toEqual({ plan: "pro", n: "3" });
  });
  it("parses engagement and requires sd or e", () => {
    const e = parsePlausiblePayload({ n: "engagement", u: "https://a.com/x", d: "a.com", sd: 140, e: 5000 });
    expect(e.scrollDepth).toBe(100);
    expect(e.engagedMs).toBe(5000);
    expect(() => parsePlausiblePayload({ n: "engagement", u: "https://a.com/", d: "a.com" })).toThrow(PayloadError);
  });
  it("keeps the hash in hash mode", () => {
    const e = parsePlausiblePayload({ n: "pageview", u: "https://a.com/app#/settings", d: "a.com", h: 1 });
    expect(pagePath(e)).toBe("/app#/settings");
  });
  it("rejects bad input", () => {
    expect(() => parsePlausiblePayload({ n: "pageview", d: "a.com" })).toThrow(PayloadError);
    expect(() => parsePlausiblePayload({ n: "", u: "https://a.com", d: "a.com" })).toThrow(PayloadError);
    expect(() => parsePlausiblePayload({ n: "pageview", u: "javascript:alert(1)", d: "a.com" })).toThrow(PayloadError);
  });
});

describe("referrer classification", () => {
  const c = (referrer: string | null, utm = { source: "", medium: "" }, clickId: string | null = null) =>
    classify({ referrer, pageHost: "example.com", utm, clickId });
  it("maps search engines incl. ccTLDs", () => {
    expect(lookupHost("www.google.co.uk")?.name).toBe("Google");
    expect(c("https://www.google.de/")).toMatchObject({ source: "Google", channel: "Organic Search" });
  });
  it("maps social, AI and video", () => {
    expect(c("https://t.co/abc")).toMatchObject({ source: "X", channel: "Organic Social" });
    expect(c("https://chatgpt.com/")).toMatchObject({ source: "ChatGPT", channel: "AI Assistants" });
    expect(c("https://m.youtube.com/watch")).toMatchObject({ source: "YouTube", channel: "Organic Video" });
  });
  it("treats internal navigation and no referrer as direct", () => {
    expect(c("https://example.com/other")).toMatchObject({ source: "Direct", channel: "Direct", referrer: "" });
    expect(c(null)).toMatchObject({ source: "Direct", channel: "Direct" });
  });
  it("uses UTM and click ids", () => {
    expect(c(null, { source: "newsletter", medium: "email" })).toMatchObject({ source: "Newsletter", channel: "Email" });
    expect(c("https://www.google.com/", { source: "", medium: "" }, "gclid")).toMatchObject({ channel: "Paid Search" });
    expect(c(null, { source: "facebook", medium: "cpc" })).toMatchObject({ source: "Facebook", channel: "Paid Social" });
  });
  it("falls back to the referrer host as a referral", () => {
    expect(c("https://blog.example.org/post")).toMatchObject({ source: "blog.example.org", channel: "Referral", referrer: "blog.example.org/post" });
  });
});

describe("ip and hostname rules", () => {
  it("matches IPv4 exact and CIDR", () => {
    expect(ipMatches("81.2.69.160", "81.2.69.160")).toBe(true);
    expect(ipMatches("81.2.69.161", "81.2.69.0/24")).toBe(true);
    expect(ipMatches("81.2.70.1", "81.2.69.0/24")).toBe(false);
  });
  it("matches IPv6 with compression", () => {
    expect(ipMatches("2a02:c7c:1234:5678::1", "2a02:c7c:1234::/48")).toBe(true);
    expect(ipMatches("2a02:c7d::1", "2a02:c7c::/32")).toBe(false);
    expect(ipBlocked("::1", ["::1"])).toBe(true);
  });
  it("ignores mixed families and junk", () => {
    expect(ipMatches("1.2.3.4", "::1")).toBe(false);
    expect(ipMatches("1.2.3.4", "nonsense")).toBe(false);
  });
  it("allows hostnames by exact and wildcard rule", () => {
    expect(hostnameAllowed("example.com", [])).toBe(true);
    expect(hostnameAllowed("www.example.com", ["*.example.com"])).toBe(true);
    expect(hostnameAllowed("example.com", ["*.example.com"])).toBe(true);
    expect(hostnameAllowed("evil.com", ["example.com"])).toBe(false);
  });
});

describe("compat script names", () => {
  it("normalises legacy variants like Plausible", () => {
    expect(legacyFile("script.js")).toBe("plausible.js");
    expect(legacyFile("script.outbound-links.hash.file-downloads.js")).toBe("plausible.file-downloads.hash.outbound-links.js");
    expect(legacyFile("script.tagged-events.pageleave.js")).toBe("plausible.tagged-events.js");
    expect(legacyFile("evil.js")).toBeNull();
  });
});

describe("bots", () => {
  it("flags crawlers, headless and empty agents", () => {
    expect(isBot("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe(true);
    expect(isBot("Mozilla/5.0 HeadlessChrome/120.0")).toBe(true);
    expect(isBot("")).toBe(true);
    expect(isBot("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15")).toBe(false);
  });
});

import { parseQwaPayload } from "../src/ingest/qwa";

describe("QWA payload", () => {
  it("maps the tracker's fields and tags the source", () => {
    const e = parseQwaPayload({ s: "example.com", n: "Signup", u: "https://example.com/p#/x", r: null, p: { plan: "pro" }, h: 1 });
    expect(e).toMatchObject({ domains: ["example.com"], name: "Signup", props: { plan: "pro" }, hashMode: true, via: "qwa" });
  });
  it("validates like the Plausible format", () => {
    expect(() => parseQwaPayload({ n: "pageview", u: "https://example.com/" })).toThrow(PayloadError);
    expect(() => parseQwaPayload(null)).toThrow(PayloadError);
  });
});
