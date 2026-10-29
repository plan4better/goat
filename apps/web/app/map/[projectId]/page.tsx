"use client";

import type { DragOverEvent, DragStartEvent } from "@dnd-kit/core";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { Box, GlobalStyles, Stack, debounce, useTheme } from "@mui/material";
import { ThemeProvider } from "@mui/material/styles";
import "maplibre-gl/dist/maplibre-gl.css";
import dynamic from "next/dynamic";
import React, { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MapRef, ViewStateChangeEvent } from "react-map-gl/maplibre";
import { MapProvider } from "react-map-gl/maplibre";
import { toast } from "react-toastify";
import { v4 } from "uuid";

import { useFolders } from "@/lib/api/folders";
import {
  updateProject,
  updateProjectInitialViewState,
  useProject,
  useProjectInitialViewState,
  useProjectLayerGroups,
} from "@/lib/api/projects";
import { DrawProvider } from "@/lib/providers/DrawProvider";
import { MeasureProvider } from "@/lib/providers/MeasureProvider";
import { setSelectedBuilderItem } from "@/lib/store/map/slice";
import { StyleStoresProvider, useEditedLayers } from "@/lib/style/editor/StyleStores";
import { createSnapToCursorModifier } from "@/lib/utils/dnd-modifier";
import { getLocFromUrl, writeLocToUrl, writeMapLocToUrl } from "@/lib/utils/map/loc-url";
import {
  type BuilderWidgetSchema,
  type CustomBasemap,
  builderWidgetSchema,
  projectSchema,
} from "@/lib/validations/project";
import { widgetSchemaMap } from "@/lib/validations/widget";

import { useAuthZ } from "@/hooks/auth/AuthZ";
import { useBrandedTheme } from "@/hooks/dashboard/useBrandedTheme";
import { useExplorerBasemap } from "@/hooks/explorer/useExplorerBasemap";
import { JobStatusWatcher } from "@/hooks/jobs/JobStatus";
import { useFilteredProjectLayers } from "@/hooks/map/LayerPanelHooks";
import { useBasemap } from "@/hooks/map/MapHooks";
import { useMapLayers } from "@/hooks/map/useMapLayers";
import { useMapUrlIntent } from "@/hooks/map/useMapUrlIntent";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { DraggableItem } from "@/components/builder/widgets/common/DraggableItem";
import { LoadingPage } from "@/components/common/LoadingPage";
import Header from "@/components/header/Header";
import EditModeHalo from "@/components/map/EditModeHalo";
import MapDropTarget from "@/components/map/MapDropTarget";
import MapViewer from "@/components/map/MapViewer";
import DataProjectLayout from "@/components/map/layouts/desktop/DataProjectLayout";
import PublicProjectLayout from "@/components/map/layouts/desktop/PublicProjectLayout";
import DataPanel from "@/components/map/panels/DataPanel";
import TransferToasts from "@/components/uploads/TransferToasts";

const BuilderConfigPanel = dynamic(() => import("@/components/builder/ConfigPanel"), { ssr: false });
const ReportsLayout = dynamic(() => import("@/components/reports").then((m) => m.ReportsLayout), {
  ssr: false,
});
const WorkflowsLayout = dynamic(() => import("@/components/workflows/WorkflowsLayout"), { ssr: false });

const UPDATE_VIEW_STATE_DEBOUNCE_TIME = 200;

/** The project's map, drawing each layer whose style is open from its editor store (inside StyleStoresProvider). */
function EditingMapViewer({
  projectId,
  ...props
}: React.ComponentProps<typeof MapViewer> & { projectId: string }) {
  const editing = useEditedLayers(
    projectId,
    props.layers as Array<{ id: number; style?: { id?: string } | null }>
  );
  return <MapViewer {...props} editing={editing} />;
}

