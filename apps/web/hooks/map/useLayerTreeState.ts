// What the layer tree changes on a map (spec 10 map state): an editor's changes are written with map-state PATCHes
// (shown at once, taken back when they fail); a project viewer's stay on the page (the cached map); a published map's
// viewer's stay view state on its rows in the store. A time slider shows its value while dragging and an editor's
// release writes it.
import { useCallback } from "react";

import { type LayerMapState, entryWithState, useProjectMap } from "@/lib/api/map";
import { updateProjectLayer, updateProjectLayerGroup } from "@/lib/store/layer/slice";
import type { ProjectLayer } from "@/lib/validations/project";

import type { MapLayer } from "@/hooks/map/useMapLayers";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

export type LayerStateChange = (layerProjectId: number, state: LayerMapState) => Promise<void>;
export type GroupStateChange = (groupId: number, state: { visible: boolean }) => Promise<void>;
/** A time slider moved: while dragging (`committed` false) the map only shows the value; an editor's release writes it. */
export type LayerTimeChange = (
  layerProjectId: number,
  value: string | number,
  committed: boolean
) => Promise<void>;

export type TreeStateMode = "edit" | "view" | "public";

export function useLayerTreeState(projectId: string | undefined, mode: TreeStateMode) {
  const dispatch = useAppDispatch();
  const rows = useAppSelector((state) => state.layers.projectLayers);
  const { setLayerState, setGroupState, viewLayerState, viewGroupState } = useProjectMap(
    mode === "public" ? undefined : projectId
  );

  const onLayerStateChange = useCallback<LayerStateChange>(
    async (layerProjectId, state) => {
      if (mode === "edit") return setLayerState(layerProjectId, state);
      if (mode === "view") return viewLayerState(layerProjectId, state);
      const layer = rows.find((l) => l.id === layerProjectId) as MapLayer | undefined;
      if (!layer?.entry) return;
      dispatch(
        updateProjectLayer({
          id: layerProjectId,
          changes: { entry: entryWithState(layer.entry, state) } as Partial<ProjectLayer>,
        })
      );
    },
    [mode, setLayerState, viewLayerState, rows, dispatch]
  );

  const onGroupStateChange = useCallback<GroupStateChange>(
    async (groupId, state) => {
      if (mode === "edit") return setGroupState(groupId, state);
      if (mode === "view") return viewGroupState(groupId, state);
      dispatch(updateProjectLayerGroup({ id: groupId, changes: { visible: state.visible } }));
    },
    [mode, setGroupState, viewGroupState, dispatch]
  );

  const onLayerTimeChange = useCallback<LayerTimeChange>(
    async (layerProjectId, value, committed) => {
      if (mode === "edit" && !committed) return viewLayerState(layerProjectId, { time_value: value });
      return onLayerStateChange(layerProjectId, { time_value: value });
    },
    [mode, viewLayerState, onLayerStateChange]
  );

  return { onLayerStateChange, onGroupStateChange, onLayerTimeChange };
}
