// A catalog dataset's preview sample, drawn with its own style through the same compiler as every map (spec 16), so
// the preview matches the layer the dataset becomes once added. Only a GOAT Style document of major 1 is drawn;
// anything else (another major, or no geometry type) leaves the caller's plain footprint rendering.
import type { Geometry } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";
import type { RenderLayer } from "@/lib/style/render/mapLayers";
import { isDrawableStyle } from "@/lib/style/version";

/** The style asset as served: a GOAT Style document (the catalog upgrades older styles on read). */
export type CatalogStyle = Record<string, unknown>;

/** The renderer's key of the sample: its MapLibre layers are `catalog-sample-<part>`. */
export const CATALOG_SAMPLE_KEY = "catalog-sample";

const GEOMETRIES = new Set(["point", "line", "polygon"]);

/** The style without its zoom range: a preview opens framed on the whole dataset, often below the layer's min_zoom. */
function previewStyle(style: Record<string, unknown>): LayerStyle {
  const { min_zoom: _min, max_zoom: _max, ...rest } = style;
  return rest as unknown as LayerStyle;
}

/** A raster item drawn from geoapi's raster tiles (`catalogRasterSource`), colored by its style as a project draws it. */
export function catalogRasterLayer(
  style: unknown,
  source: { tiles: string; tileset: string; coverage: string } | null
): RenderLayer | undefined {
  if (!source || !isDrawableStyle(style) || style.kind !== "raster") return undefined;
  return {
    key: CATALOG_SAMPLE_KEY,
    style: previewStyle(style),
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
  if (!tilesUrl || !isDrawableStyle(style) || !geometryType || !GEOMETRIES.has(geometryType)) {
    return undefined;
  }
  return {
    key: CATALOG_SAMPLE_KEY,
    style: previewStyle(style),
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
  if (!sample || !isDrawableStyle(style) || !geometryType || !GEOMETRIES.has(geometryType)) {
    return undefined;
  }
  const data: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: sample.features.map((feature, i) => ({ ...feature, id: i + 1 })),
  };
  return {
    key: CATALOG_SAMPLE_KEY,
    style: previewStyle(style),
    geometry: geometryType as Geometry,
    entry: { visible: true },
    source: { type: "points", id: `src-${CATALOG_SAMPLE_KEY}`, data },
    ...(highlight !== undefined ? { highlight } : {}),
  };
}
