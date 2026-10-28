import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getExtent } from "@/lib/api/processes";
import { fetchRasterBounds } from "@/lib/api/rasters";
import {
  boundsOfExtent,
  canZoomTo,
  clearLayerBoundsCache,
  resolveLayerBounds,
  storedBounds,
  wmsCapabilitiesUrl,
  wmtsCapabilitiesUrl,
} from "@/lib/utils/map/layerExtent";

vi.mock("@/lib/api/processes", () => ({ getExtent: vi.fn() }));
vi.mock("@/lib/api/rasters", () => ({ fetchRasterBounds: vi.fn() }));

const fixture = (name: string) =>
  readFileSync(path.join(__dirname, "../../__tests__/fixtures/capabilities", name), "utf8");

const BERLIN =
  "MULTIPOLYGON(((13.088345 52.3382448,13.7611609 52.3382448,13.7611609 52.6755087,13.088345 52.6755087,13.088345 52.3382448)))";
const WORLD = "POLYGON((-180 -90, -180 90, 180 90, 180 -90, -180 -90))";
const WMS_GETMAP =
  "https://www.wms.nrw.de/geobasis/wms_nw_dop?bbox={bbox-epsg-3857}&service=WMS&REQUEST=GetMap&layers=nw_dop_rgb&FORMAT=image/png&TRANSPARENT=true&WIDTH=256&HEIGHT=256&SRS=EPSG:3857&CRS=EPSG:3857&VERSION=1.3.0&STYLES=default";
const WMTS_TILES =
  "https://sgx.geodatenzentrum.de/wmts_basemapde/tile/1.0.0/de_basemapde_web_raster_farbe/default/GLOBAL_WEBMERCATOR/{z}/{y}/{x}.png";

describe("boundsOfExtent", () => {
  it("reads a WKT multipolygon as west, south, east, north", () => {
    expect(boundsOfExtent(BERLIN)).toEqual([13.088345, 52.3382448, 13.7611609, 52.6755087]);
  });

  it("reads a point as a box of no size", () => {
    expect(boundsOfExtent("POINT(13.4 52.5)")).toEqual([13.4, 52.5, 13.4, 52.5]);
  });

  it("reads an EWKT extent", () => {
    expect(boundsOfExtent("SRID=4326;POLYGON((1 2, 3 2, 3 4, 1 4, 1 2))")).toEqual([1, 2, 3, 4]);
  });

  it.each([null, undefined, "", "   ", "not wkt", "POLYGON EMPTY"])("has no bounds for %j", (value) => {
    expect(boundsOfExtent(value)).toBeUndefined();
  });

  it("clamps coordinates outside WGS84 into it", () => {
    expect(boundsOfExtent("POLYGON((-190 -95, 190 -95, 190 95, -190 95, -190 -95))")).toEqual([
      -180, -90, 180, 90,
    ]);
  });
});

describe("storedBounds", () => {
  it("takes no world box for an extent: that is the default of a layer without one", () => {
    expect(storedBounds({ extent: WORLD })).toBeUndefined();
    expect(
      storedBounds({ extent: "POLYGON((-180 -90, 180 -90, 180 90, -180 90, -180 -90))" })
    ).toBeUndefined();
    expect(storedBounds({ extent: BERLIN })).toEqual([13.088345, 52.3382448, 13.7611609, 52.6755087]);
  });
});

describe("capabilities addresses", () => {
  it("asks a WMS for its capabilities at the GetMap endpoint, keeping the server's own parameters", () => {
    expect(wmsCapabilitiesUrl(WMS_GETMAP)).toBe(
      "https://www.wms.nrw.de/geobasis/wms_nw_dop?SERVICE=WMS&REQUEST=GetCapabilities"
    );
    expect(wmsCapabilitiesUrl("https://maps.example/cgi?map=/srv/a.map&LAYERS=a&REQUEST=GetMap")).toBe(
      "https://maps.example/cgi?map=%2Fsrv%2Fa.map&SERVICE=WMS&REQUEST=GetCapabilities"
    );
  });

  it("finds a RESTful WMTS's capabilities next to its tiles", () => {
    expect(wmtsCapabilitiesUrl(WMTS_TILES)).toBe(
      "https://sgx.geodatenzentrum.de/wmts_basemapde/1.0.0/WMTSCapabilities.xml"
    );
    expect(
      wmtsCapabilitiesUrl(
        "https://geoportal.freiburg.de/mapcache/wmts/1.0.0/fsm/default/FrGoogleMapsCompatible/{z}/{y}/{x}.png"
      )
    ).toBe("https://geoportal.freiburg.de/mapcache/wmts/1.0.0/WMTSCapabilities.xml");
  });

  it("asks a KVP WMTS for its capabilities", () => {
    expect(
      wmtsCapabilitiesUrl(
        "https://maps.example/wmts?SERVICE=WMTS&REQUEST=GetTile&LAYER=a&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}"
      )
    ).toBe("https://maps.example/wmts?SERVICE=WMTS&REQUEST=GetCapabilities");
  });

  it("has no capabilities address for a bare tile template", () => {
    expect(
      wmtsCapabilitiesUrl("https://wmtsod1.bayernwolke.de/wmts/by_webkarte/smerc/{z}/{x}/{y}")
    ).toBeUndefined();
    expect(wmtsCapabilitiesUrl(undefined)).toBeUndefined();
  });
});

