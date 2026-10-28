// A raster file's popup (spec 9.7): the cell values under the pointer, on click (the default) or while hovering, of
// the band the style draws (an image's three; a band formula's value under its name) or of every band, from the
// raster service's point query. Map services show none (their feature info comes later, spec 9.8).
import { fetchRasterPoint } from "@/lib/api/rasters";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type JsonObject, isObject } from "@/lib/style/json";
import { type SourceLayer, sourceOf } from "@/lib/style/layerSource";
import { rasterColorSpec } from "@/lib/style/raster/color";
import { rasterToken } from "@/lib/style/raster/token";
import { type PopupProperties, popupProperties } from "@/lib/validations/layer";

export interface PopupRaster extends SourceLayer {
  visible?: boolean;
  style?: { document: LayerStyle } | null;
}

interface RasterPopupRule {
  trigger: "click" | "hover";
  /** "formula": the style's band formula, its value under its name. */
  bands: number[] | "all" | "formula";
}

/** The bands the style draws, or its band formula. */
function styledBands(render: unknown): number[] | "formula" {
  const r = isObject(render) ? render : {};
  if (r.type === "image") {
    const bands = Array.isArray(r.bands) ? r.bands.filter((b): b is number => typeof b === "number") : [];
    return bands.length ? bands : [1, 2, 3];
  }
  if (r.band === undefined || r.band === null) return [1];
  return typeof r.band === "number" ? [r.band] : "formula";
}

/** The style's band formula name. */
function formulaName(layer: PopupRaster): string {
  const render = (layer.style?.document as { render?: unknown } | undefined)?.render;
  const band = isObject(render) ? render.band : undefined;
  return isObject(band) && typeof band.name === "string" && band.name ? band.name : "Value";
}

/** A COG layer's popup rule; undefined for vector data, map services and a popup turned off. */
export function rasterPopupOf(layer: PopupRaster): RasterPopupRule | undefined {
  const style = layer.style?.document;
  if (style?.kind !== "raster" || sourceOf(layer)?.kind !== "cog") return undefined;
  const popup = (style as { popup?: unknown }).popup;
  if (popup === false || (isObject(popup) && popup.enabled === false)) return undefined;
  const record = isObject(popup) ? popup : {};
  return {
    trigger: record.trigger === "hover" ? "hover" : "click",
    bands: record.bands === "all" ? "all" : styledBands((style as { render?: unknown }).render),
  };
}

/** The topmost drawn file (layers top first) whose popup opens on `trigger`. */
export function rasterPopupLayer<T extends PopupRaster>(
  layers: readonly T[],
  trigger: "click" | "hover"
): T | undefined {
  return layers.find((layer) => layer.visible !== false && rasterPopupOf(layer)?.trigger === trigger);
}

/** The popup's cell values at a point (`band_<n>`, in the bands' order, or `formula`); null outside the file or
 * without values. */
export async function rasterValuesAt(
  layer: PopupRaster,
  lngLat: { lng: number; lat: number }
): Promise<Record<string, number> | null> {
  const rule = rasterPopupOf(layer);
  if (!rule) return null;
  const render = (layer.style?.document as { render?: unknown } | undefined)?.render;
  const spec = rule.bands === "formula" && isObject(render) ? rasterColorSpec(render as JsonObject) : null;
  const point = await fetchRasterPoint(
    String(layer.layer_id ?? layer.id),
    lngLat,
    spec ? rasterToken(spec) : undefined
  );
  if (!point) return null;
  const out: Record<string, number> = {};
  if (rule.bands === "formula") {
    if (typeof point.styled === "number" && Number.isFinite(point.styled)) out.formula = point.styled;
  } else {
    const bands = rule.bands === "all" ? point.values.map((_, i) => i + 1) : rule.bands;
    for (const band of bands) {
      const value = point.values[band - 1];
      if (typeof value === "number" && Number.isFinite(value)) out[`band_${band}`] = value;
    }
  }
  return Object.keys(out).length ? out : null;
}

/** The popup configuration showing `values` (`band_<n>` keys); one styled band carries the legend's unit. */
export function rasterPopupConfig(
  layer: PopupRaster,
  values: Record<string, unknown>
): PopupProperties | undefined {
  const rule = rasterPopupOf(layer);
  if (!rule) return undefined;
  const legend = (layer.style?.document as { legend?: unknown } | undefined)?.legend;
  const unit = isObject(legend) && typeof legend.unit === "string" && legend.unit ? legend.unit : undefined;
  const keys = Object.keys(values).filter((key) => /^band_\d+$/.test(key) || key === "formula");
  const attributes = keys.map((key) => ({
    name: key,
    label: key === "formula" ? formulaName(layer) : `Band ${key.slice(5)}`,
    type: "number" as const,
    ...(unit && keys.length === 1 && rule.bands !== "all" ? { suffix: ` ${unit}` } : {}),
  }));
  return popupProperties.parse({ trigger: rule.trigger, blocks: [{ type: "fieldList", attributes }] });
}
