// 3D buildings on every basemap (3D spec 7.3): the basemap's own extrusions, GOAT's extrusion on the basemap's
// OpenMapTiles source, or the deployment's building overlay.
import type {
  ExpressionSpecification,
  FillExtrusionLayerSpecification,
  FillLayerSpecification,
  FilterSpecification,
  LayerSpecification,
  StyleSpecification,
} from "maplibre-gl";

import { SCENE_DEFAULTS } from "@/lib/style/generated/scene";
import type { Scene } from "@/lib/style/generated/types";

import type { Basemap } from "@/types/map/common";

/**
 * A basemap's flat fill of the buildings an extrusion draws, with the `fill-opacity` that hides it where they show and
 * `copy`, GOAT's copy of it for the buildings the extrusions give no volume (`footprintCopy`).
 */
export interface Footprint {
  id: string;
  opacity: unknown;
  copy?: LayerSpecification;
}

/**
 * An extrusion's tiles reaching down to its footprints' tiles: MapLibre builds a layer in a tile only from the layer's
 * `minzoom` on, by the tile's zoom, and a tilted view loads its far tiles several zooms below the camera's. A
 * footprint hidden by the camera's zoom would leave those far buildings drawn by neither, so the extrusion is built
 * from the footprints' `minzoom` (every tile that has them, by the same rule) and shows from `shows`, its own
 * `minzoom`, by the camera's zoom as before.
 */
export interface Reach {
  minzoom: number;
  shows: number;
}

export type BuildingsPlan =
  | { kind: "own"; layers: string[]; footprints?: Footprint[]; reach?: Record<string, Reach> }
  | { kind: "source"; source: string; color?: string; footprints?: Footprint[]; reach?: Reach }
  | { kind: "overlay"; url: string }
  | { kind: "none" };

/** The id of GOAT's building layer and of the overlay's source. */
export const BUILDINGS_LAYER = "goat-buildings";
export const BUILDINGS_SOURCE = "goat-buildings-src";
/** The zoom GOAT's building layer starts at. */
const BUILDINGS_MINZOOM = 14;
/** The zoom a layer without `maxzoom` ends at (MapLibre's highest). */
const MAX_ZOOM = 24;
/** The id prefix of GOAT's copies of a basemap's footprints (`footprintCopy`). */
export const FOOTPRINT_COPY_PREFIX = "goat-footprint-";
/** GOAT's building layer's height. */
const BUILDINGS_HEIGHT = ["coalesce", ["get", "render_height"], 0];

/** The scene's buildings, from `buildings: true | false` or `{ on?, opacity? }`: `on` undefined is automatic. */
export function buildingsSetting(scene: Scene | undefined): { on: boolean | undefined; opacity: number } {
  const value = scene?.buildings;
  const part = typeof value === "object" && value !== null ? value : undefined;
  const on = typeof value === "boolean" ? value : (part?.on ?? undefined);
  return { on, opacity: part?.opacity ?? (SCENE_DEFAULTS["buildings.opacity"] as number) };
}

/**
 * The scene's `buildings` with `change` applied: `true` or `false` while it holds only `on`, else the object, and
 * undefined (automatic) when it holds nothing.
 */
export function withBuildings(
  scene: Scene | undefined,
  change: { on?: boolean; opacity?: number }
): Scene["buildings"] {
  const value = scene?.buildings;
  const current = typeof value === "boolean" ? { on: value } : { ...(value ?? {}) };
  const next: { on?: boolean | null; opacity?: number | null } = { ...current, ...change };
  if (next.on === undefined || next.on === null) delete next.on;
  if (next.opacity === undefined || next.opacity === null) delete next.opacity;
  if (next.opacity === undefined) return next.on;
  return next;
}

type Drawn = { source?: string; "source-layer"?: string };

/** Whether a fill draws the same features as an extrusion: the same source layer of the same source. */
const sameFeatures = (fill: Drawn, extrusion: Drawn) =>
  fill.source === extrusion.source && fill["source-layer"] === extrusion["source-layer"];

/** The constant fill colour of the style's first flat building layer on `source`. */
function buildingColor(style: StyleSpecification, source: string): string | undefined {
  const building = { source, "source-layer": "building" };
  const layer = style.layers.find((l) => l.type === "fill" && sameFeatures(l, building));
  const color = layer?.type === "fill" ? layer.paint?.["fill-color"] : undefined;
  return typeof color === "string" ? color : undefined;
}

