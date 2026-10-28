// How points are drawn (spec 8.1, 8.2, 8.3, 16): a heatmap from the vector tiles, clusters computed by MapLibre from
// the points themselves (a GeoJSON source), the cluster symbol styling the clusters over their count, or H3 hexagons
// from geoapi's hexagon tiles.
import type { LayerSpecification, SourceSpecification } from "maplibre-gl";

import { TILE_MAXZOOM } from "@/lib/style/compile/constants";
import { labelLayers } from "@/lib/style/compile/labels";
import { type PartContext, layerOpacity, makeLayer, put, withLayerOpacity } from "@/lib/style/compile/parts";
import { pointLayers } from "@/lib/style/compile/points";
import { fromForm } from "@/lib/style/compile/values";
import type { Expr } from "@/lib/style/compile/values";
import { PALETTES } from "@/lib/style/generated/catalog";
import { DEFAULTS, H3_AUTO_FROM_ZOOM } from "@/lib/style/generated/defaults";
import { type JsonObject, clone, isObject } from "@/lib/style/json";
import { paletteColors, paletteSteps } from "@/lib/style/palettes";

/** The cluster count's domain when a value form over `count` gives none: counts exist only in the browser. */
export const CLUSTER_COUNT_MAX = 1000;

const num = (v: unknown, d: unknown) => (typeof v === "number" ? v : (d as number));

export function heatmapLayer(ctx: PartContext, render: JsonObject): LayerSpecification {
  const paint: Record<string, unknown> = {};
  put(paint, "heatmap-radius", fromForm(render.radius, "number", DEFAULTS["heatmap.radius"]), ctx);
  put(paint, "heatmap-intensity", fromForm(render.intensity, "number", DEFAULTS["heatmap.intensity"]), ctx);
  put(
    paint,
    "heatmap-opacity",
    withLayerOpacity(ctx, fromForm(render.opacity, "number", DEFAULTS["heatmap.opacity"])),
    ctx
  );
  const weight = render.weight;
  if (isObject(weight) && typeof weight.field === "string") {
    const domain = Array.isArray(weight.domain) ? (weight.domain as number[]) : null;
    if (domain) {
      const [d0, d1] = domain;
      const x = ["to-number", ["get", weight.field], 0];
      // A domain of one value weighs every feature with a value the same (a weight of 0 would erase the heatmap);
      // a reversed domain weighs the other way round.
      paint["heatmap-weight"] =
        d0 === d1
          ? ["case", ["has", weight.field], 1, 0]
          : d0 < d1
            ? ["interpolate", ["linear"], x, d0, 0, d1, 1]
            : ["interpolate", ["linear"], x, d1, 1, d0, 0];
    }
  } else {
    put(paint, "heatmap-weight", num(weight, DEFAULTS["heatmap.weight"]), ctx);
  }
  const palette = render.palette ?? DEFAULTS["heatmap.palette"];
  const colors = [
    ...(Array.isArray(palette) ? (palette as string[]) : (PALETTES[palette as string]?.colors ?? [])),
  ];
  if (render.reverse === true) colors.reverse();
  // Transparent where there is no density, then the palette spread over the rest.
  paint["heatmap-color"] = [
    "interpolate",
    ["linear"],
    ["heatmap-density"],
    0,
    "rgba(0, 0, 0, 0)",
    ...colors.flatMap((c, i) => [Number(((i + 1) / colors.length).toFixed(10)), c]),
  ];
  const layer = makeLayer(ctx, "heatmap", "heatmap", "heatmap", {}, paint) as LayerSpecification & {
    maxzoom?: number;
  };
  if (typeof render.points_from_zoom === "number")
    layer.maxzoom = Math.min(layer.maxzoom ?? 24, render.points_from_zoom);
  return layer;
}

export function clusterSource(
  data: string | GeoJSON.FeatureCollection,
  render: JsonObject
): SourceSpecification {
  return {
    type: "geojson",
    data,
    cluster: true,
    clusterRadius: num(render.radius, DEFAULTS["cluster.radius"]),
    clusterMinPoints: num(render.min_points, DEFAULTS["cluster.min_points"]),
    // cluster_until_zoom is exclusive (single points from it); MapLibre's clusterMaxZoom is inclusive.
    clusterMaxZoom: num(render.cluster_until_zoom, DEFAULTS["cluster.cluster_until_zoom"]) - 1,
  };
}

