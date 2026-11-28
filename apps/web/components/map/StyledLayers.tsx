"use client";

// The map's project layers: renders nothing, puts the layers on the map with one `syncMapLayers` per
// animation frame, and at once where the camera crosses the zoom at which the map's buildings draw. A layer whose
// style panel is open is drawn from its editor store through a child subscribed to that store only, so an edit
// compiles and applies that layer and renders nothing else. A raster layer whose style colors values draws once the
// description of its value tiles has loaded.
import type { Map as MaplibreMap } from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useMap } from "react-map-gl/maplibre";

import { loadRasterValues } from "@/lib/api/rasters";
import type { CompiledScene } from "@/lib/scene/compile";
import type { EditorStore } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";
import type { JsonObject } from "@/lib/style/json";
import {
  type Anchors,
  type MapLayersState,
  type RenderLayer,
  type RendererMap,
  basemapAnchorsOf,
  rendererLayerIds,
  restoreGlobalState,
  syncMapLayers,
} from "@/lib/style/render/mapLayers";
import { rasterValuesOver } from "@/lib/style/render/rasterValues";
import { PENDING_KEY } from "@/lib/style/render/viewLayers";
import { type PresenceMap, watchViewPresence } from "@/lib/style/render/viewPresence";
import type { Tone } from "@/lib/style/tone";
import { lowestOverlayId } from "@/lib/utils/map/overlayLayers";

import { useBasemapStacking } from "@/hooks/map/useBasemapStacking";

export interface EditedLayer {
  key: string;
  store: EditorStore;
}

interface StyledLayersProps {
  /** Top first, in the map document's order. */
  layers: RenderLayer[];
  /** Layers drawn from their editor store instead of `layers[].style`. */
  editing?: EditedLayer[];
  /** The map's number locale. */
  locale: string;
  /** The tone of the basemap the map draws (`basemapTone`): a layer whose automatic colors follow it compiles again
   * when it changes. */
  tone: Tone;
  /** The lowest layer that stays above the project layers. */
  overlay?: string;
  /** The scene's lowest 3D building layer (`buildingsAnchor`): the layers' ground parts go below the building layer
   * the renderer derives from it (`syncMapLayers`), or where they go without buildings. */
  ground?: string;
  /** The scene as applied last (`useScene`): a new one draws again, so the building layers are read again (the zoom
   * from which they draw) without compiling a layer. */
  scene?: CompiledScene | null;
  /** Every MapLibre layer id the renderer drew, after each change (interactive layers, snapping). */
  onLayersChange?: (ids: string[]) => void;
  /** Counts the classes in view for legends that list those (spec 7.2 `legend.classes: view`), kept under this name
   * (`MAP_SCOPE`, `printScope`); none where no legend reads this map. */
  presenceScope?: string;
  /** Whether a raster layer's values are still loading, after each draw that changes it and after the first draw
   * (print and thumbnails wait for false; a failed description is not pending). */
  onValuesPending?: (pending: boolean) => void;
}

type StyleMap = RendererMap & {
  on(type: string, listener: () => void): unknown;
  off(type: string, listener: () => void): unknown;
  once(type: string, listener: () => void): unknown;
  getStyle(): { layers?: Array<{ id: string; type: string; "source-layer"?: string }> } | undefined;
  getZoom(): number;
};

const nextFrame = (callback: () => void): number =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(callback)
    : (setTimeout(callback, 16) as unknown as number);
const cancelFrame = (handle: number) =>
  typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(handle) : clearTimeout(handle);

type StyledLayer = { id: number | string; style?: { document: LayerStyle } | null };

/** The store of a layer whose style panel is open. */
const editorOf = (layer: StyledLayer, editing: EditedLayer[] | undefined): EditorStore | undefined =>
  editing?.find((entry) => entry.key === String(layer.id))?.store;

/** A layer with `document` as its style's (an open style panel's), or as it is without one. */
const withDocument = <T extends StyledLayer>(layer: T, document: LayerStyle | undefined): T =>
  layer.style && document ? { ...layer, style: { ...layer.style, document } } : layer;

