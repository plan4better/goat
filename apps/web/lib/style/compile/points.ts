// Point parts (spec 3.3, 16): a circle; a marker with a shape (lib/style/markerShapes.ts) and maybe an icon as one
// image per look (lib/style/compile/markerImage.ts), so overlapping points stack as whole markers, a pin standing on
// its place with its tip; or an icon alone tinted with
// `color`: library icons are SDF, uploads and emoji keep their colors and go into a layer of their own. A hollow
// marker (`fill: false`) draws its outline and icon only; the icon alone has no fill to leave out.
import type { LayerSpecification } from "maplibre-gl";

import { cascade, isSet, partUsed, perLayer, setValues } from "@/lib/style/compile/cascade";
import { HIGHLIGHT, ICON_HEIGHT } from "@/lib/style/compile/constants";
import { derivedValue } from "@/lib/style/compile/derived";
import { colorText, concat, everyZoom, numberText } from "@/lib/style/compile/imageNames";
import { keepsColors } from "@/lib/style/compile/images";
import { MARKER_IMAGE } from "@/lib/style/compile/markerImage";
import {
  ACTIVE,
  type PartContext,
  always,
  byFill,
  highlightColor,
  highlightWidth,
  makeLayer,
  onDecorations,
  put,
  withLayerOpacity,
} from "@/lib/style/compile/parts";
import { extrudes, heightValue } from "@/lib/style/compile/polygons";
import type { Geometry } from "@/lib/style/compile/types";
import { type Expr, type Value, combine, fromForm, isZoomed, toProperty } from "@/lib/style/compile/values";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { type JsonObject, isObject } from "@/lib/style/json";
import {
  MARKER_SHAPES,
  type MarkerShapeId,
  drawsAsImage,
  isPin,
  markerShapeOf,
} from "@/lib/style/markerShapes";

const anchor = (name: unknown) => (typeof name === "string" ? name.replace("_", "-") : name);

const moves = (offset: unknown) => Array.isArray(offset) && (offset[0] !== 0 || offset[1] !== 0);

/** A halo width that is 0 where the outline is off: icon halos have no opacity of their own. */
function haloWidth(width: Value, opacity: Value): Value {
  if (!isZoomed(opacity) && typeof opacity.expr === "number") return opacity.expr > 0 ? width : { expr: 0 };
  return combine(
    [width, opacity],
    ([w, o]) => (typeof o === "number" ? (o > 0 ? w : 0) : ["case", [">", o, 0], w, 0]),
    { kind: "number" }
  );
}

/** The marker icon of every feature: the cascade's, or the one the context picks (`PartContext.icon`). */
function iconValue(
  ctx: PartContext,
  opts: { fields?: PartContext["fields"]; fallback: Expr; map?: (ref: string) => Expr }
): Value {
  if (ctx.icon) return { expr: ctx.icon.pick(opts.map ?? ((ref) => ref), opts.fallback) };
  return cascade(ctx.style, "marker.icon", {
    fields: opts.fields,
    fallback: opts.fallback,
    ...(opts.map ? { map: opts.map as (value: unknown) => Expr } : {}),
  });
}

/** Where a marker draws (spec 3.3): on the point; at each polygon's label anchor or each line's center point on
 * vector tiles; on GeoJSON, inside the polygon itself (MapLibre places one symbol in it) or at the middle of the
 * line. Raised polygons carry the marker on the roof, as their labels. */
interface Place {
  sourceLayer: string;
  layout: Record<string, unknown>;
  /** The layer draws on decoration points of this kind. */
  decoration?: "center";
  /** The features that have a marker, where the symbol leaves it out and classes or rules switch it on. */
  filter?: Expr;
}

const list = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isObject) : []);

/** On polygons and lines a marker the symbol leaves out is off (spec 3): the features a class or rule gives one, less
 * those a class or rule switches it off for. Undefined where every feature has one. */
