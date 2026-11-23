import { describe, expect, it } from "vitest";

import { commonT } from "@/i18n/__tests__/commonI18n";

import {
  addressShownTo,
  feedSource,
  hasAddress,
  layerOrigin,
  readableAddress,
  shortAddress,
  sourceLabel,
  withoutQuery,
  withoutScheme,
} from "@/lib/utils/layerOrigin";

const COG_URL = "https://maplibre.org/maplibre-gl-js/docs/assets/cog.tif";
const WFS_URL =
  "https://www.wfs.nrw.de/geobasis/wfs_nw_alkis_vereinfacht?SERVICE=WFS&REQUEST=GetCapabilities";

const raster = (fields: Record<string, unknown>) =>
  ({ type: "raster", other_properties: {}, ...fields }) as never;

describe("layerOrigin", () => {
  it("calls a raster file read from an http(s) address a remote file", () => {
    expect(layerOrigin(raster({ data_type: "cog", url: COG_URL }))).toEqual({
      kind: "remote_file",
      format: "cog",
      url: COG_URL,
    });
    expect(layerOrigin(raster({ data_type: "cog", url: "http://example.org/a.tif" }))).toEqual({
      kind: "remote_file",
      format: "cog",
      url: "http://example.org/a.tif",
    });
  });

  it("calls a WMS, WMTS or XYZ layer a map service of that kind", () => {
    const wms = "https://example.org/wms?SERVICE=WMS&REQUEST=GetMap&BBOX={bbox-epsg-3857}";
    expect(layerOrigin(raster({ data_type: "wms", url: wms }))).toEqual({
      kind: "map_service",
      service: "wms",
      url: wms,
    });
    expect(
      layerOrigin(raster({ data_type: "wmts", url: "https://example.org/wmts/{z}/{x}/{y}.png" }))
    ).toEqual({
      kind: "map_service",
      service: "wmts",
      url: "https://example.org/wmts/{z}/{x}/{y}.png",
    });
    expect(
      layerOrigin(raster({ data_type: "xyz", url: "https://tile.example.org/{z}/{x}/{y}.png" }))
    ).toEqual({
      kind: "map_service",
      service: "xyz",
      url: "https://tile.example.org/{z}/{x}/{y}.png",
    });
  });

  it("calls a catalog layer a catalog layer, never an address, whatever it carries", () => {
    expect(
      layerOrigin({ type: "feature", other_properties: { catalog_item: { id: "x" } } } as never)
    ).toEqual({
      kind: "catalog",
    });
    // A catalog raster: GOAT's own copy, read from storage by the layer's id.
    expect(
      layerOrigin(raster({ data_type: "cog", url: null, other_properties: { catalog_item: { id: "x" } } }))
    ).toEqual({ kind: "catalog" });
    expect(
      layerOrigin(raster({ data_type: "cog", url: COG_URL, other_properties: { catalog_materialize: {} } }))
    ).toEqual({ kind: "catalog" });
  });

  it("says nothing for an uploaded feature layer, a table or a stored raster", () => {
    expect(
      layerOrigin({ type: "feature", data_type: undefined, other_properties: {} } as never)
    ).toBeUndefined();
    expect(layerOrigin({ type: "table", other_properties: {} } as never)).toBeUndefined();
    // A raster file GOAT stores has no address of its own.
    expect(layerOrigin(raster({ data_type: "cog", url: null }))).toBeUndefined();
    expect(layerOrigin(raster({ data_type: "cog" }))).toBeUndefined();
  });

  it("never treats a storage path or another scheme as an address", () => {
    for (const url of [
      "s3://goat-bucket/users/1/t_abc.tif",
      "/data/layers/t_abc.tif",
      "file:///a.tif",
      "ftp://x/a.tif",
    ])
      expect(layerOrigin(raster({ data_type: "cog", url }))).toBeUndefined();
    expect(layerOrigin(raster({ data_type: "wms", url: "s3://goat-bucket/wms" }))).toBeUndefined();
  });

  it("calls a feature layer read from a WFS a copy, with the service it came from", () => {
    // The import keeps the service's address in other_properties; the layer's own url stays empty.
    expect(
      layerOrigin({ type: "feature", data_type: "wfs", other_properties: { url: WFS_URL } } as never)
    ).toEqual({ kind: "wfs_copy", url: WFS_URL });
    expect(
      layerOrigin({ type: "feature", data_type: "wfs", url: WFS_URL, other_properties: {} } as never)
    ).toEqual({ kind: "wfs_copy", url: WFS_URL });
  });

  it("says nothing for a WFS copy without a web address", () => {
    expect(layerOrigin({ type: "feature", data_type: "wfs", other_properties: {} } as never)).toBeUndefined();
    expect(
      layerOrigin({ type: "feature", data_type: "wfs", other_properties: { url: "s3://bucket/x" } } as never)
    ).toBeUndefined();
  });
});