/** A layer as the map draws it now: with its open style panel's document. For event handlers; a component that
 * renders the layer uses `useLiveLayer`, which renders again when the document changes. */
export const liveLayer = <T extends StyledLayer>(layer: T, editing: EditedLayer[] | undefined): T =>
  withDocument(layer, editorOf(layer, editing)?.document);

/** A layer whose style panel is open, with its document taken from the store (what the map draws, so popups agree). */
export function useLiveLayer<T extends StyledLayer>(
  layer: T | undefined,
  editing: EditedLayer[] | undefined
): T | undefined {
  const store = layer ? editorOf(layer, editing) : undefined;
  const subscribe = useCallback(
    (listener: () => void) => (store ? store.subscribe(listener) : () => undefined),
    [store]
  );
  const read = () => store?.document;
  const document = useSyncExternalStore(subscribe, read, read);
  return useMemo(() => (layer ? withDocument(layer, document) : layer), [layer, document]);
}

function EditedStyle({
  layerKey,
  store,
  onDocument,
}: {
  layerKey: string;
  store: EditorStore;
  onDocument: (key: string, document: LayerStyle | null) => void;
}) {
  const document = useSyncExternalStore(
    store.subscribe,
    () => store.document,
    () => store.document
  );
  useEffect(() => onDocument(layerKey, document), [layerKey, document, onDocument]);
  useEffect(() => () => onDocument(layerKey, null), [layerKey, onDocument]);
  return null;
}