export default function MapPage(props: { params: Promise<{ projectId: string }> }) {
  const params = use(props.params);

  const { projectId } = params;

  const theme = useTheme();
  const { t, i18n } = useTranslation("common");
  const mapRef = useRef<MapRef | null>(null);
  // Read ?loc= once on mount; it wins over the project's saved initial view.
  const urlLoc = useMemo(() => getLocFromUrl(), []);
  const mapMode = useAppSelector((state) => state.map.mapMode);
  // The Explorer has its own bottom bar and is not a feature-editing session.
  const explorerActive = useAppSelector((state) => state.explorer.active);
  const dispatch = useAppDispatch();

  // A template result (T7) can land here as `?mode=workflows&workflow=<id>` /
  // `?mode=reports&layout=<id>` — see templateResultHref in
  // hooks/templates/useUseTemplate.ts. Workflow selection is handled inside
  // the hook (Redux); layoutId is threaded down to ReportsLayout below since
  // the Reports panel keeps its selection in local component state.
  const { layoutId } = useMapUrlIntent(projectId);

  const {
    project: _project,
    isLoading: isProjectLoading,
    isError: projectError,
    mutate: mutateProject,
  } = useProject(projectId);
  const {
    initialView,
    isLoading: isInitialViewLoading,
    isError: projectInitialViewError,
  } = useProjectInitialViewState(projectId);

  const {
    isLoading: areProjectLayersLoading,
    isError: projectLayersError,
    mutate: mutateProjectLayers,
  } = useFilteredProjectLayers(projectId, ["table"], []);

  // Fetch all layers including tables for widgets/workflows
  const { layers: allProjectLayersIncludingTables } = useFilteredProjectLayers(projectId, [], []);

  // The map's layers: the layer rows joined with the map request (styles and map state), in the tree's order.
  const {
    layers: mapLayers,
    map: projectMap,
    isLoading: isMapLoading,
    mutate: mutateMap,
  } = useMapLayers(projectId, { revalidateOnMount: true });

  const {
    layerGroups: projectLayerGroups,
    isLoading: areProjectLayerGroupsLoading,
    isError: projectLayerGroupsError,
    mutate: mutateProjectLayerGroups,
  } = useProjectLayerGroups(projectId);

  const project = useMemo(() => {
    if (!_project) return undefined;
    const parsedProject = projectSchema.safeParse(_project);
    if (parsedProject.success) {
      return parsedProject.data;
    } else {
      console.error("Invalid project data:", parsedProject.error);
      return undefined;
    }
  }, [_project]);

  const primaryColor = project?.builder_config?.settings?.primary_color;
  const iconColor = project?.builder_config?.settings?.icon_color;
  const fontColor = project?.builder_config?.settings?.font_color;
  // "light" mirrors the published dashboard: the preview must show what
  // visitors see, not the author's own editor light/dark preference.
  const brandedTheme = useBrandedTheme(primaryColor, iconColor, fontColor, "light");

  // Reports draw the map's layers (map document order, visibility and styles); tables draw nothing.
  const reportLayers = useMemo(
    () => (mapLayers ?? []).filter((layer) => layer.type !== "table"),
    [mapLayers]
  );

  const widgetProjectLayers = useMemo(() => {
    return allProjectLayersIncludingTables || [];
  }, [allProjectLayersIncludingTables]);

  const { mapStyle, setActiveBasemap } = useBasemap(project);
  // The theme's basemap in the Explorer, where nobody has chosen the project's:
  // told by the project as core sends it, before the schema fills in a default.
  useExplorerBasemap(_project);

  // Keep the Redux active basemap (read by the renderer for basemap layer_config) in
  // sync with the persisted basemap, re-resolving only when the active basemap
  // value or its own layer_config actually changes. Keyed on a stable string so
  // unrelated SWR revalidations (which hand back new array refs) don't re-dispatch
  // and force a style reload on raster/solid basemaps.
  const activeBasemapValue = project?.basemap;
  const activeBasemapLayerConfigKey = useMemo(() => {
    const customs = (project?.custom_basemaps as CustomBasemap[] | undefined) ?? [];
    const active = customs.find((c) => c.id === activeBasemapValue);
    return JSON.stringify(active && active.type === "vector" ? (active.layer_config ?? null) : null);
  }, [project?.custom_basemaps, activeBasemapValue]);
  useEffect(() => {
    if (activeBasemapValue) setActiveBasemap(activeBasemapValue);
    // setActiveBasemap is recreated on each render; the stable deps above gate
    // when we actually need to re-sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBasemapValue, activeBasemapLayerConfigKey]);

  const { isOrgEditor, isLoading: isAuthZLoading } = useAuthZ();
  const { folders, isLoading: isFoldersLoading } = useFolders({});
  const projectFolder = useMemo(
    () => (project?.folder_id && folders ? folders.find((f) => f.id === project.folder_id) : undefined),
    [folders, project?.folder_id]
  );
  const isProjectEditor = useMemo(() => {
    if (project?.my_role) {
      return project.my_role === "project-owner" || project.my_role === "project-editor";
    }
    if (projectFolder) {
      if (projectFolder.is_owned) return true;
      if (projectFolder.role === "folder-editor") return true;
      if (projectFolder.role === "folder-viewer") return false;
    }
    return isOrgEditor;
  }, [project?.my_role, projectFolder, isOrgEditor]);

  const isLoading = useMemo(
    () =>
      isProjectLoading ||
      isInitialViewLoading ||
      areProjectLayersLoading ||
      isMapLoading ||
      areProjectLayerGroupsLoading ||
      isAuthZLoading ||
      isFoldersLoading,
    [
      isProjectLoading,
      isInitialViewLoading,
      areProjectLayersLoading,
      isMapLoading,
      areProjectLayerGroupsLoading,
      isAuthZLoading,
      isFoldersLoading,
    ]
  );

  const hasError = useMemo(
    () => projectError || projectInitialViewError || projectLayersError || projectLayerGroupsError,
    [projectError, projectInitialViewError, projectLayersError, projectLayerGroupsError]
  );

  const updateViewState = useMemo(
    () =>
      debounce((e: ViewStateChangeEvent) => {
        updateProjectInitialViewState(projectId, {
          zoom: e.viewState.zoom,
          latitude: e.viewState.latitude,
          longitude: e.viewState.longitude,
          pitch: e.viewState.pitch,
          bearing: e.viewState.bearing,
          min_zoom: initialView?.min_zoom ?? 0,
          max_zoom: initialView?.max_zoom ?? 24,
        });
      }, UPDATE_VIEW_STATE_DEBOUNCE_TIME),
    [initialView?.max_zoom, initialView?.min_zoom, projectId]
  );

  const handleMoveEnd = useCallback(
    (e: ViewStateChangeEvent) => {
      writeLocToUrl(e.viewState);
      if (isProjectEditor) {
        updateViewState(e);
      }
    },
    [isProjectEditor, updateViewState]
  );

  const handleMapLoaded = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    writeMapLocToUrl(map);
  }, []);

  const handleJobSuccess = useCallback(() => {
    mutateProjectLayers();
    mutateProjectLayerGroups();
    mutateProject();
    mutateMap();
  }, [mutateProjectLayers, mutateProjectLayerGroups, mutateProject, mutateMap]);

  // Widget Drag and Drop
  const [activeWidget, setActiveWidget] = useState<BuilderWidgetSchema | null>(null);

  const selectedBuilderItem = useAppSelector((state) => state.map.selectedBuilderItem);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // Accepts either (key, value, refresh?) or (partial, refresh?). The latter
  // form patches multiple project fields atomically (used for the basemap
  // create+select flow so the new entry is in the array AND selected in one
  // SWR mutation, avoiding a stale-snapshot race between two awaited calls).
  const handleProjectUpdate = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    keyOrPartial: string | Record<string, any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    valueOrRefresh?: any,
    refresh = false
  ) => {
    const partial = typeof keyOrPartial === "string" ? { [keyOrPartial]: valueOrRefresh } : keyOrPartial;
    const refreshFlag = typeof keyOrPartial === "string" ? refresh : (valueOrRefresh ?? false);
    try {
      // The project as core sent it, not as parsed: the cache holds the API's
      // shape, and the schema's defaults (an unset basemap read as High
      // Fidelity) must not be written back into it as if core had sent them.
      const projectToUpdate = JSON.parse(JSON.stringify(_project ?? project));
      Object.assign(projectToUpdate, partial);
      mutateProject(projectToUpdate, refreshFlag);
      await updateProject(projectId, partial);
      // The map document carries the project's number locale.
      if ("locale" in partial) void mutateMap();
    } catch (error) {
      toast.error(t("error_updating_project"));
      mutateProject();
    }
  };

  const handleDragStart = (event: DragStartEvent) => {
    const widget = event.active.data?.current;
    if (widget?.config?.type) {
      // There are two possibilities here. Either user has dragged a new widget or an existing one
      // New widgets don't have a setup configuration defined.
      // In that case we have to create a new object with a unique id ready to be pushed in the builder_config when over panels
      if (!widget?.config?.setup) {
        const widgetSchema = widgetSchemaMap[widget.config.type];
        if (!widgetSchema) {
          console.error(`Widget schema for type ${widget.config.type} not found`);
          return;
        }
        const newWidget = widgetSchema.safeParse({
          type: widget.config.type,
        });

        if (newWidget.success) {
          // Add a default title based on the language
          const newWidgetData = newWidget.data;
          if (newWidgetData?.setup?.title && i18n.exists(`common:${newWidgetData.type}`)) {
            newWidgetData.setup.title = i18n.t(`common:${newWidgetData.type}`);
          }
          const newBuilderWidget = builderWidgetSchema.safeParse({
            id: v4(),
            type: "widget",
            config: newWidgetData,
          });
          if (newBuilderWidget.success) {
            setActiveWidget(newBuilderWidget.data);
          } else {
            console.error(
              `Widget schema for type ${widget.config.type} is not valid`,
              newBuilderWidget.error
            );
            return;
          }
        } else {
          console.error(`Widget schema for type ${widget.config.type} is not valid`, newWidget.error);
          return;
        }
      } else {
        setActiveWidget(widget as BuilderWidgetSchema);
      }
    }
  };

  const handleDragEnd = () => {
    setActiveWidget(null);
    handleProjectUpdate("builder_config", project?.builder_config, true);
  };

  const handleDragOver = (event: DragOverEvent) => {
    if (!activeWidget || !project?.builder_config) {
      return;
    }

    const { over } = event;
    if (!over) {
      return;
    }

    const builderConfig = { ...project.builder_config };
    let updatedPanels = [...builderConfig.interface];

    // 1. Find the current panel of the activeWidget (if it exists)
    let currentPanelId: string | undefined;
    let currentPanelIndex: number = -1;
    let currentWidgetIndex: number = -1;

    builderConfig.interface.forEach((panel, pIndex) => {
      const index = panel.widgets.findIndex((w) => w.id === activeWidget.id);
      if (index !== -1) {
        currentPanelId = panel.id;
        currentPanelIndex = pIndex;
        currentWidgetIndex = index;
        return; // Exit forEach once found
      }
    });

    // Determine the target location based on 'over' element type
    if (over.data?.current?.type === "panel") {
      const overPanel = over.data.current;
      const overPanelIndex = updatedPanels.findIndex((p) => p.id === overPanel.id);

      if (overPanelIndex === -1) return; // Should not happen if over.data.current.type is 'panel'

      // If activeWidget is not in any panel, or moving to a different panel
      if (!currentPanelId || currentPanelId !== overPanel.id) {
        // Remove activeWidget from its original panel if it was there
        if (currentPanelId && currentPanelIndex !== -1) {
          updatedPanels = updatedPanels.map((panel, index) => {
            if (index === currentPanelIndex) {
              return {
                ...panel,
                widgets: panel.widgets.filter((w) => w.id !== activeWidget.id),
              };
            }
            return panel;
          });
        }

        // Add the activeWidget to the end of the target panel
        updatedPanels = updatedPanels.map((panel, index) => {
          if (index === overPanelIndex) {
            // Only add if not already present (prevents duplicates during drag over)
            if (!panel.widgets.some((w) => w.id === activeWidget.id)) {
              return {
                ...panel,
                widgets: [...panel.widgets, activeWidget],
              };
            }
          }
          return panel;
        });
      }
      // else, if activeWidget is already in the overPanel, we do nothing special here
      // as panel drop means adding to end. Sorting within panel is handled by widget drop.
    } else if (over.data?.current?.type === "widget") {
      const overWidget = over.data.current as BuilderWidgetSchema; // The widget we are hovering over

      const targetPanelIndex = updatedPanels.findIndex((panel) =>
        panel.widgets.some((w) => w.id === overWidget.id)
      );

      if (targetPanelIndex === -1) return; // Target panel not found

      const targetPanel = updatedPanels[targetPanelIndex];
      const overWidgetIndex = targetPanel.widgets.findIndex((w) => w.id === overWidget.id);

      // If the widget is moving within the SAME panel
      if (currentPanelId === targetPanel.id) {
        // Use arrayMove to reorder widgets within the same panel
        const newWidgets = arrayMove(
          targetPanel.widgets,
          currentWidgetIndex, // from index
          overWidgetIndex // to index
        );

        // Update the panel with the reordered widgets
        updatedPanels = updatedPanels.map((panel, index) => {
          if (index === targetPanelIndex) {
            return {
              ...panel,
              widgets: newWidgets,
            };
          }
          return panel;
        });
      } else {
        // If the widget is moving between DIFFERENT panels (widget to widget drop)
        // Remove activeWidget from its original panel if it was there
        if (currentPanelId && currentPanelIndex !== -1) {
          updatedPanels = updatedPanels.map((panel, index) => {
            if (index === currentPanelIndex) {
              return {
                ...panel,
                widgets: panel.widgets.filter((w) => w.id !== activeWidget.id),
              };
            }
            return panel;
          });
        }

        // Add the activeWidget to the target panel at the overWidget's position
        updatedPanels = updatedPanels.map((panel, index) => {
          if (index === targetPanelIndex) {
            const newWidgets = [...panel.widgets];
            // Ensure activeWidget is not already in this specific spot
            if (!newWidgets.some((w) => w.id === activeWidget.id)) {
              newWidgets.splice(overWidgetIndex, 0, activeWidget);
            }
            return {
              ...panel,
              widgets: newWidgets,
            };
          }
          return panel;
        });
      }
    }

    const newBuilderConfig = {
      ...builderConfig,
      interface: updatedPanels,
    };

    // Only update if the configuration has actually changed
    if (JSON.stringify(newBuilderConfig) !== JSON.stringify(project.builder_config)) {
      handleProjectUpdate("builder_config", newBuilderConfig, false);
      if (selectedBuilderItem?.id !== activeWidget?.id) {
        // Set activeWidget (new ones) to selectedBuilderItem
        dispatch(setSelectedBuilderItem(activeWidget));
      }
    }
  };

  return (
    <>
      <JobStatusWatcher onSuccess={handleJobSuccess} />
      {isLoading && <LoadingPage />}
      {!isLoading && !hasError && project && (
        <MapProvider>
          <StyleStoresProvider>
            <DrawProvider>
              <MeasureProvider>
                <Stack component="div" width="100%" height="100%" overflow="hidden">
                  {isProjectEditor && (
                    <>
                      <MapDropTarget projectId={projectId} />
                      <TransferToasts />
                    </>
                  )}
                  <Header
                    showHambugerMenu={false}
                    mapHeader={true}
                    project={project}
                    onProjectUpdate={handleProjectUpdate}
                    viewOnly={!isProjectEditor}
                  />
                  <Box
                    sx={{
                      display: "flex",
                      flex: 1,
                      minHeight: 0,
                      width: "100%",
                      [theme.breakpoints.down("sm")]: {
                        marginLeft: "0",
                        width: `100%`,
                      },
                    }}>
                    <DndContext
                      onDragOver={handleDragOver}
                      onDragStart={handleDragStart}
                      onDragEnd={handleDragEnd}
                      autoScroll>
                      {mapMode === "data" && (
                        <DataProjectLayout project={project} onProjectUpdate={handleProjectUpdate} />
                      )}
                      {mapMode === "reports" && (
                        <ReportsLayout
                          project={project}
                          projectLayers={reportLayers}
                          onProjectUpdate={handleProjectUpdate}
                          initialLayoutId={layoutId}
                        />
                      )}
                      {mapMode === "workflows" && (
                        <WorkflowsLayout
                          project={project}
                          projectLayers={allProjectLayersIncludingTables}
                          projectLayerGroups={projectLayerGroups}
                          onProjectUpdate={handleProjectUpdate}
                        />
                      )}
                      {mapMode !== "reports" && mapMode !== "workflows" && (
                        <Box
                          sx={{
                            display: "flex",
                            flexDirection: "column",
                            padding: mapMode === "builder" ? "20px" : "0",
                            width: "100%",
                            height: "100%",
                            position: "relative",
                          }}>
                          <Box sx={{ flex: 1, minHeight: 0, position: "relative" }}>
                            <ThemeProvider theme={mapMode === "builder" ? brandedTheme : theme}>
                              <EditingMapViewer
                                projectId={projectId}
                                containerSx={{ zIndex: 0 }}
                                layers={mapLayers}
                                locale={projectMap?.map.locale}
                                mapRef={mapRef}
                                maxExtent={project?.max_extent || undefined}
                                initialViewState={{
                                  zoom: urlLoc?.zoom ?? initialView?.zoom ?? 3,
                                  latitude: urlLoc?.latitude ?? initialView?.latitude ?? 48.13,
                                  longitude: urlLoc?.longitude ?? initialView?.longitude ?? 11.57,
                                  pitch: urlLoc?.pitch ?? initialView?.pitch ?? 0,
                                  bearing: urlLoc?.bearing ?? initialView?.bearing ?? 0,
                                  fitBoundsOptions: {
                                    minZoom: initialView?.min_zoom ?? 0,
                                    maxZoom: initialView?.max_zoom ?? 24,
                                  },
                                }}
                                mapStyle={mapStyle}
                                onMoveEnd={handleMoveEnd}
                                onLoad={handleMapLoaded}
                                isEditor={isProjectEditor}
                              />
                            </ThemeProvider>
                            {!explorerActive && (
                              <>
                                <DataPanel
                                  projectLayers={allProjectLayersIncludingTables}
                                  isEditor={isProjectEditor}
                                />
                                <EditModeHalo />
                              </>
                            )}
                          </Box>
                          {mapMode === "builder" && (
                            <Box
                              sx={{
                                position: "absolute",
                                inset: "20px",
                                zIndex: 1,
                                pointerEvents: "none",
                              }}>
                              <ThemeProvider theme={brandedTheme}>
                                <GlobalStyles
                                  styles={{
                                    "html body .goat-dashboard-preview ::-webkit-scrollbar-thumb": {
                                      backgroundColor: brandedTheme.palette.grey[400],
                                    },
                                    "html body .goat-dashboard-preview ::-webkit-scrollbar-track": {
                                      background: "transparent",
                                    },
                                  }}
                                />
                                <Box
                                  className="goat-dashboard-preview"
                                  sx={{ color: "text.primary", height: "100%", width: "100%" }}>
                                  <PublicProjectLayout
                                    projectLayers={widgetProjectLayers}
                                    mapLayers={mapLayers}
                                    projectLayerGroups={projectLayerGroups}
                                    project={project}
                                    onProjectUpdate={handleProjectUpdate}
                                  />
                                </Box>
                              </ThemeProvider>
                            </Box>
                          )}
                        </Box>
                      )}
                      {mapMode === "builder" && (
                        <BuilderConfigPanel
                          project={project}
                          onProjectUpdate={handleProjectUpdate}
                          projectLayers={allProjectLayersIncludingTables}
                          projectLayerGroups={projectLayerGroups}
                        />
                      )}

                      {mapMode === "builder" && (
                        <DragOverlay
                          dropAnimation={null}
                          modifiers={[createSnapToCursorModifier("topCenter")]}>
                          {activeWidget?.config?.type ? (
                            <DraggableItem widgetType={activeWidget?.config?.type} isDragging={true} />
                          ) : null}
                        </DragOverlay>
                      )}
                    </DndContext>
                  </Box>
                </Stack>
              </MeasureProvider>
            </DrawProvider>
          </StyleStoresProvider>
        </MapProvider>
      )}
    </>
  );
}
