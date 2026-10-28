// The GOAT Style compiler (spec section 16): a layer style and its map entry in, MapLibre sources and layers out.
// Pure: the caller builds tile URLs, loads the listed images and puts the layers on the map.
import type { LayerSpecification, SourceSpecification } from "maplibre-gl";

import { cascade, featureFilter } from "@/lib/style/compile/cascade";
import { TILE_MAXZOOM } from "@/lib/style/compile/constants";
import { ImageCollector } from "@/lib/style/compile/images";
import { labelLayers } from "@/lib/style/compile/labels";
import { lineLayers } from "@/lib/style/compile/lines";
import type { PartContext } from "@/lib/style/compile/parts";
import { pointLayers } from "@/lib/style/compile/points";
import { polygonLayers } from "@/lib/style/compile/polygons";
import { rasterLayers } from "@/lib/style/compile/rasters";
import {
  clusterLayers,
  clusterSource,
  h3Layers,
  h3Source,
  h3SourceId,
  heatmapLayer,
} from "@/lib/style/compile/render";
import { serviceLayer, serviceSource } from "@/lib/style/compile/services";
import type { CompileInput, CompiledLayer, FieldType, Geometry } from "@/lib/style/compile/types";
import { type Expr, toProperty } from "@/lib/style/compile/values";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type JsonObject, isObject } from "@/lib/style/json";

export type { CompileInput, CompiledLayer } from "@/lib/style/compile/types";

/** The kind of source a style needs: vector tiles, the points themselves (clusters), a map service or a raster. */
export function sourceKind(style: LayerStyle): "tiles" | "points" | "service" | "raster" {
  if (style.kind === "raster") return "raster";
  return isObject(style.render) && style.render.type === "cluster" ? "points" : "tiles";
}

function sourceSpec(input: CompileInput, render: JsonObject): SourceSpecification | null {
  const { source } = input;
  if (source.type === "tiles")
    return { type: "vector", tiles: source.tiles, maxzoom: source.maxzoom ?? TILE_MAXZOOM };
  if (source.type === "points")
    return render.type === "cluster"
      ? clusterSource(source.data, render)
      : { type: "geojson", data: source.data };
  if (source.type === "service") return serviceSource(source, input.style as unknown as JsonObject);
  return null;
}

const list = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isObject) : []);

/** Sort keys of `order` (spec 7.1): by a field, or by the classes of the first classification, the first on top. */
function sortKeys(
  style: JsonObject,
  fields?: Record<string, FieldType>
): { draw: Expr; symbol: Expr } | undefined {
  const order = style.order;
  if (!isObject(order)) return undefined;
  if (typeof order.field === "string") {
    const value: Expr = ["to-number", ["get", order.field], 0];
    const negated: Expr = ["-", value];
    return order.top === "smallest" ? { draw: negated, symbol: value } : { draw: value, symbol: negated };
  }
  const c = list(style.classify)[0];
  if (order.by !== "classes" || !c) return undefined;
  const classes = list(c.classes);
  const n = classes.length;
  // The keys go through the cascade as a key of their own, so classes match features exactly as they do for parts.
  const keyed = (key: (i: number) => number, other: number, noData: number) => {
    const synthetic = {
      classify: [
        {
          ...c,
          classes: classes.map((k, i) => ({
            id: k.id,
            values: k.values,
            from: k.from,
            to: k.to,
            order: { key: key(i) },
          })),
          other: isObject(c.other) ? { order: { key: other } } : undefined,
          no_data: isObject(c.no_data) ? { order: { key: noData } } : undefined,
        },
      ],
    };
    return toProperty(cascade(synthetic, "order.key", { fields, kind: "number", fallback: other }));
  };
  return { draw: keyed((i) => n - i, 0, -1), symbol: keyed((i) => i, n, n + 1) };
}

/** The time slider's filter (spec 7.3): the field equals the slider value, dates by their year, month or day. Until a
 * value is set every time shows: the map sets the latest step once it knows the steps, and a thumbnail has no slider. */
function timeFilter(input: CompileInput, style: JsonObject): Expr | undefined {
  const time = style.time;
  if (!isObject(time) || typeof time.field !== "string") return undefined;
  const value: Expr = ["global-state", `${input.id}:time`];
  const unset: Expr = ["==", value, null];
  const type = input.fields?.[time.field];
  const length = { year: 4, month: 7, day: 10 }[time.step as string];
  if ((type === "date" || type === "datetime") && length) {
    return ["any", unset, ["==", ["slice", ["to-string", ["get", time.field]], 0, length], value]];
  }
  // Without field types (the map compiles without them) a step means a date: compared as text.
  if (!input.fields && length) {
    return [
      "any",
      unset,
      ["==", ["slice", ["to-string", ["get", time.field]], 0, length], ["to-string", value]],
    ];
  }
  return ["any", unset, ["==", ["get", time.field], value]];
}