describe("hasAddress", () => {
  it("is true for every origin but the catalog, and for none", () => {
    expect(hasAddress({ kind: "remote_file", format: "cog", url: COG_URL })).toBe(true);
    expect(hasAddress({ kind: "map_service", service: "wms", url: COG_URL })).toBe(true);
    expect(hasAddress({ kind: "wfs_copy", url: WFS_URL })).toBe(true);
    expect(hasAddress({ kind: "catalog" })).toBe(false);
    expect(hasAddress(undefined)).toBe(false);
  });
});

describe("sourceLabel", () => {
  it.each([
    [
      "en",
      "Remote file (COG)",
      "Map service (WMS)",
      "Map service (WMTS)",
      "Map service (XYZ)",
      "Copied from WFS",
      "Catalog",
    ],
    [
      "de",
      "Externe Datei (COG)",
      "Kartendienst (WMS)",
      "Kartendienst (WMTS)",
      "Kartendienst (XYZ)",
      "Kopie aus WFS",
      "Katalog",
    ],
  ] as const)(
    "words each origin the same everywhere (%s)",
    (language, file, wms, wmts, xyz, wfs, catalog) => {
      const t = commonT(language);
      expect(sourceLabel({ kind: "remote_file", format: "cog" }, t)).toBe(file);
      expect(sourceLabel({ kind: "map_service", service: "wms" }, t)).toBe(wms);
      expect(sourceLabel({ kind: "map_service", service: "wmts" }, t)).toBe(wmts);
      expect(sourceLabel({ kind: "map_service", service: "xyz" }, t)).toBe(xyz);
      expect(sourceLabel({ kind: "wfs_copy" }, t)).toBe(wfs);
      expect(sourceLabel({ kind: "catalog" }, t)).toBe(catalog);
    }
  );

  it("takes a layer's whole origin, its address left aside", () => {
    expect(sourceLabel({ kind: "remote_file", format: "cog", url: COG_URL }, commonT("en"))).toBe(
      "Remote file (COG)"
    );
  });
});

describe("feedSource", () => {
  it("reads the same origins off the three facts the content feed sends", () => {
    expect(feedSource({ data_type: "cog", is_linked: true, source_host: "maplibre.org" })).toEqual({
      kind: "remote_file",
      format: "cog",
    });
    expect(feedSource({ data_type: "wms", is_linked: true, source_host: "www.wms.nrw.de" })).toEqual({
      kind: "map_service",
      service: "wms",
    });
    expect(feedSource({ data_type: "wfs", is_linked: false, source_host: "www.wfs.nrw.de" })).toEqual({
      kind: "wfs_copy",
    });
  });

  it("says nothing for data GOAT holds", () => {
    expect(feedSource({ data_type: null, is_linked: false, source_host: null })).toBeUndefined();
    expect(feedSource({})).toBeUndefined();
    // A raster file GOAT stores: a format, but no address.
    expect(feedSource({ data_type: "cog", is_linked: false, source_host: null })).toBeUndefined();
    expect(feedSource({ data_type: "wfs", is_linked: false, source_host: null })).toBeUndefined();
  });

  it("applies the layer rule's http(s) check: a linked layer without a web host says nothing", () => {
    // Core names a host only for an http(s) address, so a stored storage path (s3://, a file) arrives without one,
    // as layerOrigin ignores such an address too.
    expect(feedSource({ data_type: "cog", is_linked: true, source_host: null })).toBeUndefined();
    expect(feedSource({ data_type: "xyz", is_linked: true, source_host: null })).toBeUndefined();
    expect(feedSource({ data_type: "cog", is_linked: true })).toBeUndefined();
  });
});

describe("addressShownTo", () => {
  const SIGNED = "https://example.org/a/b.tif?sig=x#part";

  it("leaves out the query string and the fragment for someone who may not edit the layer", () => {
    expect(addressShownTo(SIGNED, false)).toBe("https://example.org/a/b.tif");
    expect(addressShownTo("https://example.org/a/b.tif#part", false)).toBe("https://example.org/a/b.tif");
  });

  it("leaves out a user and password before the host as well, as core does", () => {
    expect(addressShownTo("https://user:secret@example.org/a/b.tif?sig=x", false)).toBe(
      "https://example.org/a/b.tif"
    );
    expect(addressShownTo("http://token@example.org:8080/a.tif", false)).toBe(
      "http://example.org:8080/a.tif"
    );
    // An @ in the path is no user.
    expect(addressShownTo("https://example.org/@scope/a.tif", false)).toBe(
      "https://example.org/@scope/a.tif"
    );
  });

  it("shows an editor the whole address", () => {
    expect(addressShownTo(SIGNED, true)).toBe(SIGNED);
    expect(addressShownTo("https://user:secret@example.org/a.tif", true)).toBe(
      "https://user:secret@example.org/a.tif"
    );
  });

  it("keeps a tile template's placeholders as they are", () => {
    expect(addressShownTo("https://tile.example.org/{z}/{x}/{y}.png", false)).toBe(
      "https://tile.example.org/{z}/{x}/{y}.png"
    );
  });
});

