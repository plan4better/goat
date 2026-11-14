import { describe, expect, it } from "vitest";

import type { Fields, FilterModel } from "@/lib/filter/model";
import { readFilter } from "@/lib/filter/read";

const FIELDS: Fields = {
  name: "string",
  traffic: "number",
  oneway: "boolean",
  opened: "date",
  seen: "datetime",
};

const p = (field: string) => ({ property: field });
const legacyEmpty = (field: string) => ({ op: "isNull", args: p(field) });

/** The single row a saved filter of one condition reads as, without its id and switch. */
const one = (node: unknown) => {
  const model = readFilter({ op: "and", args: [node] }, undefined, FIELDS);
  expect(model.rows).toHaveLength(1);
  const { id: _id, enabled: _enabled, ...row } = model.rows[0];
  return row;
};

describe("legacy shapes the old panel saved", () => {
  const cases: Array<[string, unknown, unknown]> = [
    ["!=", { op: "!=", args: [p("name"), "a"] }, { field: "name", op: "is_not", value: "a" }],
    [
      "!= with the empty value",
      { op: "or", args: [{ op: "!=", args: [p("name"), "a"] }, legacyEmpty("name")] },
      { field: "name", op: "is_not", value: "a" },
    ],
    ["isNull with a bare property", legacyEmpty("name"), { field: "name", op: "is_blank" }],
    [
      "not isNull with a bare property",
      { op: "not", args: [legacyEmpty("name")] },
      { field: "name", op: "is_not_blank" },
    ],
    [
      "includes as or of =",
      {
        op: "or",
        args: [
          { op: "=", args: [p("name"), "a"] },
          { op: "=", args: [p("name"), "b"] },
        ],
      },
      { field: "name", op: "includes", value: ["a", "b"] },
    ],
    [
      "includes of one value",
      { op: "or", args: [{ op: "=", args: [p("traffic"), 3] }] },
      { field: "traffic", op: "includes", value: [3] },
    ],
    [
      "excludes as and of != with the empty value",
      {
        op: "or",
        args: [
          {
            op: "and",
            args: [
              { op: "!=", args: [p("name"), "a"] },
              { op: "!=", args: [p("name"), "b"] },
            ],
          },
          legacyEmpty("name"),
        ],
      },
      { field: "name", op: "excludes", value: ["a", "b"] },
    ],
    [
      "excludes as and of != without it",
      { op: "and", args: [{ op: "!=", args: [p("name"), "a"] }] },
      { field: "name", op: "excludes", value: ["a"] },
    ],
    [
      "not like with the empty value",
      {
        op: "or",
        args: [{ op: "not", args: [{ op: "like", args: [p("name"), "%sch%"] }] }, legacyEmpty("name")],
      },
      { field: "name", op: "does_not_contains_the_text", value: "sch" },
    ],
    [
      "a range as and of >= and <=",
      {
        op: "and",
        args: [
          { op: ">=", args: [p("traffic"), 5] },
          { op: "<=", args: [p("traffic"), 40] },
        ],
      },
      { field: "traffic", op: "is_between", value: 5, value2: 40 },
    ],
    [
      "between with a nested pair",
      { op: "between", args: [p("traffic"), [5, 40]] },
      { field: "traffic", op: "is_between", value: 5, value2: 40 },
    ],
    [
      "between with three args",
      { op: "between", args: [p("traffic"), 5, 40] },
      { field: "traffic", op: "is_between", value: 5, value2: 40 },
    ],
    [
      "not between as or of < and > with the empty value",
      {
        op: "or",
        args: [
          { op: "<", args: [p("opened"), "2024-01-01T00:00:00"] },
          { op: ">", args: [p("opened"), "2024-03-01T00:00:00"] },
          legacyEmpty("opened"),
        ],
      },
      { field: "opened", op: "is_not_between", value: "2024-01-01T00:00:00", value2: "2024-03-01T00:00:00" },
    ],
    [
      "not between without it",
      {
        op: "or",
        args: [
          { op: "<", args: [p("traffic"), 1] },
          { op: ">", args: [p("traffic"), 9] },
        ],
      },
      { field: "traffic", op: "is_not_between", value: 1, value2: 9 },
    ],
    [
      "a date range of the old panel",
      {
        op: "and",
        args: [
          { op: ">=", args: [p("seen"), "2024-01-01T00:00:00"] },
          { op: "<=", args: [p("seen"), "2024-01-01T23:59:59"] },
        ],
      },
      { field: "seen", op: "is_between", value: "2024-01-01T00:00:00", value2: "2024-01-01T23:59:59" },
    ],
    [
      "is before as a bare date",
      { op: "<", args: [p("opened"), "2024-01-01T00:00:00"] },
      {
        field: "opened",
        op: "is_before",
        value: "2024-01-01T00:00:00",
      },
    ],
    ['= ""', { op: "=", args: [p("name"), ""] }, { field: "name", op: "is_blank" }],
    ['!= ""', { op: "!=", args: [p("name"), ""] }, { field: "name", op: "is_not_blank" }],
    ["= true", { op: "=", args: [p("oneway"), true] }, { field: "oneway", op: "is_true" }],
    [
      "like starts with",
      { op: "like", args: [p("name"), "Pri%"] },
      { field: "name", op: "starts_with", value: "Pri" },
    ],
    [
      "a number saved as text",
      { op: "=", args: [p("traffic"), "5"] },
      { field: "traffic", op: "is", value: "5" },
    ],
  ];

  it.each(cases)("%s", (_, node, row) => {
    expect(one(node)).toEqual(row);
  });
});

