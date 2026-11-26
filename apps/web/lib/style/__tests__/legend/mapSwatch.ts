// What the map draws for one feature: the compiled layers' filters, paint and layout evaluated by MapLibre's own
// expression engine, mapped back to the style's `part.key` names. The legend checks compare legend swatches with it.
import {
  Color,
  type StylePropertySpecification,
  createPropertyExpression,
  featureFilter,
  latest,
} from "@maplibre/maplibre-gl-style-spec";

import { DASHES, ICON_HEIGHT } from "@/lib/style/compile/constants";
import { parseMarkerImage } from "@/lib/style/compile/markerImage";
import { parsePatternImage } from "@/lib/style/compile/patternImage";
import type { CompiledLayer, Geometry } from "@/lib/style/compile/types";

const GEOMETRY_TYPE: Record<Geometry, 1 | 2 | 3> = { point: 1, line: 2, polygon: 3 };

/** A look: values by `part.key`; empty when no layer draws the feature at the zoom. */
export type MapLook = Record<string, unknown>;

type AnyLayer = {
  id: string;
  type: string;
  minzoom?: number;
  maxzoom?: number;
  filter?: unknown;
  paint?: Record<string, unknown>;
  layout?: Record<string, unknown>;
};

/** The name of an image a layout or paint property resolved to, or the text it is. */
const imageName = (value: unknown): string =>
  typeof value === "object" && value !== null && "name" in value
    ? String((value as { name: unknown }).name)
    : String(value ?? "");

export function mapLook(
  compiled: CompiledLayer,
  properties: Record<string, unknown>,
  zoom: number,
  geometry: Geometry
): MapLook {
  // The style's global state at its defaults, as the map starts with.
  const state = Object.fromEntries(Object.entries(compiled.state).map(([key, v]) => [key, v.default]));
  const feature = { type: GEOMETRY_TYPE[geometry], properties } as never;
  const out: MapLook = {};
  for (const layer of compiled.layers as AnyLayer[]) {
    if (zoom < (layer.minzoom ?? 0) || zoom >= (layer.maxzoom ?? 25)) continue;
    if (
      layer.filter !== undefined &&
      !featureFilter(layer.filter as never, "layers[0].filter", state).filter({ zoom }, feature)
    )
      continue;
    const read = (group: "paint" | "layout", key: string, at = zoom): unknown => {
      const spec = (latest as unknown as Record<string, Record<string, StylePropertySpecification>>)[
        `${group}_${layer.type}`
      ][key];
      const raw = layer[group]?.[key];
      if (raw === undefined) return spec.default;
      const parsed = createPropertyExpression(raw, `layers[0].${group}.${key}`, spec, state);
      if (parsed.result !== "success")
        throw new Error(`${layer.id} ${key}: ${parsed.value.map((e) => e.message).join("; ")}`);
      return parsed.value.evaluate({ zoom: at }, feature);
    };
    // MapLibre picks a symbol's image and a fill's pattern once per tile, at the tile's whole zoom (the map's zoom
    // rounded down); every other value at the map's zoom.
    const tileZoom = Math.floor(zoom);
    const part = layer.id.slice(compiled.id.length + 1);
    if (part === "marker" && layer.type === "circle") {
      out["marker.shape"] = "circle";
      out["marker.color"] = read("paint", "circle-color");
      out["marker.size"] = (read("paint", "circle-radius") as number) * 2;
      out["marker.opacity"] = read("paint", "circle-opacity");
      out["outline.color"] = read("paint", "circle-stroke-color");
      out["outline.width"] = read("paint", "circle-stroke-width");
      out["outline.opacity"] = read("paint", "circle-stroke-opacity");
    } else if (part === "marker" && layer.type === "symbol") {
      const image = parseMarkerImage(imageName(read("layout", "icon-image", tileZoom)));
      if (!image) throw new Error(`${layer.id}: not a marker image`);
      out["marker.shape"] = image.shape;
      out["marker.color"] = image.fill;
      out["marker.size"] = image.size * (read("layout", "icon-size") as number);
      out["marker.icon"] = image.icon;
      out["marker.icon_color"] = image.iconColor;
      out["marker.opacity"] = read("paint", "icon-opacity");
      // A marker on a polygon or a line has no stroke: the outline is the polygon's border (spec 3.3).
      if (geometry === "point") {
        out["outline.color"] = image.stroke;
        out["outline.width"] = image.strokeWidth;
      }
    } else if (part === "icon" && layer.type === "symbol") {
      out["marker.shape"] = "icon";
      out["marker.icon"] = imageName(read("layout", "icon-image", tileZoom));
      out["marker.color"] = read("paint", "icon-color");
      out["marker.size"] = (read("layout", "icon-size") as number) * ICON_HEIGHT;
      out["marker.opacity"] = read("paint", "icon-opacity");
    } else if (part === "fill" && layer.type === "fill") {
      out["fill.color"] = read("paint", "fill-color");
      out["fill.opacity"] = read("paint", "fill-opacity");
    } else if (part === "fill" && layer.type === "fill-extrusion") {
      // MapLibre draws a volume's color without its alpha (the layer's opacity carries a fixed color's).
      const color = read("paint", "fill-extrusion-color") as Color;
      out["fill.color"] = new Color(color.rgb[0], color.rgb[1], color.rgb[2], 1, false);
      out["extrude.height"] = read("paint", "fill-extrusion-height");
    } else if (part === "pattern" && layer.type === "fill") {
      const image = parsePatternImage(imageName(read("paint", "fill-pattern", tileZoom)));
      out["fill.pattern"] = image?.kind ?? "none";
      if (image) out["fill.pattern_color"] = image.color;
    } else if (layer.type === "line" && (part === "outline" || part === "line" || part === "casing")) {
      out[`${part}.color`] = read("paint", "line-color");
      out[`${part}.opacity`] = read("paint", "line-opacity");
      if (part !== "casing") {
        out[`${part}.width`] = read("paint", "line-width");
        // The dash by its name: the compiler writes each as its pattern in line widths.
        const pattern =
          layer.paint?.["line-dasharray"] === undefined ? DASHES.solid : read("paint", "line-dasharray");
        out[`${part}.dash`] =
          Object.keys(DASHES).find((name) => JSON.stringify(DASHES[name]) === JSON.stringify(pattern)) ??
          JSON.stringify(pattern);
      }
    }
  }
  return out;
}

