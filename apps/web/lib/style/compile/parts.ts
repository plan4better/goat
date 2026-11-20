// What every part compiler shares: the layer factory (source, filter, zooms), the rule for writing a property, the
// layer opacity.
import type { LayerSpecification } from "maplibre-gl";

import { featureFilter, isSet } from "@/lib/style/compile/cascade";
import { HIGHLIGHT } from "@/lib/style/compile/constants";
import type { ImageCollector } from "@/lib/style/compile/images";
import type { CompileInput, CompiledLayer, FieldType, Geometry } from "@/lib/style/compile/types";
import { type Expr, type Value, combine, fromForm, toProperty } from "@/lib/style/compile/values";
import { type JsonObject, deepEqual, isObject } from "@/lib/style/json";

export interface PartContext {
  id: string;
  sourceId: string;
  /** Vector tiles name a source layer; GeoJSON sources do not. */
  vectorSource: boolean;
  style: JsonObject;
  geometry: Geometry;
  fields?: Record<string, FieldType>;
  filter?: Expr;
  /** `*-sort-key` values (spec 7.1): for circles, fills and lines higher keys draw on top; symbols place lower first. */
  sortKey?: { draw: Expr; symbol: Expr };
  images: ImageCollector;
  out: CompiledLayer;
  input: CompileInput;
  /** The marker icon when it is not the cascade's (a cluster drawn like its points takes the icon of the category it
   * mostly holds): the icons it can pick, and its expression with each icon `map`ped, `fallback` where the base sets
   * none. */
  icon?: { refs: string[]; pick: (map: (ref: string) => Expr, fallback: Expr) => Expr };
  /** The marker color when it is not the cascade's (a cluster drawn like its points takes the color of the category it
   * mostly holds). */
  color?: Expr;
}

/** MapLibre's own defaults: a property equal to one of these that no record sets is left out. */
const MAPLIBRE_DEFAULTS: Record<string, unknown> = {
  "fill-opacity": 1,
  "line-opacity": 1,
  "line-width": 1,
  "line-offset": 0,
  "line-blur": 0,
  "line-cap": "butt",
  "circle-opacity": 1,
  "circle-stroke-opacity": 1,
  "icon-opacity": 1,
  "icon-rotate": 0,
  "text-opacity": 1,
  "text-max-width": 10,
  "text-transform": "none",
  "text-letter-spacing": 0,
  "text-line-height": 1.2,
  "heatmap-intensity": 1,
  "heatmap-opacity": 1,
  "heatmap-weight": 1,
};

/** Writes `key` unless no record sets `path` and the value is MapLibre's default anyway. */
export function put(
  target: Record<string, unknown>,
  key: string,
  value: Value | Expr,
  ctx: PartContext,
  path?: string
): void {
  const property =
    isObject(value) && ("expr" in value || "stops" in value) ? toProperty(value as Value) : value;
  if (
    key in MAPLIBRE_DEFAULTS &&
    deepEqual(property, MAPLIBRE_DEFAULTS[key]) &&
    !(path && isSet(ctx.style, path))
  )
    return;
  target[key] = property;
}

/** The active or hovered feature (spec 16 "highlight"). */
export const ACTIVE: Expr = [
  "any",
  ["boolean", ["feature-state", "active"], false],
  ["boolean", ["feature-state", "hover"], false],
];

/** A color that turns into GOAT's highlight color on the active feature, at every zoom stop. */
export const highlightColor = (ctx: PartContext, value: Value): Value =>
  ctx.input.highlight
    ? combine([value], ([v]) => ["case", ACTIVE, HIGHLIGHT.color, v], { kind: "color" })
    : value;

/** A width at least GOAT's highlight width on the active feature, at every zoom stop. */
export const highlightWidth = (ctx: PartContext, value: Value): Value =>
  ctx.input.highlight
    ? combine([value], ([v]) => ["case", ACTIVE, ["max", v, HIGHLIGHT.width], v], { kind: "number" })
    : value;

