// Point parts (spec 3.3, 16): a circle; a marker with a shape (lib/style/markerShapes.ts) and maybe an icon as one
// image per look (lib/style/compile/markerImage.ts), so overlapping points stack as whole markers, a pin standing on
// its place with its tip; or an icon alone tinted with
// `color`: library icons are SDF, uploads and emoji keep their colors and go into a layer of their own. A hollow
// marker (`fill: false`) draws its outline and icon only; the icon alone has no fill to leave out.
import type { LayerSpecification } from "maplibre-gl";

import { cascade, isSet, partUsed, perLayer, setValues } from "@/lib/style/compile/cascade";
import { HIGHLIGHT, ICON_HEIGHT } from "@/lib/style/compile/constants";
import { colorText, concat, everyZoom, numberText } from "@/lib/style/compile/imageNames";
import { MARKER_IMAGE } from "@/lib/style/compile/markerImage";
import {
  ACTIVE,
  type PartContext,
  highlightColor,
  highlightWidth,
  makeLayer,
  put,
  withLayerOpacity,
} from "@/lib/style/compile/parts";
import {
  type Expr,
  FILL_COLOR,
  type Value,
  combine,
  fromForm,
  isZoomed,
  substitute,
  toProperty,
} from "@/lib/style/compile/values";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { isObject } from "@/lib/style/json";
import {
  MARKER_SHAPES,
  type MarkerShapeId,
  drawsAsImage,
  isPin,
  markerShapeOf,
} from "@/lib/style/markerShapes";

/** Uploads and emoji keep their own colors: no tint, no halo. */
const keepsColors = (ref: unknown) =>
  typeof ref === "string" && (ref.startsWith("asset:") || ref.startsWith("emoji:"));

const anchor = (name: unknown) => (typeof name === "string" ? name.replace("_", "-") : name);

const moves = (offset: unknown) => Array.isArray(offset) && (offset[0] !== 0 || offset[1] !== 0);

/** Stands for the icon color nothing sets until the fill decides it: the reference color on a filled marker, the
 * marker color on a hollow one (spec 3.3). */
const ICON_TINT = "\u0000tint";

const always = (value: Value, expr: Expr) => !isZoomed(value) && value.expr === expr;

/** `filled` where a feature's marker has its fill, `hollow` where it has none. */
function byFill(fill: Value, filled: Value, hollow: Value, kind: "number" | "color"): Value {
  return combine(
    [fill, filled, hollow],
    ([f, a, b]) => (f === true ? a : f === false ? b : ["case", ["==", f, false], b, a]),
    { kind }
  );
}

/** A halo width that is 0 where the outline is off: icon halos have no opacity of their own. */
function haloWidth(width: Value, opacity: Value): Value {
  if (!isZoomed(opacity) && typeof opacity.expr === "number") return opacity.expr > 0 ? width : { expr: 0 };
  return combine(
    [width, opacity],
    ([w, o]) => (typeof o === "number" ? (o > 0 ? w : 0) : ["case", [">", o, 0], w, 0]),
    { kind: "number" }
  );
}

