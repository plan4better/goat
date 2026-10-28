"use client";

// The map's project layers: renders nothing, puts the layers on the map with one `syncMapLayers` per
// animation frame. A layer whose style panel is open is drawn from its editor store through a child subscribed to
// that store only, so an edit compiles and applies that layer and renders nothing else.
import type { Map as MaplibreMap } from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useMap } from "react-map-gl/maplibre";

import type { EditorStore } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";
import {
  type Anchors,
  type MapLayersState,
  type RenderLayer,
  type RendererMap,
  basemapAnchors,
  projectLayerOf,
  rendererLayerIds,
  restoreGlobalState,
  syncMapLayers,
} from "@/lib/style/render/mapLayers";
import { PENDING_KEY } from "@/lib/style/render/viewLayers";

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
  /** The lowest layer that stays above the project layers. */
  overlay?: string;
  /** Every MapLibre layer id the renderer drew, after each change (interactive layers, snapping). */
  onLayersChange?: (ids: string[]) => void;
}

type StyleMap = RendererMap & {
  on(type: string, listener: () => void): unknown;
  off(type: string, listener: () => void): unknown;
  once(type: string, listener: () => void): unknown;
  getStyle(): { layers?: Array<{ id: string; type: string; "source-layer"?: string }> } | undefined;
};

const nextFrame = (callback: () => void): number =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(callback)
    : (setTimeout(callback, 16) as unknown as number);
const cancelFrame = (handle: number) =>
  typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(handle) : clearTimeout(handle);

/** A layer whose style panel is open, with its document taken from the store (what the map draws, so popups agree). */
export function useLiveLayer<T extends { id: number | string; style?: { document: LayerStyle } | null }>(
  layer: T | undefined,
  editing: EditedLayer[] | undefined
): T | undefined {
  const store = layer ? editing?.find((entry) => entry.key === String(layer.id))?.store : undefined;
  const subscribe = useCallback(
    (listener: () => void) => (store ? store.subscribe(listener) : () => undefined),
    [store]
  );
  const read = () => store?.document;
  const document = useSyncExternalStore(subscribe, read, read);
  return useMemo(
    () => (layer?.style && document ? { ...layer, style: { ...layer.style, document } } : layer),
    [layer, document]
  );
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

export function StyledLayers({ layers, editing = [], locale, overlay, onLayersChange }: StyledLayersProps) {
  const { current } = useMap();
  const map = current?.getMap() as StyleMap | undefined;
  const latest = useRef({ layers, locale, overlay, onLayersChange });
  latest.current = { layers, locale, overlay, onLayersChange };
  const drawnIds = useRef("");
  const edited = useRef(new Map<string, LayerStyle>());
  const state = useRef<MapLayersState | null>(null);
  const anchors = useRef<Anchors | null>(null);
  const frame = useRef<number | null>(null);
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

  const draw = useCallback(() => {
    if (!map || unmounted.current || frame.current !== null) return;
    frame.current = nextFrame(() => {
      frame.current = null;
      if (!ready.current && !map.getStyle()) {
        map.once("styledata", draw);
        return;
      }
      ready.current = true;
      const { layers: next, locale: nextLocale, overlay: nextOverlay } = latest.current;
      anchors.current ??= basemapAnchors(map.getStyle()?.layers?.filter((l) => !projectLayerOf(map, l.id)));
      const drawn = next.map((layer) => {
        const document = edited.current.get(layer.key);
        return document ? { ...layer, style: document, version: undefined } : layer;
      });
      try {
        state.current = syncMapLayers(map, state.current, drawn, {
          locale: nextLocale,
          anchors: anchors.current,
          overlay: nextOverlay,
        });
      } catch (error) {
        if (!String(error).includes("Style is not done loading")) throw error;
        ready.current = false;
        map.once("styledata", draw);
        return;
      }
      const ids = rendererLayerIds(map);
      if (ids.join("|") !== drawnIds.current) {
        drawnIds.current = ids.join("|");
        latest.current.onLayersChange?.(ids);
      }
    });
  }, [map]);

  const onDocument = useCallback(
    (key: string, document: LayerStyle | null) => {
      if (document) edited.current.set(key, document);
      else edited.current.delete(key);
      draw();
    },
    [draw]
  );

  useEffect(() => draw(), [layers, locale, overlay, draw]);

  const stacked = useMemo(
    () => layers.map((layer) => layer.key).filter((key) => !key.startsWith(PENDING_KEY)),
    [layers]
  );
  useBasemapStacking(map as unknown as MaplibreMap | undefined, stacked);

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

  useEffect(
    () => () => {
      if (frame.current !== null) cancelFrame(frame.current);
      frame.current = null;
      if (map && state.current)
        state.current = syncMapLayers(map, state.current, [], { locale: latest.current.locale });
    },
    [map]
  );

  return (
    <>
      {editing.map((entry) => (
        <EditedStyle key={entry.key} layerKey={entry.key} store={entry.store} onDocument={onDocument} />
      ))}
    </>
  );
}
