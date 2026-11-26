// Map services (spec 9.1, 9.8, 16): the service's own pictures as a raster source, with the image adjustments.
import type { LayerSpecification, SourceSpecification } from "maplibre-gl";

import { layerBlend } from "@/lib/style/compile/parts";
import type { CompileSource } from "@/lib/style/compile/types";
import { combine, fromForm, toProperty } from "@/lib/style/compile/values";
import { type JsonObject, isObject } from "@/lib/style/json";
import { rgbOf } from "@/lib/style/raster/color";
import { xyzTiles } from "@/lib/transformers/xyz";

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
  const tileSize = source.tileSize ?? 256;
  // An XYZ template's subdomains and TMS rows, which MapLibre has no placeholders for.
  if (source.service === "xyz") return { type: "raster", ...xyzTiles(source.tiles), tileSize };
  const render = isObject(style.render) ? style.render : {};
  const tiles =
    source.service === "wms" && typeof render.service_style === "string"
      ? withServiceStyle(source.tiles, render.service_style, source.layers)
      : source.tiles;
  return { type: "raster", tiles: [tiles], tileSize };
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

/** What MapLibre's raster layer does to an image's colors with the style's adjustments (`imagePaint`), for colors the
 * map draws without one: an image drawn from value tiles with its file's color table (compile/rasters.ts). The lines
 * of MapLibre's raster.fragment.glsl with the uniforms of raster_program.ts: the hue spun, then saturation (toward the
 * average of the color before the spin), contrast and brightness, and the result clamped once, as the framebuffer does
 * for an opaque color (MapLibre clamps the color times its alpha, so a partly transparent one brightened past 1 differs).
 * Full contrast keeps a finite factor: with full brightness the result is one flat color, never an unreadable one.
 * Takes and gives "#rrggbb"; null without adjustments (null counts as none). The adjustments must be numbers: a color
 * cannot vary by zoom. */
export function imageAdjustment(style: JsonObject): ((color: string) => string) | null {
  const of = (key: string) => (typeof style[key] === "number" ? (style[key] as number) : 0);
  const [brightness, contrast, saturation, hue] = ["brightness", "contrast", "saturation", "hue"].map(of);
  if (!brightness && !contrast && !saturation && !hue) return null;
  const low = Math.max(0, brightness);
  const high = Math.min(1, 1 + brightness);
  const angle = (hue * Math.PI) / 180;
  const [s, c] = [Math.sin(angle), Math.cos(angle)];
  const w = [(2 * c + 1) / 3, (-Math.sqrt(3) * s - c + 1) / 3, (Math.sqrt(3) * s - c + 1) / 3];
  const saturate = saturation > 0 ? 1 - 1 / (1.001 - saturation) : -saturation;
  const stretch = contrast > 0 ? 1 / Math.max(1e-6, 1 - contrast) : 1 + contrast;
  return (color) => {
    const [r, g, b] = rgbOf(color).map((v) => v / 255);
    const average = (r + g + b) / 3;
    // dot(rgb, w.xyz), dot(rgb, w.zxy), dot(rgb, w.yzx)
    const spun = [
      r * w[0] + g * w[1] + b * w[2],
      r * w[2] + g * w[0] + b * w[1],
      r * w[1] + g * w[2] + b * w[0],
    ];
    return `#${spun
      .map((v) => v + (average - v) * saturate)
      .map((v) => (v - 0.5) * stretch + 0.5)
      .map((v) => low + (high - low) * v)
      .map((v) =>
        Math.round(Math.min(1, Math.max(0, v)) * 255)
          .toString(16)
          .padStart(2, "0")
      )
      .join("")}`;
  };
}

/** The layer zooms of a raster style (the whole layer, spec 3.5). */
export function zoomRange(style: JsonObject): { minzoom?: number; maxzoom?: number } {
  return {
    ...(typeof style.min_zoom === "number" && style.min_zoom > 0 ? { minzoom: style.min_zoom } : {}),
    ...(typeof style.max_zoom === "number" && style.max_zoom < 24 ? { maxzoom: style.max_zoom } : {}),
  };
}

/** The raster layer of a map service; a service sends finished pictures, so every render draws them as an image, with
 * the layer's blend (spec 4.7). */
export function serviceLayer(id: string, sourceId: string, style: JsonObject): LayerSpecification {
  const paint = imagePaint(style);
  if (style.resampling === "nearest") paint["raster-resampling"] = "nearest";
  const blend = layerBlend(style);
  if (blend) paint["raster-layer-blend"] = blend;
  const layer = { id: `${id}-raster`, type: "raster", source: sourceId, ...zoomRange(style), paint };
  return layer as unknown as LayerSpecification;
}
