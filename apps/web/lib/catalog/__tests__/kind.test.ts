import { describe, expect, it } from "vitest";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import {
  catalogBundleType,
  catalogKindOf,
  catalogRasterSource,
  catalogServiceTiles,
  catalogTilesUrl,
  markFor,
} from "@/lib/catalog/kind";
import type { CatalogCollection, CatalogItem, CatalogItemProperties } from "@/lib/validations/catalog";

/**
 * `catalogKindOf` exists because two of the properties it reads are denormalised
 * from the dataset onto each of its layers. These cases are the bug it fixed: a
 * member of a bundle used to render as the bundle itself — badged with the sibling
 * count and offering to expand into the list it was already in.
 */
const item = (properties: Partial<CatalogItemProperties>): CatalogItem => ({
  type: "Feature",
  id: "x",
  properties: { title: "t", "goat:layerType": "feature", ...properties },
  assets: {},
  links: [],
});

describe("catalogKindOf", () => {
  it("reads a dataset standing for several layers as a bundle", () => {
    expect(catalogKindOf(item({ "goat:layerType": "bundle", "goat:member_count": 4 }))).toBe("bundle");
  });

  it("does not let a member of a bundle claim to be one", () => {
    // Same row, now listed inside its own bundle: member_count and layerType are
    // both inherited, and only the caller knows the context.
    const member = item({
      "goat:layerType": "bundle",
      "goat:member_count": 4,
      "goat:geometryType": "polygon",
    });
    expect(catalogKindOf(member, true)).toBe("vector");
  });

  it("settles an inherited type from the item's own fields", () => {
    expect(catalogKindOf(item({ "goat:layerType": "bundle", "goat:geometryType": "point" }), true)).toBe(
      "vector"
    );
    expect(catalogKindOf(item({ "goat:layerType": "bundle", "table:row_count": 12 }), true)).toBe("table");
    // A plan's layers carry the plan's type; a GeoTIFF among them is a raster.
    const scan = { ...item({ "goat:layerType": "xplan" }), assets: { data: { href: "../data/a.tif" } } };
    expect(catalogKindOf(scan as CatalogItem, true)).toBe("raster");
  });

  it("reports unknown rather than guessing", () => {
    // No own geometry, no row count: could be a table or a raster, and labelling
    // it either would be a guess presented as fact.
    expect(catalogKindOf(item({ "goat:layerType": "bundle" }), true)).toBe("unknown");
  });

  it("passes through an explicit type", () => {
    expect(catalogKindOf(item({ "goat:layerType": "raster" }))).toBe("raster");
    expect(catalogKindOf(item({ "goat:layerType": "table" }))).toBe("table");
    expect(catalogKindOf(item({ "goat:layerType": "feature" }))).toBe("vector");
  });

  it("reads a WMS or WMTS item as such, also as a member that inherited `bundle`", () => {
    expect(catalogKindOf(item({ "goat:layerType": "wms" }))).toBe("wms");
    expect(catalogKindOf(item({ "goat:layerType": "wmts" }))).toBe("wmts");
    const member = {
      ...item({ "goat:layerType": "bundle", "goat:member_count": 3 }),
      links: [{ rel: "wmts", href: "https://h/WMTSCapabilities.xml", title: "x" }],
    };
    expect(catalogKindOf(member, true)).toBe("wmts");
    // A vector layer that also offers a map view stays a vector layer.
    expect(
      catalogKindOf({ ...member, properties: { ...member.properties, "goat:geometryType": "polygon" } }, true)
    ).toBe("vector");
  });

  it("marks map services and rasters apart", () => {
    expect(markFor({ kind: "wms" })).toBe(ICON_NAME.WMS);
    expect(markFor({ kind: "wmts" })).toBe(ICON_NAME.WMS);
    expect(markFor({ kind: "raster" })).toBe(ICON_NAME.RASTER);
  });
});

