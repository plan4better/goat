// How points are drawn (spec 8.1, 8.2, 8.3, 16): a heatmap from the vector tiles, clusters computed by MapLibre from
// the points themselves (a GeoJSON source), the cluster symbol styling the clusters over their count, or H3 hexagons
// from geoapi's hexagon tiles.
import type { LayerSpecification, SourceSpecification } from "maplibre-gl";

import { cascade, categoryInput, isSet, partUsed, perLayer } from "@/lib/style/compile/cascade";
import { FONT_STACKS, TILE_MAXZOOM } from "@/lib/style/compile/constants";
import { colorText, concat, numberText } from "@/lib/style/compile/imageNames";
import { type NumberFormatSpec, labelLayers, textField } from "@/lib/style/compile/labels";
import { MARKER_IMAGE } from "@/lib/style/compile/markerImage";
import { type PartContext, layerOpacity, makeLayer, put, withLayerOpacity } from "@/lib/style/compile/parts";
import { pointLayers } from "@/lib/style/compile/points";
import type { FieldType } from "@/lib/style/compile/types";
import {
  FILL_COLOR,
  type Value,
  combine,
  fromForm,
  isZoomed,
  substitute,
  toProperty,
} from "@/lib/style/compile/values";
import type { Expr } from "@/lib/style/compile/values";
import { PALETTES } from "@/lib/style/generated/catalog";
import { DEFAULTS, H3_AUTO_FROM_ZOOM } from "@/lib/style/generated/defaults";
import { type JsonObject, clone, isObject } from "@/lib/style/json";
import { isPin } from "@/lib/style/markerShapes";
import { paletteColors, paletteSteps } from "@/lib/style/palettes";
import { STYLE_VERSION } from "@/lib/style/version";

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

/** The cluster properties counting a cluster's points per icon category start with this. */
export const CLUSTER_COUNTER = "goat_cluster_";

const list = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isObject) : []);

/** The most categories a cluster counts its points in (spec 8.2): MapLibre evaluates every counter for every point
 * each time it clusters them, at every zoom, so the cost grows with their number. */
export const CLUSTER_CATEGORIES_MAX = 12;

/** The categories that give the points their icon, or else their color: the last categories classification whose
 * classes set it (it wins the cascade), its match input and each class's values (as the cascade matches them), icon
 * and color. Only the first CLUSTER_CATEGORIES_MAX classes that set an icon or a color, in list order: the points of
 * the others count as Other. */
interface MarkerCategories {
  input: Expr;
  classes: Array<{ labels: unknown[]; icon?: string; color?: string }>;
}

function markerCategories(style: JsonObject, fields?: Record<string, FieldType>): MarkerCategories | null {
  const classifications = list(style.classify)
    .filter((c) => c.method === "categories" && typeof c.field === "string")
    .reverse();
  const sets = (c: JsonObject, key: string) =>
    list(c.classes).some((k) => isObject(k.marker) && typeof k.marker[key] === "string");
  const c = classifications.find((c) => sets(c, "icon")) ?? classifications.find((c) => sets(c, "color"));
  if (!c) return null;
  const { input, label } = categoryInput(c.field as string, fields);
  const seen = new Set<string>();
  const classes: MarkerCategories["classes"] = [];
  for (const k of list(c.classes)) {
    if (classes.length === CLUSTER_CATEGORIES_MAX) break;
    const labels = (Array.isArray(k.values) ? k.values : [])
      .map(label)
      .filter((l) => l !== undefined && !seen.has(JSON.stringify(l)));
    labels.forEach((l) => seen.add(JSON.stringify(l)));
    const marker = isObject(k.marker) ? k.marker : {};
    const icon = typeof marker.icon === "string" ? marker.icon : undefined;
    const color = typeof marker.color === "string" ? marker.color : undefined;
    if (labels.length && (icon || color)) classes.push({ labels, icon, color });
  }
  return classes.length ? { input, classes } : null;
}

const counter = (name: string | number): Expr => ["get", `${CLUSTER_COUNTER}${name}`];

/** Per cluster, how many of its points fall in each category and how many in none (Other, No data). */
function categoryCounters(categories: MarkerCategories): Record<string, unknown> {
  const counters: Record<string, unknown> = {};
  const oneOf = (labels: unknown[]) => (labels.length === 1 ? labels[0] : labels);
  categories.classes.forEach((k, i) => {
    counters[`${CLUSTER_COUNTER}${i}`] = ["+", ["match", categories.input, oneOf(k.labels), 1, 0]];
  });
  counters[`${CLUSTER_COUNTER}other`] = [
    "+",
    ["match", categories.input, oneOf(categories.classes.flatMap((k) => k.labels)), 0, 1],
  ];
  return counters;
}

