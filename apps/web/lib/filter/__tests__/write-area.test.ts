import { describe, expect, it } from "vitest";

import { type FilterArea, type PolygonCoords, areaNotes } from "@/lib/filter/area";
import type { Fields, FilterModel, FilterRow } from "@/lib/filter/model";
import { readFilter } from "@/lib/filter/read";
import { overLimits, writeFilter } from "@/lib/filter/write";

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
const row = (id: string, partial: Partial<FilterRow>): FilterRow => ({
  id,
  field: "name",
  op: "is",
  enabled: true,
  ...partial,
});
const area = (partial: Partial<FilterArea> = {}): FilterArea => ({
  pieces: [{ kind: "shape", polygons: [square(0, 0)] }],
  op: "inside",
  enabled: true,
  ...partial,
});
const A = { op: "s_intersects", args: [p("geom"), { type: "Polygon", coordinates: square(0, 0) }] };
const NOTES = areaNotes(area());
const a = row("r0", { value: "a" });
const b = row("r1", { field: "traffic", value: 3 });

/** A ring of `n` positions. */
const ring = (n: number): PolygonCoords => [
  Array.from({ length: n }, (_, i): [number, number] => (i === n - 1 ? [0, 0] : [i, i % 2])),
];

describe("writeFilter with an area", () => {
  it("writes an area alone under `and`, its pieces in the notes", () => {
    expect(writeFilter({ match: "all", rows: [], area: area() }, FIELDS)).toEqual({
      cql: { op: "and", args: [A] },
      ui: { v: 1, area: NOTES },
    });
  });

  it("writes the area first, the conditions after it", () => {
    expect(writeFilter({ match: "all", rows: [a, b], area: area() }, FIELDS).cql).toEqual({
      op: "and",
      args: [A, is("name", "a"), is("traffic", 3)],
    });
  });

  it("writes match any as one group of alternatives beside the area", () => {
    expect(writeFilter({ match: "any", rows: [a, b], area: area() }, FIELDS)).toEqual({
      cql: { op: "and", args: [A, { op: "or", args: [is("name", "a"), is("traffic", 3)] }] },
      ui: { v: 1, area: NOTES, any: true },
    });
  });

  it("writes a single alternative as a group too", () => {
    expect(writeFilter({ match: "any", rows: [a], area: area() }, FIELDS)).toEqual({
      cql: { op: "and", args: [A, { op: "or", args: [is("name", "a")] }] },
      ui: { v: 1, area: NOTES, any: true },
    });
  });

  it("writes outside as `not` of the area", () => {
    expect(writeFilter({ match: "all", rows: [a], area: area({ op: "outside" }) }, FIELDS).cql).toEqual({
      op: "and",
      args: [{ op: "not", args: [A] }, is("name", "a")],
    });
  });

  it("names the geometry field the filter was read with", () => {
    const written = writeFilter({ match: "all", rows: [], area: area({ property: "geometry" }) }, FIELDS);
    expect(written.cql).toEqual({
      op: "and",
      args: [{ op: "s_intersects", args: [p("geometry"), { type: "Polygon", coordinates: square(0, 0) }] }],
    });
  });

  it("keeps a switched-off area in the notes only", () => {
    const off = area({ enabled: false });
    expect(writeFilter({ match: "any", rows: [a, b], area: off }, FIELDS)).toEqual({
      cql: { op: "or", args: [is("name", "a"), is("traffic", 3)] },
      ui: { v: 1, area: { ...NOTES, off: A } },
    });
    expect(writeFilter({ match: "all", rows: [], area: off }, FIELDS)).toEqual({
      cql: undefined,
      ui: { v: 1, area: { ...NOTES, off: A } },
    });
  });

  it("writes an area without a polygon as no area", () => {
    const empty = area({ pieces: [] });
    expect(writeFilter({ match: "all", rows: [], area: empty }, FIELDS)).toEqual({
      cql: undefined,
      ui: undefined,
    });
    expect(writeFilter({ match: "all", rows: [a], area: empty }, FIELDS)).toEqual({
      cql: { op: "and", args: [is("name", "a")] },
      ui: undefined,
    });
  });

  it("notes match any when no active row says it", () => {
    const off = { ...a, enabled: false };
    expect(writeFilter({ match: "any", rows: [off] }, FIELDS)).toEqual({
      cql: undefined,
      ui: { v: 1, off: [{ at: 0, cql: is("name", "a") }], any: true },
    });
    expect(writeFilter({ match: "any", rows: [off], area: area() }, FIELDS)).toEqual({
      cql: { op: "and", args: [A] },
      ui: { v: 1, off: [{ at: 0, cql: is("name", "a") }], area: NOTES, any: true },
    });
  });

  it("notes nothing for match any without a row", () => {
    expect(writeFilter({ match: "any", rows: [] }, FIELDS)).toEqual({ cql: undefined, ui: undefined });
    expect(writeFilter({ match: "any", rows: [], area: area() }, FIELDS).ui).toEqual({ v: 1, area: NOTES });
  });

  it("counts the positions of switched-off rows among the conditions only", () => {
    const written = writeFilter({ match: "all", rows: [a, { ...b, enabled: false }], area: area() }, FIELDS);
    expect(written.cql).toEqual({ op: "and", args: [A, is("name", "a")] });
    expect(written.ui?.off).toEqual([{ at: 1, cql: is("traffic", 3) }]);
  });

  it("reads back what it wrote", () => {
    const models: FilterModel[] = [
      {
        match: "any",
        rows: [a, { ...b, enabled: false }, row("r2", { value: "c" })],
        area: {
          pieces: [
            { kind: "view", polygons: [square(0, 0)] },
            { kind: "shape", polygons: [square(2, 2)], shape: "polygon" },
            {
              kind: "features",
              polygons: [square(4, 4), square(6, 6)],
              source: "region",
              features: [
                { id: "DE1", name: "Baden", n: 1 },
                { id: "DE2", n: 1 },
              ],
            },
          ],
          op: "outside",
          enabled: true,
        },
      },
      { match: "any", rows: [a], area: area() },
      { match: "any", rows: [a, row("r1", { value: "b" })], area: area() },
      { match: "all", rows: [a, b], area: area({ enabled: false, op: "outside" }) },
      { match: "any", rows: [{ ...a, enabled: false }], area: area({ enabled: false }) },
    ];
    for (const model of models) {
      const written = writeFilter(model, FIELDS);
      expect(readFilter(written.cql, written.ui, FIELDS)).toEqual(model);
    }
  });

  it("filters the same without the notes", () => {
    const model: FilterModel = { match: "any", rows: [a, b], area: area() };
    const { cql } = writeFilter(model, FIELDS);
    expect(writeFilter(readFilter(cql, undefined, FIELDS), FIELDS).cql).toEqual(cql);
  });
});

