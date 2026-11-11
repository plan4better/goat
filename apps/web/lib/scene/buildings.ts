// 3D buildings on every basemap (3D spec 7.3): the basemap's own extrusions, GOAT's extrusion on the basemap's
// OpenMapTiles source, or the deployment's building overlay.
import type { LayerSpecification, StyleSpecification } from "maplibre-gl";

import { SCENE_DEFAULTS } from "@/lib/style/generated/scene";
import type { Scene } from "@/lib/style/generated/types";

import type { Basemap } from "@/types/map/common";

/** A basemap's flat fill of the buildings an extrusion draws, with the `fill-opacity` that hides it where they show. */
export interface Footprint {
  id: string;
  opacity: unknown;
}

export type BuildingsPlan =
  | { kind: "own"; layers: string[]; footprints?: Footprint[] }
  | { kind: "source"; source: string; color?: string; footprints?: Footprint[] }
  | { kind: "overlay"; url: string }
  | { kind: "none" };

/** The id of GOAT's building layer and of the overlay's source. */
export const BUILDINGS_LAYER = "goat-buildings";
export const BUILDINGS_SOURCE = "goat-buildings-src";
/** The zoom GOAT's building layer starts at. */
const BUILDINGS_MINZOOM = 14;
/** The zoom a layer without `maxzoom` ends at (MapLibre's highest). */
const MAX_ZOOM = 24;

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
 * The style's flat fills of the buildings `extrusions` draw (`sameFeatures`, shown, neither GOAT's nor a project
 * layer's), each with the opacity that hides it at the zooms the extrusions show: a footprint showing through the
 * translucent buildings would draw every building twice. A source layer counts as one kind of feature, as in
 * OpenMapTiles' `building` and basemap.de's `Gebaeudeflaeche`; structures that are not buildings have their own.
 */
function footprintsOf(
  style: StyleSpecification,
  extrusions: Array<Drawn & { minzoom?: number; maxzoom?: number }>,
  isProjectLayer: (id: string) => boolean
): Footprint[] {
  const out: Footprint[] = [];
  for (const layer of style.layers) {
    if (layer.type !== "fill" || layer.layout?.visibility === "none") continue;
    if (layer.id.startsWith("goat-") || isProjectLayer(layer.id)) continue;
    const over = extrusions.filter((e) => sameFeatures(layer, e));
    if (!over.length) continue;
    const from = Math.min(...over.map((e) => e.minzoom ?? 0));
    const until = Math.max(...over.map((e) => e.maxzoom ?? MAX_ZOOM));
    const range: [number, number] = [layer.minzoom ?? 0, layer.maxzoom ?? MAX_ZOOM];
    if (Math.max(from, range[0]) >= Math.min(until, range[1])) continue;
    const opacity = hiddenOpacity(layer.paint?.["fill-opacity"], range, from, until);
    if (opacity !== undefined) out.push({ id: layer.id, opacity });
  }
  return out;
}

/**
 * The style as the basemap draws it: the paint the scene set on its layers (`recorded`, the basemap's own values by
 * layer id and property, undefined: unset) replaced by the basemap's own, so footprints are read from their own opacity.
 */
export function ownPaint(
  style: StyleSpecification | undefined,
  recorded: Map<string, Record<string, unknown>> | undefined
): StyleSpecification | undefined {
  if (!style || !recorded?.size) return style;
  return {
    ...style,
    layers: style.layers.map((layer) => {
      const own = recorded.get(layer.id);
      if (!own) return layer;
      const paint: Record<string, unknown> = { ...(layer as { paint?: object }).paint };
      for (const [prop, value] of Object.entries(own))
        if (value === undefined) delete paint[prop];
        else paint[prop] = value;
      return { ...layer, paint } as LayerSpecification;
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
      (l) => l.type === "fill-extrusion" && !l.id.startsWith("goat-") && !isProjectLayer(l.id)
    );
    const layers = own.map((l) => l.id);
    if (layers.length) {
      const footprints = footprintsOf(style, own, isProjectLayer);
      return { kind: "own", layers, ...(footprints.length ? { footprints } : {}) };
    }
  }
  if (declared && declared !== "own" && style?.sources[declared.source]) {
    const color = buildingColor(style, declared.source);
    const extrusion = { source: declared.source, "source-layer": "building", minzoom: BUILDINGS_MINZOOM };
    const footprints = footprintsOf(style, [extrusion], isProjectLayer);
    return {
      kind: "source",
      source: declared.source,
      ...(color ? { color } : {}),
      ...(footprints.length ? { footprints } : {}),
    };
  }
  return overlayUrl ? { kind: "overlay", url: overlayUrl } : { kind: "none" };
}

/** GOAT's extrusion of OpenMapTiles buildings by their `render_height` and `render_min_height`. */
export function buildingsLayer(
  source: string,
  color: string,
  opacity: number,
  sourceLayer = "building"
): LayerSpecification {
  return {
    id: BUILDINGS_LAYER,
    type: "fill-extrusion",
    source,
    "source-layer": sourceLayer,
    minzoom: BUILDINGS_MINZOOM,
    paint: {
      "fill-extrusion-color": color,
      "fill-extrusion-height": ["coalesce", ["get", "render_height"], 0],
      "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
      "fill-extrusion-opacity": opacity,
    },
  };
}
