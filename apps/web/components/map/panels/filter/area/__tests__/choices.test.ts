import { describe, expect, it } from "vitest";

import type { AreaPiece, FilterArea, PolygonCoords } from "@/lib/filter/area";

import {
  choiceOf,
  newestAlone,
  pieceOf,
  regionsOf,
  viewApart,
} from "@/components/map/panels/filter/area/choices";
import { circlePiece } from "@/components/map/panels/filter/area/pieces";

const square = (x: number): PolygonCoords => [
  [
    [x, 0],
    [x + 1, 0],
    [x + 1, 1],
    [x, 1],
    [x, 0],
  ],
];
const area = (pieces: AreaPiece[]): FilterArea => ({ pieces, op: "inside", enabled: true });
const BAYERN: AreaPiece = {
  kind: "features",
  source: "region",
  features: [{ id: "DE2", name: "Bayern", n: 1 }],
  polygons: [square(0)],
};
const POLYGON: AreaPiece = { kind: "shape", shape: "polygon", polygons: [square(2)] };
const VIEW: AreaPiece = { kind: "view", polygons: [square(9)] };

describe("a piece as the choice that keeps it", () => {
  it("names regions by their ids, with the names they were picked by", () => {
    expect(choiceOf(BAYERN)).toEqual({ kind: "region", nutsIds: ["DE2"], names: { DE2: "Bayern" } });
  });

  it("keeps a circle around a point as its centre and radius", () => {
    expect(choiceOf(circlePiece([11, 48], 5, "School"))).toEqual({
      kind: "point",
      lng: 11,
      lat: 48,
      km: 5,
      label: "School",
    });
  });

  it("keeps a polygon as its corners, the ring left open", () => {
    expect(choiceOf(POLYGON)).toEqual({
      kind: "polygon",
      ring: [
        [2, 0],
        [3, 0],
        [3, 1],
        [2, 1],
      ],
    });
  });

  it("keeps the map view as the box it showed", () => {
    expect(choiceOf(VIEW, [1, 2, 3, 4])).toEqual({ kind: "view", bbox: [1, 2, 3, 4] });
    expect(choiceOf(VIEW)).toBeNull();
  });

  it("has none for what no choice says", () => {
    expect(choiceOf({ kind: "shape", polygons: [square(0), square(2)] })).toBeNull();
    expect(choiceOf({ kind: "shape", polygons: [[...square(0), ...square(2)]] })).toBeNull();
    expect(choiceOf({ ...BAYERN, source: "layer-1" })).toBeNull();
  });
});

describe("a choice as a piece", () => {
  const outline = {
    type: "Polygon",
    coordinates: [
      [
        [10.1234567, 48],
        [12, 48],
        [12, 49],
        [10.1234567, 48],
      ],
    ],
  };

  it("gives regions their outlines, rounded, once every one has loaded", () => {
    const choice = { kind: "region" as const, nutsIds: ["DE2", "DE3"], names: { DE2: "Bayern" } };
    const loaded = { DE2: { geometry: outline }, DE3: { geometry: outline, name: "Berlin" } };
    expect(pieceOf(choice, loaded)).toEqual({
      kind: "features",
      source: "region",
      features: [
        { id: "DE2", name: "Bayern", n: 1 },
        { id: "DE3", name: "Berlin", n: 1 },
      ],
      polygons: [
        [
          [
            [10.123457, 48],
            [12, 48],
            [12, 49],
            [10.123457, 48],
          ],
        ],
        [
          [
            [10.123457, 48],
            [12, 48],
            [12, 49],
            [10.123457, 48],
          ],
        ],
      ],
    });
    // One without an outline: no piece, unless the regions are kept by id alone.
    expect(pieceOf(choice, { DE2: { geometry: outline }, DE3: {} })).toBeNull();
    expect(pieceOf(choice, { DE2: { geometry: outline }, DE3: {} }, true)).toMatchObject({
      features: [
        { id: "DE2", name: "Bayern", n: 1 },
        { id: "DE3", n: 0 },
      ],
      polygons: [
        [
          [
            [10.123457, 48],
            [12, 48],
            [12, 49],
            [10.123457, 48],
          ],
        ],
      ],
    });
  });

  it("closes a polygon's ring", () => {
    const ring: [number, number][] = [
      [2, 0],
      [3, 0],
      [3, 1],
    ];
    expect(pieceOf({ kind: "polygon", ring }, {})).toEqual({
      kind: "shape",
      shape: "polygon",
      polygons: [[[...ring, [2, 0]]]],
    });
  });

  it("makes a point the circle around it", () => {
    expect(pieceOf({ kind: "point", lng: 11, lat: 48, km: 5 }, {})).toEqual(circlePiece([11, 48], 5));
  });

  it("reads back what it was written as", () => {
    const circle = circlePiece([11, 48], 2.5);
    expect(pieceOf(choiceOf(circle)!, {})).toEqual(circle);
    expect(pieceOf(choiceOf(POLYGON)!, {})).toEqual(POLYGON);
  });

  it("lists the regions every choice names, once", () => {
    expect(
      regionsOf([
        { kind: "region", nutsIds: ["DE2", "DE3"] },
        { kind: "point", lng: 1, lat: 2, km: 3 },
        { kind: "region", nutsIds: ["DE3", "DE4"] },
      ])
    ).toEqual(["DE2", "DE3", "DE4"]);
  });
});

describe("pieces that do not mix", () => {
  it("in the fetch, a new map view replaces the other pieces, and a new piece drops the map view", () => {
    expect(viewApart(area([BAYERN, POLYGON, VIEW]), area([BAYERN, POLYGON]))?.pieces).toEqual([VIEW]);
    expect(viewApart(area([VIEW, POLYGON]), area([VIEW]))?.pieces).toEqual([POLYGON]);
    expect(viewApart(area([BAYERN, POLYGON]), area([BAYERN]))?.pieces).toEqual([BAYERN, POLYGON]);
    expect(viewApart(undefined, area([VIEW]))).toBeUndefined();
  });

  it("in the catalog, the newest piece replaces the others", () => {
    const more = { ...BAYERN };
    expect(newestAlone(area([BAYERN, POLYGON]), area([BAYERN]))?.pieces).toEqual([POLYGON]);
    expect(newestAlone(area([POLYGON, more]), area([POLYGON, BAYERN]))?.pieces).toEqual([more]);
    // Taking a piece away leaves the rest.
    expect(newestAlone(area([POLYGON]), area([POLYGON, BAYERN]))?.pieces).toEqual([POLYGON]);
  });
});
