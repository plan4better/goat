// goatlib's conversion cases (`goatlib.filter.convert`, run once by core's data migration on every stored filter):
// the rows saved before that the panel would write otherwise, converted to what the panel writes for them. Here the
// panel's own reader and writer hold the converted side to that. Only tests read the fixture: the web build never sees
// packages/python.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { type Fields, type FilterModel, isCustomRow } from "@/lib/filter/model";
import { readFilter } from "@/lib/filter/read";
import { cqlToRow, rowToCql } from "@/lib/filter/rows";
import { writeFilter } from "@/lib/filter/write";
import { type JsonObject, isObject } from "@/lib/style/json";

const FIXTURE = resolve(
  __dirname,
  "../../../../../packages/python/goatlib/tests/unit/filter/fixtures/filter_conversions.json"
);

interface Query {
  cql?: unknown;
  ui?: unknown;
  metadata?: unknown;
}

interface ConversionCase {
  name: string;
  fields: Fields;
  stored: Query;
  converted: Query;
  /** The rows converted: a JSON pointer into the query and the operator the panel reads there. `/ui/any` with the
   * operator `any` is the "match any" note dropped beside an area, as the panel drops it when it saves. */
  changed: Array<{ path: string; op: string }>;
  /** What the panel saves from `stored`. */
  written: { cql?: unknown; ui?: unknown };
}

const cases: ConversionCase[] = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, "utf8")) : [];

const keys = (path: string) => path.split("/").slice(1);

const at = (root: unknown, path: string): unknown =>
  keys(path).reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], root);

/** `root` with the node at `path` replaced (a copy). */
function put(root: unknown, path: string, value: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(root));
  const parts = keys(path);
  const parent = parts.slice(0, -1).reduce<Record<string, unknown>>((node, key) => node[key] as never, copy);
  parent[parts[parts.length - 1]] = value;
  return copy;
}

/** The rows as the panel lists them: field and operator, or custom; values are compared through the writer. */
const words = (model: FilterModel) => ({
  match: model.match,
  area: model.area?.op,
  rows: model.rows.map((row) => (isCustomRow(row) ? "custom" : `${row.field} ${row.op} ${row.enabled}`)),
});

const read = (q: Query, fields: Fields) => readFilter(q.cql, q.ui, fields);

describe.skipIf(!cases.length)("filter_conversions.json", () => {
  it.each(cases.map((c) => [c.name, c] as const))("%s: reads as the same rows", (_, c) => {
    expect(words(read(c.converted, c.fields))).toEqual(words(read(c.stored, c.fields)));
  });

  it.each(cases.map((c) => [c.name, c] as const))(
    "%s: a converted row is what the panel writes for it",
    (_, c) => {
      for (const { path, op } of c.changed.filter((change) => change.op !== "any")) {
        const row = cqlToRow(at(c.stored, path), c.fields);
        expect(row?.op).toBe(op);
        if (!row) continue;
        const type = Object.prototype.hasOwnProperty.call(c.fields, row.field)
          ? c.fields[row.field]
          : row.type;
        // A top level that is one row is saved under `and`, as the panel saves its rows.
        const converted = at(c.converted, path) as JsonObject;
        const node = path === "/cql" && isObject(converted) ? (converted.args as unknown[])[0] : converted;
        expect(node).toEqual(rowToCql(row, type, { orEmpty: true }));
        expect(cqlToRow(node, c.fields)?.op).toBe(op);
      }
    }
  );

  it.each(cases.map((c) => [c.name, c] as const))("%s: everything else stays as saved", (_, c) => {
    const restored = c.changed.reduce<unknown>(
      (query, { path }) => put(query, path, at(c.stored, path)),
      c.converted
    );
    expect(restored).toEqual(c.stored);
  });

  it.each(cases.map((c) => [c.name, c] as const))("%s: the next save is the same from either", (_, c) => {
    const fromStored = writeFilter(read(c.stored, c.fields), c.fields);
    expect(writeFilter(read(c.converted, c.fields), c.fields)).toEqual(fromStored);
    expect(JSON.parse(JSON.stringify(fromStored))).toEqual(c.written);
  });
});

it.skipIf(cases.length > 0)(
  "filter_conversions.json is not there yet: the conversion cases are skipped",
  () => {
    expect(existsSync(FIXTURE)).toBe(false);
  }
);
