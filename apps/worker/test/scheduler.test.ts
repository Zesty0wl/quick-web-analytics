import { describe, expect, it } from "vitest";
import { nextRun } from "../src/schedule";

const at = (iso: string) => Date.parse(iso);

describe("nextRun", () => {
  it("is ten past the current hour when that's still ahead", () => {
    expect(new Date(nextRun(at("2026-10-09T11:03:00Z"))).toISOString()).toBe("2026-10-09T11:10:00.000Z");
  });
  it("is ten past the next hour once this hour's slot has passed", () => {
    expect(new Date(nextRun(at("2026-10-09T11:10:00Z"))).toISOString()).toBe("2026-10-09T12:10:00.000Z");
    expect(new Date(nextRun(at("2026-10-09T11:42:00Z"))).toISOString()).toBe("2026-10-09T12:10:00.000Z");
  });
  it("rolls over midnight and month ends", () => {
    expect(new Date(nextRun(at("2026-10-31T23:30:00Z"))).toISOString()).toBe("2026-11-01T00:10:00.000Z");
  });
});
