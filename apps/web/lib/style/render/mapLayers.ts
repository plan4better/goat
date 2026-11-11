// Every project layer of a map, compiled and placed: the layers in the map document's order, top first, each
// below the nearest layer above it in the same position (spec 10 `position`: on top, below the basemap's labels or its
// roads); a change compiles and applies only the layers it touched. The renderer owns the map's global state (the
// number `locale`), the highlighted feature, and a registry from MapLibre layer ids back to project layers, which
// clicks, the feature editor and measuring use instead of id conventions.
import type { FilterSpecification, LayerSpecification, StyleSpecification } from "maplibre-gl";

import { compileLayer } from "@/lib/style/compile";
import { h3SourceId } from "@/lib/style/compile/render";
import type {
  CompileInput,
  CompileSource,
  CompiledLayer,
  Geometry,
  Position,
} from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";
import { deepEqual } from "@/lib/style/json";
import {
  type PreviewMap,
  applyCompiled,
  moveCompiled,
  removeCompiled,
  withTileParams,
} from "@/lib/style/render/apply";

/** One project layer as the renderer draws it. */
export interface RenderLayer {
  /** The project layer id (the dataset id where there is none); MapLibre layer ids are `<key>-<part>`. */
  key: string;
  style: LayerStyle;
  /** Changes whenever the style does (style id and revision); without it the style object's identity counts. */
  version?: string;
  geometry?: Geometry;
  entry: NonNullable<CompileInput["entry"]>;
  source: CompileSource;
  /** Features not drawn (the feature editor's, drawn by its overlay) and the atlas page's feature, the only one drawn. */
  filter?: { exclude?: Array<number | string>; atlas?: number };
  /** The feature shown as active. */
  highlight?: number | string;
  resolveIcon?: CompileInput["resolveIcon"];
}

/** The basemap layers the `position`s go below, and the one GOAT's 3D buildings go below. */
export interface Anchors {
  labels?: string;
  roads?: string;
  buildings?: string;
}

export interface SyncOptions {
  /** The map's number locale: the map document's, else the viewer's language. */
  locale: string;
  anchors?: Anchors;
  /** The lowest layer that stays above every project layer (the popup highlight, drawing tools). */
  overlay?: string;
  /** The scene's lowest 3D building layer: the project layers' parts drawn on the ground go below it (`GROUND`). */
  ground?: string;
}

interface Placed {
  layer: RenderLayer;
  compiled: CompiledLayer;
}

export interface MapLayersState {
  placed: Map<string, Placed>;
  order: string[];
  locale?: string;
  anchors?: Anchors;
  overlay?: string;
  /** The building layer the ground parts went below: `ground` while it is on the map. */
  ground?: string;
}

export type RendererMap = PreviewMap & {
  setFeatureState(
    target: { source: string; sourceLayer?: string; id: number | string },
    state: object
  ): unknown;
};

/**
 * The layer types MapLibre draws on the ground: with terrain it drapes them onto the terrain, and the terrain is
 * depth tested against the fill extrusions drawn before it, so a line above a building layer would be hidden behind
 * every building, however translucent. Below the buildings they show through them, with terrain and without.
 */
const GROUND = new Set(["background", "fill", "line", "raster", "hillshade", "color-relief"]);

/** Source layers of road networks in the basemaps GOAT offers (OpenMapTiles, basemap.de). */
const ROAD_SOURCE_LAYERS = new Set(["transportation", "Verkehrslinie", "Verkehrsflaeche"]);

/** Whether MapLibre draws a layer of this type on the ground (`GROUND`). */
export const drawnOnGround = (type: string): boolean => GROUND.has(type);

/**
 * Where a vector basemap's block of labels starts: the lowest point with the fewest symbol layers below it and ground
 * layers above it. Symbols among the ground layers (Dark's water names, road arrows) stay below it, a ground layer
 * among the labels (basemap.de's rock pattern) above it; other types (3D buildings, circles) count for neither side.
 */
function labelBlockStart(list: Array<{ type: string }>): number {
  let misplaced = list.filter((l) => GROUND.has(l.type)).length;
  let fewest = misplaced;
  let start = 0;
  list.forEach((l, i) => {
    if (l.type === "symbol") misplaced++;
    else if (GROUND.has(l.type)) misplaced--;
    if (misplaced < fewest) [fewest, start] = [misplaced, i + 1];
  });
  return start;
}