/** What the category most of a cluster's points have gives (`of` it), the first class on a tie; `base` where more of
 * them are in none, and for a class that gives nothing. */
function dominant(
  categories: MarkerCategories,
  of: (k: MarkerCategories["classes"][number]) => Expr | undefined,
  base: Expr
): Expr {
  return [
    "let",
    "m",
    ["max", ...categories.classes.map((_, i) => counter(i)), counter("other")],
    [
      "case",
      ...categories.classes.flatMap((k, i) => [["==", ["var", "m"], counter(i)], of(k) ?? base]),
      base,
    ],
  ];
}

/** A cluster's icon: that of its most common category, the base icon otherwise. */
function dominantIcon(categories: MarkerCategories, base: unknown): PartContext["icon"] {
  const icons = categories.classes.flatMap((k) => (k.icon ? [k.icon] : []));
  if (!icons.length) return undefined;
  return {
    refs: [...icons, ...(typeof base === "string" ? [base] : [])],
    pick: (map, fallback) =>
      dominant(
        categories,
        (k) => (k.icon ? map(k.icon) : undefined),
        typeof base === "string" ? map(base) : fallback
      ),
  };
}

/** A cluster's color: that of its most common category, the base color otherwise (one by zoom stays as it is). */
function dominantColor(categories: MarkerCategories, style: JsonObject): Expr | undefined {
  if (!categories.classes.some((k) => k.color)) return undefined;
  const base = cascade(style, "marker.color", {});
  return isZoomed(base) ? undefined : dominant(categories, (k) => k.color, base.expr);
}

const drawsLikeThePoints = (render: JsonObject) => (render.look ?? DEFAULTS["cluster.look"]) === "points";

export function clusterSource(
  data: string | GeoJSON.FeatureCollection,
  render: JsonObject,
  style: JsonObject,
  fields?: Record<string, FieldType>
): SourceSpecification {
  const categories = drawsLikeThePoints(render) ? markerCategories(style, fields) : null;
  return {
    type: "geojson",
    data,
    cluster: true,
    clusterRadius: num(render.radius, DEFAULTS["cluster.radius"]),
    clusterMinPoints: num(render.min_points, DEFAULTS["cluster.min_points"]),
    // cluster_until_zoom is exclusive (single points from it); MapLibre's clusterMaxZoom is inclusive.
    clusterMaxZoom: num(render.cluster_until_zoom, DEFAULTS["cluster.cluster_until_zoom"]) - 1,
    ...(categories || aggregateOf(render)
      ? {
          clusterProperties: {
            ...(categories ? categoryCounters(categories) : {}),
            ...valueAccumulators(render),
          },
        }
      : {}),
  } as SourceSpecification;
}

/** The cluster value's accumulator and how many of a cluster's points have a value. */
const VALUE = `${CLUSTER_COUNTER}value`;
const VALUE_N = `${CLUSTER_COUNTER}value_n`;
/** Stands for the cluster value in the cluster symbol until the layers are compiled (`withValue`). */
const SHOWN = "\u0000value";
/** Where a cluster has no point with a value, its smallest and largest start from these. */
const BEYOND = 1e300;

/** The clusters' value computed from a field (spec 8.2 `value`): its op and field; none for the count. */
function aggregateOf(render: JsonObject): { op: string; field: string } | null {
  const value = render.value;
  return isObject(value) && value.op !== "count" && typeof value.field === "string"
    ? { op: String(value.op), field: value.field }
    : null;
}

/** The cluster properties that compute the value: the sum (also for the mean), the smallest or the largest of the
 * field over a cluster's points, and how many of them have a value. */
function valueAccumulators(render: JsonObject): Record<string, unknown> {
  const aggregate = aggregateOf(render);
  if (!aggregate) return {};
  const { op, field } = aggregate;
  const has: Expr = ["has", field];
  const x: Expr = ["to-number", ["get", field], 0];
  const value =
    op === "min" || op === "max"
      ? [
          [op, ["accumulated"], ["get", VALUE]],
          ["case", has, x, op === "min" ? BEYOND : -BEYOND],
        ]
      : ["+", ["case", has, x, 0]];
  return { [VALUE]: value, [VALUE_N]: ["+", ["case", has, 1, 0]] };
}