describe("withoutScheme", () => {
  it("drops http and https", () => {
    expect(withoutScheme(COG_URL)).toBe("maplibre.org/maplibre-gl-js/docs/assets/cog.tif");
    expect(withoutScheme("HTTP://example.org/a.tif")).toBe("example.org/a.tif");
  });
});

describe("shortAddress", () => {
  it("shows the host in full, then the last path segment in full, the segments between left out", () => {
    expect(
      shortAddress(
        "copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N52_00_E013_00_DEM/Copernicus_DSM_COG_10_N52_00_E013_00_DEM.tif"
      )
    ).toBe("copernicus-dem-30m.s3.amazonaws.com/…/Copernicus_DSM_COG_10_N52_00_E013_00_DEM.tif");
    expect(shortAddress("maplibre.org/maplibre-gl-js/docs/assets/cog.tif")).toBe("maplibre.org/…/cog.tif");
  });

  it("shows a short address whole: a host, or a host and one file", () => {
    expect(shortAddress("example.org/cog.tif")).toBe("example.org/cog.tif");
    expect(shortAddress("example.org")).toBe("example.org");
    expect(shortAddress("example.org/")).toBe("example.org/");
  });

  it("keeps a map service's last template part", () => {
    expect(shortAddress("tile.example.org/{z}/{x}/{y}.png")).toBe("tile.example.org/…/{y}.png");
  });

  it("keeps an editor's query after the last segment, a slash inside it counting for nothing", () => {
    expect(shortAddress("example.org/geoserver/ows?SERVICE=WMS&FORMAT=image/png")).toBe(
      "example.org/…/ows?SERVICE=WMS&FORMAT=image/png"
    );
    expect(shortAddress("example.org/ows?FORMAT=image/png#x")).toBe("example.org/ows?FORMAT=image/png#x");
  });

  it("keeps the last folder of an address that ends in a slash", () => {
    expect(shortAddress("example.org/a/b/")).toBe("example.org/…/b/");
    expect(shortAddress("example.org/a/")).toBe("example.org/a/");
  });

  it("shortens a viewer's address, which has no query, the same way", () => {
    expect(shortAddress(withoutScheme(addressShownTo("https://example.org/a/b/c.tif?sig=x", false)))).toBe(
      "example.org/…/c.tif"
    );
  });
});

describe("withoutQuery", () => {
  it("cuts at the query string or the fragment, a template's placeholders kept", () => {
    expect(withoutQuery("https://example.org/ows?SERVICE=WMS&BBOX={bbox-epsg-3857}")).toBe(
      "https://example.org/ows"
    );
    expect(withoutQuery("https://example.org/a.tif#x")).toBe("https://example.org/a.tif");
    expect(withoutQuery("https://tile.example.org/{z}/{x}/{y}.png")).toBe(
      "https://tile.example.org/{z}/{x}/{y}.png"
    );
  });
});

describe("readableAddress", () => {
  it("shows a percent-encoded name as it reads", () => {
    expect(readableAddress("example.org/…/My%20File%C3%A4.tif")).toBe("example.org/…/My Fileä.tif");
  });

  it("keeps characters that would change the address's shape encoded", () => {
    expect(readableAddress("example.org/a%2Fb.tif?x=%26")).toBe("example.org/a%2Fb.tif?x=%26");
  });

  it("keeps the encoded form when it does not decode", () => {
    expect(readableAddress("example.org/%E0%A4%A.tif")).toBe("example.org/%E0%A4%A.tif");
  });

  it("keeps the encoded form when decoding would bring in invisible or control characters", () => {
    // A right-to-left override would show the name reversed; a line break would split it.
    expect(readableAddress("example.org/%E2%80%AEfit.exe")).toBe("example.org/%E2%80%AEfit.exe");
    expect(readableAddress("example.org/a%0Ab.tif")).toBe("example.org/a%0Ab.tif");
  });

  it.each([
    ["a tag character (U+E0001)", "%F3%A0%80%81"],
    ["a variation selector (U+FE0F)", "%EF%B8%8F"],
    ["a supplementary variation selector (U+E0100)", "%F3%A0%84%80"],
    ["the combining grapheme joiner (U+034F)", "%CD%8F"],
    ["a Hangul choseong filler (U+115F)", "%E1%85%9F"],
    ["a Hangul jungseong filler (U+1160)", "%E1%85%A0"],
    ["the Hangul filler (U+3164)", "%E3%85%A4"],
    ["the halfwidth Hangul filler (U+FFA0)", "%EF%BE%A0"],
    ["an en quad (U+2000)", "%E2%80%80"],
    ["a hair space (U+200A)", "%E2%80%8A"],
    ["the ideographic space (U+3000)", "%E3%80%80"],
  ])("keeps the encoded form when decoding would bring in %s", (_name, encoded) => {
    expect(readableAddress(`example.org/a${encoded}b.tif`)).toBe(`example.org/a${encoded}b.tif`);
  });
});
