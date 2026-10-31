"use client";

import { type RefObject, useEffect, useRef } from "react";
import type { MapRef } from "react-map-gl/maplibre";

import { type MapLike, applyMapView, projectMapContext } from "@/lib/assistant/mapView";
import { getDockState, setDockState } from "@/lib/assistant/store";
import { surfaceForMapMode, useAssistantSurface } from "@/lib/assistant/surface";
import type { PageContext } from "@/lib/assistant/types";
import { setSelectedLayers } from "@/lib/store/layer/slice";
import type { MapMode } from "@/lib/store/map/slice";
import { zoomToProjectLayer } from "@/lib/utils/map/navigate";
import type { ProjectLayer } from "@/lib/validations/project";

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The read-only project surface (spec §10): the project as the conversation's
 * target, context per mode (re-registered on a mode switch, so the dock's chips
 * re-label), and map-view proposals applied to the map in Map mode. It changes
 * no style, layer, filter, workflow, dashboard or layout.
 *
 * The live viewport is read when `getContext` is called and is not part of
 * `contextKey`: a pan or an applied view must not re-register the surface.
 */
export function useProjectAssistantSurface({
  project,
  projectId = project?.id,
  failed = false,
  mapRef,
  mapMode,
  isEditor,
  layers,
}: {
  project: { id: string; name: string; folder_id?: string | null } | undefined;
  /** The page's project id (its URL), known before the project loads. */
  projectId?: string;
  /** The project could not be loaded: no surface will register. */
  failed?: boolean;
  mapRef: RefObject<MapLike | null>;
  mapMode: MapMode;
  isEditor: boolean;
  /** The project's layers, for zooming to one from a result card. */
  layers?: ProjectLayer[];
}): void {
  const dispatch = useAppDispatch();
  // Read when a card asks, so a changed layer list does not re-register the surface.
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const activeLayerId = useAppSelector((state) => state.layers.activeLayerId);
  const workflowId = useAppSelector((state) => state.workflow.selectedWorkflowId);
  const surface = surfaceForMapMode(mapMode);
  // The dock waits for this page's surface; tell it when none will come (a failed load,
  // or a mode without a surface, e.g. "public" left behind by a public map).
  const withoutSurface = failed || (!!project && !surface);
  useEffect(() => {
    if (!withoutSurface || !projectId) return;
    setDockState({ noSurfaceProject: projectId });
    return () => {
      if (getDockState().noSurfaceProject === projectId) setDockState({ noSurfaceProject: null });
    };
  }, [withoutSurface, projectId]);
  useAssistantSurface(
    project && surface
      ? {
          surface,
          project: { id: project.id, name: project.name },
          // The chips show the selected layer and workflow: re-label when they change.
          contextKey: `${activeLayerId ?? ""}:${workflowId ?? ""}`,
          // Only editors may add layers to the project; a viewer's drop uploads a dataset.
          uploadTo: isEditor
            ? { projectId: project.id, folderId: project.folder_id ?? undefined }
            : undefined,
          getContext: (): PageContext => {
            if (surface === "project.map") {
              return projectMapContext({ projectId: project.id, map: mapRef.current, activeLayerId });
            }
            if (surface === "project.workflows" && workflowId && UUID.test(workflowId)) {
              return { surface, project_id: project.id, workflow_id: workflowId };
            }
            return { surface, project_id: project.id };
          },
          zoomToLayer:
            surface === "project.map"
              ? async (layerProjectId, { select = true } = {}) => {
                  // Selecting (not toggling) shows it in the layer list.
                  if (select) dispatch(setSelectedLayers([layerProjectId]));
                  const layer = layersRef.current?.find((candidate) => candidate.id === layerProjectId);
                  // The page's ref holds a react-map-gl MapRef; the surface types it as MapLike.
                  const map = mapRef.current as MapRef | null;
                  if (map && layer) await zoomToProjectLayer(map, layer);
                }
              : undefined,
          apply:
            surface === "project.map"
              ? (proposal) => {
                  const map = mapRef.current;
                  if (proposal.kind !== "map.view") return;
                  // Throwing lets the card report the failure instead of marking the view applied.
                  if (!map) throw new Error("The map is not ready");
                  return applyMapView(map, proposal.payload);
                }
              : undefined,
        }
      : null
  );
}
