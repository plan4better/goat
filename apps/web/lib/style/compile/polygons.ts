// Polygon parts (spec 3.1, 16): the fill, its pattern as a second fill layer (an image per look,
// lib/style/compile/patternImage.ts), the outline as a line layer. With a height (`extrude`, 3D spec 7.5) the fill is
// one fill-extrusion layer of the same id and the pattern is not drawn.
import type { LayerSpecification } from "maplibre-gl";

import { alphaOf, isNone } from "@/lib/style/colors";
import { cascade, isSet, partUsed, perLayer, setValues } from "@/lib/style/compile/cascade";
import { HIGHLIGHT } from "@/lib/style/compile/constants";
import { DASHES } from "@/lib/style/compile/constants";
import { derivedValue } from "@/lib/style/compile/derived";
import { colorText, concat, everyZoom, numberText } from "@/lib/style/compile/imageNames";
import {
  ACTIVE,
  type PartContext,
  drawsNothing,
  highlightColor,
  highlightWidth,
  layerOpacity,
  makeLayer,
  put,
  ruleInputs,
  withLayerOpacity,
} from "@/lib/style/compile/parts";
import { NO_PATTERN_IMAGE, PATTERN_IMAGE } from "@/lib/style/compile/patternImage";
import {
  type Expr,
  type Value,
  combine,
  fold,
  fromForm,
  isZoomed,
  toProperty,
  valueAt,
} from "@/lib/style/compile/values";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { SCENE_DEFAULTS } from "@/lib/style/generated/scene";
import { type JsonObject, isObject } from "@/lib/style/json";

export const dashArray = (name: unknown) => ["literal", DASHES[name as string] ?? DASHES.solid];

/** Whether the style raises features: an H3 render by its `extrude`, other styles by any record's `extrude` part. */
export function extrudes(style: JsonObject): boolean {
  const render = isObject(style.render) ? style.render : null;
  if (render?.type === "h3") return isObject(render.extrude);
  return partUsed(style, "extrude");
}

/** The height part's zoom range: outside it the volumes stand at height 0. */
function heightGate(style: JsonObject, value: Value): Value {
  const symbol = isObject(style.symbol) ? style.symbol : {};
  const part = isObject(symbol.extrude) ? symbol.extrude : {};
  const min = typeof part.min_zoom === "number" && part.min_zoom > 0 ? part.min_zoom : null;
  const max = typeof part.max_zoom === "number" && part.max_zoom < 24 ? part.max_zoom : null;
  if (min === null && max === null) return value;
  const stops: Array<[number, Expr]> = [[0, min === null ? 1 : 0]];
  if (min !== null) stops.push([min, 1]);
  if (max !== null) stops.push([max, 0]);
  const gate: Value = { interpolate: "step", stops, kind: "number" };
  return combine([value, gate], ([v, g]) => ["*", v, g], { kind: "number" });
}

/** Raw fields count storeys of 3 m with `unit: "storeys"`; fixed values, zoom stops and ranges are metres. */
const rawHeight = (style: JsonObject) =>
  perLayer(style, "extrude.unit") === "storeys"
    ? (get: Expr): Expr => ["*", get, SCENE_DEFAULTS.storey_height]
    : undefined;

/**
 * The height of every feature in metres (3D spec 5.3, 7.5): the `extrude.height` cascade, 10 m where the part is on
 * without a height, 0 where it is off or the field has no value; raw fields count storeys with `unit: "storeys"`.
 */
export function heightValue(ctx: PartContext): Value {
  const { style } = ctx;
  const symbol = isObject(style.symbol) ? style.symbol : {};
  const part = symbol.extrude;
  const unset = isObject(part) && (part.height === undefined || part.height === null);
  const height = cascade(style, "extrude.height", {
    fields: ctx.fields,
    kind: "number",
    fallback: unset ? DEFAULTS["extrude.height"] : 0,
    raw: rawHeight(style),
  });
  return heightGate(style, height);
}