export function StyledLayers({
  layers,
  editing = [],
  locale,
  tone,
  overlay,
  ground,
  scene,
  onLayersChange,
  presenceScope,
  onValuesPending,
}: StyledLayersProps) {
  const { current } = useMap();
  const map = current?.getMap() as StyleMap | undefined;
  const latest = useRef({ layers, locale, tone, overlay, ground, onLayersChange, onValuesPending });
  latest.current = { layers, locale, tone, overlay, ground, onLayersChange, onValuesPending };
  const drawnIds = useRef("");
  const redraw = useRef<() => void>(() => undefined);
  const [rasterValues] = useState(() => rasterValuesOver(loadRasterValues, () => redraw.current()));
  const valuesPending = useRef<boolean | null>(null);
  const edited = useRef(new Map<string, LayerStyle>());
  const state = useRef<MapLayersState | null>(null);
  const anchors = useRef<Anchors | null>(null);
  const frame = useRef<number | null>(null);
  const presence = useRef<ReturnType<typeof watchViewPresence> | null>(null);
  // The style JSON has loaded (getStyle() answers): sources and layers can be added. A new style (a basemap switch)
  // that is still loading makes a draw throw; it waits for the style again.
  const ready = useRef(false);
  // Gone from the page: an edited layer's child that unmounts after the renderer asks for no more draws.
  const unmounted = useRef(false);
  // First of the effects, so it is set again before the draws below run (also when React mounts twice in dev).
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);

  // One draw: the layers as they are now put on the map.
  const sync = useCallback(() => {
    if (!map || unmounted.current) return;
    if (!ready.current && !map.getStyle()) {
      map.once("styledata", () => redraw.current());
      return;
    }
    ready.current = true;
    const {
      layers: next,
      locale: nextLocale,
      tone: nextTone,
      overlay: nextOverlay,
      ground: nextGround,
    } = latest.current;
    anchors.current ??= basemapAnchorsOf(map);
    const edits = next.map((layer) => {
      const document = edited.current.get(layer.key);
      return document ? { ...layer, style: document, version: undefined } : layer;
    });
    const { layers: drawn, pending } = rasterValues.attach(edits);
    try {
      state.current = syncMapLayers(map, state.current, drawn, {
        locale: nextLocale,
        anchors: anchors.current,
        // The map's overlays (drawing, measuring, a filter's area) stay above the project layers.
        overlay: nextOverlay ?? lowestOverlayId(map.getStyle()?.layers),
        ground: nextGround,
        tone: nextTone,
      });
    } catch (error) {
      if (!String(error).includes("Style is not done loading")) throw error;
      ready.current = false;
      map.once("styledata", () => redraw.current());
      return;
    }
    const ids = rendererLayerIds(map);
    if (ids.join("|") !== drawnIds.current) {
      drawnIds.current = ids.join("|");
      latest.current.onLayersChange?.(ids);
    }
    if (pending !== valuesPending.current) {
      valuesPending.current = pending;
      latest.current.onValuesPending?.(pending);
    }
    // A class edited, another filter or time: the classes in view may have changed without a move.
    presence.current?.refresh();
  }, [map, rasterValues]);

  const draw = useCallback(() => {
    if (!map || unmounted.current || frame.current !== null) return;
    frame.current = nextFrame(() => {
      frame.current = null;
      sync();
    });
  }, [map, sync]);
  redraw.current = draw;

  const onDocument = useCallback(
    (key: string, document: LayerStyle | null) => {
      if (document) edited.current.set(key, document);
      else edited.current.delete(key);
      draw();
    },
    [draw]
  );

  useEffect(() => draw(), [layers, locale, tone, overlay, ground, scene, draw]);

  const stacked = useMemo(
    () => layers.map((layer) => layer.key).filter((key) => !key.startsWith(PENDING_KEY)),
    [layers]
  );
  useBasemapStacking(map as unknown as MaplibreMap | undefined, stacked);

  // From the camera zoom at which the map's buildings draw, the layers on top go below them (`syncMapLayers`): a
  // camera across it draws at once, in the event, so the map draws its next frame with them placed; any other event
  // compares two numbers. Every frame of a movement fires `move`, also where the zoom changes without a zoom axis (over
  // terrain the end of a drag puts the center back onto the ground with the camera in place, which changes the zoom,
  // and its inertia then moves without zooming); `moveend` closes a movement whose end changed the zoom that way.
  useEffect(() => {
    if (!map) return;
    const onMove = () => {
      const from = state.current?.buildingsFrom;
      if (from === undefined || map.getZoom() >= from === state.current?.underBuildings) return;
      if (frame.current !== null) cancelFrame(frame.current);
      frame.current = null;
      sync();
    };
    map.on("move", onMove);
    map.on("moveend", onMove);
    return () => {
      map.off("move", onMove);
      map.off("moveend", onMove);
    };
  }, [map, sync]);

  // A new style (a basemap switch) replaces the global state and maybe the layers: put both back.
  useEffect(() => {
    if (!map) return;
    const onStyleLoad = () => {
      anchors.current = null;
      restoreGlobalState(map, state.current);
      draw();
    };
    map.on("style.load", onStyleLoad);
    return () => {
      map.off("style.load", onStyleLoad);
    };
  }, [map, draw]);

  // The classes in view, for the legends that list those: counted on the layers as drawn, edits included.
  useEffect(() => {
    if (!map || !presenceScope) return;
    const watch = watchViewPresence(map as unknown as PresenceMap, presenceScope, () =>
      latest.current.layers
        .filter((layer) => !layer.key.startsWith(PENDING_KEY))
        .map((layer) => ({
          key: layer.key,
          style: (edited.current.get(layer.key) ?? layer.style) as unknown as JsonObject,
        }))
    );
    presence.current = watch;
    watch.refresh();
    return () => {
      presence.current = null;
      watch.dispose();
    };
  }, [map, presenceScope]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelFrame(frame.current);
      frame.current = null;
      rasterValues.dispose();
      if (map && state.current)
        state.current = syncMapLayers(map, state.current, [], {
          locale: latest.current.locale,
          tone: latest.current.tone,
        });
    },
    [map, rasterValues]
  );

  return (
    <>
      {editing.map((entry) => (
        <EditedStyle key={entry.key} layerKey={entry.key} store={entry.store} onDocument={onDocument} />
      ))}
    </>
  );
}
