import { describe, expect, it } from "vitest";
import { renderAlertEmail, sampleAlert, subjectFor, topMovers } from "../src/email";

describe("alert email", () => {
  const a = sampleAlert("2026-10-05");

  it("writes a specific subject", () => {
    expect(subjectFor([a])).toBe("▲ example.com: 2,410 visitors on Mon 5 Oct, 2.5× a usual Monday");
    expect(subjectFor([{ ...a, kind: "drop", value: 300 }])).toBe("▼ example.com: 300 visitors on Mon 5 Oct, 69% below a usual Monday");
    expect(subjectFor([{ ...a, kind: "outage", value: 0 }])).toMatch(/^⚠ example\.com: almost no visitors on Mon 5 Oct/);
    expect(subjectFor([a, { ...a, domain: "b.example" }, { ...a, domain: "c.example" }])).toBe("3 unusual days: example.com, b.example +1");
  });

  it("includes the numbers, chart, baseline, other metrics and drivers", () => {
    const { html, text } = renderAlertEmail({ appHost: "analytics.example.com", items: [a] });
    expect(html).toContain("2,410");
    expect(html).toContain("~980");
    expect((html.match(/<td valign="bottom"/g) ?? []).length).toBe(28); // one bar per day
    expect(html).toContain("Previous Mondays:");
    expect(html).toContain("Bounce rate");
    expect(html).toContain("news.ycombinator.com");
    expect(html).toContain("https://analytics.example.com/s/0?from=2026-10-05&amp;to=2026-10-05");
    expect(text).toContain("Where the change came from:");
  });

  it("ranks movers in the direction of the anomaly", () => {
    const rows = [{ name: "a", value: 100, usual: 10 }, { name: "b", value: 50, usual: 49 }, { name: "c", value: 5, usual: 60 }];
    expect(topMovers(rows, "spike").map((r) => r.name)).toEqual(["a"]);
    expect(topMovers(rows, "drop").map((r) => r.name)).toEqual(["c"]);
  });

  it("shows what to check for an outage instead of drivers", () => {
    const { html } = renderAlertEmail({ items: [{ ...a, kind: "outage", value: 0, drivers: undefined, lastEventAt: 1791400000 }] });
    expect(html).toContain("What to check");
    expect(html).not.toContain("Where the change came from");
  });

  it("escapes HTML in names", () => {
    const { html } = renderAlertEmail({ items: [{ ...a, domain: "<b>x</b>.example" }] });
    expect(html).not.toContain("<b>x</b>.example");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;.example");
  });
});

describe("hourly (so far today) alerts", () => {
  const a = { ...sampleAlert("2026-10-09"), value: 1240, expected: 410, intraday: { hour: 14, window: "today" as const, history: [400, 390, 430, 410, 420, 405] } };

  it("says it's the day so far", () => {
    expect(subjectFor([a])).toBe("▲ example.com: 1,240 visits so far today (to 14:00), 3.0× a usual Friday by now");
    const { html } = renderAlertEmail({ items: [a] });
    expect(html).toContain("Visits so far");
    expect(html).toContain("Usual by 14:00");
    expect(html).toContain("Previous Fridays by 14:00: 400 · 390");
    expect(html).not.toContain("The rest of the day");
  });

  it("calls out a silent tracker", () => {
    const o = { ...a, kind: "outage" as const, value: 0, expected: 96, drivers: undefined, intraday: { hour: 14, window: "last3h" as const, history: [90, 95, 99, 96, 101, 92] } };
    expect(subjectFor([o])).toBe("⚠ example.com: no visits since 11:00 (usually ~96). Is the tracker still working?");
    expect(renderAlertEmail({ items: [o] }).html).toContain("Visits 11:00–14:00");
  });

  it("charts a burst hour by hour against a usual day, picking out the hours that set it off", () => {
    const usual = [9, 6, 4, 3, 3, 5, 12, 30, 45, 50, 52, 55, 60, 58, 55, 52, 50, 48, 45, 40, 35, 25, 18, 12];
    const today = [10, 7, 5, 3, 4, 6, 14, 150, 210, 273];
    const b = { ...a, value: 633, expected: 136, intraday: { hour: 10, window: "last3h" as const, history: [92, 407, 166, 131, 117, 141], hours: { today, usual } } };
    const { html, text } = renderAlertEmail({ items: [b] });
    expect(html).toContain("Visits by hour, today vs a usual Friday");
    expect(html).not.toContain("Visitors, last 4 weeks");
    // 07:00–10:00 in the accent colour, earlier hours not; every hour has its usual bar.
    expect(html.match(/title="Today (\d\d:00)–\d\d:00: [\d,]+ visits"><div style="[^"]*background:#ec3013/g)?.map((m) => m.slice(13, 18))).toEqual(["07:00", "08:00", "09:00"]);
    expect(html.match(/title="Usual Friday/g)).toHaveLength(24);
    expect(html).toContain("Today 07:00–10:00");
    expect(html).toContain("Every hour, each site's visits so far today");
    expect(html).not.toContain("Each night");
    expect(text).toContain("Visits 07:00–10:00: 633 (usual ~136)");
    expect(text).toContain("Previous Fridays, 07:00–10:00: 92, 407, 166, 131, 117, 141");
  });

  it("keeps the four-week chart for the nightly check", () => {
    const { html } = renderAlertEmail({ items: [sampleAlert("2026-10-09")] });
    expect(html).toContain("Visitors, last 4 weeks");
    expect(html).toContain("Each night");
    expect(html).not.toContain("Every hour");
  });
});