export function pointLayers(ctx: PartContext): LayerSpecification[] {
  const { style } = ctx;
  const c = { fields: ctx.fields };
  if (!partUsed(style, "marker", "point")) return [];
  const layers: LayerSpecification[] = [];
  const size = cascade(style, "marker.size", c);
  const ownOpacity = cascade(style, "marker.opacity", c);
  const opacity = withLayerOpacity(ctx, ownOpacity);
  const fill = cascade(style, "marker.fill", c);
  // The marker opacity is the fill's: a hollow circle draws no fill, a hollow marker image is not faded by it.
  const hollowOpacity = (hollow: number) =>
    always(fill, true)
      ? opacity
      : withLayerOpacity(ctx, byFill(fill, ownOpacity, { expr: hollow }, "number"));
  const outline = partUsed(style, "outline", "point");
  const offsetSet = setValues(style, "marker.offset").some(moves);
  const symbol = isObject(style.symbol) ? style.symbol : {};
  const baseMarker = isObject(symbol.marker) ? symbol.marker : {};
  // The layer's shape; classes and rules may set their own (the icon alone only the layer, spec 3.3).
  const shape = baseMarker.shape ?? DEFAULTS["marker.shape"];
  const shapes = setValues(style, "marker.shape");
  const baseSize =
    typeof baseMarker.size === "number" ? baseMarker.size : (DEFAULTS["marker.size"] as number);
  const markerColor = cascade(style, "marker.color", c);
  // An outline in the "fill" color takes the marker's color (the circle, or the icon's tint).
  const outlineColor = substitute(
    cascade(style, "outline.color", { ...c, map: (v) => (v === "fill" ? FILL_COLOR : v) }),
    FILL_COLOR,
    markerColor
  );

  const iconRefs = setValues(style, "marker.icon").filter((r): r is string => typeof r === "string");
  if (shape !== "icon" && [shape, ...shapes].some((s) => drawsAsImage(s, iconRefs.length > 0)))
    return markerImageLayers(ctx, markerShapeOf(shape), iconRefs, {
      size,
      opacity: hollowOpacity(1),
      fill,
      color: markerColor,
      outline: outline ? { color: outlineColor } : undefined,
    });

  if (shape !== "icon") {
    const paint: Record<string, unknown> = {};
    put(paint, "circle-color", markerColor, ctx, "marker.color");
    paint["circle-radius"] = toProperty(combine([size], ([s]) => ["/", s, 2], { kind: "number" }));
    put(paint, "circle-opacity", hollowOpacity(0), ctx, "marker.opacity");
    if (outline) {
      put(paint, "circle-stroke-color", highlightColor(ctx, outlineColor), ctx, "outline.color");
      put(
        paint,
        "circle-stroke-width",
        highlightWidth(ctx, cascade(style, "outline.width", c)),
        ctx,
        "outline.width"
      );
      put(
        paint,
        "circle-stroke-opacity",
        withLayerOpacity(ctx, cascade(style, "outline.opacity", c)),
        ctx,
        "outline.opacity"
      );
    } else if (ctx.input.highlight) {
      paint["circle-stroke-color"] = HIGHLIGHT.color;
      paint["circle-stroke-width"] = ["case", ACTIVE, HIGHLIGHT.width, 0];
    }
    // circle-translate cannot vary per feature: circles move by the base offset (spec 4.5).
    const baseOffset = baseMarker.offset;
    const stops =
      isObject(baseOffset) && Array.isArray(baseOffset.zoom)
        ? (baseOffset.zoom as unknown[][]).map((s) => s[1])
        : [baseOffset];
    if (stops.some(moves))
      paint["circle-translate"] = toProperty(
        fromForm(baseOffset, "choice", ["literal", [0, 0]], (o) => ["literal", o])
      );
    layers.push(makeLayer(ctx, "marker", "circle", "marker", {}, paint));
    return layers;
  }

  // An icon alone. Without a base icon, features no class or rule gives one draw the default.
  const refs = iconRefs;
  if (!(isObject(symbol.marker) && symbol.marker.icon !== undefined)) refs.push("goat:marker");
  refs.forEach((ref) => ctx.images.add(ref));

  const layout: Record<string, unknown> = {
    "icon-image": toProperty(cascade(style, "marker.icon", { ...c, fallback: "goat:marker" })),
    "icon-size": toProperty(combine([size], ([s]) => ["/", s, ICON_HEIGHT], { kind: "number" })),
  };
  if (isSet(style, "marker.rotation")) {
    layout["icon-rotate"] = toProperty(cascade(style, "marker.rotation", c));
    layout["icon-rotation-alignment"] = "map";
  }
  if (isSet(style, "marker.anchor"))
    layout["icon-anchor"] = toProperty(cascade(style, "marker.anchor", { ...c, map: anchor }));
  if (offsetSet) {
    // icon-offset is in icon pixels, multiplied by icon-size.
    layout["icon-offset"] = toProperty(
      cascade(style, "marker.offset", {
        ...c,
        map: (o) => ["literal", (o as number[]).map((v) => (v * ICON_HEIGHT) / baseSize)],
      })
    );
  }
  if (perLayer(style, "marker.allow_overlap") === true) layout["icon-allow-overlap"] = true;

  const libraryPaint: Record<string, unknown> = {};
  put(libraryPaint, "icon-color", markerColor, ctx);
  put(libraryPaint, "icon-opacity", opacity, ctx, "marker.opacity");
  if (outline) {
    put(libraryPaint, "icon-halo-color", highlightColor(ctx, outlineColor), ctx, "outline.color");
    const width = haloWidth(cascade(style, "outline.width", c), cascade(style, "outline.opacity", c));
    put(libraryPaint, "icon-halo-width", highlightWidth(ctx, width), ctx, "outline.width");
  }
  const ownPaint: Record<string, unknown> = {};
  put(ownPaint, "icon-opacity", opacity, ctx, "marker.opacity");

  const own = refs.some(keepsColors);
  const library = refs.some((r) => !keepsColors(r));
  if (own && library) {
    const kind = cascade(style, "marker.icon", {
      ...c,
      fallback: "library",
      map: (r) => (keepsColors(r) ? "asset" : "library"),
    });
    const kindExpr: Expr = isZoomed(kind) ? "library" : kind.expr;
    layers.push(
      makeLayer(ctx, "icon", "symbol", "marker", layout, libraryPaint, "default", {
        filter: ["==", kindExpr, "library"],
      })
    );
    layers.push(
      makeLayer(ctx, "icon-asset", "symbol", "marker", layout, ownPaint, "default", {
        filter: ["==", kindExpr, "asset"],
      })
    );
  } else if (own) {
    layers.push(makeLayer(ctx, "icon-asset", "symbol", "marker", layout, ownPaint));
  } else {
    layers.push(makeLayer(ctx, "icon", "symbol", "marker", layout, libraryPaint));
  }
  return layers;
}

