import { describe, expect, it } from "vitest";
import { forViewer } from "../src/realtime";

describe("forViewer", () => {
  it("drops which tracker sends events (admins only) and keeps the rest", () => {
    const snap = { version: "7", visitors5m: 3, plausibleLastAt: 100, qwaLastAt: 200 };
    expect(forViewer(snap)).toEqual({ version: "7", visitors5m: 3 });
  });
});
