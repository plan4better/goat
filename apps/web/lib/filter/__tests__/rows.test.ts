import { describe, expect, it } from "vitest";

import type { Fields, FilterCondition } from "@/lib/filter/model";
import { cqlToRow, operatorsFor, rowToCql, takesValue } from "@/lib/filter/rows";

const FIELDS: Fields = {
  name: "string",
  traffic: "number",
  pupils: "integer",
  oneway: "boolean",
  opened: "date",
  seen: "datetime",
};

const p = (field: string) => ({ property: field });
const empty = (field: string) => ({ op: "isNull", args: [p(field)] });
const write = (row: FilterCondition) => rowToCql(row, FIELDS[row.field], { orEmpty: true });

describe("one row as the filter writes it", () => {
  const cases: Array<[FilterCondition, unknown]> = [
    [
      { field: "name", op: "is", value: "a" },
      { op: "=", args: [p("name"), "a"] },
    ],
    [
      { field: "name", op: "is_not", value: "a" },
      { op: "or", args: [{ op: "<>", args: [p("name"), "a"] }, empty("name")] },
    ],
    [
      { field: "name", op: "includes", value: ["a", "b"] },
      { op: "in", args: [p("name"), ["a", "b"]] },
    ],
    [
      { field: "name", op: "excludes", value: ["a"] },
      { op: "or", args: [{ op: "not", args: [{ op: "in", args: [p("name"), ["a"]] }] }, empty("name")] },
    ],
    [
      { field: "name", op: "contains_the_text", value: "sch" },
      { op: "like", args: [p("name"), "%sch%"] },
    ],
    [
      { field: "name", op: "does_not_contains_the_text", value: "sch" },
      { op: "or", args: [{ op: "not", args: [{ op: "like", args: [p("name"), "%sch%"] }] }, empty("name")] },
    ],
    [
      { field: "name", op: "starts_with", value: "Pri" },
      { op: "like", args: [p("name"), "Pri%"] },
    ],
    [
      { field: "name", op: "ends_with", value: "ule" },
      { op: "like", args: [p("name"), "%ule"] },
    ],
    [
      { field: "name", op: "is_blank" },
      { op: "or", args: [empty("name"), { op: "=", args: [p("name"), ""] }] },
    ],
    [
      { field: "name", op: "is_not_blank" },
      {
        op: "and",
        args: [
          { op: "not", args: [empty("name")] },
          { op: "<>", args: [p("name"), ""] },
        ],
      },
    ],
    [
      { field: "traffic", op: "is", value: 5 },
      { op: "=", args: [p("traffic"), 5] },
    ],
    [
      { field: "traffic", op: "is_not", value: 5 },
      { op: "or", args: [{ op: "<>", args: [p("traffic"), 5] }, empty("traffic")] },
    ],
    [
      { field: "traffic", op: "includes", value: [1, 2] },
      { op: "in", args: [p("traffic"), [1, 2]] },
    ],
    [
      { field: "traffic", op: "excludes", value: [1] },
      { op: "or", args: [{ op: "not", args: [{ op: "in", args: [p("traffic"), [1]] }] }, empty("traffic")] },
    ],
    [
      { field: "traffic", op: "is_not_between", value: 1, value2: 9 },
      {
        op: "or",
        args: [{ op: "<", args: [p("traffic"), 1] }, { op: ">", args: [p("traffic"), 9] }, empty("traffic")],
      },
    ],
    [{ field: "oneway", op: "is_blank" }, empty("oneway")],
    [
      { field: "oneway", op: "is_not_blank" },
      { op: "not", args: [empty("oneway")] },
    ],
    [{ field: "opened", op: "is_blank" }, empty("opened")],
    [
      { field: "opened", op: "is_not_blank" },
      { op: "not", args: [empty("opened")] },
    ],
    [{ field: "seen", op: "is_blank" }, empty("seen")],
    [
      { field: "seen", op: "is_not_blank" },
      { op: "not", args: [empty("seen")] },
    ],
    [
      { field: "opened", op: "is_after", value: "2024-01-01" },
      { op: ">", args: [p("opened"), { date: "2024-01-01" }] },
    ],
    [
      { field: "opened", op: "not_in_the_last", value: 30 },
      { op: "or", args: [{ op: "<", args: [p("opened"), { op: "daysAgo", args: [30] }] }, empty("opened")] },
    ],
    [
      { field: "seen", op: "is_before", value: "2024-01-01T08:00:00Z" },
      { op: "<", args: [p("seen"), { timestamp: "2024-01-01T08:00:00Z" }] },
    ],
    [
      { field: "seen", op: "is_between", value: "2024-01-01", value2: "2024-02-01T12:00:00Z" },
      {
        op: "between",
        args: [p("seen"), { timestamp: "2024-01-01T00:00:00Z" }, { timestamp: "2024-02-01T12:00:00Z" }],
      },
    ],
    [
      { field: "seen", op: "is_not_between", value: "2024-01-01", value2: "2024-02-01" },
      {
        op: "or",
        args: [
          { op: "<", args: [p("seen"), { timestamp: "2024-01-01T00:00:00Z" }] },
          { op: ">", args: [p("seen"), { timestamp: "2024-02-01T00:00:00Z" }] },
          empty("seen"),
        ],
      },
    ],
    [
      { field: "traffic", op: "is_less_than", value: 5 },
      { op: "<", args: [p("traffic"), 5] },
    ],
    [
      { field: "traffic", op: "is_greater_than", value: 5 },
      { op: ">", args: [p("traffic"), 5] },
    ],
    [
      { field: "traffic", op: "is_at_most", value: 5 },
      { op: "<=", args: [p("traffic"), 5] },
    ],
    [
      { field: "traffic", op: "is_at_least", value: 5 },
      { op: ">=", args: [p("traffic"), 5] },
    ],
    [
      { field: "traffic", op: "is_between", value: 1, value2: 9 },
      { op: "between", args: [p("traffic"), 1, 9] },
    ],
    [
      { field: "pupils", op: "is_not_between", value: 1, value2: 9 },
      {
        op: "or",
        args: [{ op: "<", args: [p("pupils"), 1] }, { op: ">", args: [p("pupils"), 9] }, empty("pupils")],
      },
    ],
    [{ field: "traffic", op: "is_blank" }, empty("traffic")],
    [
      { field: "traffic", op: "is_not_blank" },
      { op: "not", args: [empty("traffic")] },
    ],
    [
      { field: "oneway", op: "is_true" },
      { op: "=", args: [p("oneway"), true] },
    ],
    [
      { field: "oneway", op: "is_false" },
      { op: "=", args: [p("oneway"), false] },
    ],
    [
      { field: "opened", op: "is_on", value: "2024-01-31" },
      { op: "=", args: [p("opened"), { date: "2024-01-31" }] },
    ],
    [
      { field: "opened", op: "is_not_on", value: "2024-01-31" },
      { op: "or", args: [{ op: "<>", args: [p("opened"), { date: "2024-01-31" }] }, empty("opened")] },
    ],
    [
      { field: "seen", op: "is_on", value: "2024-01-31" },
      {
        op: "and",
        args: [
          { op: ">=", args: [p("seen"), { timestamp: "2024-01-31T00:00:00Z" }] },
          { op: "<", args: [p("seen"), { timestamp: "2024-02-01T00:00:00Z" }] },
        ],
      },
    ],
    [
      { field: "seen", op: "is_not_on", value: "2024-12-31" },
      {
        op: "or",
        args: [
          { op: "<", args: [p("seen"), { timestamp: "2024-12-31T00:00:00Z" }] },
          { op: ">=", args: [p("seen"), { timestamp: "2025-01-01T00:00:00Z" }] },
          empty("seen"),
        ],
      },
    ],
    [
      { field: "opened", op: "is_before", value: "2024-01-01" },
      { op: "<", args: [p("opened"), { date: "2024-01-01" }] },
    ],
    [
      { field: "seen", op: "is_after", value: "2024-01-01" },
      { op: ">", args: [p("seen"), { timestamp: "2024-01-01T00:00:00Z" }] },
    ],
    [
      { field: "seen", op: "is_after", value: "2024-01-01T10:30:00Z" },
      { op: ">", args: [p("seen"), { timestamp: "2024-01-01T10:30:00Z" }] },
    ],
    [
      { field: "opened", op: "is_between", value: "2024-01-01", value2: "2024-02-01" },
      { op: "between", args: [p("opened"), { date: "2024-01-01" }, { date: "2024-02-01" }] },
    ],
    [
      { field: "opened", op: "is_not_between", value: "2024-01-01", value2: "2024-02-01" },
      {
        op: "or",
        args: [
          { op: "<", args: [p("opened"), { date: "2024-01-01" }] },
          { op: ">", args: [p("opened"), { date: "2024-02-01" }] },
          empty("opened"),
        ],
      },
    ],
    // The number of days, not a date: whoever reads the filter counts them back from its own today.
    [
      { field: "seen", op: "in_the_last", value: 7 },
      { op: ">=", args: [p("seen"), { op: "daysAgo", args: [7] }] },
    ],
    [
      { field: "opened", op: "in_the_last", value: 7 },
      { op: ">=", args: [p("opened"), { op: "daysAgo", args: [7] }] },
    ],
    [
      { field: "seen", op: "not_in_the_last", value: 30 },
      { op: "or", args: [{ op: "<", args: [p("seen"), { op: "daysAgo", args: [30] }] }, empty("seen")] },
    ],
  ];

  it.each(cases.map(([row, cql]) => [`${row.field} ${row.op}`, row, cql]))("%s", (_, row, cql) => {
    expect(write(row as FilterCondition)).toEqual(cql);
  });

  it("reads every written row back as the same row", () => {
    for (const [row] of cases) {
      expect(cqlToRow(write(row), FIELDS), JSON.stringify(row)).toEqual(row);
    }
  });

  it("reads a relative day only where a row says it", () => {
    const last = (field: string, days: unknown) => ({
      op: ">=",
      args: [p(field), { op: "daysAgo", args: [days] }],
    });
    // Without the empty value, "before the day" is no row: not in the last N days keeps the features without one.
    expect(cqlToRow({ op: "<", args: [p("seen"), { op: "daysAgo", args: [7] }] }, FIELDS)).toBeNull();
    expect(cqlToRow(last("name", 7), FIELDS)).toBeNull();
    expect(cqlToRow(last("seen", 0), FIELDS)).toBeNull();
    expect(cqlToRow(last("seen", "7"), FIELDS)).toBeNull();
    for (const call of [
      { op: "daysAgo", args: [7, 1] },
      { op: "daysAgo", args: 7 },
      { op: "daysAgo", args: [7], unit: "weeks" },
    ])
      expect(cqlToRow({ op: ">=", args: [p("seen"), call] }, FIELDS), JSON.stringify(call)).toBeNull();
    expect(cqlToRow({ op: "<=", args: [p("seen"), { op: "daysAgo", args: [7] }] }, FIELDS)).toBeNull();
    // A field the layer no longer has.
    expect(cqlToRow(last("old", 7), FIELDS)).toEqual({
      field: "old",
      op: "in_the_last",
      value: 7,
      type: "date",
    });
  });

  it("covers every operator the table offers for every field type", () => {
    const covered = new Set(cases.map(([row]) => `${FIELDS[row.field]}:${row.op}`));
    const missing = Object.keys(FIELDS)
      .flatMap((field) => {
        const type = FIELDS[field];
        return operatorsFor(type).map((op) => `${type}:${op}`);
      })
      .filter((key) => !covered.has(key));
    // integer shares the number writer; the ones left are checked through number.
    expect(missing.filter((key) => !key.startsWith("integer:"))).toEqual([]);
  });

  it("writes nothing for an unfinished row", () => {
    expect(write({ field: "", op: "is", value: "a" })).toBeNull();
    expect(write({ field: "name", op: "is" })).toBeNull();
    expect(write({ field: "name", op: "is", value: "" })).toBeNull();
    expect(write({ field: "traffic", op: "is", value: " " })).toBeNull();
    expect(write({ field: "traffic", op: "is_between", value: 1 })).toBeNull();
    expect(write({ field: "name", op: "includes", value: [] })).toBeNull();
    expect(write({ field: "seen", op: "in_the_last", value: 0 })).toBeNull();
    expect(write({ field: "seen", op: "is_on", value: "soon" })).toBeNull();
  });

  it("writes a value of another type as it is, for the checker to name, instead of leaving the row out", () => {
    expect(write({ field: "traffic", op: "is", value: "abc" })).toEqual({
      op: "=",
      args: [p("traffic"), "abc"],
    });
    expect(cqlToRow(write({ field: "traffic", op: "is", value: "abc" }), FIELDS)).toEqual({
      field: "traffic",
      op: "is",
      value: "abc",
    });
    expect(write({ field: "name", op: "includes", value: ["a", 3] })).toEqual({
      op: "in",
      args: [p("name"), ["a", 3]],
    });
  });

  it("writes no wildcard: % or _ in a text gives no CQL", () => {
    for (const op of [
      "contains_the_text",
      "does_not_contains_the_text",
      "starts_with",
      "ends_with",
    ] as const) {
      expect(write({ field: "name", op, value: "a%b" }), op).toBeNull();
      expect(write({ field: "name", op, value: "a_b" }), op).toBeNull();
    }
  });

  it("types a number field's value as a number", () => {
    expect(write({ field: "pupils", op: "includes", value: "1, 2" })).toEqual({
      op: "in",
      args: [p("pupils"), [1, 2]],
    });
  });

  it("writes a removed field's row with the value as it was read", () => {
    const gone = (row: FilterCondition) => rowToCql(row, row.type, { orEmpty: true });
    expect(gone({ field: "old", op: "is", value: 5 })).toEqual({ op: "=", args: [p("old"), 5] });
    expect(gone({ field: "old", op: "is_before", value: "2024-01-01", type: "date" })).toEqual({
      op: "<",
      args: [p("old"), { date: "2024-01-01" }],
    });
  });
});

