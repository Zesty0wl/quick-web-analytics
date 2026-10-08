#!/usr/bin/env node
// Regenerates docs/screenshots/*.png from a running demo (`npm run demo` in another terminal).
// Needs playwright-core and a Chrome install: `npm i --no-save playwright-core`, then `node scripts/screenshots.mjs`.
// Options: --base http://localhost:8787
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PLAYWRIGHT_CORE ? `${process.env.PLAYWRIGHT_CORE}/` : import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const args = process.argv.slice(2);
const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : "http://localhost:8787";
const out = fileURLToPath(new URL("../docs/screenshots/", import.meta.url));
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true });

async function page({ theme = "light", palette = "signal", look = "cards", width = 1440, height = 1000 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: theme });
  await ctx.addInitScript(([t, p, l]) => {
    localStorage.setItem("qwa.theme", t);
    localStorage.setItem("qwa.palette", p);
    localStorage.setItem("qwa.look", l);
  }, [theme, palette, look]);
  return ctx.newPage();
}
const settle = async (p) => {
  await p.waitForLoadState("networkidle", { timeout: 120_000 }).catch(() => {});
  await p.waitForFunction(() => !document.querySelector(".busy-chip, .progress, .busy-block"), null, { timeout: 120_000 }).catch(() => {});
  await p.waitForTimeout(600);
};
const siteId = async (p, domain) => (await (await p.request.get(`${base}/api/me`)).json()).sites.find((s) => s.domain === domain).id;
const shot = async (p, name, clip) => {
  await p.screenshot({ path: `${out}${name}.png`, ...(clip ? { clip } : {}) });
  console.log("saved", `docs/screenshots/${name}.png`);
};

// 1. All sites, light and dark
for (const theme of ["light", "dark"]) {
  const p = await page({ theme, palette: theme === "dark" ? "cobalt" : "signal" });
  await p.goto(base, { timeout: 120_000 });
  await p.waitForSelector(".site-card");
  await settle(p);
  await shot(p, `overview-${theme}`, { x: 0, y: 0, width: 1440, height: 1240 });
  await p.context().close();
}

// 2. Site detail: header, tiles and chart; then sections
{
  const p = await page();
  await p.goto(base, { timeout: 120_000 });
  const id = await siteId(p, "acme.example");
  await p.goto(`${base}/s/${id}?range=90d`, { timeout: 120_000 });
  await p.waitForSelector(".chart .plot");
  await settle(p);
  const plot = await p.locator(".chart .plot").boundingBox();
  await p.mouse.move(plot.x + plot.width * 0.62, plot.y + plot.height * 0.4);
  await p.waitForTimeout(300);
  await shot(p, "site", { x: 0, y: 0, width: 1440, height: 1000 });
  await p.mouse.move(0, 0);

  // Section shots: un-stick the header so it can't overlap, and keep long tables to a screenful.
  await p.addStyleTag({ content: ".topwrap { position: static !important; } #s-days tbody tr:nth-child(n+13) { display: none; }" });
  for (const [sel, name] of [["#s-realtime", "realtime"], ["#s-sources", "sources"], ["#s-pages", "pages"], ["#s-devices", "devices"], ["#s-heatmap", "heatmap"], ["#s-days", "day-by-day"]]) {
    const el = p.locator(sel);
    await el.scrollIntoViewIfNeeded();
    await settle(p);
    await el.screenshot({ path: `${out}${name}.png` });
    console.log("saved", `docs/screenshots/${name}.png`);
  }
  await p.context().close();
}

// 3. Site switcher and filters (dark)
{
  const p = await page({ theme: "dark", palette: "forest" });
  await p.goto(base, { timeout: 120_000 });
  const id = await siteId(p, "docs.acme.example");
  await p.goto(`${base}/s/${id}?range=30d&f=${encodeURIComponent('[["country","is","US"]]')}`, { timeout: 120_000 });
  await p.waitForSelector(".chart .plot");
  await settle(p);
  await p.locator(".switcher-title .switcher-btn").click();
  await p.waitForSelector(".switcher-item .v:not(:empty)");
  await p.waitForTimeout(300);
  await shot(p, "switcher", { x: 0, y: 0, width: 1440, height: 900 });
  await p.context().close();
}

// 4. Phone
{
  const p = await page({ width: 390, height: 844, palette: "violet" });
  await p.goto(base, { timeout: 120_000 });
  await p.waitForSelector(".site-card");
  await settle(p);
  await shot(p, "phone");
  await p.context().close();
}

await browser.close();
