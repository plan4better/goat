/* eslint-disable @typescript-eslint/no-explicit-any -- OpenLayers' capabilities parsers return untyped documents */
import WMSCapabilities from "ol/format/WMSCapabilities";
import WMTSCapabilities from "ol/format/WMTSCapabilities";

import { generateLayerGetLegendGraphicUrl, generateWmsUrl } from "@/lib/transformers/wms";
import { convertWmtsToXYZUrl } from "@/lib/transformers/wmts";
import WFSCapabilities from "@/lib/utils/parser/ol/format/WFSCapabilities";
import type { CreateLayerFromDataset, CreateRasterLayer } from "@/lib/validations/layer";
import { createLayerFromDatasetSchema, createRasterLayerSchema } from "@/lib/validations/layer";

/**
 * External services a layer can be connected from: what an address is, what the service
 * offers, and the request that adds a picked layer. No fetching and no UI, so every rule
 * about the formats lives here and is tested without a network.
 */

export type ServiceKind = "wms" | "wmts" | "wfs" | "xyz" | "cog";

/** West, south, east, north in WGS84. */
export type LngLatBounds = [number, number, number, number];

export type UnsupportedReason =
  /** Imagery is drawn in Web Mercator; the layer is offered only in these. */
  | { reason: "projection"; crs: string[] }
  /** A WMTS layer with no resource URL, from a service that names no GetTile endpoint for KVP. */
  | { reason: "no_tiles" }
  /** A WMTS whose tiles come only in formats the map cannot draw as imagery, such as vector tiles. */
  | { reason: "format" }
  /** A WMTS whose Web Mercator grid does not match the map's zoom levels, such as one offset by five. */
  | { reason: "grid" };

/** A style a service offers for a layer (WMS `Style`, WMTS `Style`), with its legend. */
export type ServiceStyle = { name: string; title: string; legendUrl?: string };

export type ServiceLayer = {
  /** The service's own name for it, unique within the service. */
  id: string;
  title: string;
  abstract?: string;
  /** Projections it is offered in, normalised to `EPSG:<code>`. */
  crs: string[];
  bounds?: LngLatBounds;
  /** Set when GOAT cannot add it. */
  unsupported?: UnsupportedReason;
  /** WMS: the style drawn and its legend. */
  style?: string;
  legendUrl?: string;
  /** Every style the service offers for the layer, the default first. */
  styles?: ServiceStyle[];
  /** WMTS: the XYZ template the layer is drawn from. */
  tileUrl?: string;
  /** WFS: the CRS as the service names it, passed on to the import. */
  defaultCrs?: string;
};

export type ServiceGroup = { id: string; title?: string; layers: ServiceLayer[] };

export type ConnectedService = {
  kind: ServiceKind;
  /** The address the service was read from. */
  url: string;
  version?: string;
  title: string;
  provider?: string;
  /** WMS draws several layers as one; everything else is one layer at a time. */
  multiple: boolean;
  /** Imagery is drawn live from the service; WFS features are copied into GOAT. */
  mode: "live" | "copy";
  /** Empty for a direct address (tile template, COG): the address is the layer. */
  groups: ServiceGroup[];
  /** WMS: the GetMap endpoint, with the server's own query parameters kept. */
  getMapBase?: string;
};

export type ConnectFailure = "invalid" | "unreachable" | "unrecognised" | "empty";

export class ServiceConnectError extends Error {
  constructor(
    readonly reason: ConnectFailure,
    message?: string
  ) {
    super(message ?? reason);
    this.name = "ServiceConnectError";
  }
}

/** OGC parameters GOAT sets itself; anything else on an address belongs to the server. */
const OGC_PARAMS = new Set(["service", "request", "version", "acceptversions"]);

const WEB_MERCATOR = /(?:^|:)(3857|900913|102100|102113)$/;

const normaliseCrs = (crs: string) => {
  const code = crs.match(/EPSG:{1,2}(\d+)$/i) ?? crs.match(/EPSG\/\d+\/(\d+)$/i);
  return code ? `EPSG:${code[1]}` : crs;
};

const isWebMercator = (crs: string) => WEB_MERCATOR.test(normaliseCrs(crs));