/** Whether a paint value reads the zoom (an expression using `["zoom"]`, or a legacy function). */
const byZoom = (value: unknown): boolean =>
  Array.isArray(value)
    ? (value.length === 1 && value[0] === "zoom") || value.some(byZoom)
    : !!value && typeof value === "object";

/**
 * The `fill-opacity` that hides a fill from `from` to `until` and keeps its own elsewhere, or undefined where it
 * cannot: MapLibre takes the zoom only as the input of the top-level step, so a fill whose opacity reads the zoom (or is
 * a legacy function) is hidden only where the extrusion covers its whole range, and otherwise keeps its own.
 */
function hiddenOpacity(own: unknown, range: [number, number], from: number, until: number): unknown {
  if (byZoom(own)) return range[0] >= from && range[1] <= until ? 0 : undefined;
  const value = own ?? 1;
  return ["step", ["zoom"], value, from, 0, ...(until < range[1] ? [until, value] : [])];
}

/**
 * The `fill-opacity` of a footprint's copy: its own where `hiddenOpacity` hides the footprint, none elsewhere. An
 * opacity by zoom is hidden over the footprint's whole range, so the copy keeps it as it is.
 */
function shownOpacity(own: unknown, range: [number, number], from: number, until: number): unknown {
  if (byZoom(own)) return own;
  return ["step", ["zoom"], 0, from, own ?? 1, ...(until < range[1] ? [until, 0] : [])];
}

type Extrusion = Drawn & {
  id?: string;
  minzoom?: number;
  maxzoom?: number;
  filter?: unknown;
  paint?: { "fill-extrusion-height"?: unknown };
};

/** A basemap fill, as `footprintsOf` reads it. */
type Fill = FillLayerSpecification;

/**
 * The style's flat fills of the buildings `extrusions` draw (`sameFeatures`, shown, neither GOAT's nor a project
 * layer's), each with the opacity that hides it at the zooms the extrusions show: a footprint showing through the
 * translucent buildings would draw every building twice. A source layer counts as one kind of feature, as in
 * OpenMapTiles' `building` and basemap.de's `Gebaeudeflaeche`; structures that are not buildings have their own.
 */
function footprintsOf(
  style: StyleSpecification,
  extrusions: Extrusion[],
  isProjectLayer: (id: string) => boolean
): Array<Footprint & { layer: Fill }> {
  const out: Array<Footprint & { layer: Fill }> = [];
  for (const layer of style.layers) {
    if (layer.type !== "fill" || layer.layout?.visibility === "none") continue;
    if (layer.id.startsWith("goat-") || isProjectLayer(layer.id)) continue;
    const over = extrusions.filter((e) => sameFeatures(layer, e));
    if (!over.length) continue;
    const from = Math.min(...over.map((e) => e.minzoom ?? 0));
    const until = Math.max(...over.map((e) => e.maxzoom ?? MAX_ZOOM));
    const range: [number, number] = [layer.minzoom ?? 0, layer.maxzoom ?? MAX_ZOOM];
    if (Math.max(from, range[0]) >= Math.min(until, range[1])) continue;
    const own = layer.paint?.["fill-opacity"];
    const opacity = hiddenOpacity(own, range, from, until);
    if (opacity === undefined) continue;
    const copy = footprintCopy(layer, over, shownOpacity(own, range, from, until));
    out.push({ id: layer.id, opacity, layer, ...(copy ? { copy } : {}) });
  }
  return out;
}

/** How far `extrusion`'s tiles reach down: to the lowest tile zoom of the footprints it hides, where that is lower. */
function reachOf(extrusion: Extrusion, footprints: Array<{ layer: Fill }>): Reach | undefined {
  const over = footprints.filter((f) => sameFeatures(f.layer, extrusion));
  if (!over.length) return undefined;
  const shows = extrusion.minzoom ?? 0;
  const minzoom = Math.floor(Math.min(...over.map((f) => f.layer.minzoom ?? 0)));
  return minzoom < Math.floor(shows) ? { minzoom, shows } : undefined;
}

const footprintsOnly = (found: Array<Footprint & { layer: Fill }>): Footprint[] =>
  found.map(({ layer: _, ...footprint }) => footprint);

/**
 * A layer filter as an expression that can be combined with others, or undefined where it cannot: legacy filters
 * (basemap.de's `in`, `!in`, `==`) converted, expression filters as they are; one that reads the zoom or a legacy form
 * not converted here (`$type`, `<`) gives undefined.
 */
