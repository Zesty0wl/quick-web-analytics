import { describe, expect, it } from "vitest";
import { parquetReadObjects } from "hyparquet";
import { ByteWriter, ParquetWriter } from "hyparquet-writer";
import { parseVitals } from "../src/ingest/qwa";
import { parseQwaPayload } from "../src/ingest/qwa";
import { TableWriter, emptyColumns } from "../src/storage/parquet";
import { memoryBuffer, mergeTable } from "../src/storage/compact";

describe("parseVitals", () => {
  it("maps the tracker's short keys and rounds", () => {
    expect(parseVitals(123, { i: 212.6, it: "nav > button.menu", ty: "click", d: 40, p: 150, r: 22, l: 1234, le: "img.hero (hero.jpg)", c: 0.081, t: 310, f: 800 })).toEqual({
      pv: 123, inp: 213, inp_target: "nav > button.menu", inp_type: "click", inp_delay: 40, inp_processing: 150, inp_presentation: 22,
      lcp: 1234, lcp_element: "img.hero (hero.jpg)", cls: 81, ttfb: 310, fcp: 800,
    });
  });
  it("marks CLS as not measured (-1) when the browser can't measure it, and keeps a perfect 0", () => {
    expect(parseVitals(1, { l: 900 })!.cls).toBe(-1);
    expect(parseVitals(1, { l: 900, c: 0 })!.cls).toBe(0);
  });
  it("drops junk: negative or absurd times, non-printable text, and payloads with nothing measured", () => {
    const v = parseVitals(1, { i: -5, l: 9e9, it: "a\u0000b‮", c: "x" })!;
    expect(v.inp).toBe(0);
    expect(v.lcp).toBe(120_000);
    expect(v.inp_target).toBe("ab");
    expect(parseVitals(1, {})).toBeNull();
    expect(parseVitals(1, "nope")).toBeNull();
  });
  it("is only read from engagement events", () => {
    const wv = { i: 100 };
    expect(parseQwaPayload({ s: "example.com", n: "engagement", u: "https://example.com/", sd: 10, e: 1000, pv: 5, wv }).vitals?.inp).toBe(100);
    expect(parseQwaPayload({ s: "example.com", n: "pageview", u: "https://example.com/", pv: 5, wv }).vitals).toBeNull();
  });
});

describe("compaction across the Web Vitals schema change", () => {
  // An engagement file as written before the vitals columns existed.
  function oldEngagementFile(): ArrayBuffer {
    const names: [string, "INT64" | "INT32" | "STRING"][] = [["ts", "INT64"], ["session", "INT64"], ["visitor", "INT64"], ["path", "STRING"], ["scroll_depth", "INT32"], ["engaged_ms", "INT32"]];
    const writer = new ByteWriter();
    const pq = new ParquetWriter({
      writer,
      schema: [{ name: "root", num_children: names.length }, ...names.map(([name, type]) => (type === "STRING" ? { name, type: "BYTE_ARRAY", converted_type: "UTF8", repetition_type: "REQUIRED" } : { name, type, repetition_type: "REQUIRED" }))] as never,
    });
    pq.write({
      columnData: [
        { name: "ts", data: BigInt64Array.from([1n, 2n]) },
        { name: "session", data: BigInt64Array.from([10n, 11n]) },
        { name: "visitor", data: BigInt64Array.from([20n, 21n]) },
        { name: "path", data: ["/old", "/old2"] },
        { name: "scroll_depth", data: Int32Array.from([50, 60]) },
        { name: "engaged_ms", data: Int32Array.from([1000, 2000]) },
      ] as never,
    });
    pq.finish();
    return writer.getBuffer();
  }
  function newEngagementFile(): ArrayBuffer {
    const cols = emptyColumns("engagement");
    const row: Record<string, unknown> = { ts: 3, session: 12, visitor: 22, path: "/new", scroll_depth: 70, engaged_ms: 3000, pv: 99, inp: 250, inp_target: "button.buy", inp_type: "click", inp_delay: 50, inp_processing: 150, inp_presentation: 50, lcp: 1500, lcp_element: "img.hero", cls: 20, ttfb: 300, fcp: 700 };
    for (const k of Object.keys(cols)) cols[k].push(row[k]);
    const w = new TableWriter("engagement");
    w.write(cols);
    return w.finish();
  }

  it("merges old files (no vitals columns) with new ones, filling defaults", async () => {
    const merged = await mergeTable("engagement", [{ file: memoryBuffer(oldEngagementFile()) }, { file: memoryBuffer(newEngagementFile()) }]);
    expect(merged!.rows).toBe(3);
    const r = await parquetReadObjects({ file: memoryBuffer(merged!.buffer) });
    expect(r.map((x) => x.path)).toEqual(["/old", "/old2", "/new"]);
    expect(r[0].inp).toBe(0);
    expect(r[0].inp_target).toBe("");
    expect(Number(r[0].pv)).toBe(0);
    expect(r[2].inp).toBe(250);
    expect(r[2].inp_target).toBe("button.buy");
  });
});
