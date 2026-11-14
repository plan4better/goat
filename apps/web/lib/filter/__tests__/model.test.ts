import { describe, expect, it } from "vitest";

import { type FilterModel, type FilterRow, removeRow, upsertRow } from "@/lib/filter/model";

const row = (partial: Partial<FilterRow>): FilterRow => ({
  id: "e1",
  field: "status",
  op: "is",
  enabled: true,
  ...partial,
});

describe("upsertRow and removeRow", () => {
  const model: FilterModel = {
    match: "any",
    rows: [row({ id: "r0", value: "a" }), { id: "r1", cql: { op: "s_intersects" }, enabled: true }],
  };

  it("replaces a row by its id, keeping its place and whether it is on", () => {
    const next = upsertRow(
      { ...model, rows: [row({ id: "r0", enabled: false }), model.rows[1]] },
      row({ id: "r0", value: "b" })
    );
    expect(next.rows[0]).toEqual(row({ id: "r0", value: "b", enabled: false }));
    expect(next.rows[1]).toBe(model.rows[1]);
    expect(next.match).toBe("any");
  });

  it("appends a row with an unknown id and removes one by its id", () => {
    expect(upsertRow(model, row({ id: "new" })).rows.map((r) => r.id)).toEqual(["r0", "r1", "new"]);
    expect(removeRow(model, "r0").rows.map((r) => r.id)).toEqual(["r1"]);
  });
});