/**
 * The anchors of a vector basemap: the first symbol layer of its label block (labels), its first road layer, and the
 * layer the block starts at (buildings). Every basemap GOAT offers draws roads, boundaries or relief after its flat
 * building fill and ends in the block of labels, so the layers below the labels and GOAT's buildings go above all of
 * its ground. Raster and solid basemaps have none of the three, so every layer draws on top.
 */
export function basemapAnchors(
  layers: Array<{ id: string; type: string; "source-layer"?: string }> | undefined
): Anchors {
  const list = layers ?? [];
  const start = labelBlockStart(list);
  return {
    labels: list.slice(start).find((l) => l.type === "symbol")?.id,
    roads: list.find((l) => l["source-layer"] !== undefined && ROAD_SOURCE_LAYERS.has(l["source-layer"]))?.id,
    buildings: list[start]?.id,
  };
}

/**
 * The anchors of the basemap on a map, from its style's layers that are neither the renderer's, GOAT's scene (`goat-`
 * ids) nor on a GeoJSON source (the mask, the drawing and measuring tools, the popup highlight, drawn on top).
 */
export function basemapAnchorsOf(map: {
  getStyle():
    | {
        layers?: Array<{ id: string; type: string; source?: unknown; "source-layer"?: string }>;
        sources?: Record<string, { type?: string }>;
      }
    | undefined;
}): Anchors {
  const style = map.getStyle();
  const onGeojson = (source: unknown) =>
    typeof source === "string" && style?.sources?.[source]?.type === "geojson";
  return basemapAnchors(
    style?.layers?.filter(
      (l) => !projectLayerOf(map, l.id) && !l.id.startsWith("goat-") && !onGeojson(l.source)
    )
  );
}

/** Layer types that take a filter (rasters and hillshades do not). */
const FILTERED = new Set(["fill", "line", "circle", "symbol", "heatmap", "fill-extrusion"]);

function withFilters(layer: LayerSpecification, extra: unknown[]): LayerSpecification {
  // H3 hexagons (source layer "h3") are cells of many features: geoapi counts the atlas page's feature alone
  // (`withAtlasHexagons`), and the edited features stay counted until they are saved.
  if (!FILTERED.has(layer.type) || (layer as { "source-layer"?: string })["source-layer"] === "h3")
    return layer;
  const base = (layer as { filter?: unknown }).filter;
  const parts = base === undefined ? extra : [base, ...extra];
  const filter = (parts.length === 1 ? parts[0] : ["all", ...parts]) as FilterSpecification;
  return { ...layer, filter } as LayerSpecification;
}

function compile(layer: RenderLayer): CompiledLayer {
  const out = withTileParams(
    compileLayer({
      id: layer.key,
      style: layer.style,
      geometry: layer.geometry,
      source: layer.source,
      entry: layer.entry,
      highlight: true,
      resolveIcon: layer.resolveIcon,
    })
  );
  // The map's locale is the renderer's: a layer's default must not overwrite it.
  const { locale: _locale, ...state } = out.state;
  const extra: unknown[] = [];
  if (layer.filter?.exclude?.length) extra.push(["!", ["in", ["id"], ["literal", layer.filter.exclude]]]);
  const atlas = layer.filter?.atlas;
  if (atlas !== undefined) extra.push(["==", ["id"], atlas]);
  return {
    ...out,
    sources:
      atlas !== undefined ? withAtlasHexagons(out.sources, h3SourceId(layer.source.id), atlas) : out.sources,
    state,
    layers: extra.length ? out.layers.map((l) => withFilters(l, extra)) : out.layers,
  };
}

/** The hexagon tiles of the atlas page's feature alone: geoapi counts the points it is asked for (`ids`). */
function withAtlasHexagons(
  sources: CompiledLayer["sources"],
  id: string,
  feature: number
): CompiledLayer["sources"] {
  const source = sources[id];
  if (source?.type !== "vector" || !Array.isArray(source.tiles)) return sources;
  const tiles = source.tiles.map((url) => `${url}${url.includes("?") ? "&" : "?"}ids=${feature}`);
  return { ...sources, [id]: { ...source, tiles } };
}