/** The cluster symbol with `count` read as MapLibre's `point_count`, and a domain for counts where none is given. */
function overCount(node: unknown, minPoints: number): unknown {
  if (Array.isArray(node)) return node.map((item) => overCount(item, minPoints));
  if (typeof node === "string") return node.replace(/\{count\}/g, "{point_count}");
  if (!isObject(node)) return node;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) out[key] = overCount(value, minPoints);
  if (out.field === "count") {
    out.field = "point_count";
    if (("range" in out || "palette" in out) && out.domain === undefined)
      out.domain = [minPoints, CLUSTER_COUNT_MAX];
  }
  return out;
}

/** The cluster symbol when the style gives none (spec 8.2 example): circles sized by count, the count in white. */
export const DEFAULT_CLUSTER_SYMBOL = {
  marker: { shape: "circle", size: { field: "count", range: [16, 40], scale: "sqrt" } },
  label: { text: "{count}", color: "#ffffff" },
};

export function clusterLayers(ctx: PartContext, render: JsonObject): LayerSpecification[] {
  const minPoints = num(render.min_points, DEFAULTS["cluster.min_points"]);
  const symbol = overCount(
    clone(isObject(render.symbol) ? render.symbol : DEFAULT_CLUSTER_SYMBOL),
    minPoints
  );
  const clusters: PartContext = {
    ...ctx,
    id: `${ctx.id}-cluster`,
    style: { version: 1, kind: "vector", symbol },
    fields: {},
    filter: ["has", "point_count"],
    sortKey: undefined,
  };
  return [...pointLayers(clusters), ...labelLayers(clusters)];
}

/** The id of the hexagon tile source next to the layer's own. */
export const h3SourceId = (sourceId: string) => `${sourceId}-h3`;

/** geoapi's hexagon tiles: the layer's tile URLs asking for the render's resolution and value (spec 8.3). */
export function h3Source(tiles: string[], render: JsonObject): SourceSpecification {
  const value = isObject(render.value) ? render.value : {};
  const op = typeof value.op === "string" ? value.op : "count";
  const query = [
    `h3=${encodeURIComponent(String(render.resolution ?? DEFAULTS["h3.resolution"]))}`,
    `h3_value=${op}`,
    ...(op !== "count" && typeof value.field === "string"
      ? [`h3_field=${encodeURIComponent(value.field)}`]
      : []),
  ].join("&");
  return {
    type: "vector",
    tiles: tiles.map((url) => `${url}${url.includes("?") ? "&" : "?"}${query}`),
    maxzoom: TILE_MAXZOOM,
  };
}

/** How an H3 render colors one resolution's hexagons (spec 8.3): classes (`breaks` between `colors`), the palette
 * over the cell values' range, or one color while nothing is computed for it. Manual classes apply at every
 * resolution; computed ones come from `render.computed`. */
export type H3Scale =
  | { kind: "classes"; colors: string[]; breaks: number[]; domain?: [number, number] }
  | { kind: "ramp"; colors: string[]; min: number; max: number }
  | { kind: "color"; color: string };

/** The resolution an H3 render draws at `zoom`: its fixed one, or the auto one (goatlib's table, as geoapi picks). */
export function h3Resolution(render: JsonObject, zoom: number): number {
  if (typeof render.resolution === "number") return render.resolution;
  let resolution = H3_AUTO_FROM_ZOOM[0][1];
  for (const [from, res] of H3_AUTO_FROM_ZOOM) if (zoom >= from) resolution = res;
  return resolution;
}

export function h3Scale(render: JsonObject, resolution: number): H3Scale {
  const classify = isObject(render.classify) ? render.classify : null;
  const own = classify?.palette !== undefined && classify?.palette !== null;
  const palette = ((own ? classify?.palette : render.palette) ?? DEFAULTS["h3.palette"]) as string | string[];
  const reverse = (own ? classify?.reverse : render.reverse) === true;
  const ordered = (colors: string[]) => (reverse ? [...colors].reverse() : colors);
  const all = ordered(paletteColors(palette));
  const middle: H3Scale = { kind: "color", color: all[Math.floor(all.length / 2)] ?? "#808080" };
  const classes = classify && Array.isArray(classify.classes) ? classify.classes.filter(isObject) : [];
  const stepped = (breaks: number[], domain?: [number, number]): H3Scale => {
    const n = breaks.length + 1;
    const sampled = ordered(paletteSteps(palette, n));
    const colors = Array.from({ length: n }, (_, i) =>
      typeof classes[i]?.color === "string" ? (classes[i].color as string) : (sampled[i] ?? middle.color)
    );
    return { kind: "classes", colors, breaks, ...(domain ? { domain } : {}) };
  };
  if (classify?.method === "manual") {
    const breaks = classes.slice(1).map((k) => k.from);
    const ascending = breaks.every(
      (b, i) => typeof b === "number" && (i === 0 || b > (breaks[i - 1] as number))
    );
    return breaks.length && ascending ? stepped(breaks as number[]) : middle;
  }
  const computed =
    isObject(render.computed) && isObject(render.computed.resolutions) ? render.computed.resolutions : {};
  const cells = computed[String(resolution)];
  if (!isObject(cells) || typeof cells.min !== "number" || typeof cells.max !== "number") return middle;
  if (classify)
    return Array.isArray(cells.breaks) ? stepped(cells.breaks as number[], [cells.min, cells.max]) : middle;
  if (cells.min === cells.max || all.length < 2) return middle;
  return { kind: "ramp", colors: all, min: cells.min, max: cells.max };
}

