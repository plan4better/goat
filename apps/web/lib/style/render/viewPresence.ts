// The classes drawn in a map's view (spec 7.2 `legend.classes: view`), per map and layer: a small store the legends
// read, filled by a watcher on the map that the renderer starts. After a move ends (and a short pause, so a pan in
// several drags counts once) and the view's tiles are in, it asks MapLibre for the features it drew on each such
// layer's own MapLibre layers, one after the other, and stops as soon as every class was seen. Nothing runs while the
// map moves, and layers whose legend lists every class or the filter's are never read.
import type { JsonObject } from "@/lib/style/json";
import { type ClassPresence, type Presence, legendClasses } from "@/lib/style/legend";
import { type ViewFeature, countPresence } from "@/lib/style/presence";
import { mapLayerIdsOf } from "@/lib/style/render/mapLayers";
import { GEOMETRY_PARTS } from "@/lib/style/render/viewLayers";

/** The parts that draw a feature itself: a fill's pattern too; not labels, clusters (no fields) or a heatmap. */
const VIEW_PARTS = [...GEOMETRY_PARTS.filter((part) => part !== "heatmap"), "pattern"];

/** How long the map rests after a move before the count. */
const PAUSE_MS = 300;

/** The project map's counts (the map, dashboards and published maps), and a print layout's map's. */
export const MAP_SCOPE = "map";
export const printScope = (mapElementId: string): string => `print:${mapElementId}`;

const scopes = new Map<string, Map<string, Presence>>();
const listeners = new Set<() => void>();
/** The maps that have counted once: until then their legends wait rather than list every class. */
const countedScopes = new Set<string>();

/** The classes in a map's view of one layer (by the renderer's layer key), once counted. */
export const viewPresence = (scope: string, key: string): Presence | undefined => scopes.get(scope)?.get(key);

/** Whether the map has counted its view once; a layer it then has no count of lists every class. */
export const viewCounted = (scope: string): boolean => countedScopes.has(scope);

export function subscribeViewPresence(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const sameClasses = (a: ClassPresence, b: ClassPresence | undefined) =>
  !!b &&
  a.other === b.other &&
  a.no_data === b.no_data &&
  a.classes.size === b.classes.size &&
  [...a.classes].every((key) => b.classes.has(key));

const samePresence = (a: Presence | undefined, b: Presence | undefined) =>
  a === b ||
  (!!a &&
    !!b &&
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(([key, value]) => sameClasses(value, b[key])));

/** Keeps the count of one layer; true when it changed (its listeners heard of it). */
function setViewPresence(scope: string, key: string, presence: Presence | undefined): boolean {
  const layers = scopes.get(scope) ?? new Map<string, Presence>();
  if (samePresence(layers.get(key), presence)) return false;
  if (presence) layers.set(key, presence);
  else layers.delete(key);
  if (layers.size) scopes.set(scope, layers);
  else scopes.delete(scope);
  listeners.forEach((listener) => listener());
  return true;
}

/** The map as the watcher uses it (MapLibre's `Map`). */
export interface PresenceMap {
  on(type: string, listener: () => void): unknown;
  off(type: string, listener: () => void): unknown;
  once(type: string, listener: () => void): unknown;
  isMoving(): boolean;
  /** The style and every tile of the view are in. */
  loaded(): boolean;
  getLayer(id: string): unknown;
  queryRenderedFeatures(options: { layers: string[] }): ViewFeature[];
}

export interface PresenceLayer {
  /** The renderer's layer key (the project layer id). */
  key: string;
  style: JsonObject;
}

/**
 * Keeps the store's counts of `scope` current for the layers of a map whose legend lists the classes in view.
 * `layers` is read at each count, so it always sees what the map draws. `refresh` asks for a count after the layers
 * changed (a class edited, another filter); a move asks for one on its own.
 */
export function watchViewPresence(
  map: PresenceMap,
  scope: string,
  layers: () => PresenceLayer[],
  opts: { layerIds?: (key: string) => string[] } = {}
): { refresh(): void; dispose(): void } {
  const layerIds = opts.layerIds ?? ((key: string) => mapLayerIdsOf(map, key, { kinds: VIEW_PARTS }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiting = false;
  let counted = new Set<string>();

  const count = () => {
    const first = !countedScopes.has(scope);
    countedScopes.add(scope);
    let changed = false;
    const now = new Set<string>();
    for (const { key, style } of layers()) {
      if (style.kind !== "vector" || legendClasses(style) !== "view") continue;
      now.add(key);
      const counter = countPresence(style);
      for (const id of counter.done ? [] : layerIds(key)) {
        if (map.getLayer(id) && counter.add(map.queryRenderedFeatures({ layers: [id] }))) break;
      }
      changed = setViewPresence(scope, key, counter.result()) || changed;
    }
    for (const key of counted) if (!now.has(key)) changed = setViewPresence(scope, key, undefined) || changed;
    counted = now;
    // The first count ends the wait of every legend of this map, also of a layer it has no count of.
    if (first && !changed) listeners.forEach((listener) => listener());
  };
  const run = () => {
    timer = undefined;
    // A move is on: its end asks again.
    if (waiting || map.isMoving()) return;
    // The view's tiles are still coming: count once they are drawn.
    if (!map.loaded()) {
      waiting = true;
      map.once("idle", onIdle);
      return;
    }
    count();
  };
  const onIdle = () => {
    waiting = false;
    run();
  };
  const refresh = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(run, PAUSE_MS);
  };
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  map.on("moveend", refresh);
  map.on("movestart", cancel);
  return {
    refresh,
    dispose: () => {
      cancel();
      map.off("moveend", refresh);
      map.off("movestart", cancel);
      if (waiting) map.off("idle", onIdle);
      for (const key of counted) setViewPresence(scope, key, undefined);
      counted = new Set();
      countedScopes.delete(scope);
    },
  };
}
