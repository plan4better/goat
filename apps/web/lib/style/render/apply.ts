// A compiled layer on a MapLibre map, by difference with what is already there: a paint or layout change calls the
// setter, a changed tile URL sets the tiles, and only a new or retyped layer or a changed source is added again.
// Images load on demand through one missing-image resolver per map. A raster file's coloring is in its tile URL: a
// changed coloring sets the tiles after a quiet moment, so a drag in the panel asks the service once, at its end.
import type { LayerSpecification, SourceSpecification } from "maplibre-gl";

import { isMarkerImage } from "@/lib/style/compile/markerImage";
import { isPatternImage } from "@/lib/style/compile/patternImage";
import type { CompiledLayer, ImageRequest } from "@/lib/style/compile/types";
import { deepEqual, isObject } from "@/lib/style/json";
import { addMarkerImage } from "@/lib/style/render/markerImages";
import { addPatternImage } from "@/lib/style/render/patternImages";
import { loadImage } from "@/lib/transformers/map-image";

/** The MapLibre map methods the preview uses. */
export interface PreviewMap {
  getSource(id: string): unknown;
  addSource(id: string, source: SourceSpecification): unknown;
  removeSource(id: string): unknown;
  getLayer(id: string): unknown;
  addLayer(layer: LayerSpecification, beforeId?: string): unknown;
  removeLayer(id: string): unknown;
  moveLayer(id: string, beforeId?: string): unknown;
  setPaintProperty(id: string, name: string, value: unknown): unknown;
  setLayoutProperty(id: string, name: string, value: unknown): unknown;
  setFilter(id: string, filter: unknown): unknown;
  setLayerZoomRange(id: string, minzoom: number, maxzoom: number): unknown;
  setGlobalStateProperty(name: string, value: unknown): unknown;
  setMissingStyleImageResolver(resolver: (id: string) => void | Promise<void>): unknown;
  hasImage(id: string): boolean;
}

const MAX_ZOOM = 24;

/** How long a raster source's tile URLs must stay unchanged before the map loads them: every new coloring is new
 * tiles from the raster service, which a drag frame by frame would flood. */
export const RASTER_QUIET_MS = 200;

/** Per map and raster source id: the tile URLs waiting for their quiet moment. */
const pendingTiles = new WeakMap<
  object,
  Map<string, { tiles: string[]; timer: ReturnType<typeof setTimeout> }>
>();

function pendingOf(map: PreviewMap): Map<string, { tiles: string[]; timer: ReturnType<typeof setTimeout> }> {
  let pending = pendingTiles.get(map);
  if (!pending) {
    pending = new Map();
    pendingTiles.set(map, pending);
  }
  return pending;
}

/** Sets a raster source's new tiles once they stayed unchanged for a quiet moment. */
function setTilesLater(map: PreviewMap, id: string, tiles: string[]): void {
  const pending = pendingOf(map);
  const waiting = pending.get(id);
  if (waiting) clearTimeout(waiting.timer);
  const timer = setTimeout(() => {
    pending.delete(id);
    const source = map.getSource(id) as { setTiles?: (tiles: string[]) => void } | undefined;
    source?.setTiles?.(tiles);
  }, RASTER_QUIET_MS);
  pending.set(id, { tiles, timer });
}

function cancelTiles(map: PreviewMap, id: string): void {
  const pending = pendingOf(map);
  const waiting = pending.get(id);
  if (waiting) clearTimeout(waiting.timer);
  pending.delete(id);
}

/** The images each map's resolver knows, by name: the latest compiled lists. */
const imagesByMap = new WeakMap<object, Map<string, ImageRequest>>();

function registerImages(map: PreviewMap, images: ImageRequest[]): void {
  let known = imagesByMap.get(map);
  if (!known) {
    known = new Map();
    imagesByMap.set(map, known);
    const lookup = known;
    map.setMissingStyleImageResolver(async (id) => {
      // A marker with a shape: drawn here from its name, its icon found among the listed images.
      if (isMarkerImage(id)) return addMarkerImage(map as never, id, (ref) => lookup.get(ref));
      // A fill pattern: drawn here from its name (kind, spacing, line width, color).
      if (isPatternImage(id)) return addPatternImage(map as never, id);
      const image = lookup.get(id);
      if (!image) return;
      // loadImage draws the image at its logical size times the pixel ratio.
      await loadImage(
        map as never,
        image.url,
        image.name,
        image.sdf,
        image.height,
        image.height,
        image.pixelRatio
      );
    });
  }
  for (const image of images) known.set(image.name, image);
}

const DECORATION = (kinds: Array<"start" | "end" | "center">): string =>
  kinds.includes("center") && kinds.length === 1
    ? "center"
    : kinds.includes("start") && kinds.includes("end")
      ? "start_and_end"
      : kinds.includes("start")
        ? "start"
        : kinds.includes("end")
          ? "end"
          : "center";

/** A tile URL asking geoapi for what the compiled layer needs: polygon label anchors, line decoration points. */
export function tileUrl(base: string, params: CompiledLayer["tileParams"]): string {
  const query: string[] = [];
  if (params.label) query.push("label=true");
  if (params.decorations?.length) query.push(`decoration=${DECORATION(params.decorations)}`);
  if (!query.length) return base;
  return `${base}${base.includes("?") ? "&" : "?"}${query.join("&")}`;
}