describe("overLimits with shapes", () => {
  const custom = (id: string, at: number) => ({
    id,
    cql: { op: "s_intersects", args: [p("geom"), { type: "Point", coordinates: [at, at] }] },
    enabled: true,
  });

  it("is within the limits with an area of many pieces", () => {
    const many = area({
      pieces: [0, 2, 4, 6, 8].map((x) => ({ kind: "shape" as const, polygons: [square(x, x)] })),
    });
    expect(overLimits({ match: "all", rows: [], area: many }, FIELDS)).toEqual([]);
  });

  it("counts the area and each geometry of a custom row as a shape", () => {
    const rows = [custom("r0", 0), custom("r1", 1), custom("r2", 2)];
    expect(overLimits({ match: "all", rows }, FIELDS)).toEqual([]);
    expect(overLimits({ match: "all", rows, area: area() }, FIELDS)).toEqual(["shapes"]);
    expect(overLimits({ match: "all", rows, area: area({ enabled: false }) }, FIELDS)).toEqual([]);
  });

  it("flags an area with more points than the limit, also a switched-off one", () => {
    const big = area({ pieces: [{ kind: "shape", polygons: [ring(2001)] }] });
    expect(
      overLimits({
        match: "all",
        rows: [],
        area: area({ pieces: [{ kind: "shape", polygons: [ring(2000)] }] }),
      })
    ).toEqual([]);
    expect(overLimits({ match: "all", rows: [], area: big })).toEqual(["points"]);
    expect(overLimits({ match: "all", rows: [], area: { ...big, enabled: false } })).toEqual(["points"]);
  });

  it("the area is no condition", () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(`r${i}`, { value: `v${i}` }));
    expect(overLimits({ match: "all", rows, area: area() }, FIELDS)).toEqual([]);
  });
});
