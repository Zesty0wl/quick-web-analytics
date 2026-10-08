// Each test gets a fresh JSDOM window, so listeners and history patches never leak between tests.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(join(process.cwd(), "src/qwa.js"), "utf8");

interface Page {
  win: any;
  sent: { url: string; body: Record<string, any> }[];
  names: () => string[];
  clock: { now: number };
}

function page(href = "https://example.com/start", attrs: Record<string, string> = {}, before?: (win: any) => void): Page {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url: href, runScripts: "outside-only", pretendToBeVisual: true });
  const win = dom.window as any;
  const sent: Page["sent"] = [];
  const clock = { now: Date.parse("2026-10-08T12:00:00Z") };
  win.Date.now = () => clock.now;
  win.document.hasFocus = () => true;
  win.fetch = async (url: string, init: any) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return { ok: true };
  };
  const el = win.document.createElement("script");
  el.src = "https://analytics.test/t.js";
  el.setAttribute("data-site", "example.com");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  win.document.head.appendChild(el);
  Object.defineProperty(win.document, "currentScript", { value: el, configurable: true });
  before?.(win);
  win.eval(SOURCE);
  return { win, sent, clock, names: () => sent.map((s) => s.body.n) };
}

function hide(win: any) {
  Object.defineProperty(win.document, "visibilityState", { value: "hidden", configurable: true });
  win.document.dispatchEvent(new win.Event("visibilitychange"));
}

describe("QWA tracker", () => {
  it("sends a pageview to <script origin>/e with the site", () => {
    const p = page();
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0].url).toBe("https://analytics.test/e");
    expect(p.sent[0].body).toMatchObject({ s: "example.com", n: "pageview", u: "https://example.com/start" });
  });

  it("tracks SPA navigation once per URL", () => {
    const p = page();
    p.win.history.pushState(null, "", "/next");
    p.win.history.pushState(null, "", "/next");
    expect(p.names()).toEqual(["pageview", "pageview"]);
    expect(p.sent[1].body.u).toBe("https://example.com/next");
  });

  it("reports engagement for the previous page before the next pageview", () => {
    const p = page();
    p.clock.now += 5000;
    p.win.history.pushState(null, "", "/next");
    expect(p.names()).toEqual(["pageview", "engagement", "pageview"]);
    expect(p.sent[1].body).toMatchObject({ u: "https://example.com/start", e: 5000 });
  });

  it("supports custom events with props, and plausible() as an alias", () => {
    const p = page();
    p.win.qwa("Signup", { props: { plan: "pro" } });
    p.win.plausible("Legacy", { props: { a: "1" } });
    expect(p.sent.slice(1).map((s) => [s.body.n, s.body.p])).toEqual([["Signup", { plan: "pro" }], ["Legacy", { a: "1" }]]);
  });

  it("replays calls queued before the script loaded", () => {
    const p = page(undefined, {}, (win) => {
      win.plausible = function () { (win.plausible.q = win.plausible.q || []).push(arguments); };
      win.plausible("Early", { props: { x: "y" } });
    });
    expect(p.names()).toEqual(["Early", "pageview"]);
  });

  it("takes over a stub defined before load even when nothing was queued yet", () => {
    const p = page(undefined, { "data-manual": "" }, (win) => {
      win.plausible = function () { (win.plausible.q = win.plausible.q || []).push(arguments); };
      win.qwa = function () { (win.qwa.q = win.qwa.q || []).push(arguments); };
    });
    p.win.plausible("pageview", { u: "https://example.com/app/class", props: { size: "6–15" } });
    p.win.qwa("Later");
    expect(p.sent.map((s) => [s.body.n, s.body.u, s.body.p])).toEqual([
      ["pageview", "https://example.com/app/class", { size: "6–15" }],
      ["Later", "https://example.com/start", undefined],
    ]);
  });

  it("tracks outbound links and downloads, not internal links", () => {
    const p = page();
    p.win.document.body.innerHTML =
      '<a id="out" href="https://other.org/page" target="_blank">x</a><a id="dl" href="/files/report.pdf?v=2" target="_blank">y</a><a id="in" href="/about" target="_blank">z</a>';
    for (const id of ["out", "dl", "in"]) p.win.document.getElementById(id).click();
    expect(p.sent.slice(1).map((s) => [s.body.n, s.body.p?.url])).toEqual([
      ["Outbound Link: Click", "https://other.org/page"],
      ["File Download", "https://example.com/files/report.pdf"],
    ]);
  });

  it("tracks tagged elements with qwa- or plausible- classes", () => {
    const p = page();
    p.win.document.body.innerHTML =
      '<button class="btn qwa-event-name=Buy+Now qwa-event-tier=gold"><span id="inner">Buy</span></button><div id="p" class="plausible-event-name=Legacy+Tag"></div>';
    p.win.document.getElementById("inner").click();
    p.win.document.getElementById("p").click();
    expect(p.sent.slice(1).map((s) => [s.body.n, s.body.p])).toEqual([["Buy Now", { tier: "gold" }], ["Legacy Tag", {}]]);
  });

  it("sends engagement once when the tab is hidden and closed", () => {
    const p = page();
    p.clock.now += 7000;
    hide(p.win);
    p.win.dispatchEvent(new p.win.Event("pagehide"));
    const eng = p.sent.filter((s) => s.body.n === "engagement");
    expect(eng).toHaveLength(1);
    expect(eng[0].body.e).toBe(7000);
  });

  it("counts hash routes in hash mode", () => {
    const p = page("https://example.com/app#/a", { "data-hash": "" });
    p.win.location.hash = "#/b";
    p.win.dispatchEvent(new p.win.HashChangeEvent("hashchange"));
    const pv = p.sent.filter((s) => s.body.n === "pageview");
    expect(pv.map((s) => s.body.u)).toEqual(["https://example.com/app#/a", "https://example.com/app#/b"]);
    expect(pv[0].body.h).toBe(1);
  });

  it("does nothing on localhost unless data-local is set", () => {
    expect(page("http://localhost:3000/").sent).toHaveLength(0);
    expect(page("http://localhost:3000/", { "data-local": "" }).sent).toHaveLength(1);
  });

  it("honours data-manual and a custom data-api", () => {
    const p = page(undefined, { "data-manual": "", "data-api": "https://collect.test/x" });
    expect(p.sent).toHaveLength(0);
    p.win.qwa("pageview", { url: "https://example.com/virtual" });
    expect(p.sent[0].url).toBe("https://collect.test/x");
    expect(p.sent[0].body.u).toBe("https://example.com/virtual");
  });

  it("respects the qwa_ignore opt-out", () => {
    const p = page(undefined, {}, (win) => win.localStorage.setItem("qwa_ignore", "true"));
    expect(p.sent).toHaveLength(0);
  });
});
