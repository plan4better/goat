import { describe, expect, it } from "vitest";

import { shapePoints, urlLength } from "@/lib/filter/limits";

const p = (field: string) => ({ property: field });
const SQUARE = [
  [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [0, 0],
  ],
];
const polygon = { type: "Polygon", coordinates: SQUARE };
const intersects = (geometry: unknown) => ({ op: "s_intersects", args: [p("geom"), geometry] });

describe("shapePoints", () => {
  it("finds no shape in a filter without one", () => {
    expect(shapePoints(undefined)).toEqual([]);
    expect(shapePoints({ op: "and", args: [{ op: "=", args: [p("name"), "a"] }] })).toEqual([]);
  });

  it("counts the positions of each geometry", () => {
    const multi = { type: "MultiPolygon", coordinates: [SQUARE, SQUARE] };
    expect(shapePoints({ op: "and", args: [intersects(polygon)] })).toEqual([5]);
    expect(
      shapePoints({ op: "or", args: [intersects(polygon), intersects(multi)] }).sort((a, b) => a - b)
    ).toEqual([5, 10]);
    expect(shapePoints(intersects({ type: "Point", coordinates: [1, 2] }))).toEqual([1]);
  });

  it("counts an envelope as five positions", () => {
    expect(shapePoints(intersects({ bbox: [0, 0, 1, 1] }))).toEqual([5]);
  });

  it("finds a shape under `not` and in nested groups", () => {
    const nested = { op: "and", args: [{ op: "or", args: [{ op: "not", args: [intersects(polygon)] }] }] };
    expect(shapePoints(nested)).toEqual([5]);
  });

  it("does not look inside a geometry or a comparison", () => {
    const withProperties = { ...polygon, properties: { inner: polygon } };
    expect(shapePoints(intersects(withProperties))).toEqual([5]);
    expect(shapePoints({ op: "=", args: [p("name"), polygon] })).toEqual([]);
  });

  it("does not overflow on thousands of levels", () => {
    let node: unknown = intersects(polygon);
    for (let i = 0; i < 5000; i++) node = { op: "not", args: [node] };
    expect(shapePoints(node)).toEqual([5]);
  });
});

describe("urlLength", () => {
  it("is the filter as a map request carries it, as goatlib counts it", () => {
    expect(urlLength({ op: "=", args: [p("a"), "Straße & Co (1)!*~"] })).toBe(118);
  });

  it("is nothing without a filter", () => {
    expect(urlLength(undefined)).toBe(0);
  });
});
