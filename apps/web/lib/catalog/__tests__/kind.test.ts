import { describe, expect, it } from "vitest";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import {
  catalogKindOf,
  catalogRasterSource,
  catalogServiceTiles,
  catalogTilesUrl,
  markFor,
} from "@/lib/catalog/kind";
import type { CatalogItem, CatalogItemProperties } from "@/lib/validations/catalog";

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
    expect(catalogKindOf(item({ "goat:layerType": "bundle", "goat:member_count": 4 }))).toBe(
      "bundle"
    );
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
    expect(catalogKindOf(item({ "goat:layerType": "bundle", "table:row_count": 12 }), true)).toBe(
      "table"
    );
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
    expect(catalogKindOf({ ...member, properties: { ...member.properties, "goat:geometryType": "polygon" } }, true)).toBe(
      "vector"
    );
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
    expect(catalogServiceTiles({ ...wms, properties: { ...wms.properties, "goat:layerType": "bundle" } })).toContain(
      "layers=vogis:mountainbike_weglaenge"
    );
    expect(
      catalogServiceTiles({
        ...wms,
        properties: { ...wms.properties, "goat:layerType": "bundle", "goat:geometryType": "polygon" },
      })
    ).toBeNull();
    const several = catalogServiceTiles({ ...wms, links: [{ rel: "wms", href: "https://g/ows", title: "a, b" }] });
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

describe("catalogTilesUrl", () => {
  it("draws the published tiles through the catalog, and nothing else", () => {
    const tiled = { ...item({}), assets: { tiles: { href: "https://cat.example/assets/x/tiles" } } };
    expect(catalogTilesUrl(tiled)).toBe("https://cat.example/assets/x/tiles/{z}/{x}/{y}");
    // A bucket path the API did not rewrite is not something a browser can read.
    expect(catalogTilesUrl({ ...item({}), assets: { tiles: { href: "../../data/x.pmtiles" } } })).toBeNull();
    expect(catalogTilesUrl(item({}))).toBeNull();
  });
});

describe("catalogRasterSource", () => {
  it("draws a raster through the tiles the catalog announces for it", () => {
    const raster = { ...item({ "goat:layerType": "raster" }), assets: { raster: { href: "https://cat.example/assets/r/raster" } } };
    expect(catalogRasterSource(raster)).toEqual({
      tiles: "https://cat.example/assets/r/raster/{z}/{x}/{y}.webp",
      coverage: "https://cat.example/assets/r/raster/coverage/tiles/WebMercatorQuad",
    });
    expect(catalogRasterSource(item({ "goat:layerType": "raster" }))).toBeNull();
  });
});
