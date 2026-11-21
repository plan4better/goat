import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import {
  ServiceConnectError,
  buildLayerRequest,
  capabilitiesRequestUrl,
  defaultLayerName,
  detectDirectService,
  parseCapabilities,
  previewSource,
  selectionBounds,
} from "@/lib/utils/externalService";

const fixture = (name: string) => readFileSync(path.join(__dirname, "fixtures/capabilities", name), "utf8");

const WMS_URL = "https://www.wms.nrw.de/geobasis/wms_nw_dop?SERVICE=WMS&REQUEST=GetCapabilities";
const WFS_URL =
  "https://www.wfs.nrw.de/geobasis/wfs_nw_alkis_vereinfacht?SERVICE=WFS&REQUEST=GetCapabilities";
const WMTS_URL = "https://sgx.geodatenzentrum.de/wmts_basemapde/1.0.0/WMTSCapabilities.xml";
const FOLDER = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

const layerIds = (service: ReturnType<typeof parseCapabilities>) =>
  service.groups.flatMap((group) => group.layers.map((layer) => layer.id));

describe("detectDirectService", () => {
  it("takes a tile template as an XYZ layer", () => {
    const service = detectDirectService("https://tile.openstreetmap.de/{z}/{x}/{y}.png");
    expect(service).toMatchObject({ kind: "xyz", mode: "live", title: "tile.openstreetmap.de", groups: [] });
  });

  it("takes a .tif link as a COG, named after the file", () => {
    const service = detectDirectService("https://example.org/data/dgm1_32_350_5600.tif?sig=abc");
    expect(service).toMatchObject({ kind: "cog", title: "dgm1_32_350_5600" });
  });

  it("takes a WMTS REST template as a live tile layer", () => {
    const service = detectDirectService(
      "https://example.org/wmts/layer/default/GLOBAL/{TileMatrix}/{TileRow}/{TileCol}.png"
    );
    expect(service?.kind).toBe("wmts");
    expect(previewSource(service!, [])).toEqual({
      kind: "tiles",
      url: "https://example.org/wmts/layer/default/GLOBAL/{z}/{y}/{x}.png",
    });
  });

  it("leaves a capabilities address to the fetch", () => {
    expect(detectDirectService(WMS_URL)).toBeNull();
  });
});

describe("capabilitiesRequestUrl", () => {
  it("keeps an address that already asks for capabilities", () => {
    expect(capabilitiesRequestUrl(WMS_URL)).toBe(WMS_URL);
  });

  it("asks a bare endpoint for its capabilities, guessing the service from the path", () => {
    expect(capabilitiesRequestUrl("https://www.wfs.nrw.de/geobasis/wfs_nw_alkis_vereinfacht")).toBe(
      "https://www.wfs.nrw.de/geobasis/wfs_nw_alkis_vereinfacht?SERVICE=WFS&REQUEST=GetCapabilities"
    );
    expect(capabilitiesRequestUrl("https://maps.example.org/ows?map=/srv/city.map")).toBe(
      "https://maps.example.org/ows?map=%2Fsrv%2Fcity.map&SERVICE=WMS&REQUEST=GetCapabilities"
    );
  });

  it("refuses anything that is not http(s)", () => {
    expect(() => capabilitiesRequestUrl("ftp://example.org/wms")).toThrow(ServiceConnectError);
    expect(() => capabilitiesRequestUrl("not a url")).toThrow(ServiceConnectError);
  });
});