/** The time slider's value: a global state property, not part of the compiled layers. */
const timeOf = (layer: RenderLayer) => layer.entry.time?.value ?? null;
const withoutTime = ({ time: _time, ...entry }: RenderLayer["entry"]) => entry;

/** Whether a layer would compile to the same output again, apart from its time slider's value. */
function sameInput(a: RenderLayer, b: RenderLayer): boolean {
  const sameStyle =
    a.version !== undefined || b.version !== undefined ? a.version === b.version : a.style === b.style;
  return (
    sameStyle &&
    a.geometry === b.geometry &&
    a.resolveIcon === b.resolveIcon &&
    deepEqual(withoutTime(a.entry), withoutTime(b.entry)) &&
    deepEqual(a.source, b.source) &&
    deepEqual(a.filter ?? null, b.filter ?? null)
  );
}

const positionOf = (layer: RenderLayer): Position => layer.entry.position ?? "top";

interface Registry {
  byMapLayer: Map<string, string>;
  byKey: Map<string, string[]>;
}
const registries = new WeakMap<object, Registry>();

/** The project layer a MapLibre layer draws, if it is one of the renderer's. */
export function projectLayerOf(map: object, mapLayerId: string): string | undefined {
  return registries.get(map)?.byMapLayer.get(mapLayerId);
}

/** A project layer's MapLibre layers, bottom to top; `kinds` keeps parts by name (`fill`, `label`, `cluster`, ...). */
export function mapLayerIdsOf(map: object, key: string, opts: { kinds?: string[] } = {}): string[] {
  const ids = registries.get(map)?.byKey.get(key) ?? [];
  if (!opts.kinds) return [...ids];
  return ids.filter((id) => {
    const kind = id.slice(key.length + 1);
    return opts.kinds?.some((k) => kind === k || kind.startsWith(`${k}-`));
  });
}

/** Every MapLibre layer id of the renderer on this map. */
export function rendererLayerIds(map: object): string[] {
  return [...(registries.get(map)?.byMapLayer.keys() ?? [])];
}

/** Puts `next` on the map: removes the layers that left, compiles and applies the changed ones in order, moves the
 * others when the order or a position changed, and keeps the global state and the highlighted features. */