describe("canZoomTo", () => {
  it("offers zoom to for a layer with a stored extent", () => {
    expect(canZoomTo({ type: "raster", data_type: "xyz", extent: BERLIN })).toBe(true);
  });

  it("never offers it for an XYZ layer without an extent: a tile template says nothing about its area", () => {
    expect(canZoomTo({ type: "raster", data_type: "xyz", url: "https://t/{z}/{x}/{y}.png" })).toBe(false);
    // The schema's world default is no extent either.
    expect(canZoomTo({ type: "raster", data_type: "xyz", extent: WORLD })).toBe(false);
  });

  it("never offers it for a WMTS without an extent whose capabilities cannot be found", () => {
    expect(
      canZoomTo({
        type: "raster",
        data_type: "wmts",
        url: "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
      })
    ).toBe(false);
    expect(canZoomTo({ type: "raster", data_type: "wmts", url: WMTS_TILES })).toBe(true);
  });

  it("offers it for a COG and a WMS without an extent: the file and the service tell", () => {
    expect(canZoomTo({ type: "raster", data_type: "cog", url: "https://x/a.tif" })).toBe(true);
    expect(canZoomTo({ type: "raster", data_type: "wms", url: WMS_GETMAP })).toBe(true);
  });

  it("never offers it for a table: it has no geometry", () => {
    expect(canZoomTo({ type: "table" })).toBe(false);
  });
});

describe("resolveLayerBounds", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearLayerBoundsCache();
    vi.mocked(getExtent).mockReset();
    vi.mocked(fetchRasterBounds).mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a feature layer's stored extent without asking", async () => {
    const bounds = await resolveLayerBounds({ type: "feature", layer_id: "l1", extent: BERLIN });
    expect(bounds).toEqual([13.088345, 52.3382448, 13.7611609, 52.6755087]);
    expect(getExtent).not.toHaveBeenCalled();
  });

  it("measures a filtered feature layer's rows", async () => {
    vi.mocked(getExtent).mockResolvedValue({ bbox: [13.3, 52.4, 13.5, 52.6] } as never);
    const cql = { op: "=", args: [{ property: "a" }, 1] };
    const bounds = await resolveLayerBounds({
      type: "feature",
      layer_id: "l1",
      extent: BERLIN,
      query: { cql },
    });
    expect(getExtent).toHaveBeenCalledWith("l1", JSON.stringify(cql));
    expect(bounds).toEqual([13.3, 52.4, 13.5, 52.6]);
  });

  it("measures a feature layer stored without an extent", async () => {
    vi.mocked(getExtent).mockResolvedValue({ bbox: [1, 2, 3, 4] } as never);
    expect(await resolveLayerBounds({ type: "feature", layer_id: "l1", extent: WORLD })).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("falls back to the stored extent when measuring fails", async () => {
    vi.mocked(getExtent).mockRejectedValue(new Error("down"));
    const bounds = await resolveLayerBounds({
      type: "feature",
      layer_id: "l1",
      extent: BERLIN,
      other_properties: { catalog_item: {} },
    });
    expect(bounds).toEqual([13.088345, 52.3382448, 13.7611609, 52.6755087]);
  });

  it("reads a COG's bounds from geoapi, never from the processes extent", async () => {
    vi.mocked(fetchRasterBounds).mockResolvedValue([13.53, 51.36, 15.17, 52.37]);
    const layer = { type: "raster", data_type: "cog", layer_id: "c1", url: "https://x/tci.tif" };
    expect(await resolveLayerBounds(layer)).toEqual([13.53, 51.36, 15.17, 52.37]);
    expect(getExtent).not.toHaveBeenCalled();
    // Once per layer.
    await resolveLayerBounds(layer);
    expect(fetchRasterBounds).toHaveBeenCalledTimes(1);
  });

  it("reads a WMS layer's bounds from the service's capabilities", async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => fixture("wms-1.3.0.xml") });
    const bounds = await resolveLayerBounds({
      type: "raster",
      data_type: "wms",
      layer_id: "w1",
      url: WMS_GETMAP,
      other_properties: { layers: ["nw_dop_rgb"] },
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://www.wms.nrw.de/geobasis/wms_nw_dop?SERVICE=WMS&REQUEST=GetCapabilities"
    );
    expect(bounds).toEqual([5.8, 50.3, 9.5, 52.6]);
  });

  it("takes a WMS layer's names from its address when the layer stores none", async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => fixture("wms-1.3.0.xml") });
    const bounds = await resolveLayerBounds({
      type: "raster",
      data_type: "wms",
      layer_id: "w2",
      url: WMS_GETMAP,
    });
    expect(bounds).toEqual([5.8, 50.3, 9.5, 52.6]);
  });

  it("reads a WMTS layer's bounds from the service's capabilities", async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => fixture("wmts-1.0.0.xml") });
    const bounds = await resolveLayerBounds({
      type: "raster",
      data_type: "wmts",
      layer_id: "t1",
      url: WMTS_TILES,
      other_properties: { layers: ["de_basemapde_web_raster_farbe"] },
    });
    expect(bounds).toEqual([5.5, 47.2, 15.5, 55.1]);
  });

  it("has no bounds when the service cannot be read, and asks again next time", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("CORS"));
    const layer = { type: "raster", data_type: "wms", layer_id: "w3", url: WMS_GETMAP };
    expect(await resolveLayerBounds(layer)).toBeUndefined();
    fetchMock.mockResolvedValue({ ok: true, text: async () => fixture("wms-1.3.0.xml") });
    expect(await resolveLayerBounds(layer)).toEqual([5.8, 50.3, 9.5, 52.6]);
  });

  it("has no bounds for an XYZ layer", async () => {
    expect(
      await resolveLayerBounds({ type: "raster", data_type: "xyz", url: "https://t/{z}/{x}/{y}.png" })
    ).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
