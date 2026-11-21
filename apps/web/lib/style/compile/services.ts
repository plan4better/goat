// Map services (spec 9.1, 9.8, 16): the service's own pictures as a raster source, with the image adjustments.
import type { LayerSpecification, SourceSpecification } from "maplibre-gl";

import type { CompileSource } from "@/lib/style/compile/types";
import { combine, fromForm, toProperty } from "@/lib/style/compile/values";
import { type JsonObject, isObject } from "@/lib/style/json";

type ServiceSource = Extract<CompileSource, { type: "service" }>;

/** The WMS URL with `STYLES` set to the chosen service style, once per service layer the URL draws (WMS lists one
 * style per layer); the `{bbox-epsg-3857}` placeholder stays as it is. */
export function withServiceStyle(url: string, style: string, layers = 1): string {
  const value = Array.from({ length: Math.max(1, layers) }, () => encodeURIComponent(style)).join(",");
  const replaced = url.replace(/([?&]STYLES=)[^&]*/i, `$1${value}`);
  if (replaced !== url || /[?&]STYLES=/i.test(url)) return replaced;
  return `${url}${url.includes("?") ? "&" : "?"}STYLES=${value}`;
}

export function serviceSource(source: ServiceSource, style: JsonObject): SourceSpecification {
  const render = isObject(style.render) ? style.render : {};
  const tiles =
    source.service === "wms" && typeof render.service_style === "string"
      ? withServiceStyle(source.tiles, render.service_style, source.layers)
      : source.tiles;
  return { type: "raster", tiles: [tiles], tileSize: source.tileSize ?? 256 };
}

/** The paint of a raster layer drawn as an image (spec 9.1): the layer opacity and, for images, the adjustments. Each
 * may vary by zoom (spec 4.5); a property equal to MapLibre's default is left out. */
export function imagePaint(style: JsonObject, adjustments = true): Record<string, unknown> {
  const paint: Record<string, unknown> = {};
  const set = (key: string, value: unknown, unset: number) => {
    const property = toProperty(value as Parameters<typeof toProperty>[0]);
    if (property !== unset) paint[key] = property;
  };
  set("raster-opacity", fromForm(style.opacity, "number", 1), 1);
  if (!adjustments) return paint;
  // brightness b: min = max(0, b), max = min(1, 1 + b) (spec 9.1)
  const brightness = fromForm(style.brightness, "number", 0);
  set(
    "raster-brightness-min",
    combine([brightness], ([b]) => ["max", 0, b], { kind: "number" }),
    0
  );
  set(
    "raster-brightness-max",
    combine([brightness], ([b]) => ["min", 1, ["+", 1, b]], { kind: "number" }),
    1
  );
  set("raster-contrast", fromForm(style.contrast, "number", 0), 0);
  set("raster-saturation", fromForm(style.saturation, "number", 0), 0);
  set("raster-hue-rotate", fromForm(style.hue, "number", 0), 0);
  return paint;
}

/** The layer zooms of a raster style (the whole layer, spec 3.5). */
export function zoomRange(style: JsonObject): { minzoom?: number; maxzoom?: number } {
  return {
    ...(typeof style.min_zoom === "number" && style.min_zoom > 0 ? { minzoom: style.min_zoom } : {}),
    ...(typeof style.max_zoom === "number" && style.max_zoom < 24 ? { maxzoom: style.max_zoom } : {}),
  };
}

/** The raster layer of a map service; a service sends finished pictures, so every render draws them as an image. */
export function serviceLayer(id: string, sourceId: string, style: JsonObject): LayerSpecification {
  const paint = imagePaint(style);
  if (style.resampling === "nearest") paint["raster-resampling"] = "nearest";
  const layer = { id: `${id}-raster`, type: "raster", source: sourceId, ...zoomRange(style), paint };
  return layer as unknown as LayerSpecification;
}
