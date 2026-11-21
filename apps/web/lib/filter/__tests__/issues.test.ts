import { describe, expect, it } from "vitest";

import { filterIssues, rowIssues } from "@/lib/filter/issues";
import type { Fields, FilterModel, FilterRow } from "@/lib/filter/model";

const FIELDS: Fields = {
  name: "string",
  traffic: "number",
  lanes: "integer",
  lit: "boolean",
  opened: "date",
};

const row = (partial: Partial<FilterRow>): FilterRow => ({
  id: "r0",
  field: "name",
  op: "is",
  enabled: true,
  ...partial,
});

describe("rowIssues", () => {
  it("names a field the layer does not have", () => {
    expect(rowIssues(row({ field: "gone", value: "a" }), FIELDS)).toEqual([
      { code: "unknown_field", field: "gone" },
    ]);
  });

  it("takes a field whose name differs only in case, as the server does", () => {
    expect(rowIssues(row({ field: "Name", value: "a" }), FIELDS)).toEqual([]);
  });

  it("names a value that does not fit the field's type", () => {
    expect(rowIssues(row({ field: "traffic", value: "lots" }), FIELDS)).toEqual([
      { code: "field_type_mismatch", field: "traffic", type: "number" },
    ]);
    expect(rowIssues(row({ field: "name", value: 5 }), FIELDS)).toEqual([
      { code: "field_type_mismatch", field: "name", type: "string" },
    ]);
    expect(rowIssues(row({ field: "lanes", op: "includes", value: [1, "x"] }), FIELDS)).toEqual([
      { code: "field_type_mismatch", field: "lanes", type: "integer" },
    ]);
  });

  it("takes numeric text on a number field and leaves unfinished rows alone", () => {
    expect(rowIssues(row({ field: "traffic", value: "12.5" }), FIELDS)).toEqual([]);
    expect(rowIssues(row({ field: "traffic", op: "is_between", value: 1 }), FIELDS)).toEqual([]);
    expect(rowIssues(row({ field: "", value: undefined }), FIELDS)).toEqual([]);
    expect(rowIssues(row({ field: "opened", op: "in_the_last", value: 7 }), FIELDS)).toEqual([]);
    expect(rowIssues(row({ field: "lit", op: "is_true" }), FIELDS)).toEqual([]);
  });

  it("names a value list over the limit", () => {
    const values = Array.from({ length: 101 }, (_, i) => `v${i}`);
    expect(rowIssues(row({ op: "includes", value: values }), FIELDS)).toEqual([
      { code: "too_many_values", limit: 100 },
    ]);
  });
});

describe("filterIssues", () => {
  it("keys row issues by row id and names a filter over the condition limit", () => {
    const rows: FilterModel["rows"] = Array.from({ length: 21 }, (_, i) =>
      row({ id: `r${i}`, value: `v${i}` })
    );
    rows[3] = row({ id: "r3", field: "gone", value: "a" });
    const issues = filterIssues({ match: "all", rows }, FIELDS);
    expect(issues.rows).toEqual({ r3: [{ code: "unknown_field", field: "gone" }] });
    expect(issues.filter).toEqual([{ code: "too_many_conditions", limit: 20 }]);
  });

  it("leaves custom rows alone", () => {
    const custom = { id: "r0", cql: { op: "s_intersects", args: [] }, enabled: true };
    expect(filterIssues({ match: "all", rows: [custom] }, FIELDS)).toEqual({ rows: {}, filter: [] });
  });
});

describe("filterIssues: the length of the filter", () => {
  it("names a filter too long for a map request, though within the other limits", () => {
    const names = (c: string) => Array.from({ length: 100 }, (_, i) => `Grundstück am Marktplatz ${c} ${i}`);
    const rows = [..."ABCDEFGHIJKLMNO"].map((c, i) => row({ id: `r${i}`, op: "includes", value: names(c) }));
    const model: FilterModel = { match: "all", rows };
    expect(filterIssues(model, FIELDS).filter).toEqual([{ code: "too_long", limit: 60000 }]);
    expect(filterIssues({ match: "all", rows: rows.slice(0, 3) }, FIELDS).filter).toEqual([]);
  });
});
