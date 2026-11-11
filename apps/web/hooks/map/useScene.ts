// The map-level scene on a live map (3D spec 7.2): compiles the scene for the map's basemap and inputs and
// applies the difference to what it applied last. A new style (a basemap switch) replaces projection, terrain, sky,
// light, the global state and every source that is not a project layer's, so the scene is applied again in full on
// `style.load`, and on `styledata` when a style diff dropped it without one. On the globe the terrain follows the zoom
// (`terrainAt`): flat while the globe draws, rising once the map is mercator; only the terrain is set again then.
import type {
  LayerSpecification,
  LightSpecification,
  Map as MaplibreMap,
  SkySpecification,
  StyleSpecification,
  TerrainSpecification,
} from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";

import { sceneAtmosphere } from "@/lib/scene/atmosphere";
import { buildingsPlan, ownPaint } from "@/lib/scene/buildings";
import {
  type BuildingPaint,
  type CompiledScene,
  GLOBE_LIGHT_UNTIL_ZOOM,
  type SceneInputs,
  type SceneState,
  compileScene,
  terrainAt,
} from "@/lib/scene/compile";
import { projectionKind } from "@/lib/scene/visibility";
import { deepEqual } from "@/lib/style/json";
import {
  basemapAnchorsOf,
  drawnOnGround,
  projectLayerOf,
  rendererLayerIds,
} from "@/lib/style/render/mapLayers";

import type { Basemap } from "@/types/map/common";

export type UseSceneInputs = Omit<SceneInputs, "buildings" | "zoomedOut" | "atmosphere"> & {
  basemap: Basemap;
  /** The deployment's building overlay (a TileJSON URL); empty: none. */
  buildingsUrl?: string;
};

/** MapLibre's light where GOAT sets none (2D on mercator), after GOAT's light was on the map. */
const DEFAULT_LIGHT: LightSpecification = {
  anchor: "viewport",
  color: "#ffffff",
  intensity: 0.5,
  position: [1.15, 210, 30],
};

const STATE_KEYS = ["sunAzimuth", "sunAltitude", "lightPosition"] as const;

/** The scene's paint on a basemap's own layers, as layer id, property and value. */
const paintOf = (scene: CompiledScene): Array<[string, keyof BuildingPaint, unknown]> =>
  Object.entries(scene.paint).flatMap(([id, props]) =>
    propsOf(props).map((prop): [string, keyof BuildingPaint, unknown] => [id, prop, props[prop]])
  );

const propsOf = (paint: object | undefined) => Object.keys(paint ?? {}) as Array<keyof BuildingPaint>;

/**
 * Where a scene layer goes: before the basemap's roads (or labels), or above its ground layers (`basemapAnchorsOf`),
 * else below the lowest project layer. The buildings go below the project layers' parts drawn right under that
 * anchor that are not on the ground (the points and labels of layers below the labels), which stay above them; their
 * ground parts stop the walk and stay below the buildings.
 */
function beforeId(map: MaplibreMap, before: "roads" | "buildings"): string | undefined {
  const layers = map.getStyle()?.layers ?? [];
  const anchors = basemapAnchorsOf(map);
  const anchor = before === "roads" ? (anchors.roads ?? anchors.labels) : anchors.buildings;
  if (anchor && before === "roads") return anchor;
  if (anchor) {
    let at = layers.findIndex((l) => l.id === anchor);
    while (at > 0 && projectLayerOf(map, layers[at - 1].id) && !drawnOnGround(layers[at - 1].type)) at--;
    return layers[at]?.id ?? anchor;
  }
  const renderer = new Set(rendererLayerIds(map));
  return layers.find((l) => renderer.has(l.id))?.id;
}

/** Whether the map no longer shows what was applied: a style replaced or a diff dropped parts of it. */
function drifted(map: MaplibreMap, last: Applied): boolean {
  const { scene, state } = last;
  if (Object.keys(scene.sources).some((id) => !map.getSource(id))) return true;
  if (scene.layers.some(({ layer }) => !map.getLayer(layer.id))) return true;
  if (
    paintOf(scene).some(
      ([id, prop, value]) => map.getLayer(id) && !deepEqual(map.getPaintProperty(id, prop), value)
    )
  )
    return true;
  if ((map.getTerrain()?.source ?? null) !== (last.terrain?.source ?? null)) return true;
  if (!deepEqual(map.getProjection()?.type ?? "mercator", scene.projection.type)) return true;
  if (scene.sky && !deepEqual(map.getSky(), scene.sky)) return true;
  if (scene.light && !deepEqual(map.getLight()?.position, scene.light.position)) return true;
  const current = map.getGlobalState?.() ?? {};
  return STATE_KEYS.some((key) => !deepEqual(current[key] ?? null, state[key]));
}

