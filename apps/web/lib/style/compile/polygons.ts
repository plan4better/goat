// Polygon parts (spec 3.1, 16): the fill, its pattern as a second fill layer (an image per look,
// lib/style/compile/patternImage.ts), the outline as a line layer.
import type { LayerSpecification } from "maplibre-gl";

import { cascade, isSet, partUsed, setValues } from "@/lib/style/compile/cascade";
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
} from "@/lib/style/compile/parts";
import { PATTERN_IMAGE } from "@/lib/style/compile/patternImage";
import { FILL_COLOR, type Value, combine, substitute, toProperty } from "@/lib/style/compile/values";

export const dashArray = (name: unknown) => ["literal", DASHES[name as string] ?? DASHES.solid];

export function polygonLayers(ctx: PartContext): LayerSpecification[] {
  const { style } = ctx;
  const c = { fields: ctx.fields };
  const layers: LayerSpecification[] = [];
  const opacity = layerOpacity(ctx);
  const fillColor = cascade(style, "fill.color", c);
  // The outline's "fill" and the pattern's default color: the fill color, class by class and stop by stop.
  const inFill = (value: Value) => substitute(value, FILL_COLOR, fillColor);

  if (partUsed(style, "fill", "polygon")) {
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
          if (kind === "none") return "";
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
          return typeof kind === "string" ? image : ["case", ["==", kind, "none"], "", image];
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
    const color = inFill(
      cascade(style, "outline.color", { ...c, map: (v) => (v === "fill" ? FILL_COLOR : v) })
    );
    put(paint, "line-color", highlightColor(ctx, color), ctx, "outline.color");
    put(paint, "line-width", highlightWidth(ctx, cascade(style, "outline.width", c)), ctx, "outline.width");
    put(paint, "line-opacity", cascade(style, "outline.opacity", c), ctx, "outline.opacity");
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