describe("parseCapabilities — WMS", () => {
  const service = parseCapabilities(WMS_URL, fixture("wms-1.3.0.xml"));

  it("reads the service's name, provider and version", () => {
    expect(service).toMatchObject({
      kind: "wms",
      version: "1.3.0",
      title: "Digitale Orthophotos NRW",
      provider: "Geobasis NRW",
      multiple: true,
      mode: "live",
    });
  });

  it("groups named layers under their parents, skipping the root container", () => {
    expect(service.groups.map((group) => group.title)).toEqual([undefined, "Orthophotos"]);
    expect(layerIds(service)).toEqual(["nw_dop_nir", "nw_dop_rgb", "nw_dop_cir"]);
  });

  it("inherits projections and bounds down the whole tree", () => {
    const rgb = service.groups[1].layers[0];
    expect(rgb.crs).toEqual(expect.arrayContaining(["EPSG:3857", "EPSG:25832"]));
    expect(rgb.bounds).toEqual([5.8, 50.3, 9.5, 52.6]);
  });

  it("marks a layer offered only outside Web Mercator as unsupported", () => {
    const nir = service.groups[0].layers[0];
    expect(nir.unsupported).toEqual({ reason: "projection", crs: ["EPSG:25832"] });
    expect(service.groups[1].layers.every((layer) => !layer.unsupported)).toBe(true);
  });

  it("combines several layers into one GetMap URL with their styles and legends", () => {
    const request = buildLayerRequest(service, ["nw_dop_rgb", "nw_dop_cir"], {
      name: "Orthophotos",
      folderId: FOLDER,
    });
    expect(request.kind).toBe("raster");
    if (request.kind !== "raster") return;
    const url = new URL(request.payload.url.replace("{bbox-epsg-3857}", "0,0,1,1"));
    expect(`${url.origin}${url.pathname}`).toBe("https://www.wms.nrw.de/geobasis/wms_nw_dop");
    expect(url.searchParams.get("layers")).toBe("nw_dop_rgb,nw_dop_cir");
    expect(url.searchParams.get("STYLES")).toBe("default,");
    expect(url.searchParams.get("VERSION")).toBe("1.3.0");
    expect(request.payload).toMatchObject({
      type: "raster",
      data_type: "wms",
      name: "Orthophotos",
      folder_id: FOLDER,
      other_properties: { layers: ["nw_dop_rgb", "nw_dop_cir"] },
      extent: "MULTIPOLYGON(((5.8 50.3, 5.8 52.6, 9.5 52.6, 9.5 50.3, 5.8 50.3)))",
    });
    expect(request.payload.other_properties.legend_urls).toHaveLength(2);
  });

  it("keeps a server's own query parameters, such as MapServer's map file", () => {
    const own = parseCapabilities(
      "https://maps.example.org/ows?map=/srv/city.map&SERVICE=WMS&REQUEST=GetCapabilities",
      fixture("wms-1.3.0.xml")
    );
    const request = buildLayerRequest(own, ["nw_dop_rgb"], { name: "x", folderId: FOLDER });
    if (request.kind !== "raster") throw new Error("expected raster");
    const url = new URL(request.payload.url.replace("{bbox-epsg-3857}", "0,0,1,1"));
    expect(url.searchParams.get("map")).toBe("/srv/city.map");
    expect(url.searchParams.getAll("SERVICE")).toEqual([]);
    expect(url.searchParams.get("service")).toBe("WMS");
  });

  it("names the layer after what was picked, in pick order", () => {
    expect(defaultLayerName(service, ["nw_dop_cir", "nw_dop_rgb"])).toBe("DOP colour infrared + DOP colour");
    expect(defaultLayerName(service, [])).toBe("");
  });
});

describe("parseCapabilities — WMTS", () => {
  const service = parseCapabilities(WMTS_URL, fixture("wmts-1.0.0.xml"));

  it("lists one entry per layer, single choice", () => {
    expect(service).toMatchObject({
      kind: "wmts",
      title: "basemap.de WMTS",
      provider: "BKG",
      multiple: false,
    });
    expect(layerIds(service)).toEqual(["de_basemapde_web_raster_farbe", "de_basemapde_utm"]);
  });

  it("marks a layer without a Web Mercator tile matrix set as unsupported", () => {
    const [colour, utm] = service.groups[0].layers;
    expect(colour.unsupported).toBeUndefined();
    expect(utm.unsupported).toEqual({ reason: "projection", crs: ["EPSG:25832"] });
  });

  it("builds an XYZ template from the PNG resource URL", () => {
    expect(previewSource(service, ["de_basemapde_web_raster_farbe"])).toEqual({
      kind: "tiles",
      url: "https://sgx.geodatenzentrum.de/wmts_basemapde/tile/1.0.0/de_basemapde_web_raster_farbe/default/GLOBAL_WEBMERCATOR/{z}/{y}/{x}.png",
    });
    expect(selectionBounds(service, ["de_basemapde_web_raster_farbe"])).toEqual([5.5, 47.2, 15.5, 55.1]);
  });
});

