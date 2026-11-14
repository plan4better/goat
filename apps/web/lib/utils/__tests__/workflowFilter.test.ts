import { describe, expect, it } from "vitest";

import type { Fields, FilterModel, FilterRow } from "@/lib/filter/model";
import { writeFilter } from "@/lib/filter/write";
import {
  type NodeFilter,
  inheritedNodeFilter,
  nodeFilterCql,
  nodeFilterFrom,
  nodeFilterModel,
  nodeHasFilter,
} from "@/lib/utils/workflowFilter";

const FIELDS: Fields = { name: "string", lanes: "integer", lit: "boolean", built: "date" };
const p = (field: string) => ({ property: field });

const AREA_VALUE = JSON.stringify({
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ],
  ],
  properties: { type: "boundary", label: "Bonn" },
});

// A dataset step's filter as the old panel and the assistant stored it.
const STORED = {
  op: "and",
  expressions: [
    { id: "a", type: "logical", attribute: "name", expression: "is", value: "Main" },
    { id: "b", type: "logical", attribute: "lanes", expression: "includes", value: [1, 2] },
    { id: "c", type: "logical", attribute: "lanes", expression: "is_between", value: "2-4" },
    { id: "d", type: "logical", attribute: "lit", expression: "is", value: true, note: "kept" },
    {
      id: "e",
      type: "spatial",
      attribute: "geom",
      expression: "s_intersects",
      value: AREA_VALUE,
      metadata: { intersection: { label: "Bonn" } },
    },
    { id: "f", type: "logical", attribute: "name", expression: "is_empty_string", value: "" },
  ],
};

/** What the step stores, in the expressions shape these tests write. */
const storedFrom = (...args: Parameters<typeof nodeFilterFrom>) =>
  nodeFilterFrom(...args) as NodeFilter | undefined;

const rowOf = (model: FilterModel, id: string) => model.rows.find((row) => row.id === id) as FilterRow;