function markerFilter(ctx: PartContext): Expr | undefined {
  const symbol = isObject(ctx.style.symbol) ? ctx.style.symbol : {};
  const base = isObject(symbol.marker);
  const records = [
    ...list(ctx.style.classify).flatMap((c) => [...list(c.classes), c.other, c.no_data]),
    ...list(ctx.style.rules),
  ];
  if (base && !records.some((r) => isObject(r) && r.marker === false)) return undefined;
  // Each record's marker as a number: 1 where it switches it on, 0 where off; the cascade picks each feature's.
  const on = (r: unknown): JsonObject | undefined => {
    if (!isObject(r)) return undefined;
    const { marker, ...rest } = r;
    return isObject(marker)
      ? { ...rest, marker: { on: 1 } }
      : marker === false
        ? { ...rest, marker: { on: 0 } }
        : rest;
  };
  const synthetic: JsonObject = {
    symbol: { marker: { on: base ? 1 : 0 } },
    classify: list(ctx.style.classify).map((c) => ({
      ...c,
      classes: list(c.classes).map(on),
      other: on(c.other),
      no_data: on(c.no_data),
    })),
    rules: list(ctx.style.rules).map(on),
  };
  const value = cascade(synthetic, "marker.on", { fields: ctx.fields, kind: "number", fallback: 0 });
  return ["==", toProperty(value), 1];
}

function placeOf(ctx: PartContext): Place {
  if (ctx.geometry === "point") return { sourceLayer: "default", layout: {} };
  const filter = markerFilter(ctx);
  if (ctx.geometry === "line") {
    if (ctx.vectorSource)
      return { sourceLayer: "default_decoration", layout: {}, decoration: "center", filter };
    const rotated = isSet(ctx.style, "marker.rotation");
    return {
      sourceLayer: "default",
      layout: { "symbol-placement": "line-center", "icon-rotation-alignment": rotated ? "map" : "viewport" },
      filter,
    };
  }
  if (ctx.vectorSource) ctx.out.tileParams.label = true;
  const layout = extrudes(ctx.style) ? { "symbol-height-offset": toProperty(heightValue(ctx)) } : {};
  return { sourceLayer: ctx.vectorSource ? "default_anchor" : "default", layout, filter };
}

/** A marker layer at its place. */
function placed(
  ctx: PartContext,
  place: Place,
  suffix: string,
  layout: Record<string, unknown>,
  paint: Record<string, unknown>,
  opts: Parameters<typeof makeLayer>[7] = {}
): LayerSpecification {
  const filters = [place.filter, opts.filter].filter((f) => f !== undefined);
  const filter = filters.length > 1 ? ["all", ...filters] : filters[0];
  const layer = makeLayer(
    ctx,
    suffix,
    "symbol",
    "marker",
    { ...layout, ...place.layout },
    paint,
    place.sourceLayer,
    {
      ...opts,
      filter,
    }
  );
  return place.decoration ? onDecorations(ctx, [place.decoration], layer) : layer;
}

/** Whether the layer's markers are drawn as images (lib/style/compile/markerImage.ts), given the icons it uses: the
 * icon alone never; on polygons and lines always; on points where the layer's shape, or one a class or rule sets,
 * draws as one (a shape, a pin, a circle with an icon). */
export function markersAsImages(
  style: JsonObject,
  geometry: Geometry | undefined,
  icons: string[] = setValues(style, "marker.icon").filter((r): r is string => typeof r === "string")
): boolean {
  const symbol = isObject(style.symbol) ? style.symbol : {};
  const shape = (isObject(symbol.marker) ? symbol.marker.shape : undefined) ?? DEFAULTS["marker.shape"];
  if (shape === "icon") return false;
  return (
    geometry !== "point" ||
    [shape, ...setValues(style, "marker.shape")].some((s) => drawsAsImage(s, icons.length > 0))
  );
}