describe("the assistant's shapes", () => {
  it("reads a single condition without a group as one row", () => {
    const model = readFilter({ op: "<>", args: [p("name"), "a"] }, undefined, FIELDS);
    expect(model).toEqual({
      match: "all",
      rows: [{ id: "r0", field: "name", op: "is_not", value: "a", enabled: true }],
    });
  });

  it("reads typed timestamps, value lists and not isNull", () => {
    expect(one({ op: ">", args: [p("seen"), { timestamp: "2024-05-01T00:00:00+00:00" }] })).toEqual({
      field: "seen",
      op: "is_after",
      value: "2024-05-01T00:00:00+00:00",
    });
    expect(one({ op: "in", args: [p("traffic"), [1, 2]] })).toEqual({
      field: "traffic",
      op: "includes",
      value: [1, 2],
    });
    expect(one({ op: "not", args: [{ op: "isNull", args: [p("name")] }] })).toEqual({
      field: "name",
      op: "is_not_blank",
    });
  });

  it("keeps a like pattern no row says as a custom row", () => {
    const node = { op: "like", args: [p("name"), "Haupt%str_"] };
    expect(readFilter({ op: "or", args: [node] }, undefined, FIELDS).rows).toEqual([
      { id: "r0", cql: node, enabled: true },
    ]);
    expect(
      readFilter({ op: "and", args: [{ op: "like", args: [p("name"), "x"] }] }, undefined, FIELDS).rows[0]
    ).toHaveProperty("cql");
  });
});