/** The fill as volumes: colour, height, base under the height, one opacity for the layer (3D spec 7.5). */
function extrusionLayer(ctx: PartContext, fillColor: Value): LayerSpecification {
  const { style } = ctx;
  const symbol = isObject(style.symbol) ? style.symbol : {};
  const height = heightValue(ctx);
  const raw = rawHeight(style);
  const base = combine(
    [cascade(style, "extrude.base", { fields: ctx.fields, kind: "number", raw }), height],
    ([b, h]) => (b === 0 ? 0 : ["min", b, h]),
    { kind: "number" }
  );
  // MapLibre's opacity of extrusions is one value for the layer: the base fill's, fixed or by zoom.
  const fill = symbol.fill;
  const own =
    fill === false
      ? { expr: 0 }
      : fromForm(isObject(fill) ? fill.opacity : undefined, "number", DEFAULTS["fill.opacity"]);
  // MapLibre's extrusion color has no alpha: a fixed color's goes into the opacity (one value for the layer).
  const alpha = isZoomed(fillColor) ? undefined : alphaOf(fillColor.expr);
  const opacity =
    alpha !== undefined && alpha < 255
      ? combine([own], ([o]) => ["*", o, alpha / 255], { kind: "number" })
      : own;
  const paint: Record<string, unknown> = {};
  put(paint, "fill-extrusion-color", highlightColor(ctx, fillColor), ctx, "fill.color");
  paint["fill-extrusion-height"] = toProperty(height);
  const baseProperty = toProperty(base);
  if (baseProperty !== 0) paint["fill-extrusion-base"] = baseProperty;
  paint["fill-extrusion-opacity"] = toProperty(withLayerOpacity(ctx, opacity));
  // A record whose fill is a fixed None (spec 4.6) leaves the volumes: MapLibre would draw its color without the alpha.
  const none = cascade(style, "fill.color", { fields: ctx.fields, map: (v) => isNone(v) });
  // By zoom (a base color by zoom beside None classes): where the records' None does not change with the zoom.
  const stops = isZoomed(none) ? none.stops.map(([, e]) => JSON.stringify(noneOutputs(e))) : [];
  const filter = !isZoomed(none)
    ? noneFilter(noneOutputs(none.expr))
    : new Set(stops).size === 1
      ? noneFilter(JSON.parse(stops[0]) as Expr)
      : undefined;
  return makeLayer(ctx, "fill", "fill-extrusion", "fill", {}, paint, "default", {
    ordered: false,
    ...(filter ? { filter } : {}),
  });
}

/** Whether the `i`th item of a match, case or step is one of its outputs. */
function isOutput(expr: Expr[], i: number): boolean {
  const last = expr.length - 1;
  if (expr[0] === "case") return i >= 2 && (i % 2 === 0 || i === last);
  if (expr[0] === "match") return i >= 3 && (i % 2 === 1 || i === last);
  if (expr[0] === "step") return i >= 2 && i % 2 === 0;
  return false;
}

/** `expr` (a fill color's cascade with each fixed color turned into whether it is None) with every output that is no
 * fixed color (a color read from a field, a palette over one) turned into `false`. */
function noneOutputs(expr: Expr): Expr {
  if (typeof expr === "boolean") return expr;
  if (!Array.isArray(expr) || !["case", "match", "step"].includes(expr[0] as string)) return false;
  return expr.map((e, i) => (isOutput(expr, i) ? noneOutputs(e) : e));
}

/** Whether some output of `none` says None. */
const anyNone = (none: Expr): boolean =>
  none === true || (Array.isArray(none) && none.some((e, i) => isOutput(none, i) && anyNone(e)));

/** The filter that keeps the features `none` (whether a feature's fill is None) says are drawn; none where all are. */
const noneFilter = (none: Expr): Expr | undefined => (anyNone(none) ? ["!", none] : undefined);

/** How far before a position's zoom stop the offset of a blending width jumps to the new side. */
const SIDE_CHANGE = 0.001;

/** The offset of an outline at its position: half its width into the polygon, out of it, or none on the edge. A
 * position by zoom changes side at its stops while a width by zoom blends between its own: the offset then follows the
 * width's curve, with a stop at every stop of either and one just before each side change, so it stays half the drawn
 * width at every zoom. */
function outlineOffset(position: Value, width: Value): Value {
  const half = (w: Expr): Expr => ["/", w, 2];
  const at = ([p, w]: Expr[]): Expr =>
    p === "inside"
      ? half(w)
      : p === "outside"
        ? ["-", 0, half(w)]
        : typeof p === "string"
          ? 0
          : ["match", p, "inside", half(w), "outside", ["-", 0, half(w)], 0];
  if (!isZoomed(position) || !isZoomed(width) || width.interpolate === "step")
    return combine([position, width], at, { kind: "number" });
  const changes = position.stops.slice(1).map(([z]) => z - SIDE_CHANGE);
  const zooms = [...new Set([...position.stops.map(([z]) => z), ...changes, ...width.stops.map(([z]) => z)])];
  return {
    interpolate: width.interpolate,
    stops: zooms
      .sort((a, b) => a - b)
      .map((z) => [z, fold(at([valueAt(position, z), valueAt(width, z)]))] as [number, Expr]),
    kind: "number",
  };
}

