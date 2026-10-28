// Where a layer's data comes from, for the compiler (spec 16): geoapi's vector tiles with the layer's filter, the
// points themselves for clusters, geoapi's raster service for a raster file, a map service, or features held in the
// browser. The compiler adds
// the style's parts (label anchors, line decorations) to these URLs.
import { GEOAPI_BASE_URL } from "@/lib/constants";
import type { CompileSource } from "@/lib/style/compile/types";
import type { ServiceStyle } from "@/lib/utils/externalService";

/** What a layer row (a project layer, a dataset, a published layer) says about its data. */
export interface SourceLayer {
  /** The layer's key on the map: the project layer id, or the dataset id where there is no project layer. */
  id: number | string;
  /** The dataset (project layers); the key is the dataset where it is missing. */
  layer_id?: string | null;
  type?: string | null;
  data_type?: string | null;
  url?: string | null;
  other_properties?: unknown;
}

/** Where a raster or service layer's pictures come from (the layer's own configuration, spec 9.8). */
export type StyleSourceInfo =
  | { kind: "cog"; url: string }
  | {
      kind: "wms" | "wmts" | "xyz";
      url: string;
      layers?: string[];
      legendUrls?: string[];
      styles?: ServiceStyle[];
      tileSize?: number;
    };

const SERVICES = ["wms", "wmts", "xyz"] as const;

/** A raster layer's file or map service; undefined for vector data. */
export function sourceOf(layer: SourceLayer): StyleSourceInfo | undefined {
  if (layer.type !== "raster" || !layer.url) return undefined;
  if (layer.data_type === "cog") return { kind: "cog", url: layer.url };
  const service = SERVICES.find((s) => s === layer.data_type);
  if (!service) return undefined;
  const props = (layer.other_properties ?? {}) as {
    layers?: string[];
    legend_urls?: string[];
    service_styles?: ServiceStyle[];
    tile_size?: number;
  };
  return {
    kind: service,
    url: layer.url,
    layers: props.layers ?? undefined,
    legendUrls: props.legend_urls ?? undefined,
    styles: props.service_styles ?? undefined,
    tileSize: typeof props.tile_size === "number" ? props.tile_size : undefined,
  };
}

type Cql = Record<string, unknown>;

const isCql = (value: unknown): value is Cql =>
  typeof value === "object" && value !== null && Object.keys(value).length > 0;

/** The layer's filter and the temporary ones (filter widgets, click to filter), all of them applying. */
export function layerFilter(cql?: unknown, extra: unknown[] = []): Cql | undefined {
  const temporary = extra.filter(isCql);
  if (!temporary.length) return isCql(cql) ? cql : undefined;
  return { op: "and", args: isCql(cql) ? [...temporary, cql] : temporary };
}

/** The cache key of a data change: browsers keep tiles for an hour, so for an hour after the dataset changed its tile
 * URLs carry the change's time. */
export function versionParam(updatedAt?: string | null, now = Date.now()): string | undefined {
  if (!updatedAt) return undefined;
  const changed = new Date(updatedAt).getTime();
  if (Number.isNaN(changed) || now - changed >= 3600_000) return undefined;
  return String(Math.floor(changed / 1000));
}

/** The URL of a dataset's points as GeoJSON (clusters are computed from them in the browser). */
export function getClusterGeoJsonUrl(geoapiBaseUrl: string, layerId: string, filter?: string): string {
  const params = new URLSearchParams({ limit: "100000", f: "json" });
  if (filter) params.set("filter", filter);
  return `${geoapiBaseUrl}/collections/${layerId}/items?${params.toString()}`;
}

export interface SourceOptions {
  /** What the style draws from (`sourceKind`): tiles, the points (clusters), a raster file or a map service. */
  kind: "tiles" | "points" | "service" | "raster";
  /** The layer's own filter (CQL2-JSON). */
  cql?: unknown;
  /** Temporary filters, applied together with the layer's. */
  extra?: unknown[];
  /** The feature editor edits this dataset: tiles are made from the table, not from stored PMTiles. */
  dynamic?: boolean;
  /** When the dataset's data last changed (ISO). */
  version?: string | null;
  /** Features held in the browser instead of geoapi's (the feature editor's pending changes). */
  data?: GeoJSON.FeatureCollection;
  /** The source id; `src-<key>` by default, which a basemap switch carries into the new style. */
  id?: string;
  geoapiUrl?: string;
}

/** The compiler's source for a layer; null when the layer has nothing to draw from. */
export function compileSourceFor(layer: SourceLayer, opts: SourceOptions): CompileSource | null {
  const id = opts.id ?? `src-${layer.id}`;
  if (opts.data) return { type: "points", id, data: opts.data };
  const raster = sourceOf(layer);
  if (raster?.kind === "cog") {
    // The raster service colors the file; the coloring is added to the tile URL by the compiler.
    const base = opts.geoapiUrl ?? GEOAPI_BASE_URL;
    if (!base) return null;
    const root = `${base}/collections/${String(layer.layer_id ?? layer.id)}/raster`;
    const version = versionParam(opts.version);
    return {
      type: "raster",
      id,
      tiles: `${root}/tiles/{z}/{x}/{y}.webp`,
      dem: `${root}/dem/{z}/{x}/{y}.webp`,
      ...(version ? { version } : {}),
    };
  }
  if (raster)
    return {
      type: "service",
      id,
      service: raster.kind,
      tiles: raster.url,
      tileSize: raster.tileSize,
      layers: raster.layers?.length,
    };
  if (opts.kind === "raster" || opts.kind === "service") return null;
  const base = opts.geoapiUrl ?? GEOAPI_BASE_URL;
  if (!base) return null;
  const dataset = String(layer.layer_id ?? layer.id);
  const filter = layerFilter(opts.cql, opts.extra);
  const version = versionParam(opts.version);
  if (opts.kind === "points") {
    // The data version too: a changed URL makes the map read the points again after a data change.
    const url = new URL(getClusterGeoJsonUrl(base, dataset, filter ? JSON.stringify(filter) : undefined));
    if (version) url.searchParams.set("v", version);
    return { type: "points", id, data: url.toString() };
  }
  const params = new URLSearchParams();
  if (filter) params.set("filter", JSON.stringify(filter));
  if (opts.dynamic) params.set("dynamic", "true");
  if (version) params.set("v", version);
  const query = params.toString();
  return {
    type: "tiles",
    id,
    tiles: [`${base}/collections/${dataset}/tiles/WebMercatorQuad/{z}/{x}/{y}${query ? `?${query}` : ""}`],
  };
}