/** The numbers a size form can take: its value, its zoom stops' values, its range. */
function sizes(form: unknown): number[] {
  if (typeof form === "number") return [form];
  if (!isObject(form)) return [];
  if (Array.isArray(form.zoom)) return (form.zoom as unknown[][]).flatMap((stop) => sizes(stop[1]));
  if (Array.isArray(form.range)) return form.range.filter((n): n is number => typeof n === "number");
  return [];
}

/** The largest size any feature's marker takes: marker images are drawn at it and scaled down. */
function largestSize(node: unknown): number | undefined {
  if (Array.isArray(node))
    return Math.max(...node.map(largestSize).filter((n): n is number => n !== undefined));
  if (!isObject(node)) return undefined;
  const found = Object.entries(node).flatMap(([key, value]) => {
    const own = key === "marker" && isObject(value) ? sizes(value.size) : [];
    const inner = largestSize(value);
    return inner !== undefined && Number.isFinite(inner) ? [...own, inner] : own;
  });
  return found.length ? Math.max(...found) : undefined;
}

/** The base marker's size where it is one number, else the reference size. */
function perLayerSize(style: PartContext["style"]): number {
  const marker = isObject(style.symbol) && isObject(style.symbol.marker) ? style.symbol.marker : {};
  return typeof marker.size === "number" ? marker.size : (DEFAULTS["marker.size"] as number);
}

