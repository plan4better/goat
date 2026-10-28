// Line parts (spec 3.2, 16): the casing below the line with the same filter, zooms and layout (its width the line
// width plus twice the casing width), the line, and arrows along it or at geoapi's decoration points.
import type { LayerSpecification } from "maplibre-gl";

import { cascade, isSet, partUsed, perLayer } from "@/lib/style/compile/cascade";
import { ICON_HEIGHT } from "@/lib/style/compile/constants";
import {
  type PartContext,
  highlightColor,
  highlightWidth,
  layerOpacity,
  makeLayer,
  put,
  withLayerOpacity,
} from "@/lib/style/compile/parts";
import { dashArray } from "@/lib/style/compile/polygons";
import { combine, fromForm, toProperty } from "@/lib/style/compile/values";

export function lineLayers(ctx: PartContext): LayerSpecification[] {
  const { style } = ctx;
  const c = { fields: ctx.fields };
  if (!partUsed(style, "line", "line")) return [];
  const layers: LayerSpecification[] = [];
  const opacity = layerOpacity(ctx);
  const width = cascade(style, "line.width", c);
  const offset = cascade(style, "line.offset", c);
  const lineColor = cascade(style, "line.color", c);
  const layout: Record<string, unknown> = {};
  put(layout, "line-cap", cascade(style, "line.cap", c), ctx, "line.cap");
  put(layout, "line-join", cascade(style, "line.join", c), ctx, "line.join");

  if (partUsed(style, "casing", "line")) {
    const casingWidth = combine(
      [width, cascade(style, "casing.width", c)],
      ([l, w]) => ["+", l, ["*", 2, w]],
      { kind: "number" }
    );
    const paint: Record<string, unknown> = {};
    put(paint, "line-color", cascade(style, "casing.color", c), ctx, "casing.color");
    paint["line-width"] = toProperty(casingWidth);
    put(paint, "line-offset", offset, ctx, "line.offset");
    put(paint, "line-opacity", cascade(style, "casing.opacity", c), ctx, "casing.opacity");
    if (opacity) paint["line-layer-opacity"] = toProperty(opacity);
    layers.push(makeLayer(ctx, "casing", "line", "line", layout, paint));
  }

  const paint: Record<string, unknown> = {};
  put(paint, "line-color", highlightColor(ctx, lineColor), ctx, "line.color");
  put(paint, "line-width", highlightWidth(ctx, width), ctx, "line.width");
  put(paint, "line-offset", offset, ctx, "line.offset");
  put(paint, "line-opacity", cascade(style, "line.opacity", c), ctx, "line.opacity");
  put(paint, "line-blur", cascade(style, "line.blur", c), ctx, "line.blur");
  if (isSet(style, "line.dash"))
    paint["line-dasharray"] = toProperty(cascade(style, "line.dash", { ...c, map: dashArray }));
  if (opacity) paint["line-layer-opacity"] = toProperty(opacity);
  layers.push(makeLayer(ctx, "line", "line", "line", layout, paint));

  if (partUsed(style, "arrows", "line")) layers.push(...arrowLayers(ctx, lineColor));
  return layers;
}

function arrowLayers(ctx: PartContext, lineColor: ReturnType<typeof cascade>): LayerSpecification[] {
  const { style } = ctx;
  const c = { fields: ctx.fields };
  ctx.images.add("goat:arrow");
  const placement = perLayer(style, "arrows.placement");
  const direction = perLayer(style, "arrows.direction");
  const size = combine([cascade(style, "arrows.size", c)], ([s]) => ["/", s, ICON_HEIGHT], {
    kind: "number",
  });
  // Arrows take the line's color, class by class, unless a record colors them.
  const color = isSet(style, "arrows.color") ? cascade(style, "arrows.color", c) : lineColor;
  const layout = {
    "icon-image": "goat:arrow",
    "icon-size": toProperty(size),
    "icon-rotation-alignment": "map",
    "icon-allow-overlap": true,
  };
  const paint: Record<string, unknown> = { "icon-color": toProperty(color) };
  // Arrows have no opacity key; the part's on and off (spec 3) and the layer opacity reach them here.
  put(
    paint,
    "icon-opacity",
    withLayerOpacity(ctx, cascade(style, "arrows.opacity", { ...c, kind: "number", fallback: 1 })),
    ctx
  );
  const kinds = direction === "both" ? ["forward", "backward"] : [direction];
  const suffix = (i: number) => (i ? "arrows-back" : "arrows");
  if (placement === "repeat") {
    // goat:arrow points north; along a line MapLibre aligns the icon's x axis with the line.
    const spacing = toProperty(fromForm(perLayer(style, "arrows.spacing"), "number", 100));
    return kinds.map((k, i) =>
      makeLayer(
        ctx,
        suffix(i),
        "symbol",
        "arrows",
        {
          "symbol-placement": "line",
          "symbol-spacing": spacing,
          ...layout,
          "icon-rotate": k === "backward" ? 270 : 90,
        },
        paint
      )
    );
  }
  const decorations =
    placement === "both_ends" ? ["start", "end"] : [placement as "start" | "end" | "center"];
  ctx.out.tileParams.decorations = [
    ...new Set([...(ctx.out.tileParams.decorations ?? []), ...decorations]),
  ] as Array<"start" | "end" | "center">;
  return kinds.map((k, i) =>
    makeLayer(
      ctx,
      suffix(i),
      "symbol",
      "arrows",
      {
        ...layout,
        "icon-rotate": k === "backward" ? ["+", ["get", "bearing"], 180] : ["get", "bearing"],
      },
      paint,
      "default_decoration"
    )
  );
}
