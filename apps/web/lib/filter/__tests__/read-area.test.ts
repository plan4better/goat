import { describe, expect, it } from "vitest";

import { type FilterArea, type PolygonCoords, areaCql, areaNotes } from "@/lib/filter/area";
import { type Fields, type FilterModel, isCustomRow } from "@/lib/filter/model";
import { activeParts, readFilter } from "@/lib/filter/read";

const FIELDS: Fields = { name: "string", traffic: "number" };

const square = (x: number, y: number, size = 1): PolygonCoords => [
  [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
    [x, y],
  ],
];
const p = (field: string) => ({ property: field });
const is = (field: string, value: unknown) => ({ op: "=", args: [p(field), value] });
const A = { op: "s_intersects", args: [p("geom"), { type: "Polygon", coordinates: square(0, 0) }] };
const A2 = { op: "s_intersects", args: [p("geom"), { type: "Polygon", coordinates: square(5, 5) }] };
const and = (...args: unknown[]) => ({ op: "and", args });
const or = (...args: unknown[]) => ({ op: "or", args });

/** The rows without their ids; a custom row as "custom". */
const rows = (m: FilterModel) =>
  m.rows.map((r) =>
    isCustomRow(r) ? "custom" : `${r.field} ${r.op} ${r.value}${r.enabled ? "" : " (off)"}`
  );
const shape: FilterArea = {
  pieces: [{ kind: "shape", polygons: [square(0, 0)] }],
  op: "inside",
  enabled: true,
};