export function syncMapLayers(
  map: RendererMap,
  prev: MapLayersState | null,
  next: RenderLayer[],
  opts: SyncOptions
): MapLayersState {
  const nextKeys = next.map((layer) => layer.key);
  for (const [key, placed] of prev?.placed ?? []) {
    if (!nextKeys.includes(key)) removeCompiled(map, placed.compiled);
  }

  const anchors = opts.anchors ?? {};
  const ground = opts.ground && map.getLayer(opts.ground) ? opts.ground : undefined;
  const reorder =
    !prev ||
    !deepEqual(
      prev.order.filter((k) => nextKeys.includes(k)),
      nextKeys.filter((k) => prev.placed.has(k))
    ) ||
    !deepEqual(prev.anchors ?? {}, anchors) ||
    prev.overlay !== opts.overlay ||
    prev.ground !== ground ||
    next.some((layer) => {
      const old = prev.placed.get(layer.key);
      return old !== undefined && positionOf(old.layer) !== positionOf(layer);
    });
  const anchorFor = (position: Position) =>
    (position === "below_labels"
      ? anchors.labels
      : position === "below_roads"
        ? (anchors.roads ?? anchors.labels)
        : undefined) ?? opts.overlay;
  // A position's ground parts go below the buildings where the buildings are below the position's anchor; they
  // and the other parts are then placed as two stacks, each in the map document's order.
  let mapOrder: Map<string, number> | undefined;
  const below = (a: string, b: string) => {
    if (!mapOrder) {
      const style = (map as { getStyle?: () => { layers?: Array<{ id: string }> } | undefined }).getStyle?.();
      mapOrder = new Map((style?.layers ?? []).map((l, i) => [l.id, i]));
    }
    return (mapOrder.get(a) ?? -1) < (mapOrder.get(b) ?? Infinity);
  };
  const groundAnchorFor = (position: Position) => {
    const anchor = anchorFor(position);
    if (!ground || position === "top" || anchor === undefined) return ground ?? anchor;
    return below(ground, anchor) ? ground : anchor;
  };
  const splits = (position: Position) => groundAnchorFor(position) !== anchorFor(position);
  const onGround = (position: Position, l: LayerSpecification) => splits(position) && GROUND.has(l.type);
  const lowestOnMap = (compiled: CompiledLayer, position: Position, low: boolean) =>
    compiled.layers.find((l) => onGround(position, l) === low && map.getLayer(l.id))?.id;

  const placed = new Map<string, Placed>();
  next.forEach((layer, index) => {
    const position = positionOf(layer);
    const stackBefore = (low: boolean) => {
      let id: string | undefined;
      for (let i = index - 1; i >= 0 && id === undefined; i--) {
        const above = placed.get(next[i].key);
        if (above && positionOf(next[i]) === position) id = lowestOnMap(above.compiled, position, low);
      }
      return id ?? (low ? groundAnchorFor(position) : anchorFor(position));
    };
    const raised = stackBefore(false);
    const low = splits(position) ? stackBefore(true) : raised;
    const beforeId = (l: LayerSpecification) => (onGround(position, l) ? low : raised);
    const old = prev?.placed.get(layer.key);
    let compiled = old && sameInput(old.layer, layer) ? old.compiled : compile(layer);
    if (compiled !== old?.compiled) applyCompiled(map, old?.compiled ?? null, compiled, { beforeId });
    else if (timeOf(old.layer) !== timeOf(layer)) {
      // A moved time slider sets its global state; the default keeps the value for restoreGlobalState.
      const name = `${layer.key}:time`;
      if (name in compiled.state) {
        compiled = { ...compiled, state: { ...compiled.state, [name]: { default: timeOf(layer) } } };
        map.setGlobalStateProperty(name, timeOf(layer));
      }
    }
    if (old && reorder) moveCompiled(map, compiled, beforeId);
    placed.set(layer.key, { layer, compiled });
  });

  if (prev?.locale !== opts.locale) map.setGlobalStateProperty("locale", opts.locale);
  for (const { layer, compiled } of placed.values()) {
    const before = prev?.placed.get(layer.key)?.layer.highlight;
    if (before === layer.highlight) continue;
    const target = (id: number | string) => ({
      source: layer.source.id,
      ...(layer.source.type === "tiles" ? { sourceLayer: "default" } : {}),
      id,
    });
    if (before !== undefined) map.setFeatureState(target(before), { active: false });
    if (layer.highlight !== undefined && compiled.layers.length)
      map.setFeatureState(target(layer.highlight), { active: true });
  }

  const registry: Registry = { byMapLayer: new Map(), byKey: new Map() };
  for (const [key, { compiled }] of placed) {
    const ids = compiled.layers.map((l) => l.id);
    registry.byKey.set(key, ids);
    for (const id of ids) registry.byMapLayer.set(id, key);
  }
  registries.set(map, registry);

  return { placed, order: nextKeys, locale: opts.locale, anchors, overlay: opts.overlay, ground };
}

/** Sets the global state again (the locale, every time slider's value) after a new style replaced it. */
export function restoreGlobalState(map: RendererMap, state: MapLayersState | null): void {
  if (!state) return;
  if (state.locale) map.setGlobalStateProperty("locale", state.locale);
  for (const { compiled } of state.placed.values())
    for (const [name, entry] of Object.entries(compiled.state))
      map.setGlobalStateProperty(name, entry.default);
}

/** A new basemap style with the project layers carried over (`setStyle`'s `transformStyle`): every `src-*` source
 * and the layers drawing from it, unchanged and on top of the basemap, so MapLibre's diff keeps them and their tiles. */
export function carryProjectLayers(
  previous: StyleSpecification | undefined,
  next: StyleSpecification
): StyleSpecification {
  if (!previous) return next;
  const sources = { ...next.sources };
  for (const [id, source] of Object.entries(previous.sources ?? {})) {
    if (id.startsWith("src-")) sources[id] = source;
  }
  const carried = (previous.layers ?? []).filter(
    (l) => "source" in l && typeof l.source === "string" && l.source.startsWith("src-")
  );
  return { ...next, sources, layers: [...next.layers, ...carried] };
}
