import { describe, expect, it, vi } from "vitest";

import {
  type FilterArea,
  type PolygonCoords,
  areaCql,
  areaGeometry,
  areaNotes,
  areaSum,
  featureCount,
  geometryPolygons,
  isAreaNode,
  pointCount,
  readArea,
  readAreaNotes,
  roundPolygons,
  shapeCount,
  viewPolygon,
} from "@/lib/filter/area";

const square = (x: number, y: number, size = 1): PolygonCoords => [
  [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
    [x, y],
  ],
];

const geom = { property: "geom" };
const intersects = (geometry: unknown, property: unknown = geom) => ({
  op: "s_intersects",
  args: [property, geometry],
});
const polygon = (coordinates: PolygonCoords) => ({ type: "Polygon", coordinates });
const multi = (coordinates: PolygonCoords[]) => ({ type: "MultiPolygon", coordinates });

const area = (pieces: FilterArea["pieces"], rest: Partial<FilterArea> = {}): FilterArea => ({
  pieces,
  op: "inside",
  enabled: true,
  ...rest,
});

const THREE: FilterArea = area([
  { kind: "view", polygons: [square(0, 0, 10)] },
  { kind: "shape", polygons: [square(1, 1)], shape: "circle" },
  {
    kind: "features",
    polygons: [square(2, 2), square(3, 3), square(4, 4)],
    source: "region",
    features: [
      { id: "DE21", name: "Oberbayern", n: 2 },
      { id: "DE22", n: 1 },
    ],
  },
]);

describe("the area's geometry", () => {
  it("is nothing without a polygon", () => {
    expect(areaGeometry(area([]))).toBeNull();
    expect(areaCql(area([]))).toBeUndefined();
  });

  it("is a polygon for one and a multipolygon of every piece's polygons in their order", () => {
    expect(areaGeometry(area([{ kind: "shape", polygons: [square(0, 0)] }]))).toEqual(polygon(square(0, 0)));
    expect(areaGeometry(THREE)).toEqual(
      multi([square(0, 0, 10), square(1, 1), square(2, 2), square(3, 3), square(4, 4)])
    );
  });

  it("counts every position of every ring", () => {
    expect(pointCount([square(0, 0), [...square(1, 1), ...square(2, 2)]])).toBe(15);
  });

  it("counts the drawn shapes and the picked features", () => {
    expect(shapeCount(THREE)).toBe(1);
    expect(featureCount(THREE)).toBe(2);
  });
});

describe("the area's CQL", () => {
  it("is one s_intersects on the geometry, under not for outside", () => {
    const inside = area([{ kind: "shape", polygons: [square(0, 0)] }]);
    expect(areaCql(inside)).toEqual(intersects(polygon(square(0, 0))));
    expect(areaCql({ ...inside, op: "outside" })).toEqual({
      op: "not",
      args: [intersects(polygon(square(0, 0)))],
    });
  });

  it("keeps the geometry field the filter was saved with", () => {
    const a = area([{ kind: "shape", polygons: [square(0, 0)] }], { property: "geometry" });
    expect(areaCql(a)).toEqual(intersects(polygon(square(0, 0)), { property: "geometry" }));
  });

  it.each([
    ["a polygon", intersects(polygon(square(0, 0))), true],
    ["a multipolygon", intersects(multi([square(0, 0), square(2, 2)])), true],
    ["an envelope", intersects({ bbox: [0, 0, 1, 1] }), true],
    ["not of it", { op: "not", args: [intersects(polygon(square(0, 0)))] }, true],
    ["another spatial operator", { op: "s_within", args: [geom, polygon(square(0, 0))] }, false],
    ["a point", intersects({ type: "Point", coordinates: [0, 0] }), false],
    ["a line", intersects({ type: "LineString", coordinates: square(0, 0)[0] }), false],
    ["a polygon without a ring", intersects({ type: "Polygon", coordinates: [] }), false],
    ["coordinates that are none", intersects({ type: "Polygon", coordinates: [[["a", 0]]] }), false],
    ["no field", intersects(polygon(square(0, 0)), "geom"), false],
    ["a third argument", { op: "s_intersects", args: [geom, polygon(square(0, 0)), 1] }, false],
    [
      "not of two",
      { op: "not", args: [intersects(polygon(square(0, 0))), intersects({ bbox: [0, 0, 1, 1] })] },
      false,
    ],
    ["a comparison", { op: "=", args: [geom, 1] }, false],
    ["nothing", undefined, false],
  ])("%s: an area node %s", (_, node, expected) => {
    expect(isAreaNode(node)).toBe(expected);
  });

  it("reads an envelope as the polygon the server makes of it", () => {
    expect(geometryPolygons({ bbox: [1, 2, 3, 4] })).toEqual([
      [
        [
          [1, 2],
          [1, 4],
          [3, 4],
          [3, 2],
          [1, 2],
        ],
      ],
    ]);
    expect(geometryPolygons({ bbox: [1, 2, 0, 3, 4, 9] })).toEqual(geometryPolygons({ bbox: [1, 2, 3, 4] }));
    expect(geometryPolygons({ bbox: [1, 2, 3] })).toBeNull();
  });
});

