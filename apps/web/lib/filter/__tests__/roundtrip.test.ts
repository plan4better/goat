// goatlib's filter cases, shared with the Python checker's tests: every saved and written shape, read into rows and
// written back. Only tests read them: the web build never sees packages/python.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { filterIssues } from "@/lib/filter/issues";
import { shapePoints } from "@/lib/filter/limits";
import { type Fields, type FilterModel, isCustomRow } from "@/lib/filter/model";
import { readFilter } from "@/lib/filter/read";
import { writeFilter } from "@/lib/filter/write";

const FIXTURE = resolve(
  __dirname,
  "../../../../../packages/python/goatlib/tests/unit/filter/fixtures/filter_cases.json"
);

interface FilterCase {
  name: string;
  fields: Fields;
  cql: unknown;
  issues: string[];
  rows?:
    | {
        match: "all" | "any";
        /** Set when the reader takes a spatial condition as the filter's area. */
        area?: "inside" | "outside";
        rows: Array<{ field: string; op: string; value?: unknown; value2?: unknown } | "custom">;
      }
    | "custom";
  stable?: boolean;
}

const NOW = new Date("2026-11-13T00:00:00Z");

const cases: FilterCase[] = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, "utf8")) : [];

/** The rows as the fixture states them: no ids, switches or guessed types. */
const plain = (model: FilterModel) =>
  model.rows.map((row) => {
    if (isCustomRow(row)) return "custom";
    const { id: _id, enabled: _enabled, type: _type, ...rest } = row;
    return rest;
  });

describe.skipIf(!cases.length)("filter_cases.json", () => {
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_, c) => {
    const model = readFilter(c.cql, undefined, c.fields);
    if (c.rows === "custom") {
      expect(model.rows.length).toBeGreaterThan(0);
      expect(model.rows.some(isCustomRow)).toBe(true);
    } else if (c.rows) {
      expect(model.match).toBe(c.rows.match);
      expect(plain(model)).toEqual(c.rows.rows);
      expect(model.area?.op).toBe(c.rows.area);
    }
    const written = writeFilter(model, c.fields, { now: NOW });
    // Written once, the filter reads as the same rows (a number saved as text now a number) and writes the same CQL
    // again.
    const again = readFilter(written.cql, written.ui, c.fields);
    const shape = (m: FilterModel) =>
      plain(m).map((row) => (row === "custom" ? row : `${row.field} ${row.op}`));
    expect(shape(again)).toEqual(shape(model));
    expect(again.area).toEqual(model.area);
    expect(writeFilter(again, c.fields, { now: NOW }).cql).toEqual(written.cql);
    if (c.stable) expect(written.cql).toEqual(c.cql);
  });

  // Shapes and their points are counted as goatlib counts them: the same cases are over the same limits.
  const SHAPE_CODES = ["too_many_shapes", "area_too_detailed"];
  it.each(cases.map((c) => [c.name, c] as const))("%s: shape limits", (_, c) => {
    const expected = c.issues.filter((code) => SHAPE_CODES.includes(code));
    const shapes = shapePoints(c.cql);
    const counted = [
      ...(shapes.length > 3 ? ["too_many_shapes"] : []),
      ...shapes.filter((points) => points > 2000).map(() => "area_too_detailed"),
    ];
    expect(counted).toEqual(expected);
    const panel = filterIssues(readFilter(c.cql, undefined, c.fields), c.fields).filter.map((i) => i.code);
    expect(panel.filter((code) => SHAPE_CODES.includes(code))).toEqual([...new Set(expected)]);
  });
});

it.skipIf(cases.length > 0)("filter_cases.json is not there yet: the shared cases are skipped", () => {
  expect(existsSync(FIXTURE)).toBe(false);
});