function scaleExpr(scale: H3Scale): Expr {
  const value: Expr = ["to-number", ["get", "value"], 0];
  if (scale.kind === "color") return scale.color;
  if (scale.kind === "classes")
    return ["step", value, scale.colors[0], ...scale.breaks.flatMap((b, i) => [b, scale.colors[i + 1]])];
  const { colors, min, max } = scale;
  return [
    "interpolate",
    ["linear"],
    value,
    ...colors.flatMap((c, i) => [Number((min + ((max - min) * i) / (colors.length - 1)).toFixed(10)), c]),
  ];
}

/** The hexagons' fill color: one scale per computed resolution, chosen by the hexagon's `resolution`. */
function h3Color(render: JsonObject): Expr {
  const fallback = h3Scale({ ...render, computed: undefined }, 0);
  const computed =
    isObject(render.computed) && isObject(render.computed.resolutions) ? render.computed.resolutions : {};
  const byResolution = Object.keys(computed)
    .map(Number)
    .filter((res) => Number.isInteger(res))
    .sort((a, b) => a - b)
    .map((res) => [res, h3Scale(render, res)] as const)
    .filter(([, scale]) => scale.kind !== "color");
  if (isObject(render.classify) && render.classify.method === "manual") return scaleExpr(fallback);
  if (!byResolution.length) return scaleExpr(fallback);
  if (byResolution.length === 1) return scaleExpr(byResolution[0][1]);
  return [
    "match",
    ["get", "resolution"],
    ...byResolution.flatMap(([res, scale]) => [res, scaleExpr(scale)]),
    scaleExpr(fallback),
  ];
}

/** The hexagons over geoapi's H3 tiles: a fill and, unless its width is 0, an outline; up to `points_from_zoom`. */
export function h3Layers(ctx: PartContext, render: JsonObject): LayerSpecification[] {
  const source = h3SourceId(ctx.sourceId);
  const zooms: { minzoom?: number; maxzoom?: number } = {};
  if (typeof ctx.style.min_zoom === "number" && ctx.style.min_zoom > 0) zooms.minzoom = ctx.style.min_zoom;
  const max = Math.min(
    typeof ctx.style.max_zoom === "number" ? ctx.style.max_zoom : 24,
    typeof render.points_from_zoom === "number" ? render.points_from_zoom : 24
  );
  if (max < 24) zooms.maxzoom = max;
  const fillPaint: Record<string, unknown> = { "fill-color": h3Color(render) };
  put(
    fillPaint,
    "fill-opacity",
    withLayerOpacity(ctx, fromForm(render.opacity, "number", DEFAULTS["h3.opacity"])),
    ctx
  );
  const layers = [
    { id: `${ctx.id}-h3-fill`, type: "fill", source, "source-layer": "h3", ...zooms, paint: fillPaint },
  ] as LayerSpecification[];
  const outline = isObject(render.outline) ? render.outline : {};
  const width = typeof outline.width === "number" ? outline.width : (DEFAULTS["h3.outline.width"] as number);
  if (width > 0) {
    const linePaint: Record<string, unknown> = {
      "line-color": typeof outline.color === "string" ? outline.color : DEFAULTS["h3.outline.color"],
      "line-width": width,
    };
    const layer = layerOpacity(ctx);
    if (layer) put(linePaint, "line-opacity", layer, ctx);
    layers.push({
      id: `${ctx.id}-h3-outline`,
      type: "line",
      source,
      "source-layer": "h3",
      ...zooms,
      paint: linePaint,
    } as LayerSpecification);
  }
  return layers;
}
