import { afterEach, describe, expect, it } from "vitest";

import { catalogPreviewRequest, setCatalogPreviewToken } from "@/lib/catalog/preview";

const GEOAPI = "https://geoapi.example";
const TILE = `${GEOAPI}/collections/catalog:x/tiles/WebMercatorQuad/3/4/2`;

afterEach(() => setCatalogPreviewToken(null));

describe("catalogPreviewRequest", () => {
  it("signs the requests of a catalog item's preview", () => {
    setCatalogPreviewToken("token");
    const signed = { headers: { Authorization: "Bearer token" } };
    expect(catalogPreviewRequest(TILE, GEOAPI)).toEqual({ url: TILE, ...signed });
    const values = `${GEOAPI}/collections/catalog:x/coverage/tiles/WebMercatorQuad/3/2/4?f=webp`;
    expect(catalogPreviewRequest(values, GEOAPI)).toEqual({ url: values, ...signed });
  });

  it("gives the token to no other address", () => {
    setCatalogPreviewToken("token");
    for (const url of [
      // A layer's tiles, read as before.
      `${GEOAPI}/collections/abc123/tiles/WebMercatorQuad/3/4/2`,
      // A map service's own server, and one that only quotes the address.
      "https://provider.example/wms?service=WMS&layers=a",
      `https://provider.example/wms?next=${TILE}`,
      // Another host with the same path.
      "https://other.example/collections/catalog:x/tiles/WebMercatorQuad/3/4/2",
      `${GEOAPI}.other.example/collections/catalog:x/tiles/WebMercatorQuad/3/4/2`,
    ]) {
      expect(catalogPreviewRequest(url, GEOAPI), url).toBeUndefined();
    }
  });

  it("signs nothing without a token, or without a geoapi address", () => {
    expect(catalogPreviewRequest(TILE, GEOAPI)).toBeUndefined();
    setCatalogPreviewToken("token");
    expect(catalogPreviewRequest(TILE, "")).toBeUndefined();
  });
});
