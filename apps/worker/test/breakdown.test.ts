import { describe, expect, it } from "vitest";
import { joinRows } from "../src/breakdown";

describe("joinRows", () => {
  it("puts each key's comparison value beside it, zero when it's new", () => {
    const cur = { rows: [{ event: "Signup", events: 40, visitors: 30 }, { event: "Download", events: 5, visitors: 5 }], meta: {} as never };
    const prev = { rows: [{ event: "Signup", events: 10 }], meta: {} as never };
    expect(joinRows(3, "event", ["events", "visitors"], cur, prev)).toEqual([
      { site: 3, key: "Signup", values: { events: 40, visitors: 30 }, previous: 10 },
      { site: 3, key: "Download", values: { events: 5, visitors: 5 }, previous: 0 },
    ]);
  });
});
