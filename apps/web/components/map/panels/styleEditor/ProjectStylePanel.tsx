"use client";

// The style panel of a project layer: the layer's active style in a store the page's registry holds, so
// the map draws the edit at once and a save outlives the panel. It opens at once with the map request's document;
// the opening check (core recomputes a style whose data changed and answers its issues) arrives in the background.
import type { Map as MaplibreMap } from "maplibre-gl";
import { type ReactNode, useEffect, useMemo } from "react";
import { useMap } from "react-map-gl/maplibre";

import { useProjectMap } from "@/lib/api/map";
import type { Geometry } from "@/lib/style/compile/types";
import type { EditorStore } from "@/lib/style/editor/store";
import { sourceOf } from "@/lib/style/layerSource";
import { createCoreTransport } from "@/lib/style/transports/core";

import type { MapLayer } from "@/hooks/map/useMapLayers";
import { useAppSelector } from "@/hooks/store/ContextHooks";
import { useLayerStyle } from "@/hooks/style/useLayerStyle";
import { useStyleData } from "@/hooks/style/useStyleData";

import { type EditorLayer, StyleEditor } from "@/components/map/panels/styleEditor/StyleEditor";
import { StyleSections } from "@/components/map/panels/styleEditor/StyleSections";
import { MapStateProvider, type Position } from "@/components/map/panels/styleEditor/mapState";

const geometryOf = (type: string | null | undefined): Geometry | undefined => {
  const g = type?.toLowerCase();
  return g === "point" || g === "line" || g === "polygon" ? g : undefined;
};

/** Runs the opening check once per store and hands its answer to the saver like a save reply. */
function useOpeningCheck(projectId: string, layer: MapLayer, store: EditorStore | null) {
  const styleId = layer.style?.id;
  useEffect(() => {
    if (!store || !styleId) return;
    let open = true;
    createCoreTransport({ projectId, layerProjectId: layer.id, styleId })
      .load()
      .then((stored) => {
        if (open) store.saver.receive(stored);
      })
      .catch(() => undefined);
    return () => {
      open = false;
    };
    // Once per store: a new store is a new opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);
}

export function ProjectStylePanel({
  projectId,
  layer,
  top,
}: {
  projectId: string;
  layer: MapLayer;
  /** Above the sections: the layer's named styles. */
  top?: ReactNode;
}) {
  const store = useLayerStyle(projectId, layer);
  useOpeningCheck(projectId, layer, store);
  const source = useMemo(() => sourceOf(layer), [layer]);
  const geometry = geometryOf(layer.feature_layer_geometry_type);
  const kind: EditorLayer["kind"] =
    layer.type !== "raster" ? "vector" : source?.kind === "cog" ? "raster" : "service";
  const data = useStyleData({ id: layer.layer_id, name: layer.name, geometry, source });
  // The panel is outside the <Map>: the project map by its id (`map`), which `current` is only inside it.
  const { current, map: projectMap } = useMap();
  const map = ((current ?? projectMap)?.getMap() ?? null) as MaplibreMap | null;
  const zoom = useAppSelector((state) => state.map.currentZoom ?? 12);
  const { setLayerState } = useProjectMap(projectId);
  const position = (layer.entry?.position ?? "top") as Position;
  const mapState = useMemo(
    () => ({ position, onPosition: (next: Position) => void setLayerState(layer.id, { position: next }) }),
    [position, setLayerState, layer.id]
  );
  if (!store) return null;
  return (
    <StyleEditor
      layer={{ id: String(layer.id), name: layer.name, geometry, kind }}
      store={store}
      data={data}
      map={map}
      mapZoom={zoom}
      top={top}
      header={false}>
      <MapStateProvider value={mapState}>
        <StyleSections kind={kind} />
      </MapStateProvider>
    </StyleEditor>
  );
}