describe("catalogServiceTiles", () => {
  it("builds the GetMap tiles from the item's wms links", () => {
    const wms = {
      ...item({ "goat:layerType": "wms" }),
      links: [
        { rel: "wms", href: "https://vogis.cnv.at/geoserver/ows", title: "vogis:mountainbike_weglaenge" },
      ],
    };
    const tiles = catalogServiceTiles(wms);
    expect(tiles).toContain("https://vogis.cnv.at/geoserver/ows?bbox={bbox-epsg-3857}");
    expect(tiles).toContain("layers=vogis:mountainbike_weglaenge");
    expect(catalogServiceTiles(item({}))).toBeNull();
    // Only a WMS item draws live; a bundle or feature carrying a WMS link keeps its sample.
    // A bundle member inherits `bundle` but is still a WMS by its own link; one with geometry is not.
    expect(
      catalogServiceTiles({ ...wms, properties: { ...wms.properties, "goat:layerType": "bundle" } })
    ).toContain("layers=vogis:mountainbike_weglaenge");
    expect(
      catalogServiceTiles({
        ...wms,
        properties: { ...wms.properties, "goat:layerType": "bundle", "goat:geometryType": "polygon" },
      })
    ).toBeNull();
    const several = catalogServiceTiles({
      ...wms,
      links: [{ rel: "wms", href: "https://g/ows", title: "a, b" }],
    });
    expect(several).toContain("&layers=a,b&");
    const wmts = {
      ...item({ "goat:layerType": "wmts" }),
      links: [
        { rel: "wmts", href: "https://h/WMTSCapabilities.xml", title: "ortho" },
        { rel: "xyz", href: "https://h/ortho/{z}/{y}/{x}.png" },
      ],
    };
    expect(catalogServiceTiles(wmts)).toBe("https://h/ortho/{z}/{y}/{x}.png");
    expect(catalogServiceTiles({ ...wmts, links: wmts.links.slice(0, 1) })).toBeNull();
  });
});

const GEOAPI = "https://geoapi.example";

describe("catalogTilesUrl", () => {
  it("reads the published tiles from geoapi, for an item that says it has them", () => {
    expect(catalogTilesUrl(item({ "goat:tiles": true }), GEOAPI)).toBe(
      "https://geoapi.example/collections/catalog:x/tiles/WebMercatorQuad/{z}/{x}/{y}"
    );
    // Without published tiles the detail map draws the sample.
    expect(catalogTilesUrl(item({}), GEOAPI)).toBeNull();
    // No geoapi address, nowhere to read them from.
    expect(catalogTilesUrl(item({ "goat:tiles": true }), "")).toBeNull();
  });
});

describe("catalogRasterSource", () => {
  it("reads a raster item from geoapi's raster routes, as a layer's file", () => {
    expect(catalogRasterSource(item({ "goat:layerType": "raster" }), GEOAPI)).toEqual({
      tiles: "https://geoapi.example/collections/catalog:x/raster/tiles/{z}/{x}/{y}.webp",
      tileset: "https://geoapi.example/collections/catalog:x/raster/tiles",
      coverage: "https://geoapi.example/collections/catalog:x/coverage/tiles/WebMercatorQuad",
    });
    // A map service is drawn by its provider, a vector layer by its tiles or its sample.
    expect(catalogRasterSource(item({ "goat:layerType": "wms" }), GEOAPI)).toBeNull();
    expect(catalogRasterSource(item({}), GEOAPI)).toBeNull();
    expect(catalogRasterSource(item({ "goat:layerType": "raster" }), "")).toBeNull();
  });
});

describe("catalogBundleType", () => {
  it("names a typed bundle, which is added whole; a plain group is not one", () => {
    const of = (type: string | null) =>
      ({ id: "d", "goat:bundleType": type }) as unknown as CatalogCollection;
    expect(catalogBundleType(of("xplan"))).toBe("xplan");
    expect(catalogBundleType(of("XPlan"))).toBe("xplan");
    expect(catalogBundleType(of("Generic"))).toBeUndefined();
    expect(catalogBundleType(of(""))).toBeUndefined();
    expect(catalogBundleType(of(null))).toBeUndefined();
  });
});