describe("readFilter with an area", () => {
  it("reads an area alone", () => {
    expect(readFilter(and(A), undefined, FIELDS)).toEqual({ match: "all", rows: [], area: shape });
  });

  it("reads the area beside a condition, wherever it stands", () => {
    for (const cql of [and(A, is("name", "a")), and(is("name", "a"), A)]) {
      const model = readFilter(cql, undefined, FIELDS);
      expect(model.area).toEqual(shape);
      expect(model.match).toBe("all");
      expect(model.rows).toEqual([{ id: "r0", field: "name", op: "is", value: "a", enabled: true }]);
    }
  });

  it("reads `not` of the area as outside", () => {
    const model = readFilter(and({ op: "not", args: [A] }, is("name", "a")), undefined, FIELDS);
    expect(model.area).toEqual({ ...shape, op: "outside" });
    expect(rows(model)).toEqual(["name is a"]);
  });

  it("reads an area that is the whole filter", () => {
    expect(readFilter(A, undefined, FIELDS)).toEqual({ match: "all", rows: [], area: shape });
  });

  it("reads `or` of the area alone as match all", () => {
    expect(readFilter(or(A), undefined, FIELDS)).toEqual({ match: "all", rows: [], area: shape });
  });

  it("leaves an area that is one of several alternatives a custom row", () => {
    const model = readFilter(or(A, is("name", "a")), undefined, FIELDS);
    expect(model.area).toBeUndefined();
    expect(model.match).toBe("any");
    expect(rows(model)).toEqual(["custom", "name is a"]);
  });

  it("takes the first area; a second stays a custom row", () => {
    const model = readFilter(and(A, A2, is("name", "a")), undefined, FIELDS);
    expect(model.area).toEqual(shape);
    expect(rows(model)).toEqual(["custom", "name is a"]);
    expect(isCustomRow(model.rows[0]) && model.rows[0].cql).toEqual(A2);
  });

  it("reads one group of alternatives beside the area as match any", () => {
    const model = readFilter(and(A, or(is("name", "a"), is("traffic", 3))), undefined, FIELDS);
    expect(model.area).toEqual(shape);
    expect(model.match).toBe("any");
    expect(rows(model)).toEqual(["name is a", "traffic is 3"]);
  });

  it("reads alternatives on one field as one row, unless the notes say match any", () => {
    const cql = and(A, or(is("name", "a"), is("name", "b")));
    const plain = readFilter(cql, undefined, FIELDS);
    expect(plain.match).toBe("all");
    expect(rows(plain)).toEqual(["name includes a,b"]);
    const noted = readFilter(cql, { v: 1, any: true }, FIELDS);
    expect(noted.match).toBe("any");
    expect(rows(noted)).toEqual(["name is a", "name is b"]);
    expect(noted.area).toEqual(shape);
  });

  it("reads a single alternative beside the area as match any when the notes say so", () => {
    const model = readFilter(and(A, or(is("name", "a"))), { v: 1, any: true }, FIELDS);
    expect(model.match).toBe("any");
    expect(rows(model)).toEqual(["name is a"]);
  });

  it("splits the geometry into the pieces its notes describe", () => {
    const area: FilterArea = {
      pieces: [
        { kind: "view", polygons: [square(0, 0)] },
        { kind: "shape", polygons: [square(2, 2)], shape: "circle" },
        {
          kind: "features",
          polygons: [square(4, 4), square(6, 6)],
          source: "region",
          features: [{ id: "DE1", name: "Baden", n: 2 }],
        },
      ],
      op: "inside",
      enabled: true,
    };
    const model = readFilter(and(areaCql(area)), { v: 1, area: areaNotes(area) }, FIELDS);
    expect(model.area).toEqual(area);
  });

  it("reads a switched-off area from the notes", () => {
    const off = { ...shape, enabled: false };
    const notes = { v: 1, area: { ...areaNotes(off), off: areaCql(off) } };
    const model = readFilter(and(is("name", "a")), notes, FIELDS);
    expect(model.area).toEqual(off);
    expect(rows(model)).toEqual(["name is a"]);
    expect(readFilter(undefined, notes, FIELDS)).toEqual({ match: "all", rows: [], area: off });
  });

  it("an area in the filter wins over a switched-off one in the notes", () => {
    const other: FilterArea = {
      ...shape,
      pieces: [{ kind: "shape", polygons: [square(5, 5)] }],
      enabled: false,
    };
    const notes = { v: 1, area: { ...areaNotes(other), off: areaCql(other) } };
    expect(readFilter(and(A), notes, FIELDS).area).toEqual(shape);
  });

  it("ignores a switched-off area in the notes that is no area", () => {
    const notes = { v: 1, area: { pieces: [], sum: "x", off: is("name", "a") } };
    expect(readFilter(and(is("name", "b")), notes, FIELDS).area).toBeUndefined();
  });

  it("keeps match any when no row is active", () => {
    const notes = { v: 1, any: true, off: [{ at: 0, cql: is("name", "a") }] };
    const bare = readFilter(undefined, notes, FIELDS);
    expect(bare.match).toBe("any");
    expect(rows(bare)).toEqual(["name is a (off)"]);
    const withArea = readFilter(and(A), notes, FIELDS);
    expect(withArea.match).toBe("any");
    expect(withArea.area).toEqual(shape);
    expect(rows(withArea)).toEqual(["name is a (off)"]);
  });

  it("does not take match any from the notes when the filter says all", () => {
    expect(readFilter(and(is("name", "a"), is("traffic", 3)), { v: 1, any: true }, FIELDS).match).toBe("all");
    expect(readFilter(and(A, is("name", "a"), is("traffic", 3)), { v: 1, any: true }, FIELDS).match).toBe(
      "all"
    );
  });

  it("places switched-off rows among the conditions, not counting the area", () => {
    const notes = { v: 1, off: [{ at: 0, cql: is("name", "a") }] };
    const model = readFilter(and(A, is("traffic", 3)), notes, FIELDS);
    expect(rows(model)).toEqual(["name is a (off)", "traffic is 3"]);
  });

  it("reads the map extent older panels saved as the map view", () => {
    const geometry = {
      type: "Polygon",
      coordinates: square(0, 0),
      properties: { type: "bbox", label: "Map Extent" },
    };
    const model = readFilter(and({ op: "s_intersects", args: [p("geom"), geometry] }), undefined, FIELDS);
    expect(model.area).toEqual({
      pieces: [{ kind: "view", polygons: [square(0, 0)] }],
      op: "inside",
      enabled: true,
    });
    expect(model.rows).toEqual([]);
  });
});

describe("activeParts", () => {
  it("counts the conditions that filter and the area as one more", () => {
    expect(activeParts(undefined)).toBe(0);
    expect(activeParts({})).toBe(0);
    expect(activeParts(and(is("name", "a"), is("traffic", 3)))).toBe(2);
    expect(activeParts(and(A))).toBe(1);
    expect(activeParts(and(A, or(is("name", "a"), { op: ">", args: [p("traffic"), 3] })))).toBe(3);
  });
});
