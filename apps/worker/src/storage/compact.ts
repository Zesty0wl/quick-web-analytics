// Merge Parquet files of one table into a single file, one row group at a time (bounded memory).
import { parquetMetadataAsync, parquetRead, type AsyncBuffer } from "hyparquet";
import { COLUMNS, TIME_COLUMN, type TableName } from "@qwa/shared";
import { TableWriter } from "./parquet";

export interface MergeSource {
  file: AsyncBuffer;
  /** Drop rows whose time column falls in any of these [start, end) ranges (unix seconds). */
  skip?: [number, number][];
}

type Cols = Record<string, unknown[]>;

export async function mergeTable(table: TableName, sources: MergeSource[]): Promise<{ buffer: ArrayBuffer; rows: number } | null> {
  const names = COLUMNS[table].map(([c]) => c);
  const timeCol = TIME_COLUMN[table];
  const writer = new TableWriter(table);

  for (const src of sources) {
    const metadata = await parquetMetadataAsync(src.file);
    // Older files may lack columns added since (e.g. Web Vitals): read what's there and fill the rest with defaults.
    const present = new Set(metadata.schema.map((el) => el.name));
    const readable = names.filter((n) => present.has(n));
    const types = Object.fromEntries(COLUMNS[table]);
    let rowStart = 0;
    for (const rg of metadata.row_groups) {
      const rowEnd = rowStart + Number(rg.num_rows);
      const cols: Cols = {};
      await parquetRead({
        file: src.file,
        metadata,
        columns: readable,
        rowStart,
        rowEnd,
        onChunk: (c) => {
          // A chunk can extend beyond the requested range; keep only this row group's rows.
          const from = Math.max(rowStart, c.rowStart) - c.rowStart;
          const to = Math.min(rowEnd, c.rowEnd) - c.rowStart;
          const target = (cols[c.columnName] ??= []);
          const data = c.columnData as ArrayLike<unknown>;
          for (let i = from; i < to; i++) target.push(data[i]);
        },
      });
      for (const n of names) {
        if (!present.has(n)) cols[n] = new Array(rowEnd - rowStart).fill(types[n] === "STRING" ? "" : 0);
        cols[n] ??= [];
      }

      if (src.skip?.length) {
        const t = cols[timeCol];
        const keep: number[] = [];
        for (let i = 0; i < t.length; i++) {
          const ts = Number(t[i]);
          if (!src.skip.some(([s, e]) => ts >= s && ts < e)) keep.push(i);
        }
        if (keep.length !== t.length) for (const n of names) cols[n] = keep.map((i) => cols[n][i]);
      }
      writer.write(cols);
      rowStart = rowEnd;
    }
  }
  return writer.rows > 0 ? { buffer: writer.finish(), rows: writer.rows } : null;
}

/** AsyncBuffer over an in-memory ArrayBuffer. */
export function memoryBuffer(buf: ArrayBuffer): AsyncBuffer {
  return { byteLength: buf.byteLength, slice: (s, e) => buf.slice(s, e) };
}

/** AsyncBuffer over an R2 object, reading only the byte ranges the parser asks for. */
export function r2Buffer(bucket: R2Bucket, key: string, size: number): AsyncBuffer {
  return {
    byteLength: size,
    async slice(start: number, end?: number) {
      const obj = await bucket.get(key, { range: { offset: start, length: (end ?? size) - start } });
      if (!obj) throw new Error(`missing ${key}`);
      return obj.arrayBuffer();
    },
  };
}
