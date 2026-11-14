import { describe, expect, it } from "vitest";

import type { FilterArea, PolygonCoords, Position } from "@/lib/filter/area";
import { filterIssues } from "@/lib/filter/issues";
import type { Fields, FilterModel } from "@/lib/filter/model";

const FIELDS: Fields = { name: "string" };

/** A closed ring of `n` positions, with short coordinates: what is measured here is the points, not the length. */
const ring = (n: number): PolygonCoords => [
  [...Array.from({ length: n - 1 }, (_, i): Position => [i / 1000, (i % 2) / 1000]), [0, 0]],
];

const area = (polygons: PolygonCoords[], enabled = true): FilterArea => ({
  pieces: [{ kind: "shape", polygons }],
  op: "inside",
  enabled,
});

const spatial = (n: number) => ({
  op: "s_intersects",
  args: [{ property: "geom" }, { type: "Point", coordinates: [n, n] }],
});

const model = (partial: Partial<FilterModel>): FilterModel => ({ match: "all", rows: [], ...partial });

describe("filterIssues with an area", () => {
  it("says nothing about an area within the limits", () => {
    expect(filterIssues(model({ area: area([ring(2000)]) }), FIELDS).filter).toEqual([]);
  });

  it("names an area with more points than the limit", () => {
    expect(filterIssues(model({ area: area([ring(2001)]) }), FIELDS).filter).toEqual([
      { code: "area_too_detailed", limit: 2000 },
    ]);
  });

  it("names it for a switched-off area too: it could not be switched on", () => {
    expect(filterIssues(model({ area: area([ring(2001)], false) }), FIELDS).filter).toEqual([
      { code: "area_too_detailed", limit: 2000 },
    ]);
  });

  it("names more shapes than the limit: the area and the ones in custom rows", () => {
    const rows = [0, 1, 2].map((n) => ({ id: `r${n}`, cql: spatial(n), enabled: true }));
    expect(filterIssues(model({ rows }), FIELDS).filter).toEqual([]);
    expect(filterIssues(model({ rows, area: area([ring(5)]) }), FIELDS).filter).toEqual([
      { code: "too_many_shapes", limit: 3 },
    ]);
  });
});