export function pointLayers(ctx: PartContext): LayerSpecification[] {
  const { style } = ctx;
  const c = { fields: ctx.fields };
  if (!partUsed(style, "marker", ctx.geometry)) return [];
  // On polygons and lines the marker is always an image (circle layers draw at every vertex of a GeoJSON polygon or
  // line), and the outline is the polygon's border, not the marker's stroke.
  const point = ctx.geometry === "point";
  const place = placeOf(ctx);
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
  const outline = point && partUsed(style, "outline", "point");
  const offsetSet = setValues(style, "marker.offset").some(moves);
  const symbol = isObject(style.symbol) ? style.symbol : {};
  const baseMarker = isObject(symbol.marker) ? symbol.marker : {};
  // The layer's shape; classes and rules may set their own (the icon alone only the layer, spec 3.3).
  const shape = baseMarker.shape ?? DEFAULTS["marker.shape"];
  const baseSize =
    typeof baseMarker.size === "number" ? baseMarker.size : (DEFAULTS["marker.size"] as number);
  const colorOf = (map?: (color: unknown) => Expr): Value =>
    ctx.color !== undefined
      ? { expr: ctx.color(map ?? ((color) => color)) }
      : cascade(style, "marker.color", map ? { ...c, map } : c);
  const markerColor = colorOf();
  // An outline in the "fill" color takes the marker's color (the circle, or the icon's tint), "auto" its darker shade.
  const outlineColor = derivedValue(style, "outline.color", {
    geometry: "point",
    fields: ctx.fields,
    follow: colorOf,
  });

  const iconRefs = ctx.icon
    ? [...ctx.icon.refs]
    : setValues(style, "marker.icon").filter((r): r is string => typeof r === "string");
  if (markersAsImages(style, ctx.geometry, iconRefs))
    return markerImageLayers(ctx, place, markerShapeOf(shape), iconRefs, {
      size,
      opacity: hollowOpacity(1),
      fill,
      color: markerColor,
      follow: colorOf,
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
    "icon-image": toProperty(iconValue(ctx, { ...c, fallback: "goat:marker" })),
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
    const kind = iconValue(ctx, {
      ...c,
      fallback: "library",
      map: (r) => (keepsColors(r) ? "asset" : "library"),
    });
    const kindExpr: Expr = isZoomed(kind) ? "library" : kind.expr;
    layers.push(placed(ctx, place, "icon", layout, libraryPaint, { filter: ["==", kindExpr, "library"] }));
    layers.push(placed(ctx, place, "icon-asset", layout, ownPaint, { filter: ["==", kindExpr, "asset"] }));
  } else if (own) {
    layers.push(placed(ctx, place, "icon-asset", layout, ownPaint));
  } else {
    layers.push(placed(ctx, place, "icon", layout, libraryPaint));
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
  place: Place,
  shape: MarkerShapeId,
  refs: string[],
  marker: {
    size: Value;
    opacity: Value;
    fill: Value;
    color: Value;
    /** The marker color with each fixed color `map`ped. */
    follow: (map?: (color: unknown) => Expr) => Value;
    outline?: { color: Value };
  }
): LayerSpecification[] {
  const { style } = ctx;
  const c = { fields: ctx.fields };
  refs.forEach((ref) => ctx.images.add(ref));
  const largest = largestSize(style) ?? (DEFAULTS["marker.size"] as number);
  const width = marker.outline
    ? haloWidth(cascade(style, "outline.width", c), cascade(style, "outline.opacity", c))
    : { expr: 0 };
  const shapes = setValues(style, "marker.shape");
  // An icon color nothing sets: the reference color on a filled marker, the marker color on a hollow one (spec 3.3).
  const iconColor = derivedValue(style, "marker.icon_color", {
    geometry: ctx.geometry,
    fields: ctx.fields,
    follow: marker.follow,
    fill: marker.fill,
  });
  const parts = [
    cascade(style, "marker.shape", { ...c, fallback: "circle" }),
    iconValue(ctx, { ...c, fallback: "" }),
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
  // On polygons and lines the area or the line itself shows the active feature.
  if (ctx.input.highlight && ctx.geometry === "point") {
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
  layers.push(placed(ctx, place, "marker", layout, paint, { ordered: false }));
  return layers;
}