interface Applied {
  scene: CompiledScene;
  state: SceneState;
  /** The terrain on the map: the scene's at the zoom it was set at. */
  terrain: TerrainSpecification | null;
  /** The basemap's own visibility of layers the scene shows, to give back. */
  original: Map<string, string>;
  /** The basemap's own paint properties the scene sets (undefined: unset), by layer id, to give back. */
  originalPaint: Map<string, Record<string, unknown>>;
}

/** The scene's terrain as the map shows it at its current zoom. */
const terrainOn = (map: MaplibreMap, scene: CompiledScene): TerrainSpecification | null =>
  terrainAt(scene.terrain, map.getZoom(), projectionKind(scene.projection));

/**
 * Puts `next` on the map: everything when `prev` is null, else only what changed. `kept` is the basemap's own
 * visibility and paint recorded on the same style before (a full apply after a style diff), so what the scene set is
 * not taken for the basemap's own.
 */
function applyScene(
  map: MaplibreMap,
  prev: Applied | null,
  next: CompiledScene,
  kept?: Pick<Applied, "original" | "originalPaint">
): Applied {
  const full = prev === null;
  const old = prev?.scene;
  const original = prev?.original ?? kept?.original ?? new Map<string, string>();
  const originalPaint =
    prev?.originalPaint ?? kept?.originalPaint ?? new Map<string, Record<string, unknown>>();

  if (full || !deepEqual(old!.projection, next.projection)) map.setProjection(next.projection);

  // Layers that leave or change go first, then the sources that leave or change, then the new sources and layers.
  const nextLayers = new Map(next.layers.map((l) => [l.layer.id, l]));
  for (const { layer } of old?.layers ?? []) {
    const kept = nextLayers.get(layer.id);
    const sourceChanged = (id: string) => !deepEqual(old!.sources[id], next.sources[id]);
    const source = (layer as { source?: string }).source;
    if (
      map.getLayer(layer.id) &&
      (!kept || !deepEqual(kept.layer, layer) || (source && sourceChanged(source)))
    )
      map.removeLayer(layer.id);
  }
  for (const id of Object.keys(old?.sources ?? {}))
    if (map.getSource(id) && !deepEqual(old!.sources[id], next.sources[id])) map.removeSource(id);
  for (const [id, source] of Object.entries(next.sources)) if (!map.getSource(id)) map.addSource(id, source);
  for (const { layer, before } of next.layers)
    if (!map.getLayer(layer.id)) map.addLayer(layer as LayerSpecification, beforeId(map, before));

  // A basemap's own layers: shown, or back to the basemap's own visibility.
  const touched = new Set([...original.keys(), ...next.show]);
  for (const id of touched) {
    if (!map.getLayer(id)) continue;
    if (!original.has(id)) original.set(id, (map.getLayoutProperty(id, "visibility") as string) ?? "visible");
    const want = next.show.includes(id) ? "visible" : original.get(id)!;
    if (((map.getLayoutProperty(id, "visibility") as string) ?? "visible") !== want)
      map.setLayoutProperty(id, "visibility", want as "visible" | "none");
  }

  // Their paint: the scene's, or back to the basemap's own (every property the scene set is recorded there first).
  for (const id of new Set([...originalPaint.keys(), ...Object.keys(next.paint)])) {
    if (!map.getLayer(id)) continue;
    const own = originalPaint.get(id) ?? {};
    originalPaint.set(id, own);
    const wanted = next.paint[id] ?? {};
    for (const prop of new Set([...propsOf(own), ...propsOf(wanted)])) {
      if (!(prop in own)) own[prop] = map.getPaintProperty(id, prop);
      const want = prop in wanted ? wanted[prop] : own[prop];
      if (!deepEqual(map.getPaintProperty(id, prop), want))
        map.setPaintProperty(id, prop, want as number | undefined);
    }
  }

  const terrain = terrainOn(map, next);
  if (full || !deepEqual(prev!.terrain, terrain)) map.setTerrain(terrain);

  // The state before the light that reads it.
  const state = next.state;
  for (const key of STATE_KEYS)
    if (full || !deepEqual(prev!.state?.[key], state[key])) map.setGlobalStateProperty(key, state[key]);

  if (next.sky) {
    if (full || !deepEqual(old!.sky, next.sky)) map.setSky(next.sky);
  } else if (old?.sky) map.setSky(undefined as unknown as SkySpecification);
  if (next.light) {
    if (full || !deepEqual(old!.light, next.light)) map.setLight(next.light);
  } else if (old?.light) map.setLight(DEFAULT_LIGHT);

  return { scene: next, state, terrain, original, originalPaint };
}