/** A cluster's value: its count, or what the accumulators give, which it has where any of its points has a value
 * (the mean is the sum over those). */
function valueExpr(render: JsonObject): { get: Expr; has: Expr } {
  const aggregate = aggregateOf(render);
  if (!aggregate) return { get: ["get", "point_count"], has: true };
  const n: Expr = ["get", VALUE_N];
  return {
    get: aggregate.op === "mean" ? ["/", ["get", VALUE], ["max", n, 1]] : ["get", VALUE],
    has: [">", n, 0],
  };
}

/** The cluster symbol's numbers, for its labels: the count, and the value's stand-in. */
const CLUSTER_NUMBERS: Record<string, FieldType> = { point_count: "integer", [SHOWN]: "number" };

/** `node` with the stand-in for the cluster value replaced by the cluster's value. */
function withValue(node: unknown, value: { get: Expr; has: Expr }): unknown {
  if (!Array.isArray(node)) {
    if (!isObject(node)) return node;
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, withValue(v, value)]));
  }
  if (node[0] === "literal") return node;
  if (node.length === 2 && node[1] === SHOWN) {
    if (node[0] === "get") return value.get;
    if (node[0] === "has") return value.has;
  }
  return node.map((item) => withValue(item, value));
}

/** The cluster symbol with `count` read as MapLibre's `point_count`, and a domain for counts where none is given; with
 * a value computed from a field, `value` read as its stand-in. */