describe("reading an area", () => {
  it("without notes is one shape of all its polygons", () => {
    expect(readArea(intersects(multi([square(0, 0), square(2, 2)])), undefined, true)).toEqual(
      area([{ kind: "shape", polygons: [square(0, 0), square(2, 2)] }])
    );
  });

  it("under not is outside", () => {
    expect(readArea({ op: "not", args: [intersects(polygon(square(0, 0)))] }, undefined, false)).toEqual(
      area([{ kind: "shape", polygons: [square(0, 0)] }], { op: "outside", enabled: false })
    );
  });

  it("keeps a geometry field of another name", () => {
    expect(readArea(intersects(polygon(square(0, 0)), { property: "geometry" }), undefined, true)).toEqual(
      area([{ kind: "shape", polygons: [square(0, 0)] }], { property: "geometry" })
    );
  });

  it("reads the map extent older panels saved as the map view", () => {
    const old = { ...polygon(square(0, 0)), properties: { type: "bbox", label: "Map Extent" } };
    expect(readArea(intersects(old), undefined, true)).toEqual(
      area([{ kind: "view", polygons: [square(0, 0)] }])
    );
  });

  it("reads a named boundary as a shape with its name", () => {
    const old = { ...multi([square(0, 0), square(2, 2)]), properties: { type: "boundary", label: "Bayern" } };
    expect(readArea(intersects(old), undefined, true)).toEqual(
      area([{ kind: "shape", polygons: [square(0, 0), square(2, 2)], label: "Bayern" }])
    );
  });

  it("is nothing for a node that is no area", () => {
    expect(readArea({ op: "=", args: [geom, 1] }, undefined, true)).toBeUndefined();
  });

  it("with its notes is the pieces it was made of", () => {
    expect(readArea(areaCql(THREE), areaNotes(THREE), true)).toEqual(THREE);
    const outside = { ...THREE, op: "outside" as const };
    expect(readArea(areaCql(outside), areaNotes(outside), true)).toEqual(outside);
  });

  it("notes of another geometry are left out", () => {
    const moved = intersects(multi([square(5, 5), square(1, 1), square(2, 2), square(3, 3), square(4, 4)]));
    expect(readArea(moved, areaNotes(THREE), true)?.pieces).toEqual([
      { kind: "shape", polygons: [square(5, 5), square(1, 1), square(2, 2), square(3, 3), square(4, 4)] },
    ]);
  });

  it("notes that count other polygons than the geometry has are left out", () => {
    const notes = areaNotes(THREE);
    const fewer = { ...notes, pieces: notes.pieces.slice(0, 2) };
    expect(readArea(areaCql(THREE), fewer, true)?.pieces).toHaveLength(1);
  });
});