function filterCondition(filter: unknown): unknown {
  if (!Array.isArray(filter) || typeof filter[0] !== "string") return undefined;
  const [op, ...args] = filter as [string, ...unknown[]];
  if (op === "all" || op === "any" || op === "none") {
    const parts = args.map(filterCondition);
    if (parts.some((p) => p === undefined)) return undefined;
    return op === "none" ? ["!", ["any", ...parts]] : [op, ...parts];
  }
  if (typeof args[0] !== "string") return byZoom(filter) ? undefined : filter;
  const [key, ...values] = args as [string, ...unknown[]];
  if (key.startsWith("$")) return undefined;
  if (op === "has") return ["has", key];
  if (op === "!has") return ["!", ["has", key]];
  if ((op === "==" || op === "!=") && values.length === 1) return [op, ["get", key], values[0]];
  if (op === "in" || op === "!in") {
    const labels = [...new Set(values)];
    if (!labels.length) return op === "!in";
    const kind = typeof labels[0];
    if ((kind !== "string" && kind !== "number") || labels.some((v) => typeof v !== kind)) return undefined;
    return ["match", ["get", key], labels, op === "in", op === "!in"];
  }
  return undefined;
}

/**
 * The features no extrusion of `extrusions` gives a volume, as a filter, or false where every feature gets one. An
 * extrusion gives a feature a volume where it draws it (its filter, as far as `filterCondition` reads it; one it
 * cannot read is taken as drawing none, so the footprints stay) with a height above 0 (`fill-extrusion-height`,
 * MapLibre's 0 where unset; one by zoom is taken as above 0).
 */
function noVolume(extrusions: Extrusion[]): unknown {
  const raises: unknown[] = [];
  for (const e of extrusions) {
    const height = e.paint?.["fill-extrusion-height"];
    const above =
      height === undefined || typeof height === "number"
        ? (height ?? 0) > 0
        : byZoom(height) || [">", ["to-number", height, 0], 0];
    const draws = e.filter === undefined ? true : (filterCondition(e.filter) ?? false);
    if (above === false || draws === false) continue;
    const raised = above === true ? draws : draws === true ? above : ["all", draws, above];
    if (raised === true) return false;
    if (!raises.some((r) => JSON.stringify(r) === JSON.stringify(raised))) raises.push(raised);
  }
  if (!raises.length) return true;
  return ["!", raises.length === 1 ? raises[0] : ["any", ...raises]];
}

/**
 * GOAT's copy of a footprint the scene hides, for the buildings the extrusions give no volume (basemap.de's buildings
 * without `hoehe`, OpenMapTiles' merged buildings without `render_height` below zoom 14): the footprint's own source,
 * filter, zoom range, layout and paint, shown with `opacity` where the footprint is hidden, so those buildings stay
 * flat as the basemap draws them. Its filter carries the condition, as the footprint's own `fill-opacity` cannot: a
 * value by feature there turns the zoom step to the tiles' zoom. Undefined where the footprint's filter cannot be read.
 */
function footprintCopy(
  fill: Fill,
  extrusions: Extrusion[],
  opacity: unknown
): LayerSpecification | undefined {
  const own = fill.filter === undefined ? true : filterCondition(fill.filter);
  const none = noVolume(extrusions);
  if (own === undefined || none === false) return undefined;
  const filter = own === true ? none : none === true ? own : ["all", own, none];
  const { visibility: _, ...layout } = (fill.layout ?? {}) as Record<string, unknown>;
  return {
    id: FOOTPRINT_COPY_PREFIX + fill.id,
    type: "fill",
    source: fill.source,
    ...(fill["source-layer"] ? { "source-layer": fill["source-layer"] } : {}),
    ...(fill.minzoom !== undefined ? { minzoom: fill.minzoom } : {}),
    ...(fill.maxzoom !== undefined ? { maxzoom: fill.maxzoom } : {}),
    ...(filter === true ? {} : { filter: filter as FilterSpecification }),
    ...(Object.keys(layout).length ? { layout } : {}),
    paint: { ...fill.paint, "fill-opacity": opacity as number },
  } as LayerSpecification;
}

/**
 * The style as the basemap draws it: the paint the scene set on its layers (`recorded`, the basemap's own values by
 * layer id and property, undefined: unset) and the zoom range it lowered (`zooms`, the basemap's own `minzoom`)
 * replaced by the basemap's own, so footprints are read from their own opacity and extrusions from their own zoom.
 */