describe("parseCapabilities — WMTS from GeoWebCache", () => {
  const url = "https://example.org/geoserver/gwc/service/wmts?REQUEST=GetCapabilities";
  const service = parseCapabilities(url, fixture("wmts-geowebcache.xml"));
  const layer = (id: string) => service.groups[0].layers.find((entry) => entry.id === id);
  const rest = "https://example.org/geoserver/gwc/service/wmts/rest";

  it("fills the template's placeholders whatever their case, the empty style included", () => {
    expect(layer("ws:quad")?.tileUrl).toBe(`${rest}/ws:quad//WebMercatorQuad/{z}/{y}/{x}?format=image/png`);
  });

  it("draws the EPSG:900913 grid, naming each tile matrix as the service does", () => {
    expect(layer("ws:gridset")?.unsupported).toBeUndefined();
    expect(layer("ws:gridset")?.tileUrl).toBe(
      `${rest}/ws:gridset//EPSG:900913/EPSG:900913:{z}/{y}/{x}?format=image/png`
    );
  });

  it("draws a grid of 512 px tiles that cover what 256 px tiles do at the same level", () => {
    expect(layer("ws:hidpi")?.tileUrl).toBe(
      `${rest}/ws:hidpi//EPSG:900913x2/EPSG:900913x2:{z}/{y}/{x}?format=image/png`
    );
  });

  it("marks only the layer without a resource URL as having no tiles", () => {
    expect(layer("ws:kvp")?.unsupported).toEqual({ reason: "no_tiles" });
    expect(layer("ws:quad")?.unsupported).toBeUndefined();
  });

  it("tells a layer offered only in formats the map can't draw as imagery from a KVP-only one", () => {
    expect(layer("ws:vector")?.unsupported).toEqual({ reason: "format" });
  });

  it("refuses a Web Mercator grid whose levels are not the map's zoom levels", () => {
    expect(layer("ws:offset")?.unsupported).toEqual({ reason: "grid" });
  });

  it("names the projection when no linked grid is Web Mercator, even without a resource URL", () => {
    expect(layer("ws:national")?.unsupported).toEqual({
      reason: "projection",
      crs: ["EPSG:6870", "EPSG:4326"],
    });
  });
});

describe("parseCapabilities — WMTS from QGIS Server, which offers KVP only", () => {
  const url =
    "https://example.org/cgi-bin/qgis_mapserv.fcgi?MAP=/srv/projects/area.qgs&SERVICE=WMTS&REQUEST=GetCapabilities";
  const text = fixture("wmts-qgis-server.xml");

  it("draws a layer without a resource URL through GetTile requests", () => {
    const [layer] = parseCapabilities(url, text).groups[0].layers;
    expect(layer.unsupported).toBeUndefined();
    const tile = new URL(layer.tileUrl!.replace("{z}", "5").replace("{y}", "10").replace("{x}", "16"));
    expect(Object.fromEntries(tile.searchParams)).toEqual({
      MAP: "/srv/projects/area.qgs",
      SERVICE: "WMTS",
      REQUEST: "GetTile",
      VERSION: "1.0.0",
      LAYER: "area",
      STYLE: "default",
      FORMAT: "image/png",
      TILEMATRIXSET: "EPSG:3857",
      TILEMATRIX: "5",
      TILEROW: "10",
      TILECOL: "16",
    });
    expect(tile.pathname).toBe("/cgi-bin/qgis_mapserv.fcgi");
  });

  it("does not request by KVP from a service that does not allow it", () => {
    const restOnly = text.replaceAll("<ows:Value>KVP</ows:Value>", "<ows:Value>RESTful</ows:Value>");
    const [layer] = parseCapabilities(url, restOnly).groups[0].layers;
    expect(layer.unsupported).toEqual({ reason: "no_tiles" });
  });
});

describe("parseCapabilities — WFS", () => {
  it("reads WFS 2.0 feature types as a single choice, copied into GOAT", () => {
    const service = parseCapabilities(WFS_URL, fixture("wfs-2.0.0.xml"));
    expect(service).toMatchObject({
      kind: "wfs",
      version: "2.0.0",
      title: "ALKIS vereinfacht NRW",
      provider: "Geobasis NRW",
      multiple: false,
      mode: "copy",
    });
    expect(layerIds(service)).toEqual(["ave:Flurstueck", "ave:GebaeudeBauwerk"]);
    // Features are reprojected on import, so no projection is unsupported.
    expect(service.groups[0].layers.every((layer) => !layer.unsupported)).toBe(true);
    expect(service.groups[0].layers[0].bounds).toEqual([5.8, 50.3, 9.5, 52.6]);
  });

  it("reads WFS 1.1 feature types, which sit one level deeper", () => {
    const service = parseCapabilities("https://example.org/wfs", fixture("wfs-1.1.0.xml"));
    expect(layerIds(service)).toEqual(["app:baeume"]);
    expect(service.groups[0].layers[0].crs).toEqual(["EPSG:25833"]);
  });

  it("imports the picked feature type through layer_import", () => {
    const service = parseCapabilities(WFS_URL, fixture("wfs-2.0.0.xml"));
    expect(
      buildLayerRequest(service, ["ave:Flurstueck"], { name: "Flurstücke", folderId: FOLDER })
    ).toMatchObject({
      kind: "import",
      payload: {
        name: "Flurstücke",
        folder_id: FOLDER,
        data_type: "wfs",
        url: WFS_URL,
        other_properties: { url: WFS_URL, layers: ["ave:Flurstueck"], srs: "urn:ogc:def:crs:EPSG::25832" },
      },
    });
  });

  it("has no preview source: the features are not there until imported", () => {
    const service = parseCapabilities(WFS_URL, fixture("wfs-2.0.0.xml"));
    expect(previewSource(service, ["ave:Flurstueck"])).toBeNull();
  });
});

