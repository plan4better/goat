// A map's layers for the renderer, with the page's state around them: the temporary filters (not in the data view),
// the feature editor's dataset and edits, clustered layers loading their points only once they were shown, and time
// sliders without a stored value at their latest step.
import { useMemo, useRef } from "react";

import type { RenderLayer } from "@/lib/style/render/mapLayers";
import { type RenderOptions, type ViewLayer, renderLayersOf } from "@/lib/style/render/viewLayers";

import { useTimeDefaults } from "@/hooks/map/useTimeSteps";
import { useAppSelector } from "@/hooks/store/ContextHooks";

export function useRenderLayers(
  layers: ViewLayer[] | undefined,
  opts: Pick<RenderOptions, "highlight" | "atlas"> = {}
): RenderLayer[] {
  const temporaryFilters = useAppSelector((state) => state.map.temporaryFilters);
  const mapMode = useAppSelector((state) => state.map.mapMode);
  const pendingFeatures = useAppSelector((state) => state.featureEditor.pendingFeatures);
  const editDataset = useAppSelector((state) => state.featureEditor.activeLayerId);

  const editing = useMemo<RenderOptions["editing"]>(() => {
    if (!editDataset) return undefined;
    const pending = Object.values(pendingFeatures);
    return {
      dataset: editDataset,
      // Changed and deleted features leave the tiles; the changed ones are drawn from the browser.
      exclude: pending.filter((f) => f.action === "update" || f.action === "delete").map((f) => f.id),
      pending: {
        type: "FeatureCollection",
        features: pending
          .filter((f) => f.geometry !== null && f.committed && f.action !== "delete" && !f.drawFeatureId)
          .map((f) => ({
            type: "Feature" as const,
            id: f.id,
            geometry: f.geometry as GeoJSON.Geometry,
            properties: { ...f.properties, _pending: true, _pendingId: f.id },
          })),
      },
    };
  }, [editDataset, pendingFeatures]);

  // Every layer key shown so far; a clustered layer downloads its points once it is first shown and keeps them.
  const revealed = useRef(new Set<string>());
  const timeDefaults = useTimeDefaults(layers);
  const { highlight, atlas } = opts;
  return useMemo(() => {
    for (const layer of layers ?? []) if (layer.visible) revealed.current.add(String(layer.id));
    return renderLayersOf(layers ?? [], {
      temporaryFilters: mapMode === "data" ? [] : temporaryFilters,
      editing,
      highlight,
      atlas,
      revealed: revealed.current,
      timeDefaults,
    });
  }, [layers, mapMode, temporaryFilters, editing, highlight, atlas, timeDefaults]);
}