describe("the area's notes", () => {
  it("say each piece without its polygons, and the geometry they belong to", () => {
    expect(areaNotes(THREE)).toEqual({
      pieces: [
        { kind: "view", n: 1 },
        { kind: "shape", n: 1, shape: "circle" },
        {
          kind: "features",
          source: "region",
          features: [
            { id: "DE21", name: "Oberbayern", n: 2 },
            { id: "DE22", n: 1 },
          ],
        },
      ],
      sum: areaSum([square(0, 0, 10), square(1, 1), square(2, 2), square(3, 3), square(4, 4)]),
    });
  });

  it("leave out a circle's centre and radius: they say which polygons are whose, not how a shape was made", () => {
    const circle = area([
      { kind: "shape", shape: "circle", center: [11, 48], km: 3, label: "School", polygons: [square(1, 1)] },
    ]);
    expect(areaNotes(circle).pieces).toEqual([{ kind: "shape", n: 1, shape: "circle", label: "School" }]);
  });

  it("the sum follows the coordinates", () => {
    expect(areaSum([square(0, 0)])).toBe(areaSum([square(0, 0)]));
    expect(areaSum([square(0, 0)])).not.toBe(areaSum([square(0, 0.000001)]));
    expect(areaSum([square(0, 0)])).toMatch(/^[0-9a-f]{8}$/);
  });

  it("take the sum once for the same pieces, however often they are written", () => {
    const pieces: FilterArea["pieces"] = [{ kind: "shape", polygons: [square(7, 7)] }];
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const first = areaNotes(area(pieces));
      // Switching the area off or to outside leaves its pieces as they are.
      expect(areaNotes(area(pieces, { enabled: false, op: "outside" })).sum).toBe(first.sum);
      expect(stringify).toHaveBeenCalledTimes(1);
      expect(areaNotes(area([...pieces])).sum).toBe(first.sum);
      expect(stringify).toHaveBeenCalledTimes(2);
    } finally {
      stringify.mockRestore();
    }
  });

  it("are read as far as they are well formed", () => {
    const notes = areaNotes(THREE);
    expect(readAreaNotes(notes)).toEqual(notes);
    expect(readAreaNotes({ ...notes, off: { op: "x" } })).toEqual({ ...notes, off: { op: "x" } });
    expect(readAreaNotes({ ...notes, more: 1 })).toEqual(notes);
  });

  it.each([
    ["nothing", undefined],
    ["no sum", { pieces: [{ kind: "view", n: 1 }] }],
    ["no pieces", { sum: "00000000" }],
    ["a piece of another kind", { sum: "0", pieces: [{ kind: "ring", n: 1 }] }],
    ["a piece without polygons", { sum: "0", pieces: [{ kind: "shape", n: 0 }] }],
    ["a count that is none", { sum: "0", pieces: [{ kind: "view", n: 1.5 }] }],
    [
      "features without a source",
      { sum: "0", pieces: [{ kind: "features", features: [{ id: "a", n: 1 }] }] },
    ],
    [
      "a feature without an id",
      { sum: "0", pieces: [{ kind: "features", source: "region", features: [{ n: 1 }] }] },
    ],
    ["no features", { sum: "0", pieces: [{ kind: "features", source: "region", features: [] }] }],
  ])("%s: no notes", (_, raw) => {
    expect(readAreaNotes(raw)).toBeUndefined();
  });
});

describe("making a piece", () => {
  it("the map view is a closed box, held to the world", () => {
    expect(viewPolygon([11.1234567891, 48.1, 11.9, 48.3])).toEqual([
      [
        [11.123457, 48.1],
        [11.9, 48.1],
        [11.9, 48.3],
        [11.123457, 48.3],
        [11.123457, 48.1],
      ],
    ]);
    expect(viewPolygon([-200, -95, 190, 95])).toEqual([
      [
        [-180, -90],
        [180, -90],
        [180, 90],
        [-180, 90],
        [-180, -90],
      ],
    ]);
  });

  it("rounds coordinates to six decimals", () => {
    expect(roundPolygons([[[[1.00000049, 2.123456789, 5]]]])).toEqual([[[[1, 2.123457]]]]);
  });
});
