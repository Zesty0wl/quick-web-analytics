import { ByteWriter, ParquetWriter } from "hyparquet-writer";
import { COLUMNS, ROW_GROUP_SIZE, type ColumnType, type TableName } from "@qwa/shared";

type Columns = Record<string, unknown[]>;

function schemaFor(table: TableName) {
  const cols = COLUMNS[table];
  return [
    { name: "root", num_children: cols.length },
    ...cols.map(([name, type]) =>
      type === "STRING"
        ? { name, type: "BYTE_ARRAY" as const, converted_type: "UTF8" as const, repetition_type: "REQUIRED" as const }
        : { name, type, repetition_type: "REQUIRED" as const },
    ),
  ];
}

function typed(values: unknown[], type: ColumnType) {
  if (type === "INT64") return BigInt64Array.from(values as number[], (v) => BigInt(Math.trunc(Number(v) || 0)));
  if (type === "INT32") return Int32Array.from(values as number[], (v) => Math.trunc(Number(v) || 0));
  return (values as unknown[]).map((v) => (v === null || v === undefined ? "" : String(v)));
}

/** Streaming writer: add batches of rows (as columns), each becomes one or more row groups. */
export class TableWriter {
  private writer = new ByteWriter();
  private pq: ParquetWriter;
  rows = 0;

  constructor(private table: TableName) {
    this.pq = new ParquetWriter({ writer: this.writer, schema: schemaFor(table) as never });
  }

  write(columns: Columns): void {
    const n = columns[COLUMNS[this.table][0][0]]?.length ?? 0;
    if (n === 0) return;
    this.pq.write({
      columnData: COLUMNS[this.table].map(([name, type]) => ({ name, data: typed(columns[name], type) as never })),
      rowGroupSize: ROW_GROUP_SIZE,
    });
    this.rows += n;
  }

  finish(): ArrayBuffer {
    this.pq.finish();
    return this.writer.getBuffer();
  }
}

export function emptyColumns(table: TableName): Columns {
  return Object.fromEntries(COLUMNS[table].map(([name]) => [name, [] as unknown[]]));
}
