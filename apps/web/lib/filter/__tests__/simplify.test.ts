import { describe, expect, it } from "vitest";

import { type PolygonCoords, pointCount } from "@/lib/filter/area";
import { simplifyToFit } from "@/lib/filter/simplify";

type Position = [number, number];

const circle = (n: number, cx = 10, cy = 50, r = 1): Position[] => {
  const ring = Array.from({ length: n }, (_, i): Position => {
    const a = (i / n) * 2 * Math.PI;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
  return [...ring, ring[0]];
};

const square = (x: number, size = 0.1): Position[] => [
  [x, 0],
  [x + size, 0],
  [x + size, size],
  [x, size],
  [x, 0],
];

const atMost = (limit: number) => (candidate: PolygonCoords[]) => pointCount(candidate) <= limit;

describe("simplifyToFit", () => {
  it("drops as few positions as it can", () => {
    const result = simplifyToFit([[circle(6000)]], atMost(1000));
    expect(result).not.toBeNull();
    expect(pointCount(result!.polygons)).toBe(1000);
  });

  it("only drops positions, and keeps every ring closed", () => {
    const original = circle(3000);
    const result = simplifyToFit([[original]], atMost(500))!;
    const ring = result.polygons[0][0];
    const known = new Set(original.map((p) => p.join()));
    expect(ring.every((p) => known.has(p.join()))).toBe(true);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it("says in meters how far the edges moved", () => {
    // A square at the equator with one spike of 0.01 degrees on its south side.
    const spiked: Position[] = [
      [0, 0],
      [0.5, -0.01],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ];
    const result = simplifyToFit([[spiked]], atMost(5))!;
    expect(result.polygons[0][0]).toHaveLength(5);
    expect(result.shift).toBeGreaterThan(1090);
    expect(result.shift).toBeLessThan(1120);
  });

  it("keeps every ring and hole, each with at least four positions", () => {
    const outer = circle(200, 10, 50, 1);
    const hole = circle(200, 10, 50, 0.5).reverse();
    const result = simplifyToFit([[outer, hole], [circle(200, 14, 50, 1)]], atMost(12))!;
    expect(result.polygons.map((polygon) => polygon.map((ring) => ring.length))).toEqual([[4, 4], [4]]);
  });

  it("finds nothing when even the simplest outline does not fit", () => {
    const squares = Array.from({ length: 10 }, (_, i) => [square(i)]);
    expect(simplifyToFit(squares, atMost(30))).toBeNull();
  });

  it("asks whether a candidate fits, so any limit can decide", () => {
    const text = (candidate: PolygonCoords[]) => JSON.stringify(candidate).length <= 2000;
    const result = simplifyToFit([[circle(1000)]], text)!;
    expect(JSON.stringify(result.polygons).length).toBeLessThanOrEqual(2000);
  });
});