function overCount(node: unknown, minPoints: number, aggregate = false): unknown {
  if (Array.isArray(node)) return node.map((item) => overCount(item, minPoints, aggregate));
  if (typeof node === "string")
    return node
      .replace(/\{count\}/g, "{point_count}")
      .replace(/\{value\}/g, aggregate ? `{${SHOWN}}` : "{point_count}");
  if (!isObject(node)) return node;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) out[key] = overCount(value, minPoints, aggregate);
  if (out.field === "value" && aggregate) out.field = SHOWN;
  else if (out.field === "count" || out.field === "value") {
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

/** Cluster numbers as the app shortens them, "1.2 k", "3.4 M", in the viewer's language, and whole below a thousand. */
const SHORT = { abbreviate: true, decimals: 0 };

/** The cluster symbol's count label on the cluster itself (spec 8.2: the placement is fixed), without the labels'
 * default halo unless the symbol sets one: the count sits on the cluster's own color. */
function onCluster(symbol: unknown): unknown {
  if (!isObject(symbol) || !isObject(symbol.label)) return symbol;
  const label: JsonObject = { ...symbol.label, placement: "center" };
  if (label.halo === undefined) label.halo = { width: 0 };
  if (label.format === undefined) label.format = SHORT;
  return { ...symbol, label };
}

/** A value by attribute where a cluster has no attribute value to read: a range's middle, a palette's middle color,
 * else its `no_data` (none: the property's default); in zoom stops (spec 4.4) stop by stop, the default where a stop
 * has none. Any other value stays. */
function standIn(value: unknown): unknown {
  if (isObject(value) && Array.isArray(value.zoom)) {
    const stops = (value.zoom as unknown[]).map((stop) =>
      Array.isArray(stop) ? [stop[0], standIn(stop[1])] : stop
    );
    return stops.some((stop) => Array.isArray(stop) && stop[1] === undefined)
      ? undefined
      : { ...value, zoom: stops };
  }
  if (!isObject(value) || typeof value.field !== "string") return value;
  if (Array.isArray(value.range)) return ((value.range[0] as number) + (value.range[1] as number)) / 2;
  if (value.palette !== undefined) {
    const colors = paletteColors(value.palette as string | string[]);
    if (value.reverse === true) colors.reverse();
    if (colors.length) return colors[Math.floor(colors.length / 2)];
  }
  return value.no_data;
}

/** The parts' values by attribute replaced by their stand-ins (`standIn`). */
const withStandIns = (part: unknown): unknown =>
  isObject(part)
    ? Object.fromEntries(
        Object.entries(part)
          .map(([key, value]) => [key, standIn(value)])
          .filter(([, value]) => value !== undefined)
      )
    : part;

/** The points' own marker and outline for clusters drawn like them (spec 8.2 `look: points`): clusters have no
 * attribute values, so a size by attribute is the middle of its range and a color by attribute the middle of its
 * palette; values by zoom stay. Every cluster draws, its count on it or not. The legend's Clusters sample is drawn from
 * it too. */
export function pointsSymbol(style: JsonObject): JsonObject {
  const base = isObject(style.symbol) ? style.symbol : {};
  const symbol: JsonObject = {};
  if (isObject(base.marker))
    symbol.marker = { ...(withStandIns(base.marker) as JsonObject), allow_overlap: true };
  else if (base.marker !== undefined) symbol.marker = base.marker;
  if (base.outline !== undefined) symbol.outline = withStandIns(base.outline);
  return symbol;
}

/** Badge sides (px) for numbers below 100, 1,000, 10,000, 100,000 and from there on, at a 12 px number: shortened
 * numbers ("1.2 k", "12.3 k") take a few more characters than their digits. */
const BADGE_SIDES = [18, 26, 34, 40, 46];
/** The badge's ring where the cluster symbol has no outline: it sets the badge off a marker of the same color. */
const BADGE_RING = { color: "#ffffff", width: 1.5 };
/** The badge's middle is at least this far right of and above the cluster's place (px at a 12 px number), so it never
 * covers a small marker. */
const BADGE_CLEARANCE = 10;

/** Where the corner of an anchor's box lies: the share of the side left of and above the place. */
const ANCHOR_SHARES: Record<string, [number, number]> = {
  center: [0.5, 0.5],
  top: [0.5, 0],
  bottom: [0.5, 1],
  left: [0, 0.5],
  right: [1, 0.5],
  top_left: [0, 0],
  top_right: [1, 0],
  bottom_left: [0, 1],
  bottom_right: [1, 1],
};

/** `value` with each number it can give replaced by `fn` of it; null when an output is not a number. */
function mapNumbers(value: Value, fn: (n: number) => Expr): Value | null {
  const outputs = (expr: Expr): Expr | null => {
    if (typeof expr === "number") return fn(expr);
    if (!Array.isArray(expr)) return null;
    const op = expr[0];
    const last = expr.length - 1;
    const at = (isOutput: (i: number) => boolean) => {
      const mapped = expr.map((e, i) => (isOutput(i) ? outputs(e) : e));
      return mapped.some((e, i) => isOutput(i) && e === null) ? null : mapped;
    };
    if (op === "case") return at((i) => i >= 2 && (i % 2 === 0 || i === last));
    if (op === "match") return at((i) => i >= 3 && (i % 2 === 1 || i === last));
    if (op === "step") return at((i) => i >= 2 && i % 2 === 0);
    if (op === "interpolate") return at((i) => i >= 4 && i % 2 === 0);
    if (op === "let") return at((i) => i === last);
    return null;
  };
  if (!isZoomed(value)) {
    const expr = outputs(value.expr);
    return expr === null ? null : { expr };
  }
  const stops = value.stops.map(([z, e]) => [z, outputs(e)] as [number, Expr]);
  return stops.some(([, e]) => e === null) ? null : { ...value, stops };
}

/**
 * The count on a badge at the cluster marker's upper right (spec 8.2 `count: badge`): a filled circle in the cluster
 * symbol's marker color with its outline, the number in its label color. The badge and the number are moved by the same
 * px from the cluster's place, the icon in px (its size is 1) and the text in ems of its fixed size, per feature, so
 * they stay together over markers sized by count or by zoom.
 */
function badgeLayer(clusters: PartContext, own: JsonObject): LayerSpecification {
  const marker = clusters.style;
  const symbol: JsonObject = { version: STYLE_VERSION, kind: "vector", symbol: own };
  const label = isObject(own.label) ? own.label : {};
  const textSize = typeof label.size === "number" ? label.size : (DEFAULTS["label.size"] as number);
  const scale = textSize / (DEFAULTS["label.size"] as number);

  // The badge: its fill, its ring (the cluster symbol's outline where it has one).
  const fill = cascade(symbol, "marker.color", {});
  const outline = partUsed(symbol, "outline");
  const stroke = outline
    ? substitute(
        cascade(symbol, "outline.color", { map: (v) => (v === "fill" ? FILL_COLOR : v) }),
        FILL_COLOR,
        fill
      )
    : { expr: BADGE_RING.color };
  const strokeWidth = outline ? cascade(symbol, "outline.width", {}) : { expr: BADGE_RING.width };
  const sides = BADGE_SIDES.map((side) => Math.round(side * scale));
  // The number: the cluster label's (the count unless it shows the value), shortened unless it has a format.
  const template = typeof label.text === "string" ? label.text : "{point_count}";
  const only = /^\{([^{}]+)\}$/.exec(template.trim());
  const shown: Expr = ["abs", ["to-number", ["get", only ? only[1] : "point_count"], 0]];
  const format = (isObject(label.format) ? label.format : SHORT) as NumberFormatSpec;
  const text = textField(template, {
    fields: CLUSTER_NUMBERS,
    formatFor: () => format,
    onNumber: () => {
      clusters.out.state.locale = { default: "en-US" };
    },
  });
  const image = combine(
    [fill, stroke, strokeWidth],
    ([f, s, w]) => {
      const name = (side: number) =>
        concat([MARKER_IMAGE, `circle|${side}||`, colorText(f), "|", colorText(s), "|", numberText(w), "|"]);
      return [
        "step",
        shown,
        name(sides[0]),
        ...sides.slice(1).flatMap((side, i) => [10 ** (i + 2), name(side)]),
      ];
    },
    { step: true, kind: "choice" }
  );

  // The corner of the marker's box: its side (with the outline's width on each side) and where the anchor puts it.
  const base = isObject(marker.symbol) && isObject(marker.symbol.marker) ? marker.symbol.marker : {};
  const shape = base.shape ?? DEFAULTS["marker.shape"];
  const anchor = isSet(marker, "marker.anchor")
    ? perLayer(marker, "marker.anchor")
    : isPin(shape)
      ? "bottom"
      : "center";
  const [left, above] = ANCHOR_SHARES[anchor as string] ?? ANCHOR_SHARES.center;
  const ring = partUsed(marker, "outline", "point") ? perLayer(marker, "outline.width") : 0;
  const width = typeof ring === "number" ? ring : 0;
  const clearance = BADGE_CLEARANCE * scale;
  const corner = (size: number) => {
    const side = size + 2 * width;
    return [Math.max(side * (1 - left), clearance), Math.min(-side * above, -clearance)];
  };
  const size = cascade(marker, "marker.size", {});
  const fixedSize = typeof base.size === "number" ? base.size : (DEFAULTS["marker.size"] as number);
  const offset = (fn: (xy: number[]) => number[]) =>
    toProperty(
      mapNumbers(size, (s) => ["literal", fn(corner(s))]) ?? { expr: ["literal", fn(corner(fixedSize))] }
    );

  const layout: Record<string, unknown> = {
    "icon-image": toProperty(image),
    "icon-offset": offset((xy) => xy),
    "icon-allow-overlap": true,
    "icon-ignore-placement": true,
    "text-field": text,
    "text-font": [...FONT_STACKS.bold.normal],
    "text-size": textSize,
    "text-offset": offset((xy) => xy.map((px) => px / textSize)),
    "text-allow-overlap": true,
    "text-ignore-placement": true,
  };
  const paint: Record<string, unknown> = {
    "text-color": toProperty(
      cascade(symbol, "label.color", { fallback: DEFAULT_CLUSTER_SYMBOL.label.color })
    ),
  };
  return makeLayer(clusters, "badge", "symbol", "marker", layout, paint, "default", { ordered: false });
}

export function clusterLayers(ctx: PartContext, render: JsonObject): LayerSpecification[] {
  const minPoints = num(render.min_points, DEFAULTS["cluster.min_points"]);
  const own = overCount(
    clone(isObject(render.symbol) ? render.symbol : DEFAULT_CLUSTER_SYMBOL),
    minPoints,
    aggregateOf(render) !== null
  ) as JsonObject;
  const points = drawsLikeThePoints(render);
  const badge = (render.count ?? DEFAULTS["cluster.count"]) === "badge";
  // Drawn like the points: their marker and outline; otherwise the cluster symbol's. The count goes on the cluster
  // or on the badge.
  const { label, ...drawn } = own;
  const symbol: JsonObject = points ? pointsSymbol(ctx.style) : drawn;
  if (!badge && label !== undefined) symbol.label = label;
  const categories = points ? markerCategories(ctx.style, ctx.fields) : null;
  const base = isObject(ctx.style.symbol) && isObject(ctx.style.symbol.marker) ? ctx.style.symbol.marker : {};
  const style: JsonObject = { version: STYLE_VERSION, kind: "vector", symbol: onCluster(symbol) };
  const clusters: PartContext = {
    ...ctx,
    id: `${ctx.id}-cluster`,
    style,
    fields: CLUSTER_NUMBERS,
    filter: ["has", "point_count"],
    sortKey: undefined,
    icon: categories ? dominantIcon(categories, base.icon) : undefined,
    color: categories ? dominantColor(categories, style) : undefined,
  };
  const layers = [...pointLayers(clusters), ...labelLayers(clusters)];
  if (badge) layers.push(badgeLayer(clusters, own));
  return withValue(layers, valueExpr(render)) as LayerSpecification[];
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
    // One class (every cell holds the same value) has no breaks to step through.
    return scale.breaks.length
      ? ["step", value, scale.colors[0], ...scale.breaks.flatMap((b, i) => [b, scale.colors[i + 1]])]
      : scale.colors[0];
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

/** A hexagon's value scaled to 0 to 1 over a resolution's computed range (spec 5.8 linear or square root). */
function scaledValue(scale: unknown, min: number, max: number): Expr {
  const value: Expr = ["to-number", ["get", "value"], 0];
  const clamp = (t: Expr): Expr => ["max", 0, ["min", 1, t]];
  if (scale === "linear") return clamp(["/", ["-", value, min], max - min]);
  const [s0, s1] = [Math.sqrt(Math.max(min, 0)), Math.sqrt(Math.max(max, 0))];
  return clamp(["/", ["-", ["sqrt", ["max", value, 0]], s0], s1 - s0]);
}

/** How tall a column is, 0 to 1 of the tallest (3D spec 5.4): the scaled value of its resolution's computed range,
 * one half where nothing was computed. */
function columnShare(render: JsonObject, extrude: JsonObject): Expr {
  const scale = extrude.scale ?? DEFAULTS["h3.extrude.scale"];
  const computed =
    isObject(render.computed) && isObject(render.computed.resolutions) ? render.computed.resolutions : {};
  const branches = Object.entries(computed).flatMap(([res, cells]) => {
    const resolution = Number(res);
    if (!Number.isInteger(resolution) || !isObject(cells)) return [];
    const { min, max } = cells;
    if (typeof min !== "number" || typeof max !== "number") return [];
    const flat = scale === "linear" ? min >= max : Math.sqrt(Math.max(min, 0)) >= Math.sqrt(Math.max(max, 0));
    return [[resolution, flat ? 0.5 : scaledValue(scale, min, max)] as const];
  });
  if (!branches.length) return 0.5;
  branches.sort((a, b) => a[0] - b[0]);
  return ["match", ["get", "resolution"], ...branches.flat(), 0.5];
}

/** The hexagons as columns: the fill colour, base plus the column's share of the tallest, one opacity. */
function h3ColumnPaint(ctx: PartContext, render: JsonObject, extrude: JsonObject): Record<string, unknown> {
  const tallest = fromForm(extrude.tallest, "number", DEFAULTS["h3.extrude.tallest"]);
  const base = fromForm(extrude.base, "number", DEFAULTS["h3.extrude.base"]);
  const share = columnShare(render, extrude);
  const height = combine([base, tallest], ([b, t]) => ["+", b, ["*", share, t]], { kind: "number" });
  const paint: Record<string, unknown> = {
    "fill-extrusion-color": h3Color(render),
    "fill-extrusion-height": toProperty(height),
  };
  const baseProperty = toProperty(base);
  if (baseProperty !== 0) paint["fill-extrusion-base"] = baseProperty;
  paint["fill-extrusion-opacity"] = toProperty(
    withLayerOpacity(ctx, fromForm(render.opacity, "number", DEFAULTS["h3.opacity"]))
  );
  return paint;
}

/** The hexagons over geoapi's H3 tiles: a fill and, unless its width is 0, an outline; up to `points_from_zoom`.
 * With `extrude` the fill is a fill-extrusion of columns and the outline is not drawn (3D spec 7.6). */
export function h3Layers(ctx: PartContext, render: JsonObject): LayerSpecification[] {
  const source = h3SourceId(ctx.sourceId);
  const zooms: { minzoom?: number; maxzoom?: number } = {};
  if (typeof ctx.style.min_zoom === "number" && ctx.style.min_zoom > 0) zooms.minzoom = ctx.style.min_zoom;
  const max = Math.min(
    typeof ctx.style.max_zoom === "number" ? ctx.style.max_zoom : 24,
    typeof render.points_from_zoom === "number" ? render.points_from_zoom : 24
  );
  if (max < 24) zooms.maxzoom = max;
  if (isObject(render.extrude)) {
    const paint = h3ColumnPaint(ctx, render, render.extrude);
    return [
      { id: `${ctx.id}-h3-fill`, type: "fill-extrusion", source, "source-layer": "h3", ...zooms, paint },
    ] as LayerSpecification[];
  }
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
