import { describe, expect, it } from "vitest";
import { lastClosedDay } from "../src/answer";

const live = (...days: string[]) => ({ tag: "t", files: Object.fromEntries(days.map((d) => [`sites/1/sessions/day/${d}.parquet`, new ArrayBuffer(1)])) });

describe("which days are closed", () => {
  it("is every day when nothing is waiting to be flushed", () => {
    expect(lastClosedDay("Europe/London", undefined)).toBeNull();
    expect(lastClosedDay("Europe/London", { tag: "", files: {} })).toBeNull();
  });
  it("is the day before the first unflushed UTC day, where local days are UTC days", () => {
    expect(lastClosedDay("UTC", live("2026-11-14"))).toBe("2026-11-13");
    expect(lastClosedDay("Europe/London", live("2026-11-14", "2026-11-13"))).toBe("2026-11-12");
  });
  it("leaves out a local day that the unflushed UTC day cuts into", () => {
    // 14 Nov UTC starts at 19:00 on the 13th in New York: the 13th isn't wholly closed, the 12th is.
    expect(lastClosedDay("America/New_York", live("2026-11-14"))).toBe("2026-11-12");
    // …and at 09:00 on the 14th in Tokyo: the 13th is closed.
    expect(lastClosedDay("Asia/Tokyo", live("2026-11-14"))).toBe("2026-11-13");
  });
});
