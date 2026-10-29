/**
 * A query's Arrow table as plain row objects, built column by column. Arrow's
 * own way, a proxy per row turned into an object (`row.toJSON()`), costs a
 * few microseconds a row on the main thread: on the largest feeds a list
 * query of ten thousand rows is a long task by itself.
 *
 * Numbers in columns without nulls come from the column's typed array in one
 * go; any other column is read by its iterator, a chunk at a time (`get(i)`
 * searches for the chunk of every row), giving what `toJSON` gives: nulls,
 * strings, lists and dates come out exactly as before.
 */
import { DataType, type Table } from "apache-arrow";

export function rowsOf<T = Record<string, unknown>>(table: Table): T[] {
  const n = table.numRows;
  const columns = table.schema.fields.map((field, i) => {
    const vector = table.getChildAt(i);
    // Bools are bit-packed and 64-bit integers BigInts: neither reads as
    // numbers from the typed array.
    const plain =
      !!vector &&
      vector.nullCount === 0 &&
      (DataType.isFloat(field.type) || (DataType.isInt(field.type) && field.type.bitWidth <= 32));
    const values: ArrayLike<unknown> = !vector
      ? []
      : plain
        ? (vector.toArray() as ArrayLike<number>)
        : Array.from(vector as Iterable<unknown>);
    return { name: field.name, values };
  });
  const rows: Record<string, unknown>[] = new Array(n);
  for (let r = 0; r < n; r++) {
    const row: Record<string, unknown> = {};
    for (const c of columns) row[c.name] = c.values[r] ?? null;
    rows[r] = row;
  }
  return rows as T[];
}