/** The compiled layer with its vector tile URLs carrying the tile parameters. */
export function withTileParams(compiled: CompiledLayer): CompiledLayer {
  const sources = Object.fromEntries(
    Object.entries(compiled.sources).map(([id, source]) => [
      id,
      source.type === "vector" && Array.isArray(source.tiles)
        ? { ...source, tiles: source.tiles.map((url) => tileUrl(url, compiled.tileParams)) }
        : source,
    ])
  );
  return { ...compiled, sources };
}

const sameExcept = (a: object, b: object, key: string) => {
  const { [key]: _a, ...restA } = a as Record<string, unknown>;
  const { [key]: _b, ...restB } = b as Record<string, unknown>;
  return deepEqual(restA, restB);
};

function updateProperties(
  id: string,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  set: (id: string, name: string, value: unknown) => unknown
): void {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of keys) {
    if (!deepEqual(before?.[key], after?.[key])) set(id, key, after?.[key]);
  }
}

const layerOf = (layer: LayerSpecification) => layer as LayerSpecification & Record<string, unknown>;

export function applyCompiled(
  map: PreviewMap,
  prev: CompiledLayer | null,
  next: CompiledLayer,
  opts: { beforeId?: string } = {}
): void {
  registerImages(map, next.images);
  const prevSources = prev?.sources ?? {};
  const prevLayers = new Map((prev?.layers ?? []).map((layer) => [layer.id, layerOf(layer)]));
  const nextIds = new Set(next.layers.map((layer) => layer.id));

  const removeLayer = (id: string) => {
    if (map.getLayer(id)) map.removeLayer(id);
  };
  const dropSource = (id: string) => {
    cancelTiles(map, id);
    for (const layer of prev?.layers ?? []) if (layerOf(layer).source === id) removeLayer(layer.id);
    if (map.getSource(id)) map.removeSource(id);
  };

  for (const layer of prev?.layers ?? []) if (!nextIds.has(layer.id)) removeLayer(layer.id);
  for (const id of Object.keys(prevSources)) if (!(id in next.sources)) dropSource(id);

  for (const [id, source] of Object.entries(next.sources)) {
    const old = prevSources[id];
    const existing = map.getSource(id) as Record<string, unknown> | undefined;
    if (!existing) {
      map.addSource(id, source);
      continue;
    }
    if (!old || deepEqual(old, source)) continue;
    // New tile URLs (labels or line decorations switched on) load the source again rather than setTiles: MapLibre's
    // reload after setTiles races the reload a layer added in the same frame starts, which re-parses the cached
    // tiles, so the tiles would stay without the label points.
    if (sameExcept(old, source, "data") && typeof existing.setData === "function" && "data" in source) {
      (existing.setData as (data: unknown) => void)(source.data);
    } else if (
      source.type === "raster" &&
      sameExcept(old, source, "tiles") &&
      typeof existing.setTiles === "function" &&
      Array.isArray(source.tiles)
    ) {
      setTilesLater(map, id, source.tiles);
    } else {
      dropSource(id);
      map.addSource(id, source);
    }
  }

  // Bottom to top: a layer that is (re)added goes below the next one already on the map, else below beforeId.
  const beforeFor = (index: number): string | undefined => {
    for (let i = index + 1; i < next.layers.length; i++)
      if (map.getLayer(next.layers[i].id)) return next.layers[i].id;
    return opts.beforeId;
  };
  next.layers.forEach((spec, index) => {
    const layer = layerOf(spec);
    const old = prevLayers.get(layer.id);
    const present = map.getLayer(layer.id);
    if (
      !present ||
      !old ||
      old.type !== layer.type ||
      old.source !== layer.source ||
      old["source-layer"] !== layer["source-layer"]
    ) {
      if (present) map.removeLayer(layer.id);
      map.addLayer(spec, beforeFor(index));
      return;
    }
    updateProperties(
      layer.id,
      old.paint as Record<string, unknown>,
      layer.paint as Record<string, unknown>,
      (id, k, v) => map.setPaintProperty(id, k, v)
    );
    updateProperties(
      layer.id,
      old.layout as Record<string, unknown>,
      layer.layout as Record<string, unknown>,
      (id, k, v) => map.setLayoutProperty(id, k, v)
    );
    if (!deepEqual(old.filter, layer.filter)) map.setFilter(layer.id, layer.filter ?? null);
    if (old.minzoom !== layer.minzoom || old.maxzoom !== layer.maxzoom) {
      map.setLayerZoomRange(
        layer.id,
        (layer.minzoom as number | undefined) ?? 0,
        (layer.maxzoom as number | undefined) ?? MAX_ZOOM
      );
    }
  });

  for (const [name, entry] of Object.entries(next.state)) {
    if (!isObject(prev?.state[name]) || !deepEqual(prev?.state[name], entry))
      map.setGlobalStateProperty(name, entry.default);
  }
}

/** Moves a compiled layer's map layers below `beforeId` (to the top without one), keeping their order. */
export function moveCompiled(map: PreviewMap, compiled: CompiledLayer, beforeId?: string): void {
  for (const layer of compiled.layers) if (map.getLayer(layer.id)) map.moveLayer(layer.id, beforeId);
}

/** Takes a compiled layer off the map again. */
export function removeCompiled(map: PreviewMap, compiled: CompiledLayer): void {
  for (const id of Object.keys(compiled.sources)) cancelTiles(map, id);
  for (const layer of [...compiled.layers].reverse()) if (map.getLayer(layer.id)) map.removeLayer(layer.id);
  for (const id of Object.keys(compiled.sources)) if (map.getSource(id)) map.removeSource(id);
}
