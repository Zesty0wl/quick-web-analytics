import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parquetMetadataAsync, parquetReadObjects } from "hyparquet";
import { ROW_GROUP_SIZE } from "@qwa/shared";
import { TableWriter, emptyColumns } from "../src/storage/parquet";
import { memoryBuffer, mergeTable } from "../src/storage/compact";

const DAY = (d: string) => Date.parse(`${d}T00:00:00Z`) / 1000;

function pageviews(day: string, n: number, path = "/"): ArrayBuffer {
  const cols = emptyColumns("pageviews");
  for (let i = 0; i < n; i++) {
    cols.ts.push(DAY(day) + (i % 86_400));
    cols.session.push(1000 + i);
    cols.visitor.push(2 ** 52 + i); // large ids must survive exactly
    cols.hostname.push("example.com");
    cols.path.push(path);
    cols.props.push(i % 2 ? '{"k":"v"}' : "");
  }
  const w = new TableWriter("pageviews");
  w.write(cols);
  return w.finish();
}

async function rows(buf: ArrayBuffer) {
  return parquetReadObjects({ file: memoryBuffer(buf) });
}

describe("mergeTable", () => {
  it("merges day files in order and keeps values exact", async () => {
    const merged = await mergeTable("pageviews", [
      { file: memoryBuffer(pageviews("2026-09-01", 3)) },
      { file: memoryBuffer(pageviews("2026-09-02", 2, "/b")) },
    ]);
    expect(merged!.rows).toBe(5);
    const r = await rows(merged!.buffer);
    expect(r.map((x) => x.path)).toEqual(["/", "/", "/", "/b", "/b"]);
    expect(Number(r[0].visitor)).toBe(2 ** 52);
    expect(r[1].props).toBe('{"k":"v"}');
  });

  it("rebuilds an existing month, replacing the days supplied as day files", async () => {
    const month = await mergeTable("pageviews", [
      { file: memoryBuffer(pageviews("2026-09-01", 3)) },
      { file: memoryBuffer(pageviews("2026-09-02", 4)) },
    ]);
    // A late re-flush of 2026-09-02 with different contents.
    const rebuilt = await mergeTable("pageviews", [
      { file: memoryBuffer(month!.buffer), skip: [[DAY("2026-09-02"), DAY("2026-09-03")]] },
      { file: memoryBuffer(pageviews("2026-09-02", 1, "/late")) },
    ]);
    const r = await rows(rebuilt!.buffer);
    expect(r.length).toBe(4);
    expect(r.filter((x) => x.path === "/late").length).toBe(1);
  });

  it("streams inputs larger than one row group", async () => {
    const n = ROW_GROUP_SIZE + 1000;
    const merged = await mergeTable("pageviews", [{ file: memoryBuffer(pageviews("2026-09-03", n)) }]);
    expect(merged!.rows).toBe(n);
    const meta = await parquetMetadataAsync(memoryBuffer(merged!.buffer));
    expect(meta.row_groups.length).toBe(2);
    if (process.env.COMPACT_SAMPLE_OUT) writeFileSync(process.env.COMPACT_SAMPLE_OUT, Buffer.from(merged!.buffer));
  });

  it("returns null when every row is skipped", async () => {
    const merged = await mergeTable("pageviews", [
      { file: memoryBuffer(pageviews("2026-09-01", 2)), skip: [[DAY("2026-09-01"), DAY("2026-09-02")]] },
    ]);
    expect(merged).toBeNull();
  });
});
