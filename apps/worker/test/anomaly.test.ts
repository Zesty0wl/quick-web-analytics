import { describe as group, expect, it } from "vitest";
import { denseSeries, describe, detectAnomalies, detectIntraday, episodes } from "../src/anomaly";

// 12 weeks of a weekday/weekend pattern with mild noise, starting on a Monday.
function weeks(n = 12, weekday = 1000, weekend = 600) {
  const out: { day: string; value: number }[] = [];
  const start = Date.UTC(2026, 6, 6); // Mon 6 Jul 2026
  for (let i = 0; i < n * 7; i++) {
    const d = new Date(start + i * 86_400_000);
    const dow = d.getUTCDay();
    const base = dow === 0 || dow === 6 ? weekend : weekday;
    out.push({ day: d.toISOString().slice(0, 10), value: Math.round(base * (1 + 0.05 * Math.sin(i * 1.7))) });
  }
  return out;
}

group("detectAnomalies", () => {
  it("finds nothing in normal weekly traffic", () => {
    expect(detectAnomalies(weeks())).toEqual([]);
  });

  it("does not compare weekdays with weekends", () => {
    // A quiet Saturday is normal; it must not be reported as a drop against weekdays.
    expect(detectAnomalies(weeks(12, 1000, 300))).toEqual([]);
  });

  it("flags a spike against the same weekday", () => {
    const s = weeks();
    s[s.length - 3].value = 3200; // a Friday
    const a = detectAnomalies(s);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ day: s[s.length - 3].day, kind: "spike", value: 3200 });
    expect(a[0].expected).toBeGreaterThan(900);
  });

  it("flags a drop and an outage", () => {
    const s = weeks();
    s[s.length - 10].value = 350; // a Friday (usually ~1,000)
    s[s.length - 1].value = 0;
    const kinds = detectAnomalies(s).map((a) => a.kind);
    expect(kinds).toEqual(["drop", "outage"]);
  });

  it("ignores big relative swings on tiny sites", () => {
    const s = weeks(12, 6, 3);
    s[s.length - 2].value = 20; // 3× the usual, but only +14 visitors
    expect(detectAnomalies(s)).toEqual([]);
  });

  it("needs at least four weeks of history", () => {
    const s = weeks(4);
    s[s.length - 1].value = 5000;
    expect(detectAnomalies(s)).toEqual([]);
    const longer = weeks(5);
    longer[longer.length - 1].value = 5000;
    expect(detectAnomalies(longer)).toHaveLength(1);
  });

  it("treats missing days as zero visitors (dense series)", () => {
    const s = weeks().filter((_, i, arr) => i !== arr.length - 1);
    s.push({ day: "2026-09-28", value: 900 }); // leaves 2026-09-27 out
    const dense = denseSeries(s);
    expect(dense.find((p) => p.day === "2026-09-27")?.value).toBe(0);
  });

  it("reports a run of unusual days once", () => {
    const s = weeks();
    for (const i of [5, 4, 3]) s[s.length - i].value = 4000; // three days in a row
    s[s.length - 1].value = 0;
    const found = detectAnomalies(s);
    expect(found.filter((a) => a.kind === "spike")).toHaveLength(3);
    expect(episodes(found).map((a) => [a.kind, a.day])).toEqual([["spike", s[s.length - 5].day], ["outage", s[s.length - 1].day]]);
  });

  it("describes anomalies in words", () => {
    expect(describe({ kind: "spike", value: 3000, expected: 1000, day: "2026-10-02" })).toBe("Visitors 3.0× the usual Friday (3,000 vs about 1,000)");
    expect(describe({ kind: "drop", value: 400, expected: 1000, day: "2026-10-02" })).toBe("Visitors 60% below the usual Friday (400 vs about 1,000)");
    expect(describe({ kind: "outage", value: 0, expected: 900, day: "2026-10-03" })).toMatch(/Almost no visitors.*Saturday/);
  });
});

group("detectIntraday", () => {
  it("flags a burst in the last three hours that the day so far dilutes", () => {
    const hist = Array.from({ length: 6 }, (_, k) => ({ today: 1000 + k * 60, last3h: 200 + k * 10 }));
    // Day so far only 1.5× usual, but the last three hours are 6×.
    expect(detectIntraday({ today: 1600, last3h: 1400, history: hist, hour: 13 })).toMatchObject({ kind: "spike", window: "last3h", value: 1400 });
    // 3× in the last three hours isn't a burst.
    expect(detectIntraday({ today: 1300, last3h: 700, history: hist, hour: 13 })).toBeNull();
    // Small sites need +200 visits, not just a big ratio.
    const small = Array.from({ length: 6 }, () => ({ today: 40, last3h: 8 }));
    expect(detectIntraday({ today: 90, last3h: 60, history: small, hour: 13 })).toBeNull();
  });

  const history = (today: number, last3h: number) => Array.from({ length: 6 }, (_, i) => ({ today: today + (i % 3) * 10 - 10, last3h: last3h + (i % 2) * 6 - 3 }));

  it("stays quiet on a normal day", () => {
    expect(detectIntraday({ today: 410, last3h: 95, history: history(400, 90) })).toBeNull();
  });

  it("flags a spike in the day so far", () => {
    expect(detectIntraday({ today: 1240, last3h: 600, history: history(400, 90) })).toMatchObject({ kind: "spike", window: "today", value: 1240 });
  });

  it("flags a broken tracker from a silent last three hours", () => {
    expect(detectIntraday({ today: 300, last3h: 0, history: history(400, 90) })).toMatchObject({ kind: "outage", window: "last3h", value: 0 });
  });

  it("doesn't call a quiet night an outage", () => {
    expect(detectIntraday({ today: 12, last3h: 0, history: history(14, 6) })).toBeNull();
  });

  it("needs enough history", () => {
    expect(detectIntraday({ today: 5000, last3h: 0, history: history(400, 90).slice(0, 3) })).toBeNull();
  });

  it("ignores early-morning spikes but still catches a silent tracker", () => {
    expect(detectIntraday({ today: 1240, last3h: 600, history: history(400, 90), hour: 4 })).toBeNull();
    expect(detectIntraday({ today: 300, last3h: 0, history: history(400, 90), hour: 4 })).toMatchObject({ kind: "outage" });
  });
});
