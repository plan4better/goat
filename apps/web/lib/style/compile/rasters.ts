// Raster files (spec 9) drawn from geoapi's raster service: the coloring travels in the tile URL as a token, so the
// service colors the cells for every render type and screen, print and thumbnails draw the same tiles. Terrain is
// MapLibre's hillshade over the service's Terrarium elevation tiles.
import type { LayerSpecification } from "maplibre-gl";

import { imagePaint, zoomRange } from "@/lib/style/compile/services";
import type { CompileSource, CompiledLayer } from "@/lib/style/compile/types";
import { combine, fromForm, toProperty } from "@/lib/style/compile/values";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { type JsonObject, isObject } from "@/lib/style/json";
import { rasterColorSpec } from "@/lib/style/raster/color";
import { MAX_TOKEN_LENGTH, rasterToken } from "@/lib/style/raster/token";

type RasterSource = Extract<CompileSource, { type: "raster" }>;

/** The service's tiles are 256 px. */
const TILE_SIZE = 256;

/** A URL template with query parameters added. */
function withQuery(template: string, params: Record<string, string | undefined>): string {
  const query = Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  if (!query) return template;
  return `${template}${template.includes("?") ? "&" : "?"}${query}`;
}

const rgbOf = (hex: string): [number, number, number] => {
  const h = hex.replace(/^#/, "");
  const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h.slice(0, 6);
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
};

/** The hillshade paint (spec 9.6): one light, or GDAL's four for `multidirectional`; the layer opacity goes into
 * the colors' alpha, since a hillshade has no opacity of its own. */
function hillshadePaint(style: JsonObject, render: JsonObject): Record<string, unknown> {
  const pick = <T>(key: string): T => (render[key] ?? DEFAULTS[`terrain.${key}`]) as T;
  const method = pick<string>("method");
  const direction = pick<number>("direction");
  const altitude = pick<number>("altitude");
  const opacity = fromForm(style.opacity, "number", 1);
  const color = (hex: string) =>
    toProperty(
      combine(
        [opacity],
        ([a]) => {
          const [r, g, b] = rgbOf(hex);
          return `rgba(${r}, ${g}, ${b}, ${typeof a === "number" ? Number(a.toFixed(4)) : 1})`;
        },
        { kind: "color" }
      )
    );
  const lights =
    method === "multidirectional"
      ? [-90, -45, 0, 45].map((d) => (((direction + d) % 360) + 360) % 360)
      : null;
  const shadow = color(pick<string>("shadow_color"));
  const highlight = color(pick<string>("highlight_color"));
  // A color array cannot be an expression over zoom: several lights take the opacity at the last zoom stop.
  const flat = (c: unknown) => (Array.isArray(c) && c[0] === "interpolate" ? c[c.length - 1] : c);
  const paint: Record<string, unknown> = {
    "hillshade-method": method,
    "hillshade-illumination-direction": lights ?? direction,
    "hillshade-illumination-altitude": lights ? lights.map(() => altitude) : altitude,
    "hillshade-exaggeration": pick<number>("exaggeration"),
    "hillshade-shadow-color": lights ? lights.map(() => flat(shadow)) : shadow,
    "hillshade-highlight-color": lights ? lights.map(() => flat(highlight)) : highlight,
  };
  if (method === "standard") paint["hillshade-accent-color"] = color(pick<string>("accent_color"));
  if (style.resampling === "nearest") paint.resampling = "nearest";
  return paint;
}

/** The layers of a raster file style; its sources and colorings go into `out`. */
export function rasterLayers(
  id: string,
  source: RasterSource,
  style: JsonObject,
  out: CompiledLayer
): LayerSpecification[] {
  const render: JsonObject = isObject(style.render) ? style.render : { type: "image" };
  const spec = rasterColorSpec(render);
  const token = spec ? rasterToken(spec) : null;
  // A coloring too long for a URL (several hundred categories) is not sent (spec 19: raster_service).
  if (token && token.length > MAX_TOKEN_LENGTH) {
    out.unsupported.push("raster_service");
    return [];
  }
  const zooms = zoomRange(style);
  const layers: LayerSpecification[] = [];
  if (token) {
    out.sources[source.id] = {
      type: "raster",
      tiles: [withQuery(source.tiles, { style: token, v: source.version })],
      tileSize: TILE_SIZE,
    };
    const paint = imagePaint(style, render.type === "image" || render.type === undefined);
    // Categories keep their cells sharp unless the style says otherwise (spec 9).
    const resampling = style.resampling ?? (render.type === "categorical" ? "nearest" : undefined);
    if (resampling === "nearest") paint["raster-resampling"] = "nearest";
    layers.push({
      id: `${id}-raster`,
      type: "raster",
      source: source.id,
      ...zooms,
      paint,
    } as LayerSpecification);
  }
  if (render.type === "terrain") {
    const dem = `${source.id}-dem`;
    out.sources[dem] = {
      type: "raster-dem",
      tiles: [withQuery(source.dem, { v: source.version })],
      tileSize: TILE_SIZE,
      encoding: "terrarium",
    };
    layers.push({
      id: `${id}-hillshade`,
      type: "hillshade",
      source: dem,
      ...zooms,
      paint: hillshadePaint(style, render),
    } as LayerSpecification);
  }
  return layers;
}
