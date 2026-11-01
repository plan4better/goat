import { useParams } from "next/navigation";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { updateProjectLayerTree, useProjectLayerGroups, useProjectLayers } from "@/lib/api/projects";
import { updateProjectLayer as updateLocalProjectLayer } from "@/lib/store/layer/slice";
import { updateProjectLayerGroup as updateLocalProjectLayerGroup } from "@/lib/store/layer/slice";
import type { ProjectLayerTreeUpdate } from "@/lib/validations/project";

import { useFilteredProjectLayers } from "@/hooks/map/LayerPanelHooks";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

const NO_LAYERS: never[] = [];

/**
 * The project's layers and groups as a dashboard widget sees them, and the one
 * way a widget changes their visibility, legend or expanded state.
 *
 * Public view (`viewOnly`): the published layers in Redux, changed locally only.
 * Editor: the saved layers, updated optimistically and persisted; `order` and
 * `parent_id` stay pinned to what is saved, so a widget can never reorder or
 * reparent layers on the map. With `persist: false` the editor only shows the
 * change and saves nothing, for steps that follow each other quickly (play,
 * slider drags); the last one is saved with `persist: true`.
 */
export const useWidgetLayerTree = (viewOnly?: boolean) => {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const { projectId } = useParams() as { projectId: string };
  const { mutate: mutateProjectLayers } = useFilteredProjectLayers(projectId);

  const reduxProjectLayers = useAppSelector((state) => state.layers.projectLayers);
  const reduxProjectLayerGroups = useAppSelector((state) => state.layers.projectLayerGroups);

  const { layers: editProjectLayers } = useProjectLayers(viewOnly ? undefined : projectId);
  const { layerGroups: editProjectLayerGroups, mutate: mutateProjectLayerGroups } = useProjectLayerGroups(
    viewOnly ? undefined : projectId
  );

  const updateTree = useCallback(
    async (updatePayload: ProjectLayerTreeUpdate, { persist = true }: { persist?: boolean } = {}) => {
      try {
        if (viewOnly) {
          updatePayload.items.forEach((item) => {
            if (item.type === "layer" && item.properties) {
              const existingLayer = reduxProjectLayers.find((l) => l.id === item.id);
              if (existingLayer) {
                dispatch(
                  updateLocalProjectLayer({
                    id: item.id,
                    changes: {
                      properties: {
                        ...existingLayer.properties,
                        ...item.properties,
                        legend: item.properties.legend
                          ? { ...existingLayer.properties?.legend, ...item.properties.legend }
                          : existingLayer.properties?.legend,
                      },
                    },
                  })
                );
              }
            } else if (item.type === "group" && item.properties) {
              const existingGroup = reduxProjectLayerGroups.find((g) => g.id === item.id);
              if (existingGroup) {
                dispatch(
                  updateLocalProjectLayerGroup({
                    id: item.id,
                    changes: {
                      properties: {
                        ...existingGroup.properties,
                        ...item.properties,
                      },
                    },
                  })
                );
              }
            }
          });
        } else {
          const sanitizedItems = updatePayload.items.map((item) => {
            if (item.type === "layer") {
              const existing = editProjectLayers?.find((l) => l.id === item.id);
              return {
                ...item,
                order: existing?.order ?? item.order,
                parent_id: existing?.layer_project_group_id ?? null,
              };
            }
            const existing = editProjectLayerGroups?.find((g) => g.id === item.id);
            return {
              ...item,
              order: existing?.order ?? item.order,
              parent_id: existing?.parent_id ?? null,
            };
          });
          const sanitizedPayload: ProjectLayerTreeUpdate = { items: sanitizedItems };

          if (editProjectLayers) {
            const updatedLayers = editProjectLayers.map((layer) => {
              const updateItem = sanitizedItems.find((item) => item.id === layer.id && item.type === "layer");
              if (updateItem) {
                return {
                  ...layer,
                  properties: updateItem.properties
                    ? { ...layer.properties, ...updateItem.properties }
                    : layer.properties,
                };
              }
              return layer;
            });
            mutateProjectLayers(updatedLayers, false);
          }

          if (editProjectLayerGroups) {
            const updatedGroups = editProjectLayerGroups.map((group) => {
              const updateItem = sanitizedItems.find((item) => item.id === group.id && item.type === "group");
              if (updateItem) {
                return {
                  ...group,
                  properties: updateItem.properties
                    ? { ...group.properties, ...updateItem.properties }
                    : group.properties,
                };
              }
              return group;
            });
            mutateProjectLayerGroups(updatedGroups, false);
          }

          if (!persist) return;
          await updateProjectLayerTree(projectId, sanitizedPayload);
        }
      } catch (error) {
        console.error("Dashboard widget - error updating layer tree:", error);
        toast.error(t("error_updating_layer_tree"));
        if (!viewOnly) {
          mutateProjectLayers();
          mutateProjectLayerGroups();
        }
      }
    },
    [
      viewOnly,
      reduxProjectLayers,
      reduxProjectLayerGroups,
      editProjectLayers,
      editProjectLayerGroups,
      dispatch,
      projectId,
      mutateProjectLayers,
      mutateProjectLayerGroups,
      t,
    ]
  );

  return {
    projectId,
    layers: viewOnly ? reduxProjectLayers : editProjectLayers || NO_LAYERS,
    layerGroups: viewOnly ? reduxProjectLayerGroups : editProjectLayerGroups || NO_LAYERS,
    updateTree,
  };
};
