// Polygon parts (spec 3.1, 16): the fill, its pattern as a second fill layer (an image per look,
// lib/style/compile/patternImage.ts), the outline as a line layer. With a height (`extrude`, 3D spec 7.5) the fill is
// one fill-extrusion layer of the same id and the pattern is not drawn.
import type { LayerSpecification } from "maplibre-gl";

import { cascade, isSet, partUsed, perLayer, setValues } from "@/lib/style/compile/cascade";
import { HIGHLIGHT } from "@/lib/style/compile/constants";
import { DASHES } from "@/lib/style/compile/constants";
import { colorText, concat, everyZoom, numberText } from "@/lib/style/compile/imageNames";
import {
  ACTIVE,
  type PartContext,
  highlightColor,
  highlightWidth,
  layerOpacity,
  makeLayer,
  put,
  withLayerOpacity,
} from "@/lib/style/compile/parts";
import { NO_PATTERN_IMAGE, PATTERN_IMAGE } from "@/lib/style/compile/patternImage";
import {
  AUTO_COLOR,
  type Expr,
  FILL_COLOR,
  type Value,
  combine,
  fold,
  followColor,
  fromForm,
  isZoomed,
  substitute,
  toDarkerShade,
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
  const opacity =
    fill === false
      ? { expr: 0 }
      : fromForm(isObject(fill) ? fill.opacity : undefined, "number", DEFAULTS["fill.opacity"]);
  const paint: Record<string, unknown> = {};
  put(paint, "fill-extrusion-color", highlightColor(ctx, fillColor), ctx, "fill.color");
  paint["fill-extrusion-height"] = toProperty(height);
  const baseProperty = toProperty(base);
  if (baseProperty !== 0) paint["fill-extrusion-base"] = baseProperty;
  paint["fill-extrusion-opacity"] = toProperty(withLayerOpacity(ctx, opacity));
  return makeLayer(ctx, "fill", "fill-extrusion", "fill", {}, paint, "default", { ordered: false });
}

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
  // The outline's "fill" and the pattern's default color: the fill color, class by class and stop by stop; the
  // outline's "auto" its darker shade.
  const fillShade = cascade(style, "fill.color", { ...c, map: toDarkerShade });
  const inFill = (value: Value) =>
    substitute(substitute(value, FILL_COLOR, fillColor), AUTO_COLOR, fillShade);

  if (extrudes(style)) {
    layers.push(extrusionLayer(ctx, fillColor));
  } else if (partUsed(style, "fill", "polygon")) {
    const fillOpacity = cascade(style, "fill.opacity", c);
    const paint: Record<string, unknown> = {};
    put(paint, "fill-color", fillColor, ctx, "fill.color");
    put(paint, "fill-opacity", fillOpacity, ctx, "fill.opacity");
    if (opacity) paint["fill-layer-opacity"] = toProperty(opacity);
    layers.push(makeLayer(ctx, "fill", "fill", "fill", {}, paint));

    const patterns = setValues(style, "fill.pattern").filter(
      (p): p is string => typeof p === "string" && p !== "none"
    );
    if (patterns.length) {
      const shown = cascade(style, "fill.pattern", { ...c, map: (n) => (n === "none" ? 0 : 1) });
      // The image's name carries the look, feature by feature and stop by stop; lines in the fill color by default.
      const name = combine(
        [
          cascade(style, "fill.pattern", c),
          cascade(style, "fill.pattern_spacing", c),
          cascade(style, "fill.pattern_width", c),
          everyZoom(inFill(cascade(style, "fill.pattern_color", { ...c, fallback: FILL_COLOR }))),
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

  if (partUsed(style, "outline", "polygon")) {
    const paint: Record<string, unknown> = {};
    const color = inFill(cascade(style, "outline.color", { ...c, map: followColor }));
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
