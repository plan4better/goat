// A catalog dataset's preview sample, drawn with its own style through the same compiler as every map (spec 16), so
// the preview matches the layer the dataset becomes once added. Only a GOAT Style document is drawn; anything else
// (or no geometry type) leaves the caller's plain footprint rendering.
import type { Geometry } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";
import { isObject } from "@/lib/style/json";
import type { RenderLayer } from "@/lib/style/render/mapLayers";

/** The style asset as served: a GOAT Style document (the catalog upgrades older styles on read). */
export type CatalogStyle = Record<string, unknown>;

/** The renderer's key of the sample: its MapLibre layers are `catalog-sample-<part>`. */
export const CATALOG_SAMPLE_KEY = "catalog-sample";

const GEOMETRIES = new Set(["point", "line", "polygon"]);

/** A raster layer drawn by the catalog's raster tiles, colored by its style as a project draws it. */
export function catalogRasterLayer(
  style: unknown,
  source: { tiles: string; dem: string } | null
): RenderLayer | undefined {
  if (!source || !isObject(style) || style.version !== 1 || style.kind !== "raster") return undefined;
  return {
    key: CATALOG_SAMPLE_KEY,
    style: style as unknown as LayerStyle,
    entry: { visible: true },
    source: { type: "raster", id: `src-${CATALOG_SAMPLE_KEY}-raster`, ...source },
  };
}

/** The layer's published tiles as a render layer, drawn with its style like a project layer is. */
export function catalogTilesLayer(
  style: unknown,
  geometryType: string | undefined,
  tilesUrl: string | null,
  highlight?: number
): RenderLayer | undefined {
  if (!tilesUrl || !isObject(style) || style.version !== 1 || !geometryType || !GEOMETRIES.has(geometryType)) {
    return undefined;
  }
  return {
    key: CATALOG_SAMPLE_KEY,
    style: style as unknown as LayerStyle,
    geometry: geometryType as Geometry,
    entry: { visible: true },
    source: { type: "tiles", id: `src-${CATALOG_SAMPLE_KEY}-tiles`, tiles: [tilesUrl] },
    ...(highlight !== undefined ? { highlight } : {}),
  };
}

/** The sample as a render layer; features are numbered from 1 so the active one can be highlighted by feature state. */
export function catalogSampleLayer(
  style: unknown,
  geometryType: string | undefined,
  sample: GeoJSON.FeatureCollection | null,
  highlight?: number
): RenderLayer | undefined {
  if (!sample || !isObject(style) || style.version !== 1 || !geometryType || !GEOMETRIES.has(geometryType)) {
    return undefined;
  }
  const data: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: sample.features.map((feature, i) => ({ ...feature, id: i + 1 })),
  };
  return {
    key: CATALOG_SAMPLE_KEY,
    style: style as unknown as LayerStyle,
    geometry: geometryType as Geometry,
    entry: { visible: true },
    source: { type: "points", id: `src-${CATALOG_SAMPLE_KEY}`, data },
    ...(highlight !== undefined ? { highlight } : {}),
  };
}
