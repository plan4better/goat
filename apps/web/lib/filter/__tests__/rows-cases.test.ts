// goatlib's filter row cases (`goatlib.filter.rows`, the assistant's row reader and writer): stored queries with the
// rows, match and area the panel shows for them. Here the panel's own reader and writer hold the cases to that, so the
// assistant's rows stay the panel's. Only tests read the fixture: the web build never sees packages/python. A missing
// fixture fails the file.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { type Fields, type FilterModel, isCustomRow } from "@/lib/filter/model";
import { readFilter } from "@/lib/filter/read";
import { writeFilter } from "@/lib/filter/write";

const FIXTURE = resolve(
  __dirname,
  "../../../../../packages/python/goatlib/tests/unit/filter/fixtures/filter_rows.json"
);

interface Query {
  cql?: unknown;
  ui?: unknown;
  metadata?: unknown;
}

interface RowsCase {
  name: string;
  fields: Fields;
  query: Query;
  match: FilterModel["match"];
  rows: Array<{ kind: "row" | "custom"; enabled: boolean }>;
  area: "none" | "inside" | "outside" | "off";
  /** A stored query the panel does not write in this form: what it writes for it. */
  written?: Query;
}

const cases: RowsCase[] = JSON.parse(readFileSync(FIXTURE, "utf8"));

/** The panel's rows as the fixture describes them. */
const shown = (model: FilterModel) => ({
  match: model.match,
  rows: model.rows.map((row) => ({ kind: isCustomRow(row) ? "custom" : "row", enabled: row.enabled })),
  area: !model.area ? "none" : model.area.enabled ? model.area.op : "off",
});

describe("filter_rows.json", () => {
  it("holds cases", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases.map((c) => [c.name, c] as const))(
    "reads case %s as the shared fixture says and writes it back unchanged",
    (_, c) => {
      const model = readFilter(c.query.cql, c.query.ui, c.fields);
      expect(shown(model)).toEqual({ match: c.match, rows: c.rows, area: c.area });
      // `writeFilter` gives the CQL and the notes; the save adds the stored `metadata` as it was (`apply` in
      // hooks/map/useLayerFilter.ts), so it is not compared here.
      const { cql, ui } = c.written ?? c.query;
      expect(JSON.parse(JSON.stringify(writeFilter(model, c.fields)))).toEqual(
        JSON.parse(JSON.stringify({ cql, ui }))
      );
    }
  );
});