/** The fields an expression reads (`get` and `has`). */
function fieldsRead(node: unknown, found: Set<string>): Set<string> {
  if (Array.isArray(node)) {
    if ((node[0] === "get" || node[0] === "has") && typeof node[1] === "string" && node.length === 2)
      found.add(node[1]);
    else node.forEach((item) => fieldsRead(item, found));
  } else if (isObject(node)) {
    Object.values(node).forEach((value) => fieldsRead(value, found));
  }
  return found;
}

export function compileLayer(input: CompileInput): CompiledLayer {
  const out: CompiledLayer = {
    id: input.id,
    sources: {},
    layers: [],
    images: [],
    state: {},
    tileParams: {},
    position: input.entry?.position ?? "top",
    unsupported: [],
  };
  const style = input.style as unknown as Record<string, unknown>;
  const render: JsonObject = isObject(style.render) ? style.render : { type: "features" };
  const source = sourceSpec(input, render);
  if (source) out.sources[input.source.id] = source;
  const geometry = input.geometry ?? (style.geometry as Geometry | undefined);
  const images = new ImageCollector(input.resolveIcon);
  if (style.kind === "raster") {
    // Raster files are colored in the browser until the raster service exists (spec 9); map services send finished
    // pictures.
    if (input.source.type === "service") out.layers.push(serviceLayer(input.id, input.source.id, style));
    else if (input.source.type === "raster")
      out.layers.push(...rasterLayers(input.id, input.source, style, out));
    else out.unsupported.push("raster_service");
  } else if (
    style.kind === "vector" &&
    geometry &&
    (input.source.type === "tiles" || input.source.type === "points")
  ) {
    const time = timeFilter(input, style);
    if (time) out.state[`${input.id}:time`] = { default: input.entry?.time?.value ?? null };
    const filters = [featureFilter(style, { fields: input.fields }), time].filter((f) => f !== undefined);
    const ctx: PartContext = {
      id: input.id,
      sourceId: input.source.id,
      vectorSource: input.source.type === "tiles",
      style,
      geometry,
      fields: input.fields,
      filter: filters.length > 1 ? ["all", ...filters] : filters[0],
      sortKey: sortKeys(style, input.fields),
      images,
      out,
      input,
    };
    const parts = () => {
      if (geometry === "point") out.layers.push(...pointLayers(ctx));
      if (geometry === "polygon") out.layers.push(...polygonLayers(ctx));
      if (geometry === "line") out.layers.push(...lineLayers(ctx));
      out.layers.push(...labelLayers(ctx));
    };
    if (geometry === "point" && (render.type === "heatmap" || render.type === "h3")) {
      if (render.type === "heatmap") {
        out.layers.push(heatmapLayer(ctx, render));
      } else if (input.source.type === "tiles") {
        out.sources[h3SourceId(input.source.id)] = h3Source(input.source.tiles, render);
        out.layers.push(...h3Layers(ctx, render));
      }
      const from = render.points_from_zoom;
      if (typeof from === "number") {
        const start = out.layers.length;
        parts();
        out.layers = out.layers.map((layer, i) =>
          i < start
            ? layer
            : ({ ...layer, minzoom: Math.max(layer.minzoom ?? 0, from) } as LayerSpecification)
        );
      }
    } else if (geometry === "point" && render.type === "cluster" && input.source.type === "points") {
      const singles: Expr = ["!", ["has", "point_count"]];
      ctx.filter = ctx.filter === undefined ? singles : ["all", singles, ctx.filter];
      parts();
      out.layers.push(...clusterLayers(ctx, render));
    } else {
      parts();
    }
    // Label anchors and decoration points carry only the fields asked for (spec 15).
    const extra = new Set<string>();
    for (const layer of out.layers) {
      const sourceLayer = (layer as { "source-layer"?: string })["source-layer"];
      if (sourceLayer === "default_anchor" || sourceLayer === "default_decoration") fieldsRead(layer, extra);
    }
    extra.delete("bearing");
    if (extra.size) out.tileParams.fields = [...extra].sort();
  }
  out.images = images.list();
  if (input.entry?.visible === false) {
    out.layers = out.layers.map(
      (layer) => ({ ...layer, layout: { ...layer.layout, visibility: "none" } }) as LayerSpecification
    );
  }
  return out;
}