describe("operators", () => {
  it("come from goatlib's table", () => {
    expect(operatorsFor("boolean")).toEqual(["is_true", "is_false", "is_blank", "is_not_blank"]);
    expect(operatorsFor("date")).toContain("in_the_last");
    expect(operatorsFor("date")).not.toContain("is");
    expect(operatorsFor(undefined)).toEqual(["is", "is_not", "is_blank", "is_not_blank"]);
  });

  it("say which take a value", () => {
    expect(takesValue("is_blank")).toBe(false);
    expect(takesValue("is_true")).toBe(false);
    expect(takesValue("in_the_last")).toBe(true);
  });

  it("an operator the field type does not offer reads as no row", () => {
    expect(cqlToRow({ op: "like", args: [p("traffic"), "%5%"] }, FIELDS)).toBeNull();
    expect(cqlToRow({ op: ">=", args: [p("opened"), { date: "2024-01-01" }] }, FIELDS)).toBeNull();
  });
});

describe("the style's spelling (orEmpty: false)", () => {
  const style = (row: FilterCondition) => rowToCql(row, FIELDS[row.field], { orEmpty: false });

  it("stays as it was", () => {
    expect(style({ field: "name", op: "is_not", value: "a" })).toEqual({ op: "<>", args: [p("name"), "a"] });
    expect(style({ field: "name", op: "is_blank" })).toEqual(empty("name"));
    expect(style({ field: "traffic", op: "is_between", value: 1, value2: 2 })).toEqual({
      op: "and",
      args: [
        { op: ">=", args: [p("traffic"), 1] },
        { op: "<=", args: [p("traffic"), 2] },
      ],
    });
    expect(style({ field: "opened", op: "is_before", value: "2020-01-01" })).toEqual({
      op: "<",
      args: [p("opened"), "2020-01-01"],
    });
    expect(
      cqlToRow({ op: ">", args: [p("opened"), { date: "2020-01-01" }] }, FIELDS, { orEmpty: false })
    ).toBeNull();
    expect(cqlToRow({ op: "!=", args: [p("name"), "a"] }, FIELDS, { orEmpty: false })).toBeNull();
  });
});

describe("a comparison with empty text", () => {
  it("on a field the layer no longer has stays a test for empty text too", () => {
    const row = cqlToRow({ op: "=", args: [p("gone"), ""] }, FIELDS);
    expect(row).toEqual({ field: "gone", op: "is_blank", type: "string" });
    expect(rowToCql(row as FilterCondition, row?.type, { orEmpty: true })).toEqual({
      op: "or",
      args: [empty("gone"), { op: "=", args: [p("gone"), ""] }],
    });
  });

  it("on a field that is not text is kept as it is", () => {
    expect(cqlToRow({ op: "=", args: [p("traffic"), ""] }, FIELDS)).toBeNull();
    expect(cqlToRow({ op: "<>", args: [p("opened"), ""] }, FIELDS)).toBeNull();
  });
});
