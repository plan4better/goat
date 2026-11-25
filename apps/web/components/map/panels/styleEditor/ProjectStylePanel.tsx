"use client";

// The style panel of a project layer: the layer's active style in a store the page's registry holds, so
// the map draws the edit at once and a save outlives the panel. It opens at once with the map request's document;
// the opening check (core recomputes a style whose data changed and answers its issues) arrives in the background.
import type { Map as MaplibreMap } from "maplibre-gl";
import { type ReactNode, useEffect, useMemo, useSyncExternalStore } from "react";
import { useMap } from "react-map-gl/maplibre";

import { useProjectMap } from "@/lib/api/map";
import { useProject } from "@/lib/api/projects";
import type { Geometry } from "@/lib/style/compile/types";
import { useStyleStores } from "@/lib/style/editor/StyleStores";
import type { EditorStore } from "@/lib/style/editor/store";
import { sourceOf } from "@/lib/style/layerSource";
import { breaksBandOf } from "@/lib/style/raster/metadata";
import { basemapTone } from "@/lib/style/tone";
import { createCoreTransport } from "@/lib/style/transports/core";

import { useBasemap } from "@/hooks/map/MapHooks";
import type { MapLayer } from "@/hooks/map/useMapLayers";
import { useAppSelector } from "@/hooks/store/ContextHooks";
import { useLayerStyle } from "@/hooks/style/useLayerStyle";
import type { LegendLayer } from "@/hooks/style/useLegendPresence";
import { useStyleData } from "@/hooks/style/useStyleData";

import { type EditorLayer, StyleEditor } from "@/components/map/panels/styleEditor/StyleEditor";
import { StyleSections } from "@/components/map/panels/styleEditor/StyleSections";
import { MapStateProvider, type Position } from "@/components/map/panels/styleEditor/mapState";

const noSubscribe = () => () => undefined;

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
  visible = true,
}: {
  projectId: string;
  layer: MapLayer;
  /** Above the sections: the layer's named styles. */
  top?: ReactNode;
  /** Off while the Style tab is not the open one: the panel's popovers close. */
  visible?: boolean;
}) {
  const held = useLayerStyle(projectId, layer);
  // The store of the layer and style shown. Another layer or named style picked in the open panel arrives a render
  // before its store does: until then there is none, so no section shows or edits one layer with the other's style.
  const registry = useStyleStores();
  const styleId = layer.style?.id;
  const store =
    held && styleId && registry?.get({ projectId, layerProjectId: layer.id, styleId }) === held ? held : null;
  useOpeningCheck(projectId, layer, store);
  const source = useMemo(() => sourceOf(layer), [layer]);
  const geometry = geometryOf(layer.feature_layer_geometry_type);
  const kind: EditorLayer["kind"] =
    layer.type !== "raster" ? "vector" : source?.kind === "cog" ? "raster" : "service";
  // A raster file's info carries the statistics and class breaks of the band or band formula the style colors as edited
  // now (the stored document's until the store is there, so the info is asked once).
  const readBand = () => breaksBandOf(store?.document ?? layer.style?.document);
  const breaksBand = useSyncExternalStore(store?.subscribe ?? noSubscribe, readBand, readBand);
  const dataset = useStyleData({ id: layer.layer_id, name: layer.name, geometry, source, breaksBand });
  // The legend preview's counts follow the layer's filter and data, not every change of the layer object.
  const { id, layer_id: datasetId, dataset_updated_at: version } = layer;
  const cql = layer.query?.cql;
  const legendLayer = useMemo<LegendLayer>(
    () => ({ key: String(id), dataset: datasetId, cql, version }),
    [id, datasetId, cql, version]
  );
  const data = useMemo(() => ({ ...dataset, legendLayer }), [dataset, legendLayer]);
  // The panel is outside the <Map>: the project map by its id (`map`), which `current` is only inside it.
  const { current, map: projectMap } = useMap();
  const map = ((current ?? projectMap)?.getMap() ?? null) as MaplibreMap | null;
  const zoom = useAppSelector((state) => state.map.currentZoom ?? 12);
  // The basemap the project map draws, resolved as the page resolves it for the map: swatches show the derived
  // colors for its tone.
  const tone = basemapTone(useBasemap(useProject(projectId).project).activeBasemap);
  const { setLayerState } = useProjectMap(projectId);
  const position = (layer.entry?.position ?? "top") as Position;
  const mapState = useMemo(
    () => ({
      position,
      layer: layer.id,
      onPosition: (next: Position) => void setLayerState(layer.id, { position: next }),
    }),
    [position, setLayerState, layer.id]
  );
  // The editor stays over the swap of its store, which closes its popovers; the sections start anew with each layer
  // and named style, so nothing half picked in one shows in the next.
  const shell = store ?? held;
  if (!shell) return null;
  return (
    <StyleEditor
      layer={{ id: String(layer.id), name: layer.name, geometry, kind }}
      store={shell}
      data={data}
      map={map}
      mapZoom={zoom}
      tone={tone}
      top={top}
      header={false}
      shown={visible}>
      {store && (
        <MapStateProvider value={mapState}>
          <StyleSections key={`${layer.id}:${styleId}`} kind={kind} />
        </MapStateProvider>
      )}
    </StyleEditor>
  );
}