/** A marker with a shape as one image per look (lib/style/compile/markerImage.ts), and its highlight ring. */
function markerImageLayers(
  ctx: PartContext,
  shape: MarkerShapeId,
  refs: string[],
  marker: { size: Value; opacity: Value; fill: Value; color: Value; outline?: { color: Value } }
): LayerSpecification[] {
  const { style } = ctx;
  const c = { fields: ctx.fields };
  refs.forEach((ref) => ctx.images.add(ref));
  const largest = largestSize(style) ?? (DEFAULTS["marker.size"] as number);
  const width = marker.outline
    ? haloWidth(cascade(style, "outline.width", c), cascade(style, "outline.opacity", c))
    : { expr: 0 };
  const shapes = setValues(style, "marker.shape");
  const iconColor = always(marker.fill, true)
    ? cascade(style, "marker.icon_color", c)
    : substitute(
        cascade(style, "marker.icon_color", { ...c, fallback: ICON_TINT }),
        ICON_TINT,
        byFill(marker.fill, { expr: DEFAULTS["marker.icon_color"] as Expr }, marker.color, "color")
      );
  const parts = [
    cascade(style, "marker.shape", { ...c, fallback: "circle" }),
    cascade(style, "marker.icon", { ...c, fallback: "" }),
    everyZoom(marker.color),
    marker.outline ? everyZoom(marker.outline.color) : { expr: "" },
    everyZoom(width),
    everyZoom(iconColor),
    marker.fill,
  ];
  const name = combine(
    parts,
    ([form, icon, color, stroke, w, iconColor, filled]) =>
      concat([
        MARKER_IMAGE,
        form,
        `|${largest}|`,
        icon,
        "|",
        // A hollow marker's fill part is empty.
        filled === true
          ? colorText(color)
          : filled === false
            ? ""
            : ["case", ["==", filled, false], "", colorText(color)],
        "|",
        colorText(stroke),
        "|",
        numberText(w),
        "|",
        colorText(iconColor),
      ]),
    { step: true, kind: "choice" }
  );
  const layout: Record<string, unknown> = {
    "icon-image": toProperty(name),
    "icon-size": toProperty(combine([marker.size], ([s]) => ["/", s, largest], { kind: "number" })),
  };
  if (isSet(style, "marker.rotation")) {
    layout["icon-rotate"] = toProperty(cascade(style, "marker.rotation", c));
    layout["icon-rotation-alignment"] = "map";
  }
  // A pin stands on its place with its tip, at the bottom centre of its image, unless the style sets an anchor.
  if (isSet(style, "marker.anchor"))
    layout["icon-anchor"] = toProperty(cascade(style, "marker.anchor", { ...c, map: anchor }));
  else if (shapes.some(isPin))
    layout["icon-anchor"] = toProperty(
      cascade(style, "marker.shape", { ...c, map: (v) => (isPin(v) ? "bottom" : "center") })
    );
  // icon-offset is in image pixels (the largest marker's), multiplied by icon-size.
  if (setValues(style, "marker.offset").some(moves))
    layout["icon-offset"] = toProperty(cascade(style, "marker.offset", { ...c, map: (o) => ["literal", o] }));
  // Markers with a shape draw even where they collide, as circles always did, unless overlap is turned off. Drawn
  // overlapping, the order puts the top feature on top (as for circles); colliding, it decides who wins (symbols).
  const overlap = !isSet(style, "marker.allow_overlap") || perLayer(style, "marker.allow_overlap") === true;
  if (overlap) layout["icon-allow-overlap"] = true;
  if (ctx.sortKey) layout["symbol-sort-key"] = overlap ? ctx.sortKey.draw : ctx.sortKey.symbol;
  const paint: Record<string, unknown> = {};
  put(paint, "icon-opacity", marker.opacity, ctx, always(marker.fill, false) ? undefined : "marker.opacity");

  const layers: LayerSpecification[] = [];
  if (ctx.input.highlight) {
    // A layout image cannot change with feature state: the active marker gets a ring under it.
    const radius = combine([marker.size, width], ([s, w]) => ["+", ["/", s, 2], w], { kind: "number" });
    // Around a pin's head, above its tip: circle-translate is one value per layer, so the base size places it.
    const baseSize = perLayerSize(style);
    const head =
      isPin(shape) && !isSet(style, "marker.anchor")
        ? { "circle-translate": [0, -((24 - MARKER_SHAPES[shape].icon.cy) / 24) * baseSize] }
        : {};
    layers.push(
      makeLayer(
        ctx,
        "ring",
        "circle",
        "marker",
        {},
        {
          "circle-radius": toProperty(radius),
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": HIGHLIGHT.color,
          "circle-stroke-width": ["case", ACTIVE, HIGHLIGHT.width, 0],
          ...head,
        }
      )
    );
  }
  layers.push(makeLayer(ctx, "marker", "symbol", "marker", layout, paint, "default", { ordered: false }));
  return layers;
}
