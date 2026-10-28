import { describe, expect, it } from "vitest";

import { compileSourceFor, getClusterGeoJsonUrl, sourceOf, versionParam } from "@/lib/style/layerSource";

const GEOAPI = "https://geoapi.test";
const feature = { id: 7, layer_id: "d1", type: "feature" };
const cql = { op: "=", args: [{ property: "kind" }, "school"] };
const temporary = { op: ">", args: [{ property: "size" }, 3] };

const params = (url: string) => new URL(url.replace("{z}/{x}/{y}", "0/0/0")).searchParams;

describe("compileSourceFor", () => {
  it("CQL and temporary filters are encoded into filter=", () => {
    const only = compileSourceFor(feature, { kind: "tiles", cql, geoapiUrl: GEOAPI });
    expect(only).toMatchObject({ type: "tiles", id: "src-7" });
    const tiles = (only as { tiles: string[] }).tiles[0];
    expect(tiles.startsWith(`${GEOAPI}/collections/d1/tiles/WebMercatorQuad/{z}/{x}/{y}`)).toBe(true);
    expect(JSON.parse(params(tiles).get("filter") as string)).toEqual(cql);

    const both = compileSourceFor(feature, { kind: "tiles", cql, extra: [temporary], geoapiUrl: GEOAPI });
    expect(JSON.parse(params((both as { tiles: string[] }).tiles[0]).get("filter") as string)).toEqual({
      op: "and",
      args: [temporary, cql],
    });
    const none = compileSourceFor(feature, { kind: "tiles", cql: {}, geoapiUrl: GEOAPI });
    expect(params((none as { tiles: string[] }).tiles[0]).has("filter")).toBe(false);
  });

  it("the points of a cluster are read with the same filter", () => {
    const points = compileSourceFor(feature, { kind: "points", cql, geoapiUrl: GEOAPI });
    expect(points).toMatchObject({ type: "points", id: "src-7" });
    const url = new URL((points as { data: string }).data);
    expect(url.pathname).toBe("/collections/d1/items");
    expect(JSON.parse(url.searchParams.get("filter") as string)).toEqual(cql);
  });

  it("v= appears only within an hour of a data change", () => {
    const now = Date.parse("2026-10-25T12:00:00Z");
    expect(versionParam("2026-10-25T11:30:00Z", now)).toBe(String(Date.parse("2026-10-25T11:30:00Z") / 1000));
    expect(versionParam("2026-10-25T10:30:00Z", now)).toBeUndefined();
    expect(versionParam(undefined, now)).toBeUndefined();
    const recent = new Date(Date.now() - 60_000).toISOString();
    const tiles = compileSourceFor(feature, { kind: "tiles", version: recent, geoapiUrl: GEOAPI });
    expect(params((tiles as { tiles: string[] }).tiles[0]).get("v")).toBe(
      String(Math.floor(Date.parse(recent) / 1000))
    );
  });

  it("dynamic=true only for the edited dataset", () => {
    const edited = compileSourceFor(feature, { kind: "tiles", dynamic: true, geoapiUrl: GEOAPI });
    const other = compileSourceFor(feature, { kind: "tiles", geoapiUrl: GEOAPI });
    expect(params((edited as { tiles: string[] }).tiles[0]).get("dynamic")).toBe("true");
    expect(params((other as { tiles: string[] }).tiles[0]).has("dynamic")).toBe(false);
  });

  it("COG, WMS, WMTS and XYZ sources carry tile size and service layer count", () => {
    const cog = { id: 3, layer_id: "r1", type: "raster", data_type: "cog", url: "https://files/a.tif" };
    expect(compileSourceFor(cog, { kind: "raster", geoapiUrl: GEOAPI })).toEqual({
      type: "raster",
      id: "src-3",
      tiles: `${GEOAPI}/collections/r1/raster/tiles/{z}/{x}/{y}.webp`,
      dem: `${GEOAPI}/collections/r1/raster/dem/{z}/{x}/{y}.webp`,
    });
    const changed = new Date(Date.now() - 60_000).toISOString();
    expect(compileSourceFor(cog, { kind: "raster", geoapiUrl: GEOAPI, version: changed })).toMatchObject({
      version: String(Math.floor(new Date(changed).getTime() / 1000)),
    });
    for (const service of ["wms", "wmts", "xyz"] as const) {
      const layer = {
        id: 4,
        type: "raster",
        data_type: service,
        url: "https://maps/{z}/{x}/{y}",
        other_properties: { tile_size: 512, layers: ["a", "b"] },
      };
      expect(compileSourceFor(layer, { kind: "service" })).toEqual({
        type: "service",
        id: "src-4",
        service,
        tiles: "https://maps/{z}/{x}/{y}",
        tileSize: 512,
        layers: 2,
      });
    }
    expect(sourceOf(feature)).toBeUndefined();
  });

  it("an overlay of features is a GeoJSON source of their own", () => {
    const data = { type: "FeatureCollection" as const, features: [] };
    expect(compileSourceFor(feature, { kind: "tiles", data, id: "pending-7" })).toEqual({
      type: "points",
      id: "pending-7",
      data,
    });
  });
});

describe("clustered points after a data change", () => {
  it("the points URL carries the data version, so a saved edit reloads the points", () => {
    const changed = new Date(Date.now() - 60_000).toISOString();
    const points = compileSourceFor(feature, { kind: "points", version: changed, geoapiUrl: GEOAPI });
    const url = new URL((points as { data: string }).data);
    expect(url.searchParams.get("v")).toBe(versionParam(changed));
    const unchanged = compileSourceFor(feature, { kind: "points", geoapiUrl: GEOAPI });
    expect(new URL((unchanged as { data: string }).data).searchParams.has("v")).toBe(false);
  });
});

describe("getClusterGeoJsonUrl", () => {
  it("builds the OGC items URL with limit=100000", () => {
    const url = getClusterGeoJsonUrl("http://geoapi", "layer-1");
    expect(url).toBe("http://geoapi/collections/layer-1/items?limit=100000&f=json");
  });

  it("appends a filter param when given", () => {
    const url = getClusterGeoJsonUrl("http://geoapi", "layer-1", '{"op":"="}');
    expect(url).toContain("filter=");
    expect(url).toContain(encodeURIComponent('{"op":"="}'));
  });
});