const parseHttpUrl = (address: string): URL => {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    throw new ServiceConnectError("invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ServiceConnectError("invalid");
  return url;
};

const fileStem = (url: URL) => {
  const file = url.pathname.split("/").pop() ?? "";
  return decodeURIComponent(file.replace(/\.[^/.]+$/, "")) || url.hostname;
};

const direct = (kind: ServiceKind, url: string, title: string): ConnectedService => ({
  kind,
  url,
  title,
  multiple: false,
  mode: "live",
  groups: [],
});

/**
 * An address that is itself the layer — a tile template or a COG file — or `null` for one
 * that has to be asked for its capabilities.
 */
export const detectDirectService = (address: string): ConnectedService | null => {
  const trimmed = address.trim();
  let url: URL;
  try {
    url = parseHttpUrl(trimmed);
  } catch {
    return null;
  }
  // `new URL` escapes the braces, so the placeholders are looked for in the raw text.
  const has = (token: string) => trimmed.includes(`{${token}}`);
  if (has("z") && has("x") && has("y") && !has("TileRow") && !has("TileCol"))
    return direct("xyz", trimmed, url.hostname);
  if (has("TileMatrix") && has("TileRow") && has("TileCol") && !has("Style") && !has("TileMatrixSet"))
    return direct("wmts", trimmed, url.hostname);
  if (/\.tiff?$/i.test(url.pathname)) return direct("cog", trimmed, fileStem(url));
  return null;
};

/**
 * The address to read a service's capabilities from. One that already asks for them, or
 * points at a capabilities document, is used as it is; a bare endpoint gets the request
 * added, with the service guessed from the address — the part people most often leave off.
 */
export const capabilitiesRequestUrl = (address: string): string => {
  const url = parseHttpUrl(address);
  const keys = [...url.searchParams.keys()].map((key) => key.toLowerCase());
  if (keys.includes("request") || /\.xml$/i.test(url.pathname)) return address.trim();
  const hint = `${url.pathname}${url.search}`.toLowerCase();
  const service = hint.includes("wfs") ? "WFS" : hint.includes("wmts") ? "WMTS" : "WMS";
  url.searchParams.append("SERVICE", service);
  url.searchParams.append("REQUEST", "GetCapabilities");
  return url.toString();
};

const documentKind = (text: string): "wms" | "wmts" | "wfs" | null => {
  const root = new DOMParser().parseFromString(text, "application/xml").documentElement;
  if (!root || root.getElementsByTagName("parsererror").length) return null;
  const name = root.localName;
  if (name === "WMS_Capabilities" || name === "WMT_MS_Capabilities") return "wms";
  if (name === "WFS_Capabilities") return "wfs";
  if (name === "Capabilities" && (root.namespaceURI ?? "").includes("opengis.net/wmts")) return "wmts";
  return null;
};

const unique = (values: string[]) => [...new Set(values)];

const wmsBounds = (layer: any): LngLatBounds | undefined => {
  const box = layer?.EX_GeographicBoundingBox;
  return Array.isArray(box) && box.length === 4 ? (box as LngLatBounds) : undefined;
};

/**
 * The GetMap endpoint: the address the capabilities came from, less the OGC parameters
 * GOAT sets itself. A server's own parameters (MapServer's `map=`) stay, or every tile
 * request would reach a different map than the one that was browsed.
 */
const getMapBaseOf = (address: string): string => {
  const url = new URL(address);
  const kept = new URLSearchParams();
  url.searchParams.forEach((value, key) => {
    if (!OGC_PARAMS.has(key.toLowerCase())) kept.append(key, value);
  });
  const query = kept.toString();
  return `${url.origin}${url.pathname}${query ? `?${query}` : ""}`;
};

const parseWms = (address: string, text: string): ConnectedService => {
  const doc = new WMSCapabilities().read(text) as any;
  const root = doc?.Capability?.Layer;
  // Layers straight under the root come first: listed after a titled group, they would
  // read as part of it.
  const groups: ServiceGroup[] = [{ id: "root", layers: [] }];
  const groupFor = (id: string, title?: string) => {
    let group = groups.find((entry) => entry.id === id);
    if (!group) {
      group = { id, title, layers: [] };
      groups.push(group);
    }
    return group;
  };

  // OpenLayers merges a layer's CRS with its parent's only one level down, so projections
  // and bounds are inherited here, down the whole tree, as the WMS spec has them.
  const walk = (
    layer: any,
    parent: { crs: string[]; bounds?: LngLatBounds; path: string[]; groupId: string }
  ) => {
    const crs = unique([...parent.crs, ...((layer.CRS as string[] | undefined) ?? [])].map(normaliseCrs));
    const bounds = wmsBounds(layer) ?? parent.bounds;
    if (layer.Name) {
      const style = layer.Style?.[0];
      groupFor(parent.groupId, parent.path.length ? parent.path.join(" › ") : undefined).layers.push({
        id: layer.Name,
        title: layer.Title || layer.Name,
        abstract: layer.Abstract || undefined,
        crs,
        bounds,
        // A document that lists no projection at all cannot be judged; let it through.
        unsupported: crs.length && !crs.some(isWebMercator) ? { reason: "projection", crs } : undefined,
        style: style?.Name ?? "",
        legendUrl: style?.LegendURL?.[0]?.OnlineResource,
        styles: ((layer.Style ?? []) as any[])
          .filter((s) => s?.Name)
          .map((s) => ({
            name: s.Name,
            title: s.Title || s.Name,
            ...(s.LegendURL?.[0]?.OnlineResource ? { legendUrl: s.LegendURL[0].OnlineResource } : {}),
          })),
      });
    }
    const children: any[] = layer.Layer ?? [];
    if (!children.length) return;
    // The root is the service itself; its title is already the service's name.
    const isRoot = layer === root;
    const path = isRoot ? parent.path : [...parent.path, layer.Title || layer.Name];
    const groupId = isRoot ? "root" : `${parent.groupId}/${layer.Name ?? layer.Title}`;
    children.forEach((child) => walk(child, { crs, bounds, path, groupId }));
  };
  if (root) walk(root, { crs: [], path: [], groupId: "root" });

  const service = doc?.Service ?? {};
  return {
    kind: "wms",
    url: address,
    version: doc?.version,
    title: service.Title || new URL(address).hostname,
    provider: service.ContactInformation?.ContactPersonPrimary?.ContactOrganization || undefined,
    multiple: true,
    mode: "live",
    groups: groups.filter((group) => group.layers.length),
    getMapBase: getMapBaseOf(address),
  };
};

/** Web Mercator's extent along the equator, and the pixel size OGC scale denominators assume. */
const WEB_MERCATOR_EXTENT = 2 * Math.PI * 6378137;
const OGC_PIXEL_SIZE = 0.00028;

/**
 * What a tile matrix set names its matrices before the zoom level — `EPSG:900913:` for
 * GeoWebCache's grid, nothing for most — or `null` for a set the map cannot draw as z/x/y:
 * another projection, or a matrix whose tiles do not span the zoom level its name ends in.
 * The span decides, not the scale, so 512 px tiles at twice the resolution draw too.
 */
const zoomMatrixPrefix = (set: any): string | null => {
  const matrices: any[] = set?.TileMatrix ?? [];
  if (!isWebMercator(String(set?.SupportedCRS ?? "")) || !matrices.length) return null;
  let prefix: string | null = null;
  for (const matrix of matrices) {
    const name = String(matrix.Identifier ?? "").match(/^(.*?)(\d+)$/);
    const span = (matrix.TileWidth ?? 256) * matrix.ScaleDenominator * OGC_PIXEL_SIZE;
    const zoom = Math.log2(WEB_MERCATOR_EXTENT / span);
    if (!name || Math.abs(zoom - Number(name[2])) > 0.01) return null;
    if (prefix !== null && name[1] !== prefix) return null;
    prefix = name[1];
  }
  return prefix;
};

/** Tile formats the map can draw, in order of preference. */
const WMTS_TILE_FORMATS = ["image/png", "image/jpeg", "image/tiff", "image/png8"];

/** The first of the formats that the map draws as imagery, in order of preference. */
const drawableFormat = (formats: string[]): string | undefined =>
  WMTS_TILE_FORMATS.map((format) => formats.find((candidate) => candidate.includes(format))).find(Boolean);

/**
 * The GetTile endpoint for KVP requests, less the OGC parameters GOAT sets itself, or
 * `undefined` for a service that does not take them. A service that names no encoding is
 * assumed to take KVP.
 */
const wmtsKvpBase = (doc: any): string | undefined => {
  const endpoints: any[] = doc?.OperationsMetadata?.GetTile?.DCP?.HTTP?.Get ?? [];
  const kvp = endpoints.find((endpoint) => {
    const encoding = (endpoint.Constraint ?? []).find((constraint: any) => constraint.name === "GetEncoding");
    return endpoint.href && (!encoding || (encoding.AllowedValues?.Value ?? []).includes("KVP"));
  });
  return kvp ? getMapBaseOf(kvp.href) : undefined;
};

/** A GetTile request by KVP, written as a resource URL template so it is filled in the same way. */
const kvpTemplate = (base: string, layer: string, format: string) => {
  const fixed = new URLSearchParams({
    SERVICE: "WMTS",
    REQUEST: "GetTile",
    VERSION: "1.0.0",
    LAYER: layer,
    FORMAT: format,
  });
  const placeholders =
    "STYLE={Style}&TILEMATRIXSET={TileMatrixSet}&TILEMATRIX={TileMatrix}&TILEROW={TileRow}&TILECOL={TileCol}";
  return `${base}${base.includes("?") ? "&" : "?"}${fixed}&${placeholders}`;
};

/**
 * Where a WMTS layer's tiles are requested, in the first format the map draws: its resource
 * URL template, or a GetTile request by KVP for a layer without one, as QGIS Server serves.
 * `requestable` is false when the tiles cannot be asked for at all, which is told apart
 * from tiles that come in no format the map draws.
 */
const wmtsTemplate = (layer: any, kvpBase?: string): { template?: string; requestable: boolean } => {
  const resources: any[] = (layer.ResourceURL ?? []).filter(
    (resource: any) => resource.resourceType !== "FeatureInfo"
  );
  if (resources.length) {
    const format = drawableFormat(resources.map((resource) => String(resource.format)));
    const resource = resources.find((candidate) => String(candidate.format) === format);
    return { template: resource?.template, requestable: true };
  }
  if (!kvpBase) return { requestable: false };
  const format = drawableFormat(layer.Format ?? []);
  return { template: format ? kvpTemplate(kvpBase, layer.Identifier, format) : undefined, requestable: true };
};

/** The first grid a WMTS layer links that the map draws as z/x/y, with its matrix prefix. */
const wmtsZoomGrid = (layer: any, matrixSets: any[]): { id: string; prefix: string } | undefined => {
  for (const link of layer.TileMatrixSetLink ?? []) {
    const prefix = zoomMatrixPrefix(matrixSets.find((set) => set.Identifier === link.TileMatrixSet));
    if (prefix !== null) return { id: link.TileMatrixSet, prefix };
  }
  return undefined;
};

/**
 * Why a WMTS layer cannot be drawn, the most fundamental reason first: without Web Mercator,
 * how the tiles are requested does not matter.
 */
const wmtsRefusal = (crs: string[], requestable: boolean, template?: string): UnsupportedReason => {
  if (!crs.some(isWebMercator)) return { reason: "projection", crs };
  if (!requestable) return { reason: "no_tiles" };
  if (!template) return { reason: "format" };
  return { reason: "grid" };
};

const parseWmts = (address: string, text: string): ConnectedService => {
  const doc = new WMTSCapabilities().read(text) as any;
  const layers: any[] = doc?.Contents?.Layer ?? [];
  const matrixSets: any[] = doc?.Contents?.TileMatrixSet ?? [];
  const kvpBase = wmtsKvpBase(doc);

  const entries: ServiceLayer[] = layers.map((layer) => {
    const { template, requestable } = wmtsTemplate(layer, kvpBase);
    const grid = wmtsZoomGrid(layer, matrixSets);
    // Drawn in its first style.
    const tileUrl =
      template && grid
        ? convertWmtsToXYZUrl(template, layer.Style?.[0]?.Identifier ?? "", grid.id, grid.prefix)
        : undefined;
    const linked = (layer.TileMatrixSetLink ?? []).map((link: any) => link.TileMatrixSet);
    const crs = unique(
      matrixSets
        .filter((set) => linked.includes(set.Identifier))
        .map((set) => normaliseCrs(String(set.SupportedCRS ?? "")))
        .filter(Boolean)
    );
    const bounds = Array.isArray(layer.WGS84BoundingBox)
      ? (layer.WGS84BoundingBox as LngLatBounds)
      : undefined;
    return {
      id: layer.Identifier,
      title: layer.Title || layer.Identifier,
      styles: ((layer.Style ?? []) as any[])
        .filter((style) => style?.Identifier)
        .map((style) => ({
          name: style.Identifier,
          title: typeof style.Title === "string" && style.Title ? style.Title : style.Identifier,
          ...(style.LegendURL?.[0]?.href ? { legendUrl: style.LegendURL[0].href } : {}),
        })),
      abstract: layer.Abstract || undefined,
      crs,
      bounds,
      unsupported: tileUrl ? undefined : wmtsRefusal(crs, requestable, template),
      tileUrl,
    };
  });

  return {
    kind: "wmts",
    url: address,
    version: doc?.version,
    title: doc?.ServiceIdentification?.Title || new URL(address).hostname,
    provider: doc?.ServiceProvider?.ProviderName || undefined,
    multiple: false,
    mode: "live",
    groups: entries.length ? [{ id: "root", layers: entries }] : [],
  };
};

const parseWfs = (address: string, text: string): ConnectedService => {
  const doc = new WFSCapabilities().read(text) as any;
  // 2.0 lists feature types directly; 1.x nests them one level deeper.
  const list = doc?.FeatureTypeList;
  const types: any[] = Array.isArray(list) ? list : (list?.FeatureType ?? []);

  const entries: ServiceLayer[] = types
    .filter((type) => type?.Name)
    .map((type) => {
      const defaultCrs: string | undefined = type.DefaultCRS ?? type.DefaultSRS ?? undefined;
      const box = type.WGS84BoundingBox;
      const bounds =
        box?.LowerCorner && box?.UpperCorner
          ? ([box.LowerCorner[0], box.LowerCorner[1], box.UpperCorner[0], box.UpperCorner[1]] as LngLatBounds)
          : undefined;
      // No projection is unsupported: the import reprojects the features.
      return {
        id: type.Name,
        title: type.Title || type.Name,
        abstract: type.Abstract || undefined,
        crs: defaultCrs ? [normaliseCrs(defaultCrs)] : [],
        bounds,
        defaultCrs,
      };
    });

  return {
    kind: "wfs",
    url: address,
    version: doc?.version,
    title: doc?.ServiceIdentification?.Title || new URL(address).hostname,
    provider: doc?.ServiceProvider?.ProviderName || undefined,
    multiple: false,
    mode: "copy",
    groups: entries.length ? [{ id: "root", layers: entries }] : [],
  };
};

/** What a capabilities document offers. Throws `ServiceConnectError` for anything else. */
export const parseCapabilities = (address: string, text: string): ConnectedService => {
  const kind = documentKind(text);
  if (!kind) throw new ServiceConnectError("unrecognised");
  const service =
    kind === "wms"
      ? parseWms(address, text)
      : kind === "wmts"
        ? parseWmts(address, text)
        : parseWfs(address, text);
  if (!service.groups.length) throw new ServiceConnectError("empty");
  return service;
};

/** Every layer the service offers, in list order. */
export const serviceLayers = (service: ConnectedService): ServiceLayer[] =>
  service.groups.flatMap((group) => group.layers);

/** The picked layers GOAT can add, in the order they were picked. */
export const pickedLayers = (service: ConnectedService, ids: string[]): ServiceLayer[] => {
  const layers = serviceLayers(service);
  return ids
    .map((id) => layers.find((layer) => layer.id === id))
    .filter((layer): layer is ServiceLayer => !!layer && !layer.unsupported);
};

export const isDirect = (service: ConnectedService) => service.groups.length === 0;

/** A name the layer can start with: the file or host for an address, else what was picked. */
export const defaultLayerName = (service: ConnectedService, ids: string[]): string =>
  isDirect(service)
    ? service.title
    : pickedLayers(service, ids)
        .map((layer) => layer.title)
        .join(" + ");

/** The area the picked layers cover, if the service says. */
export const selectionBounds = (service: ConnectedService, ids: string[]): LngLatBounds | undefined => {
  const boxes = pickedLayers(service, ids)
    .map((layer) => layer.bounds)
    .filter((box): box is LngLatBounds => !!box);
  if (!boxes.length) return undefined;
  return [
    Math.min(...boxes.map((box) => box[0])),
    Math.min(...boxes.map((box) => box[1])),
    Math.max(...boxes.map((box) => box[2])),
    Math.max(...boxes.map((box) => box[3])),
  ];
};

const wmsTileUrl = (service: ConnectedService, layers: ServiceLayer[]) => {
  const base = service.getMapBase ?? getMapBaseOf(service.url);
  const [path, query] = base.split("?");
  const url = generateWmsUrl(
    path,
    layers.map((layer) => layer.id).join(","),
    layers.map((layer) => layer.style ?? "").join(","),
    service.version
  );
  // `generateWmsUrl` starts its own query; the server's parameters go in front of it.
  return query ? url.replace("?", `?${query}&`) : url;
};

/**
 * What the layer is drawn from: a tile template, a COG, or `null` where nothing can be
 * drawn yet — no layer picked, or WFS features that only exist once imported.
 */
export const previewSource = (
  service: ConnectedService,
  ids: string[]
): { kind: "tiles" | "cog"; url: string } | null => {
  if (service.kind === "cog") return { kind: "cog", url: `cog://${service.url}` };
  if (service.kind === "xyz") return { kind: "tiles", url: service.url };
  if (service.kind === "wmts" && isDirect(service))
    return { kind: "tiles", url: convertWmtsToXYZUrl(service.url) };
  const layers = pickedLayers(service, ids);
  if (!layers.length) return null;
  if (service.kind === "wms") return { kind: "tiles", url: wmsTileUrl(service, layers) };
  if (service.kind === "wmts" && layers[0].tileUrl) return { kind: "tiles", url: layers[0].tileUrl };
  return null;
};

const extentWkt = ([west, south, east, north]: LngLatBounds) =>
  `MULTIPOLYGON(((${west} ${south}, ${west} ${north}, ${east} ${north}, ${east} ${south}, ${west} ${south})))`;

/** What `createLayer` sends to `layer_import`: `url` becomes its `wfs_url`. */
export type WfsImportPayload = CreateLayerFromDataset & { url: string };

export type LayerRequest =
  | { kind: "raster"; payload: CreateRasterLayer }
  | { kind: "import"; payload: WfsImportPayload };

/**
 * The request that adds the picked layers: a raster layer that points at the service, or
 * for a WFS an import job that copies the features into GOAT.
 */
export const buildLayerRequest = (
  service: ConnectedService,
  ids: string[],
  { name, folderId }: { name: string; folderId: string }
): LayerRequest => {
  const layers = pickedLayers(service, ids);

  if (service.kind === "wfs") {
    const [layer] = layers;
    if (!layer) throw new ServiceConnectError("empty");
    return {
      kind: "import",
      payload: {
        ...createLayerFromDatasetSchema.parse({
          name,
          folder_id: folderId,
          data_type: "wfs",
          other_properties: {
            url: service.url,
            layers: [layer.id],
            ...(layer.defaultCrs ? { srs: layer.defaultCrs } : {}),
          },
        }),
        url: service.url,
      },
    };
  }

  const source = previewSource(service, ids);
  if (!source) throw new ServiceConnectError("empty");
  const bounds = selectionBounds(service, ids);
  const otherProperties =
    service.kind === "wms"
      ? {
          layers: layers.map((layer) => layer.id),
          legend_urls: layers.map(
            (layer) =>
              layer.legendUrl ??
              generateLayerGetLegendGraphicUrl(
                (service.getMapBase ?? service.url).split("?")[0],
                layer.id,
                layer.style,
                service.version
              )
          ),
        }
      : service.kind === "wmts" && layers.length
        ? { layers: [layers[0].id] }
        : {};
  // One service layer: the styles it offers, for the style panel's choice (spec 9.8).
  const styles = layers.length === 1 ? layers[0].styles : undefined;
  if (styles?.length) Object.assign(otherProperties, { service_styles: styles });

  return {
    kind: "raster",
    payload: createRasterLayerSchema.parse({
      name,
      folder_id: folderId,
      type: "raster",
      data_type: service.kind,
      // The COG protocol prefix is the map's business; the layer stores the file's address.
      url: service.kind === "cog" ? service.url : source.url,
      ...(bounds ? { extent: extentWkt(bounds) } : {}),
      other_properties: otherProperties,
    }),
  };
};