/** A part opacity times the layer opacity, for layers without a layer opacity of their own (spec 4.6). */
export function withLayerOpacity(ctx: PartContext, opacity: Value): Value {
  const layer = layerOpacity(ctx);
  return layer ? combine([opacity, layer], ([a, b]) => ["*", a, b], { kind: "number" }) : opacity;
}

/** The layer opacity when the style sets one other than 1 (spec 4.6). */
export function layerOpacity(ctx: PartContext): Value | null {
  if (ctx.style.opacity === undefined || ctx.style.opacity === 1) return null;
  return fromForm(ctx.style.opacity, "number", 1);
}

function zooms(ctx: PartContext, part: string): { minzoom?: number; maxzoom?: number } {
  const symbol = isObject(ctx.style.symbol) ? ctx.style.symbol : {};
  const node = isObject(symbol[part]) ? symbol[part] : {};
  const num = (v: unknown, d: number) => (typeof v === "number" ? v : d);
  const min = Math.max(num(ctx.style.min_zoom, 0), num(node.min_zoom, 0));
  const max = Math.min(num(ctx.style.max_zoom, 24), num(node.max_zoom, 24));
  return { ...(min > 0 ? { minzoom: min } : {}), ...(max < 24 ? { maxzoom: max } : {}) };
}

/** A kind of geoapi's decoration points (spec 15): a line's start, end or center. */
export type Decoration = "start" | "end" | "center";

const DECORATIONS: readonly Decoration[] = ["start", "end", "center"];

/** The kinds of decoration points each layer on them draws on. */
const decorated = new WeakMap<object, Decoration[]>();

/** `layer` draws on the decoration points of `kinds`: the tile URL asks for them (spec 15). */
export function onDecorations<T extends LayerSpecification>(
  ctx: PartContext,
  kinds: Decoration[],
  layer: T
): T {
  // GeoJSON features are the lines themselves.
  if (!ctx.vectorSource) return layer;
  const all = new Set([...(ctx.out.tileParams.decorations ?? []), ...kinds]);
  ctx.out.tileParams.decorations = DECORATIONS.filter((k) => all.has(k));
  decorated.set(layer, kinds);
  return layer;
}

/** Where the tiles carry decoration points of more kinds than a layer draws on, the layer keeps to its own (spec 16). */
export function keepDecorations(out: CompiledLayer): void {
  const all = out.tileParams.decorations ?? [];
  for (const layer of out.layers) {
    const kinds = decorated.get(layer);
    if (!kinds || all.every((k) => kinds.includes(k))) continue;
    const own: Expr = ["match", ["get", "_decoration"], kinds, true, false];
    const target = layer as { filter?: unknown };
    target.filter = target.filter === undefined ? own : ["all", target.filter, own];
  }
}

/** One MapLibre layer of a part: `${id}-${suffix}` on the layer's source, with the feature filter and zooms. */
export function makeLayer(
  ctx: PartContext,
  suffix: string,
  type: LayerSpecification["type"],
  part: string,
  layout: Record<string, unknown>,
  paint: Record<string, unknown>,
  sourceLayer = "default",
  opts: { filter?: Expr; ordered?: boolean } = {}
): LayerSpecification {
  const layer: Record<string, unknown> = { id: `${ctx.id}-${suffix}`, type, source: ctx.sourceId };
  if (ctx.vectorSource) layer["source-layer"] = sourceLayer;
  const filters = [ctx.filter, featureFilter(ctx.style, { fields: ctx.fields }, part), opts.filter].filter(
    (f) => f !== undefined
  );
  if (filters.length) layer.filter = filters.length === 1 ? filters[0] : ["all", ...filters];
  Object.assign(layer, zooms(ctx, part));
  const ordered =
    ctx.sortKey && opts.ordered !== false && type !== "raster" && type !== "heatmap"
      ? { ...layout, [`${type}-sort-key`]: type === "symbol" ? ctx.sortKey.symbol : ctx.sortKey.draw }
      : layout;
  if (Object.keys(ordered).length) layer.layout = ordered;
  layer.paint = paint;
  return layer as unknown as LayerSpecification;
}