/**
 * Applies the scene to `map` (3D spec 7.2): on mount, when the inputs change, and again whenever a new style replaced
 * it. On the globe a custom light follows the zoom across `GLOBE_LIGHT_UNTIL_ZOOM` (set again only when it crosses),
 * and the terrain follows the zoom by `terrainAt` (set again only when its step changes). Returns what it applied last.
 */
export function useScene(map: MaplibreMap | null, inputs: UseSceneInputs): CompiledScene | null {
  const [compiled, setCompiled] = useState<CompiledScene | null>(null);
  const applied = useRef<Applied | null>(null);
  // The inputs by value: a new object with the same content changes nothing.
  const key = JSON.stringify(inputs);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stable = useMemo(() => inputs, [key]);
  // Which side of the globe's zoomed-out range the camera is on: read from the map when compiling, kept here only
  // so that crossing it applies the scene again.
  const [zoomedOut, setZoomedOut] = useState(false);
  const followsZoom = stable.projection === "globe" && !!stable.scene?.light;

  useEffect(() => {
    if (!map || !followsZoom) return;
    const read = () => setZoomedOut(map.getZoom() < GLOBE_LIGHT_UNTIL_ZOOM);
    read();
    map.on("zoom", read);
    return () => {
      map.off("zoom", read);
    };
  }, [map, followsZoom]);

  useEffect(() => {
    if (!map) return;
    const { basemap, buildingsUrl, ...rest } = stable;
    // `recorded`: the basemap's own paint on this style, under what the scene set (`ownPaint`).
    const compile = (recorded?: Applied["originalPaint"]) => {
      const style = ownPaint(map.getStyle() as StyleSpecification | undefined, recorded);
      return compileScene({
        ...rest,
        zoomedOut: followsZoom && map.getZoom() < GLOBE_LIGHT_UNTIL_ZOOM,
        atmosphere: sceneAtmosphere(basemap, rest.imagery, style, map.getZoom(), rest.tone),
        buildings: buildingsPlan(basemap, style, buildingsUrl, (id) => projectLayerOf(map, id) !== undefined),
      });
    };
    // `full` applies everything again; "diff" keeps what was recorded of the basemap's own layers on this style.
    const apply = (full: boolean | "diff") => {
      try {
        const last = applied.current;
        const next = compile(full === true ? undefined : last?.originalPaint);
        applied.current = applyScene(
          map,
          full ? null : last,
          next,
          full === "diff" ? (last ?? undefined) : undefined
        );
        setCompiled(next);
      } catch (error) {
        // A new style still loading: the next style.load or styledata applies it.
        if (!String(error).includes("Style is not done loading")) throw error;
        applied.current = null;
      }
    };
    apply(false);
    const onStyleLoad = () => apply(true);
    const onStyleData = () => {
      const last = applied.current;
      if (!last) return apply(true);
      if (drifted(map, last)) apply("diff");
    };
    // The terrain alone, without applying the rest of the scene again.
    const onZoom = () => {
      const last = applied.current;
      if (!last) return;
      const terrain = terrainOn(map, last.scene);
      if (deepEqual(last.terrain, terrain)) return;
      try {
        map.setTerrain(terrain);
        applied.current = { ...last, terrain };
      } catch (error) {
        // A new style still loading: its style.load applies the scene, terrain included.
        if (!String(error).includes("Style is not done loading")) throw error;
      }
    };
    const globe = stable.projection === "globe";
    map.on("style.load", onStyleLoad);
    map.on("styledata", onStyleData);
    if (globe) map.on("zoom", onZoom);
    return () => {
      map.off("style.load", onStyleLoad);
      map.off("styledata", onStyleData);
      if (globe) map.off("zoom", onZoom);
    };
  }, [map, stable, followsZoom, zoomedOut]);

  return compiled;
}