describe("nodeFilterModel", () => {
  it("reads the stored rows by their ids, matched as stored", () => {
    const model = nodeFilterModel(STORED, FIELDS);
    expect(model.match).toBe("all");
    expect(model.rows.map((row) => row.id)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(rowOf(model, "a")).toEqual({ id: "a", field: "name", op: "is", value: "Main", enabled: true });
    expect(rowOf(model, "b")).toMatchObject({ op: "includes", value: [1, 2] });
    // The range saved as text before.
    expect(rowOf(model, "c")).toMatchObject({ op: "is_between", value: 2, value2: 4 });
    expect(rowOf(model, "d")).toMatchObject({ field: "lit", op: "is_true" });
  });

  it("keeps an area and a row no condition says as custom rows with the CQL they filter by", () => {
    const model = nodeFilterModel(STORED, FIELDS);
    expect(model.rows[4]).toEqual({
      id: "e",
      cql: { op: "s_intersects", args: [p("geom"), JSON.parse(AREA_VALUE)] },
      enabled: true,
    });
    expect(model.rows[5]).toEqual({ id: "f", cql: { op: "=", args: [p("name"), ""] }, enabled: true });
  });

  it("keeps a row whose operator the field does not offer as a custom row", () => {
    const stored = {
      op: "or",
      expressions: [{ id: "a", type: "logical", attribute: "name", expression: "is_at_least", value: 3 }],
    };
    const model = nodeFilterModel(stored, FIELDS);
    expect(model.match).toBe("any");
    expect(model.rows[0]).toMatchObject({ id: "a", enabled: true });
    expect("cql" in model.rows[0]).toBe(true);
  });

  it("reads a moment the old panel stored without its zone mark as the filter's rows hold it", () => {
    const stored = (attribute: string, value: string) => ({
      op: "and",
      expressions: [{ id: "a", type: "logical", attribute, expression: "is_before", value }],
    });
    const fields: Fields = { ...FIELDS, seen: "datetime" };
    const valueOf = (attribute: string, value: string) =>
      (nodeFilterModel(stored(attribute, value), fields).rows[0] as FilterRow).value;
    // The picker gave a wall time read as UTC: a moment gets its zone mark, a day's start is the day.
    expect(valueOf("seen", "2024-01-01T10:30:00")).toBe("2024-01-01T10:30:00Z");
    expect(valueOf("seen", "2024-01-01T00:00:00")).toBe("2024-01-01");
    // A date field holds days.
    expect(valueOf("built", "2024-01-01T10:30:00")).toBe("2024-01-01");
  });

  it("reads a filter stored as CQL, and nothing as no rows", () => {
    const cql = { op: "or", args: [{ op: "=", args: [p("name"), "Main"] }] };
    expect(nodeFilterModel(cql, FIELDS)).toEqual({
      match: "any",
      rows: [{ id: "r0", field: "name", op: "is", value: "Main", enabled: true }],
    });
    expect(nodeFilterModel(undefined, FIELDS)).toEqual({ match: "all", rows: [] });
    expect(nodeFilterModel({ op: "and", expressions: [] }, FIELDS)).toEqual({ match: "all", rows: [] });
  });
});

describe("nodeFilterFrom", () => {
  it("writes back an untouched filter exactly as it was stored", () => {
    expect(storedFrom(nodeFilterModel(STORED, FIELDS), STORED, FIELDS)).toEqual(STORED);
  });

  it("writes back rows stored without an id as they were, an area and an extra key included", () => {
    const stored = {
      op: "and",
      expressions: [
        { type: "spatial", attribute: "geom", expression: "s_intersects", value: AREA_VALUE },
        { type: "logical", attribute: "name", expression: "is", value: "Main", note: "kept" },
      ],
    };
    expect(storedFrom(nodeFilterModel(stored, FIELDS), stored, FIELDS)).toEqual(stored);
  });

  it("rewrites only the row that changed, in the stored shape", () => {
    const model = nodeFilterModel(STORED, FIELDS);
    const changed: FilterModel = {
      ...model,
      rows: model.rows.map((row) => (row.id === "c" ? { ...row, value: 3 } : row)),
    };
    const written = storedFrom(changed, STORED, FIELDS);
    expect(written?.expressions[2]).toEqual({
      id: "c",
      type: "logical",
      attribute: "lanes",
      expression: "is_between",
      // As goatlib's workflow runner reads a range.
      value: "3-4",
    });
    expect(written?.expressions.filter((_, i) => i !== 2)).toEqual(
      STORED.expressions.filter((_, i) => i !== 2)
    );
  });

  it("adds a new row, leaves out unfinished and switched-off rows, and matches any as or", () => {
    const model = nodeFilterModel(STORED, FIELDS);
    const next: FilterModel = {
      match: "any",
      rows: [
        ...model.rows.map((row) => (row.id === "a" ? { ...row, enabled: false } : row)),
        { id: "n1", field: "built", op: "is_before", value: "2024-01-01", enabled: true },
        { id: "n2", field: "name", op: "contains_the_text", enabled: true },
      ],
    };
    const written = storedFrom(next, STORED, FIELDS);
    expect(written?.op).toBe("or");
    expect(written?.expressions.map((e) => e.id)).toEqual(["b", "c", "d", "e", "f", "n1"]);
    expect(written?.expressions[5]).toEqual({
      id: "n1",
      type: "logical",
      attribute: "built",
      expression: "is_before",
      value: "2024-01-01",
    });
  });

  it("writes the shapes the workflow runner reads: a value list, no value for an empty test", () => {
    const written = storedFrom(
      {
        match: "all",
        rows: [
          { id: "n1", field: "name", op: "excludes", value: ["a", "b"], enabled: true },
          { id: "n2", field: "name", op: "is_blank", enabled: true },
        ],
      },
      undefined,
      FIELDS
    );
    expect(written?.expressions).toEqual([
      { id: "n1", type: "logical", attribute: "name", expression: "excludes", value: ["a", "b"] },
      { id: "n2", type: "logical", attribute: "name", expression: "is_blank", value: "" },
    ]);
  });

  it("writes a range as low-high text for the runner, a range it would misread as a pair", () => {
    const range = (value: unknown, value2: unknown, op: FilterRow["op"] = "is_between") =>
      storedFrom(
        { match: "all", rows: [{ id: "n1", field: "lanes", op, value, value2, enabled: true }] },
        undefined,
        FIELDS
      )?.expressions[0].value;
    expect(range(2, 4.5)).toBe("2-4.5");
    expect(range(-2, 4)).toEqual([-2, 4]);
    expect(range(2, 4, "is_not_between")).toEqual([2, 4]);
  });

  it("stores nothing for no rows, and keeps a filter stored as CQL in CQL", () => {
    expect(storedFrom({ match: "all", rows: [] }, STORED, FIELDS)).toBeUndefined();
    const cql = {
      op: "and",
      args: [
        { op: "=", args: [p("name"), "Main"] },
        { op: "s_intersects", args: [p("geom"), { type: "Point", coordinates: [0, 0] }] },
      ],
    };
    const model = nodeFilterModel(cql, FIELDS);
    expect(storedFrom(model, cql, FIELDS)).toEqual(cql);
    const changed = { ...model, rows: model.rows.map((r) => (r.id === "r0" ? { ...r, value: "Side" } : r)) };
    expect(storedFrom(changed, cql, FIELDS)).toEqual({
      op: "and",
      args: [{ op: "=", args: [p("name"), "Side"] }, cql.args[1]],
    });
  });
});

describe("nodeFilterCql", () => {
  it("filters by every stored row, the area included", () => {
    const cql = nodeFilterCql(STORED, FIELDS);
    expect(cql).toEqual(writeFilter(nodeFilterModel(STORED, FIELDS), FIELDS).cql);
    expect(cql?.args).toHaveLength(6);
    expect((cql?.args as unknown[])[4]).toEqual({
      op: "s_intersects",
      args: [p("geom"), JSON.parse(AREA_VALUE)],
    });
  });

  it("is undefined without a row", () => {
    expect(nodeFilterCql(undefined, FIELDS)).toBeUndefined();
  });
});

describe("inheritedNodeFilter", () => {
  it("copies a layer's filter as the step's stored rows: conditions and an area", () => {
    const area = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    };
    const cql = {
      op: "or",
      args: [
        { op: "in", args: [p("name"), ["a", "b"]] },
        { op: "between", args: [p("lanes"), 2, 4] },
        {
          op: "or",
          args: [
            { op: "<>", args: [p("name"), "x"] },
            { op: "isNull", args: [p("name")] },
          ],
        },
        { op: "s_intersects", args: [p("geom"), area] },
      ],
    };
    expect(inheritedNodeFilter(cql)).toEqual({
      op: "or",
      expressions: [
        { id: "r0", type: "logical", attribute: "name", expression: "includes", value: ["a", "b"] },
        { id: "r1", type: "logical", attribute: "lanes", expression: "is_between", value: "2-4" },
        { id: "r2", type: "logical", attribute: "name", expression: "is_not", value: "x" },
        {
          id: "r3",
          type: "spatial",
          attribute: "geom",
          expression: "s_intersects",
          value: JSON.stringify(area),
        },
      ],
    });
  });

  describe("with the layer's area", () => {
    const shape = {
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
        [
          [
            [5, 5],
            [6, 5],
            [6, 6],
            [5, 5],
          ],
        ],
      ],
    };
    const inside = { op: "s_intersects", args: [p("geom"), shape] };
    const named = { op: "=", args: [p("name"), "Main"] };
    const wide = { op: ">", args: [p("lanes"), 2] };
    const spatial = {
      id: "area",
      type: "spatial",
      attribute: "geom",
      expression: "s_intersects",
      value: JSON.stringify(shape),
    };
    const isMain = { id: "r0", type: "logical", attribute: "name", expression: "is", value: "Main" };

    it("copies an inside area as the step's spatial row, before the conditions", () => {
      expect(inheritedNodeFilter({ op: "and", args: [inside, named] })).toEqual({
        op: "and",
        expressions: [spatial, isMain],
      });
      expect(inheritedNodeFilter({ op: "and", args: [inside] })).toEqual({
        op: "and",
        expressions: [spatial],
      });
    });

    it("keeps the area beside one alternative: both have to hold", () => {
      expect(inheritedNodeFilter({ op: "and", args: [inside, { op: "or", args: [wide] }] })).toEqual({
        op: "and",
        expressions: [
          spatial,
          { id: "r0", type: "logical", attribute: "lanes", expression: "is_greater_than", value: 2 },
        ],
      });
    });

    it("leaves out alternatives beside an area: the step's rows are all or any, not both", () => {
      expect(inheritedNodeFilter({ op: "and", args: [inside, { op: "or", args: [named, wide] }] })).toEqual({
        op: "and",
        expressions: [spatial],
      });
    });

    it("leaves out an outside area: the step's rows cannot say it", () => {
      expect(inheritedNodeFilter({ op: "and", args: [{ op: "not", args: [inside] }, named] })).toEqual({
        op: "and",
        expressions: [isMain],
      });
    });
  });

  it("leaves out what the step's rows cannot say, and gives nothing for no filter", () => {
    const nested = {
      op: "and",
      args: [
        {
          op: "or",
          args: [
            { op: "=", args: [p("a"), 1] },
            { op: "=", args: [p("b"), 2] },
          ],
        },
      ],
    };
    expect(inheritedNodeFilter(nested)).toBeUndefined();
    expect(inheritedNodeFilter(undefined)).toBeUndefined();
    expect(inheritedNodeFilter({ op: "and", args: [] })).toBeUndefined();
  });
});

describe("nodeHasFilter", () => {
  it("says whether the step filters: by a row, or by an older step's area alone", () => {
    expect(nodeHasFilter(STORED)).toBe(true);
    expect(nodeHasFilter(undefined)).toBe(false);
    expect(nodeHasFilter({ op: "and", expressions: [] })).toBe(false);
    const area = { type: "Polygon", coordinates: JSON.parse(AREA_VALUE).coordinates };
    expect(nodeHasFilter({ op: "and", args: [{ op: "s_intersects", args: [p("geom"), area] }] })).toBe(true);
  });
});
