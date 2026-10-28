// The area a layer covers, for zoom to layer and every map that opens on a layer: its stored extent where that
// says something, else what the data, the file or the service tells.
import bbox from "@turf/bbox";

import { getExtent } from "@/lib/api/processes";
import { fetchRasterBounds } from "@/lib/api/rasters";
import { isCatalogLayer } from "@/lib/utils/catalog-layer";
import { parseCapabilities, selectionBounds } from "@/lib/utils/externalService";
import { wktToGeoJSON } from "@/lib/utils/map/wkt";

/** West, south, east, north in degrees. */
export type Bounds = [number, number, number, number];

/** What the helpers read of a layer: a project layer, a dataset or a layer tree node all have it. */
export interface ExtentLayer {
  type?: string | null;
  data_type?: string | null;
  layer_id?: string | null;
  url?: string | null;
  extent?: string | null;
  other_properties?: Record<string, unknown> | null;
  query?: { cql?: Record<string, unknown> | null } | null;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const asBounds = (box: unknown): Bounds | undefined => {
  if (!Array.isArray(box) || box.length < 4) return undefined;
  const [w, s, e, n] = box.slice(0, 4).map(Number);
  if (![w, s, e, n].every(Number.isFinite) || s > n) return undefined;
  return [clamp(w, -180, 180), clamp(s, -90, 90), clamp(e, -180, 180), clamp(n, -90, 90)];
};

/** The bounds of a WKT (or EWKT) extent; undefined for none or one that does not parse. */
export function boundsOfExtent(extent: unknown): Bounds | undefined {
  if (typeof extent !== "string" || !extent.trim()) return undefined;
  try {
    const geometry = wktToGeoJSON(extent.trim().replace(/^SRID=\d+;/i, ""));
    if (!geometry) return undefined;
    const box = asBounds(bbox(geometry as never));
    // A bounded box west of east; an empty geometry measures as infinities, which `asBounds` refuses.
    return box && box[0] <= box[2] ? box : undefined;
  } catch {
    return undefined;
  }
}

/** The whole world: what a layer without an extent reads as, once a schema has put in its default. */
export const isWholeWorld = ([w, s, e, n]: Bounds) => e - w >= 359 && n - s >= 170;

/** A layer's stored extent, where it says something: none, or the world box, says nothing. */
export function storedBounds(layer: Pick<ExtentLayer, "extent">): Bounds | undefined {
  const box = boundsOfExtent(layer.extent);
  return box && !isWholeWorld(box) ? box : undefined;
}

/** OGC request parameters GOAT writes itself; a server's own (MapServer's `map=`) are kept. */
const OGC_PARAMS = new Set([
  "bbox",
  "service",
  "request",
  "layers",
  "layer",
  "styles",
  "style",
  "format",
  "transparent",
  "width",
  "height",
  "srs",
  "crs",
  "version",
  "dpi",
  "map_resolution",
  "format_options",
  "tilematrixset",
  "tilematrix",
  "tilerow",
  "tilecol",
]);

const parseUrl = (address: string | null | undefined): URL | undefined => {
  if (!address) return undefined;
  try {
    const url = new URL(address);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
};

const kvpCapabilities = (url: URL, service: "WMS" | "WMTS") => {
  const kept = new URLSearchParams();
  url.searchParams.forEach((value, key) => {
    if (!OGC_PARAMS.has(key.toLowerCase())) kept.append(key, value);
  });
  kept.append("SERVICE", service);
  kept.append("REQUEST", "GetCapabilities");
  return `${url.origin}${url.pathname}?${kept.toString()}`;
};

/** A WMS layer's capabilities address, from the GetMap address it draws from. */
export function wmsCapabilitiesUrl(address: string | null | undefined): string | undefined {
  const url = parseUrl(address);
  return url ? kvpCapabilities(url, "WMS") : undefined;
}

/**
 * A WMTS layer's capabilities address, from the tile address it draws from: a KVP GetTile address asks the same
 * endpoint; a RESTful one keeps them at `{base}/1.0.0/WMTSCapabilities.xml`, with its tiles under `{base}/1.0.0/` or
 * `{base}/tile/1.0.0/`. A bare tile template has none.
 */
export function wmtsCapabilitiesUrl(address: string | null | undefined): string | undefined {
  const url = parseUrl(address);
  if (!url) return undefined;
  const request = [...url.searchParams.entries()].find(([key]) => key.toLowerCase() === "request")?.[1];
  if (request?.toLowerCase() === "gettile") return kvpCapabilities(url, "WMTS");
  const path = decodeURIComponent(url.pathname);
  const at = path.indexOf("/1.0.0/");
  if (at < 0) return undefined;
  const base = path.slice(0, at).replace(/\/tile$/, "");
  return `${url.origin}${base}/1.0.0/WMTSCapabilities.xml`;
}

/**
 * Whether zoom to layer can ever work for `layer`, decided before anything is fetched: not for a table (no geometry),
 * nor for a raster layer stored without an extent that nothing could tell (an XYZ tile template, a WMTS tile
 * template whose capabilities cannot be found).
 */
export function canZoomTo(layer: ExtentLayer): boolean {
  if (layer.type === "table") return false;
  if (storedBounds(layer) || layer.type !== "raster") return true;
  switch (layer.data_type) {
    case "cog":
      return true;
    case "wms":
      return !!wmsCapabilitiesUrl(layer.url);
    case "wmts":
      return !!wmtsCapabilitiesUrl(layer.url);
    default:
      return false;
  }
}

/** The service layer names a WMS or WMTS layer draws: stored with it, else in its address's `LAYERS`. */
const serviceLayerNames = (layer: ExtentLayer): string[] => {
  const stored = layer.other_properties?.["layers"];
  if (Array.isArray(stored) && stored.length) return stored.map(String);
  const url = parseUrl(layer.url);
  const param = url && [...url.searchParams.entries()].find(([key]) => /^layers?$/i.test(key))?.[1];
  return param ? param.split(",").filter(Boolean) : [];
};

/** Lookups already made, by what they asked: a service's capabilities or a file's header is read once. */
const lookups = new Map<string, Promise<Bounds | undefined>>();

/** Forget the lookups (tests). */
export function clearLayerBoundsCache() {
  lookups.clear();
}

const once = (key: string, lookup: () => Promise<Bounds | undefined>): Promise<Bounds | undefined> => {
  const known = lookups.get(key);
  if (known) return known;
  const pending = lookup()
    .catch(() => undefined)
    .then((found) => {
      // A failed read is asked again next time: the service may only have been down.
      if (!found) lookups.delete(key);
      return found;
    });
  lookups.set(key, pending);
  return pending;
};

const serviceBounds = (capabilitiesUrl: string, names: string[]) =>
  once(`service:${capabilitiesUrl}:${names.join(",")}`, async () => {
    if (!names.length) return undefined;
    const response = await fetch(capabilitiesUrl, { headers: { Accept: "application/xml, text/xml, */*" } });
    if (!response.ok) return undefined;
    const service = parseCapabilities(capabilitiesUrl, await response.text());
    return asBounds(selectionBounds(service, names));
  });

/**
 * The area `layer` covers, or undefined where nothing tells.
 *
 * - A feature layer: its rows, measured, when a filter hides some of them, when it is a catalog layer (whose stored
 *   extent is the bbox its provider published, often a whole territory) or when it is stored without an extent;
 *   else, and when measuring fails, the stored extent.
 * - A raster layer: its stored extent; else a COG file's bounds (geoapi reads them from its header), a WMS or
 *   WMTS layer's bounds from the service's capabilities. An XYZ layer has none.
 */
export async function resolveLayerBounds(layer: ExtentLayer): Promise<Bounds | undefined> {
  const stored = storedBounds(layer);
  if (layer.type === "raster") {
    if (stored) return stored;
    if (layer.data_type === "cog" && layer.layer_id) {
      const id = layer.layer_id;
      return once(`cog:${id}`, async () => asBounds(await fetchRasterBounds(id)));
    }
    if (layer.data_type === "wms" || layer.data_type === "wmts") {
      const capabilities =
        layer.data_type === "wms" ? wmsCapabilitiesUrl(layer.url) : wmtsCapabilitiesUrl(layer.url);
      return capabilities ? serviceBounds(capabilities, serviceLayerNames(layer)) : undefined;
    }
    return undefined;
  }
  if (layer.type === "table") return undefined;

  const cql = layer.query?.cql;
  const filtered = !!cql && Object.keys(cql).length > 0;
  if ((filtered || isCatalogLayer(layer as never) || !stored) && layer.layer_id) {
    try {
      const result = await getExtent(layer.layer_id, filtered ? JSON.stringify(cql) : undefined);
      const measured = asBounds(result?.bbox);
      if (measured) return measured;
    } catch {
      // The stored extent below stands in.
    }
  }
  return stored ?? boundsOfExtent(layer.extent);
}
