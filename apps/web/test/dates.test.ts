import { describe, expect, it } from "vitest";
import { compareLabel, comparisonRange, isSameTime, localMidnight } from "../src/dates";

const at = (iso: string) => Date.parse(iso);

describe("localMidnight", () => {
  it("finds local midnight either side of a clock change", () => {
    expect(localMidnight("Europe/London", "2026-10-15")).toBe(at("2026-10-14T23:00:00Z") / 1000);
    expect(localMidnight("Europe/London", "2026-10-26")).toBe(at("2026-10-26T00:00:00Z") / 1000);
  });
});

describe("comparisonRange", () => {
  const tz = "Europe/London";
  const today = { from: "2026-10-16", to: "2026-10-16" };

  it("compares today with yesterday up to the same time, in 5-minute steps", () => {
    const cmp = comparisonRange(today, "prev", tz, at("2026-10-16T09:07:00Z"));
    expect(cmp).toEqual({ from: "2026-10-15", to: "2026-10-15", since: at("2026-10-14T23:00:00Z") / 1000, until: at("2026-10-15T09:05:00Z") / 1000 });
    expect(isSameTime(today, cmp)).toBe(true);
    expect(compareLabel("today", "prev", today.from, today.to, true)).toBe("yesterday up to the same time");
  });

  it("does the same for the same day last year", () => {
    const cmp = comparisonRange(today, "year", tz, at("2026-10-16T09:07:00Z"));
    expect(cmp).toMatchObject({ from: "2025-10-16", to: "2025-10-16", until: at("2025-10-16T09:05:00Z") / 1000 });
  });

  it("keeps whole days for anything but today", () => {
    const now = at("2026-10-16T09:07:00Z");
    expect(comparisonRange({ from: "2026-10-10", to: "2026-10-16" }, "prev", tz, now)).toEqual({ from: "2026-10-03", to: "2026-10-09" });
    expect(comparisonRange({ from: "2026-10-15", to: "2026-10-15" }, "prev", tz, now)).toEqual({ from: "2026-10-14", to: "2026-10-14" });
  });
});
