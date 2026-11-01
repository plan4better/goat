import { describe, expect, it } from "vitest";

import { SpatialIntersectionGeomType } from "@/lib/validations/filter";

import {
  spatialGeometry,
  spatialGeometryType,
  spatialIntersectionOptions,
} from "@/components/map/panels/filter/spatialIntersection";

const t = (key: string) => key;

describe("spatial intersections of a filter row", () => {
  it("offers the map extent", () => {
    expect(spatialIntersectionOptions(t, null).map((option) => option.value)).toEqual([
      SpatialIntersectionGeomType.BBOX,
    ]);
  });

  it("shows a boundary the row already holds, such as a region the assistant set", () => {
    const options = spatialIntersectionOptions(t, SpatialIntersectionGeomType.BOUNDARY);
    expect(options.map((option) => [option.value, option.label])).toEqual([
      [SpatialIntersectionGeomType.BBOX, "map_extent"],
      [SpatialIntersectionGeomType.BOUNDARY, "boundary"],
    ]);
  });

  it("reads the type of a row's geometry", () => {
    const area = JSON.stringify({
      type: "Polygon",
      coordinates: [],
      properties: { type: "boundary", label: "München, Kreisfreie Stadt" },
    });
    expect(spatialGeometryType(area)).toBe("boundary");
    expect(spatialGeometryType("not json")).toBeNull();
    expect(spatialGeometryType(undefined)).toBeNull();
  });

  it("reads a row's geometry, or null for a value that is not one", () => {
    expect(spatialGeometry('{"type":"Polygon","properties":{"label":"Bayern"}}')?.properties?.label).toBe(
      "Bayern"
    );
    expect(spatialGeometry("not json")).toBeNull();
    expect(spatialGeometry("null")).toBeNull();
    expect(spatialGeometry('"text"')).toBeNull();
    expect(spatialGeometry(42)).toBeNull();
  });
});