export function ownPaint(
  style: StyleSpecification | undefined,
  recorded: Map<string, Record<string, unknown>> | undefined,
  zooms?: Map<string, { minzoom?: number }>
): StyleSpecification | undefined {
  if (!style || (!recorded?.size && !zooms?.size)) return style;
  return {
    ...style,
    layers: style.layers.map((layer) => {
      const own = recorded?.get(layer.id);
      const zoom = zooms?.get(layer.id);
      if (!own && !zoom) return layer;
      const next: Record<string, unknown> = { ...layer };
      if (own) {
        const paint: Record<string, unknown> = { ...(layer as { paint?: object }).paint };
        for (const [prop, value] of Object.entries(own))
          if (value === undefined) delete paint[prop];
          else paint[prop] = value;
        next.paint = paint;
      }
      if (zoom)
        if (zoom.minzoom === undefined) delete next.minzoom;
        else next.minzoom = zoom.minzoom;
      return next as unknown as LayerSpecification;
    }),
  };
}

/**
 * How a basemap gets 3D buildings, from what it declares and what its loaded style has. The loaded style also holds
 * the project's layers and GOAT's own: `isProjectLayer` and the `goat-` prefix keep those out of the basemap's own
 * extrusions, so switching buildings off never hides a project layer's heights.
 */
export function buildingsPlan(
  basemap: Basemap,
  style: StyleSpecification | undefined,
  overlayUrl?: string,
  isProjectLayer: (id: string) => boolean = () => false
): BuildingsPlan {
  const declared = basemap.source === "builtin" ? basemap.buildings : undefined;
  if (declared === "own" && style) {
    const own = style.layers.filter(
      (l): l is FillExtrusionLayerSpecification =>
        l.type === "fill-extrusion" && !l.id.startsWith("goat-") && !isProjectLayer(l.id)
    );
    const layers = own.map((l) => l.id);
    if (layers.length) {
      const footprints = footprintsOf(style, own, isProjectLayer);
      const reach = Object.fromEntries(
        own.flatMap((l) => {
          const r = reachOf(l, footprints);
          return r ? [[l.id, r] as const] : [];
        })
      );
      return {
        kind: "own",
        layers,
        ...(footprints.length ? { footprints: footprintsOnly(footprints) } : {}),
        ...(Object.keys(reach).length ? { reach } : {}),
      };
    }
  }
  if (declared && declared !== "own" && style?.sources[declared.source]) {
    const color = buildingColor(style, declared.source);
    const extrusion = {
      source: declared.source,
      "source-layer": "building",
      minzoom: BUILDINGS_MINZOOM,
      paint: { "fill-extrusion-height": BUILDINGS_HEIGHT },
    };
    const footprints = footprintsOf(style, [extrusion], isProjectLayer);
    const reach = reachOf(extrusion, footprints);
    return {
      kind: "source",
      source: declared.source,
      ...(color ? { color } : {}),
      ...(footprints.length ? { footprints: footprintsOnly(footprints) } : {}),
      ...(reach ? { reach } : {}),
    };
  }
  return overlayUrl ? { kind: "overlay", url: overlayUrl } : { kind: "none" };
}

/**
 * An extrusion's opacity where its tiles reach below the zoom it shows from (`Reach`): none until then, so it looks
 * as before there (MapLibre draws no extrusion layer at opacity 0).
 */
export const reachedOpacity = (opacity: number, reach: Reach | undefined): number | unknown[] =>
  reach ? ["step", ["zoom"], 0, reach.shows, opacity] : opacity;

/**
 * GOAT's extrusion of OpenMapTiles buildings by their `render_height` and `render_min_height`; with a `reach`, built
 * from the basemap's footprint tiles on and shown from `BUILDINGS_MINZOOM`.
 */
export function buildingsLayer(
  source: string,
  color: string,
  opacity: number,
  sourceLayer = "building",
  reach?: Reach
): LayerSpecification {
  return {
    id: BUILDINGS_LAYER,
    type: "fill-extrusion",
    source,
    "source-layer": sourceLayer,
    minzoom: reach?.minzoom ?? BUILDINGS_MINZOOM,
    paint: {
      "fill-extrusion-color": color,
      "fill-extrusion-height": BUILDINGS_HEIGHT as ExpressionSpecification,
      "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
      "fill-extrusion-opacity": reachedOpacity(opacity, reach) as number,
    },
  };
}