export function polygonLayers(ctx: PartContext): LayerSpecification[] {
  const { style } = ctx;
  const c = { fields: ctx.fields };
  const layers: LayerSpecification[] = [];
  const opacity = layerOpacity(ctx);
  const fillColor = cascade(style, "fill.color", c);
  const derived = { geometry: "polygon" as const, fields: ctx.fields, inputs: ruleInputs(ctx) };
  // A fill that is None for all draws no layer (spec 4.6); its pattern still draws, unless its color is None too.
  const filled = !drawsNothing(fillColor);

  if (extrudes(style)) {
    if (filled) layers.push(extrusionLayer(ctx, fillColor));
  } else if (partUsed(style, "fill", "polygon")) {
    if (filled) {
      const fillOpacity = cascade(style, "fill.opacity", c);
      const paint: Record<string, unknown> = {};
      put(paint, "fill-color", fillColor, ctx, "fill.color");
      put(paint, "fill-opacity", fillOpacity, ctx, "fill.opacity");
      if (opacity) paint["fill-layer-opacity"] = toProperty(opacity);
      layers.push(makeLayer(ctx, "fill", "fill", "fill", {}, paint));
    }

    const patterns = setValues(style, "fill.pattern").filter(
      (p): p is string => typeof p === "string" && p !== "none"
    );
    const patternColor = patterns.length ? derivedValue(style, "fill.pattern_color", derived) : null;
    if (patternColor && !drawsNothing(patternColor)) {
      const shown = cascade(style, "fill.pattern", { ...c, map: (n) => (n === "none" ? 0 : 1) });
      // The image's name carries the look, feature by feature and stop by stop; lines in the fill color by default.
      const name = combine(
        [
          cascade(style, "fill.pattern", c),
          cascade(style, "fill.pattern_spacing", c),
          cascade(style, "fill.pattern_width", c),
          everyZoom(patternColor),
        ],
        ([kind, spacing, width, color]) => {
          if (kind === "none") return NO_PATTERN_IMAGE;
          const image = concat([
            PATTERN_IMAGE,
            kind,
            "|",
            numberText(spacing),
            "|",
            numberText(width),
            "|",
            colorText(color),
          ]);
          return typeof kind === "string" ? image : ["case", ["==", kind, "none"], NO_PATTERN_IMAGE, image];
        },
        { step: true, kind: "choice" }
      );
      const pattern: Record<string, unknown> = { "fill-pattern": toProperty(name) };
      // The pattern draws at full opacity whatever the fill's (spec 3.1); "none" leaves a feature without one.
      put(pattern, "fill-opacity", shown, ctx);
      if (opacity) pattern["fill-layer-opacity"] = toProperty(opacity);
      layers.push(makeLayer(ctx, "pattern", "fill", "fill", {}, pattern));
    }
  }

  const color = partUsed(style, "outline", "polygon") ? derivedValue(style, "outline.color", derived) : null;
  // An outline that is None for all draws as one switched off.
  if (color && !drawsNothing(color)) {
    const paint: Record<string, unknown> = {};
    put(paint, "line-color", highlightColor(ctx, color), ctx, "outline.color");
    const width = cascade(style, "outline.width", c);
    put(paint, "line-width", highlightWidth(ctx, width), ctx, "outline.width");
    put(paint, "line-opacity", cascade(style, "outline.opacity", c), ctx, "outline.opacity");
    // Inside or outside: the line moves by half its width; MapLibre insets a polygon's ring by a positive offset.
    if (setValues(style, "outline.position").some((p) => p === "inside" || p === "outside"))
      put(paint, "line-offset", outlineOffset(cascade(style, "outline.position", c), width), ctx);
    if (isSet(style, "outline.dash"))
      paint["line-dasharray"] = toProperty(cascade(style, "outline.dash", { ...c, map: dashArray }));
    if (opacity) paint["line-layer-opacity"] = toProperty(opacity);
    layers.push(makeLayer(ctx, "outline", "line", "outline", {}, paint));
  } else if (ctx.input.highlight) {
    // Without an outline, the active feature still gets GOAT's highlight edge.
    const paint = {
      "line-color": HIGHLIGHT.color,
      "line-width": HIGHLIGHT.width,
      "line-opacity": ["case", ACTIVE, 1, 0],
    };
    layers.push(makeLayer(ctx, "outline", "line", "outline", {}, paint));
  }
  return layers;
}