/** One paint value of one compiled layer as MapLibre evaluates it: for a feature's properties at a zoom, with what
 * a feature does not carry itself in `globals` (a heatmap's density). */
export function paintValue(
  compiled: CompiledLayer,
  layerId: string,
  key: string,
  properties: Record<string, unknown> = {},
  zoom = 12,
  globals: Record<string, unknown> = {}
): unknown {
  return layerValue(compiled, layerId, "paint", key, properties, zoom, globals);
}

/** One paint or layout value of one compiled layer as MapLibre evaluates it (`paintValue`); an image's name as its
 * text. */
export function layerValue(
  compiled: CompiledLayer,
  layerId: string,
  group: "paint" | "layout",
  key: string,
  properties: Record<string, unknown> = {},
  zoom = 12,
  globals: Record<string, unknown> = {}
): unknown {
  return layerReader(compiled, layerId, group, key)(properties, zoom, globals);
}

/** `layerValue` of one property, its expression parsed once, for many features and zooms. */
export function layerReader(
  compiled: CompiledLayer,
  layerId: string,
  group: "paint" | "layout",
  key: string
): (properties: Record<string, unknown>, zoom: number, globals?: Record<string, unknown>) => unknown {
  const layer = (compiled.layers as AnyLayer[]).find((l) => l.id === layerId);
  if (!layer) throw new Error(`no layer ${layerId}`);
  const state = Object.fromEntries(Object.entries(compiled.state).map(([name, v]) => [name, v.default]));
  const spec = (latest as unknown as Record<string, Record<string, StylePropertySpecification>>)[
    `${group}_${layer.type}`
  ][key];
  if (!spec) throw new Error(`${layerId} (${layer.type}) has no ${group} property ${key}`);
  const raw = layer[group]?.[key];
  if (raw === undefined) return () => spec.default;
  const parsed = createPropertyExpression(raw, `layers[0].${group}.${key}`, spec, state);
  if (parsed.result !== "success")
    throw new Error(`${layerId} ${key}: ${parsed.value.map((e) => e.message).join("; ")}`);
  const expression = parsed.value;
  return (properties, zoom, globals = {}) => {
    const value = expression.evaluate({ zoom, ...globals } as never, { type: 1, properties } as never);
    return key === "icon-image" ? imageName(value) : value;
  };
}

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

/** A color as the map draws it (MapLibre's color, its color text, a hex color): `#rrggbb` without its alpha, and its
 * alpha (0 to 1); undefined for anything else, and for a MapLibre color at alpha 0, which keeps no hue. */
export function colorOf(value: unknown): { hex: string; alpha: number } | undefined {
  if (typeof value === "string" && HEX.test(value))
    return {
      hex: value.slice(0, 7).toLowerCase(),
      alpha: value.length === 9 ? parseInt(value.slice(7), 16) / 255 : 1,
    };
  const color = value instanceof Color ? value : typeof value === "string" ? Color.parse(value) : undefined;
  if (!color || color.a === 0) return undefined;
  const [r, g, b, a] = color.rgb;
  const hex = [r, g, b]
    .map((x) =>
      Math.round(x * 255)
        .toString(16)
        .padStart(2, "0")
    )
    .join("");
  return { hex: `#${hex}`, alpha: a };
}