describe("what no row says", () => {
  // A point is no area: the filter's area is made of polygons (read-area.test.ts).
  const area = { op: "s_intersects", args: [p("geom"), { type: "Point", coordinates: [1, 2] }] };

  it("is a custom row holding the node as it was, in its place", () => {
    const nested = {
      op: "or",
      args: [
        { op: "=", args: [p("name"), "a"] },
        { op: "=", args: [p("traffic"), 1] },
      ],
    };
    const isOrEmpty = {
      op: "or",
      args: [
        { op: "=", args: [p("name"), "a"] },
        { op: "isNull", args: [p("name")] },
      ],
    };
    const model = readFilter(
      { op: "and", args: [area, { op: "=", args: [p("name"), "a"] }, nested, isOrEmpty] },
      undefined,
      FIELDS
    );
    expect(model.rows[0]).toEqual({ id: "r0", cql: area, enabled: true });
    expect((model.rows[0] as { cql: unknown }).cql).toBe(area);
    expect(model.rows[1]).toMatchObject({ id: "r1", field: "name", op: "is" });
    expect(model.rows[2]).toEqual({ id: "r2", cql: nested, enabled: true });
    expect(model.rows[3]).toEqual({ id: "r3", cql: isOrEmpty, enabled: true });
  });

  it("reads a top level that is not a group as one custom row", () => {
    expect(readFilter(area, undefined, FIELDS)).toEqual({
      match: "all",
      rows: [{ id: "r0", cql: area, enabled: true }],
    });
  });

  it("reads a field the layer no longer has as a row", () => {
    expect(one({ op: "=", args: [p("gone"), 5] })).toEqual({
      field: "gone",
      op: "is",
      value: 5,
      type: "number",
    });
    expect(one({ op: "<", args: [p("gone"), { date: "2024-01-01" }] })).toEqual({
      field: "gone",
      op: "is_before",
      value: "2024-01-01",
      type: "date",
    });
    expect(one({ op: "isNull", args: [p("gone")] })).toEqual({ field: "gone", op: "is_blank" });
  });

  it("never throws on garbage", () => {
    const garbage: unknown[] = [
      null,
      undefined,
      "text",
      42,
      [],
      [{ op: "=" }],
      {},
      { op: "and" },
      { op: "and", args: "x" },
      {
        op: "and",
        args: [null, 1, "a", [], {}, { op: "not" }, { op: "not", args: [] }, { op: "in", args: [p("name")] }],
      },
      {
        op: "or",
        args: [
          { op: "isNull", args: null },
          { op: "between", args: [p("traffic"), [1]] },
        ],
      },
      { op: "=", args: [{ property: 5 }, 1] },
      { op: "=", args: [p("constructor"), 1] },
      { op: "=", args: [p("__proto__"), 1] },
    ];
    for (const cql of garbage) {
      for (const ui of [
        undefined,
        null,
        "x",
        { v: 1, off: "x" },
        { v: 1, off: [null, { at: -1, cql: {} }, { at: 0 }] },
      ])
        expect(() => readFilter(cql, ui, FIELDS)).not.toThrow();
    }
    expect(readFilter(null, undefined, FIELDS)).toEqual({ match: "all", rows: [] });
    expect(readFilter({}, undefined, FIELDS)).toEqual({ match: "all", rows: [] });
    // What is no CQL at all is kept as it is: saving again does not drop it without a word.
    expect(readFilter("name = 'a'", undefined, FIELDS).rows).toEqual([
      { id: "r0", cql: "name = 'a'", enabled: true },
    ]);
  });

  it("reads a tree thousands of levels deep without overflowing the stack", () => {
    for (const op of ["and", "or", "not"]) {
      let node: unknown = { op: "=", args: [p("name"), "a"] };
      for (let i = 0; i < 5000; i++) node = { op, args: [node] };
      const model = readFilter(node, undefined, FIELDS);
      expect(model.rows.length, op).toBeLessThanOrEqual(1);
      expect(() => readFilter({ op: "and", args: [node, node] }, undefined, FIELDS)).not.toThrow();
    }
  });
});

describe("notes", () => {
  it("put switched-off rows back at their place", () => {
    const model: FilterModel = readFilter(
      {
        op: "or",
        args: [
          { op: "=", args: [p("name"), "a"] },
          { op: "=", args: [p("traffic"), 2] },
        ],
      },
      { v: 1, off: [{ at: 1, cql: { op: "=", args: [p("name"), "b"] } }] },
      FIELDS
    );
    expect(model.match).toBe("any");
    expect(model.rows.map((row) => [row.id, row.enabled, "value" in row ? row.value : null])).toEqual([
      ["r0", true, "a"],
      ["r1", false, "b"],
      ["r2", true, 2],
    ]);
  });

  it("ignore a position past the end and a block of another version", () => {
    const cql = { op: "and", args: [{ op: "=", args: [p("name"), "a"] }] };
    const off = { op: "=", args: [p("name"), "b"] };
    expect(
      readFilter(cql, { v: 1, off: [{ at: 9, cql: off }] }, FIELDS).rows.map((row) => row.enabled)
    ).toEqual([true, false]);
    expect(readFilter(cql, { v: 2, off: [{ at: 0, cql: off }] }, FIELDS).rows).toHaveLength(1);
  });

  it("read a row written as in the last N days as that again", () => {
    const cql = {
      op: "and",
      args: [
        { op: ">=", args: [p("seen"), { timestamp: "2026-11-06T10:20:30Z" }] },
        {
          op: "or",
          args: [
            { op: "<", args: [p("opened"), { date: "2026-10-14" }] },
            { op: "isNull", args: [p("opened")] },
          ],
        },
      ],
    };
    const rows = readFilter(
      cql,
      {
        v: 1,
        relative: [
          { at: 0, days: 7 },
          { at: 1, days: 30 },
        ],
      },
      FIELDS
    ).rows;
    expect(rows).toEqual([
      { id: "r0", field: "seen", op: "in_the_last", value: 7, enabled: true },
      { id: "r1", field: "opened", op: "not_in_the_last", value: 30, enabled: true },
    ]);
    // Without the notes the frozen date has no row: a custom row, still filtering the same.
    expect(readFilter(cql, undefined, FIELDS).rows.every((row) => "cql" in row)).toBe(true);
  });
});
