import { useParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { useProjectLayerGroups } from "@/lib/api/projects";

import { useLayerTreeState } from "@/hooks/map/useLayerTreeState";
import { type MapLayer, useMapLayers, withMapGroups } from "@/hooks/map/useMapLayers";
import { useAppSelector } from "@/hooks/store/ContextHooks";

const NO_LAYERS: never[] = [];

/** A layer a widget turns on or off. */
export interface VisibilityChange {
  id: number;
  visible: boolean;
}

/**
 * The map's layers and groups as a dashboard widget sees them, and how a widget
 * changes them.
 *
 * Public view (`viewOnly`): the published map's layers in the store, changed as
 * view state only. Editor: the project's map (its layer rows joined with the map
 * document); a change is map state, shown at once and written. With
 * `persist: false` the editor only shows a visibility change and writes nothing,
 * for steps that follow each other quickly (play, slider drags); the last one is
 * written with `persist: true`.
 */
export const useWidgetLayerTree = (viewOnly?: boolean) => {
  const { t } = useTranslation("common");
  const { projectId } = useParams() as { projectId: string };

  const reduxProjectLayers = useAppSelector((state) => state.layers.projectLayers) as MapLayer[];
  const reduxProjectLayerGroups = useAppSelector((state) => state.layers.projectLayerGroups);

  const { layers: editProjectLayers, map: projectMap } = useMapLayers(viewOnly ? undefined : projectId);
  const { layerGroups: editLayerGroups } = useProjectLayerGroups(viewOnly ? undefined : projectId);
  const editProjectLayerGroups = useMemo(
    () => withMapGroups(editLayerGroups ?? [], projectMap?.map),
    [editLayerGroups, projectMap?.map]
  );
  // An editor in the builder writes map state; a dashboard visitor's changes are view state.
  const treeState = useLayerTreeState(projectId, viewOnly ? "public" : "edit");
  const { onLayerStateChange, previewLayerState } = treeState;

  const setVisibility = useCallback(
    async (changes: VisibilityChange[], { persist = true }: { persist?: boolean } = {}) => {
      try {
        // Shown at once, all together; the writes follow one after the other. A visitor's change is view state:
        // shown is all there is.
        await Promise.all(changes.map(({ id, visible }) => previewLayerState(id, { visible })));
        if (!persist || viewOnly) return;
        for (const { id, visible } of changes) await onLayerStateChange(id, { visible });
      } catch (error) {
        console.error("Dashboard widget - error updating layer visibility:", error);
        toast.error(t("error_updating_layer_tree"));
      }
    },
    [previewLayerState, onLayerStateChange, viewOnly, t]
  );

  return {
    projectId,
    layers: viewOnly ? reduxProjectLayers : editProjectLayers || NO_LAYERS,
    layerGroups: viewOnly ? reduxProjectLayerGroups : editProjectLayerGroups || NO_LAYERS,
    treeState,
    setVisibility,
  };
};