describe("parseCapabilities — refusals", () => {
  it("refuses a document that is not a WMS, WMTS or WFS", () => {
    expect(() => parseCapabilities("https://example.org", "<html><body>Geoportal</body></html>")).toThrow(
      expect.objectContaining({ reason: "unrecognised" })
    );
  });

  it("refuses a service with nothing to add", () => {
    const empty = fixture("wfs-2.0.0.xml").replace(/<wfs:FeatureTypeList>[\s\S]*<\/wfs:FeatureTypeList>/, "");
    expect(() => parseCapabilities(WFS_URL, empty)).toThrow(expect.objectContaining({ reason: "empty" }));
  });
});

describe("direct services", () => {
  it("adds an XYZ template as it is", () => {
    const service = detectDirectService("https://tile.openstreetmap.de/{z}/{x}/{y}.png")!;
    expect(buildLayerRequest(service, [], { name: "OSM", folderId: FOLDER })).toMatchObject({
      kind: "raster",
      payload: {
        data_type: "xyz",
        url: "https://tile.openstreetmap.de/{z}/{x}/{y}.png",
        other_properties: {},
      },
    });
  });

  it("previews a COG through the cog protocol", () => {
    const service = detectDirectService("https://example.org/data/dgm1.tif")!;
    expect(previewSource(service, [])).toEqual({
      kind: "cog",
      url: "cog://https://example.org/data/dgm1.tif",
    });
    expect(defaultLayerName(service, [])).toBe("dgm1");
  });
});

describe("service styles", () => {
  const TWO_STYLES = `<?xml version="1.0"?>
<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms" xmlns:xlink="http://www.w3.org/1999/xlink">
  <Service><Name>WMS</Name><Title>Aerial</Title></Service>
  <Capability>
    <Request><GetMap><Format>image/png</Format><DCPType><HTTP><Get><OnlineResource xlink:href="https://wms.example/service?"/></Get></HTTP></DCPType></GetMap></Request>
    <Layer>
      <Title>Root</Title><CRS>EPSG:3857</CRS>
      <Layer>
        <Name>aerial</Name><Title>Aerial photo</Title>
        <Style><Name>default</Name><Title>Colors</Title><LegendURL><Format>image/png</Format><OnlineResource xlink:href="https://wms.example/legend-default.png"/></LegendURL></Style>
        <Style><Name>grey</Name><Title>Grey</Title><LegendURL><Format>image/png</Format><OnlineResource xlink:href="https://wms.example/legend-grey.png"/></LegendURL></Style>
      </Layer>
    </Layer>
  </Capability>
</WMS_Capabilities>`;
  const service = parseCapabilities(
    "https://wms.example/service?SERVICE=WMS&REQUEST=GetCapabilities",
    TWO_STYLES
  );

  it("a layer lists every style the service offers, with its legend", () => {
    expect(service.groups[0].layers[0].styles).toEqual([
      { name: "default", title: "Colors", legendUrl: "https://wms.example/legend-default.png" },
      { name: "grey", title: "Grey", legendUrl: "https://wms.example/legend-grey.png" },
    ]);
  });

  it("adding one service layer stores its styles", () => {
    const request = buildLayerRequest(service, ["aerial"], { name: "Aerial", folderId: FOLDER });
    if (request.kind !== "raster") throw new Error("raster expected");
    expect(request.payload.other_properties.service_styles).toEqual([
      { name: "default", title: "Colors", legendUrl: "https://wms.example/legend-default.png" },
      { name: "grey", title: "Grey", legendUrl: "https://wms.example/legend-grey.png" },
    ]);
  });
});
