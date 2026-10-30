import { Box, Stack } from "@mui/material";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { useFolders } from "@/lib/api/folders";
import {
  addProjectLayers,
  createProjectLayerGroup,
  deleteProjectLayerGroup,
  updateProjectLayerGroup,
  updateProjectLayerTree,
  useProjectLayerGroups,
  useProjectLayers,
} from "@/lib/api/projects";
import { SYSTEM_LAYERS_IDS } from "@/lib/constants";
import { DEFAULT_BASEMAP } from "@/lib/constants/basemaps";
import { setSelectedLayers } from "@/lib/store/layer/slice";
import { setActiveRightPanel } from "@/lib/store/map/slice";
import type { CustomBasemap, Project, ProjectLayerTreeUpdate } from "@/lib/validations/project";

import { MapSidebarItemID } from "@/types/map/common";

import { useAuthZ } from "@/hooks/auth/AuthZ";
import { useBasemap } from "@/hooks/map/MapHooks";
import { useCustomBasemapMutations } from "@/hooks/map/useCustomBasemapMutations";
import { useMeasureTool } from "@/hooks/map/useMeasureTool";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { FloatingPanel } from "@/components/common/FloatingPanel";
import { ExplorerBottomBar } from "@/components/explorer/ExplorerBottomBar";
import { ExplorerProvider } from "@/components/explorer/ExplorerContext";
import { EXPLORER_PANEL_WIDTH, ExplorerLeftPanel } from "@/components/explorer/ExplorerLeftPanel";
import { ExplorerRightPanel } from "@/components/explorer/right/ExplorerRightPanel";
import { EXPLORER_RIGHT_PANEL_WIDTH, useRightPanelWidth } from "@/components/explorer/right/panelSize";
import { STRIP_TOP } from "@/components/explorer/strip/stripLayout";
import AttributionControl from "@/components/map/controls/Attribution";
import { BasemapSelector } from "@/components/map/controls/BasemapSelector";
import { CustomBasemapDialog } from "@/components/map/controls/CustomBasemapDialog";
import { Fullscren } from "@/components/map/controls/Fullscreen";
import Scalebar from "@/components/map/controls/Scalebar";
import { Toolbox as ToolboxCtrl } from "@/components/map/controls/Toolbox";
import { Zoom } from "@/components/map/controls/Zoom";
import { MeasureButton, MeasureResultsPanel } from "@/components/map/controls/measure";
import SearchControl from "@/components/map/controls/search/SearchControl";
import { useEditorSearchLayers } from "@/components/map/controls/search/editorSearchLayers";
import { DATA_PANEL_HEIGHT_CONSUMER_ATTR, DATA_PANEL_HEIGHT_VAR } from "@/components/map/panels/DataPanel";
import FeatureEditPanel from "@/components/map/panels/FeatureEditPanel";
import BundleSettingsPanel from "@/components/map/panels/bundle/BundleSettingsPanel";
import LayerSettingsPanel from "@/components/map/panels/layer/LayerSettingsPanel";
import { ProjectLayerTree } from "@/components/map/panels/layer/ProjectLayerTree";
import Toolbox from "@/components/map/panels/toolbox/CombinedToolbox";
import { MapFixedPopupSlot } from "@/components/map/popover/MapFixedPopupSlot";

const toolbarHeight = 52;
const panelWidth = 300;
const GAP_SIZE = 16;
/** The room the Explorer leaves under its left panel and bottom bar, whose
 * bottoms line up: the scale bar sits in it under the panel (EXPLORER_FOOT_GAP
 * below it) and the map credits under the bar, neither covered. */
const EXPLORER_FOOT = 30;
/** The round map controls' column (zoom, fullscreen, basemap), and how much
 * higher they sit in the Explorer to end on its panels' line: their stack
 * otherwise ends 8 px lower, on the credits. */
const MAP_CONTROLS_WIDTH = 40;
const EXPLORER_CONTROLS_LIFT = 8;
const EXPLORER_FOOT_GAP = 8;
/** The Explorer's bottom bar from the left panel: the same 8 px as the cost
 * card under it. */
const EXPLORER_BAR_GAP = 8;

interface DataProjectLayoutProps {
  project: Project;
  isPublic?: boolean;
  // Accepts (key, value, refresh?) or (partial, refresh?) — see handleProjectUpdate in app/map/[projectId]/page.tsx.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onProjectUpdate?: (keyOrPartial: any, valueOrRefresh?: any, refresh?: boolean) => void;
}

const DataProjectLayout = ({ project, onProjectUpdate }: DataProjectLayoutProps) => {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const projectId = project.id;

  // Measure tool - using the reusable hook
  const measureTool = useMeasureTool();

  // Fetch project data with SWR
  const { layers: allProjectLayers, mutate: mutateProjectLayers } = useProjectLayers(projectId);
  const { layerGroups: projectLayerGroups, mutate: mutateProjectLayerGroups } =
    useProjectLayerGroups(projectId);

  // Filter out system layers
  const projectLayers = useMemo(() => {
    return allProjectLayers?.filter((layer) => !SYSTEM_LAYERS_IDS.includes(layer.layer_id)) || [];
  }, [allProjectLayers]);

  // Queryables for the search scope are only fetched once the control is opened.
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [searchPanelOpen, setSearchPanelOpen] = useState(false);
  const { searchLayers, layersById: searchLayersById } = useEditorSearchLayers(projectLayers, searchExpanded);
  const searchSource = useMemo(
    () => ({ mode: "editor" as const, placesEnabled: true as const, layers: searchLayers }),
    [searchLayers]
  );

  const { translatedBaseMaps, activeBasemap, setActiveBasemap } = useBasemap(project);
  // When editing a non-active basemap we preview it ephemerally (Redux only, no
  // persist); this remembers what to restore when the dialog closes.
  const basemapBeforeEdit = useRef<string | null>(null);

  const { addCustomBasemap, editCustomBasemap, deleteCustomBasemap } = useCustomBasemapMutations(
    project,
    onProjectUpdate
  );

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CustomBasemap | null>(null);

  const activeRight = useAppSelector((state) => state.map.activeRightPanel);
  // The PT network Explorer takes over the panels (docs/pt-network-editor).
  const explorerActive = useAppSelector((state) => state.explorer.active);
  const explorerBundleId = useAppSelector((state) => state.explorer.bundleId);
  const leftWidth = explorerActive ? EXPLORER_PANEL_WIDTH : panelWidth;
  // The Explorer's right panel (or its rail) takes the map's right edge; the
  // map controls and the bottom bar move left of it.
  const explorerRight = useRightPanelWidth();
  const explorerRightRoom = explorerRight ? explorerRight + GAP_SIZE : 0;
  const featureEditorActive = useAppSelector((state) => state.featureEditor.activeLayerId);
  const selectedBundleId = useAppSelector((state) => state.layers.selectedBundleId);
  const featureEditorActiveFeature = useAppSelector((state) => state.featureEditor.activeFeatureId);
  // Only when there is a feature to edit. Draw mode alone is not enough: with no
  // active feature every field renders empty, typing is a no-op and Done is
  // disabled, so the panel would sit there dead — before the first feature is
  // drawn, and again after Done returns to draw mode for the next one. Draw
  // mode has its own indicator.
  const showFeatureEditPanel = !!featureEditorActive && !!featureEditorActiveFeature;
  // Panel height is read via CSS variable --data-panel-height for real-time updates
  const isDataPanelOpen = useAppSelector((state) => state.map.isDataPanelOpen);
  const mapMode = useAppSelector((state) => state.map.mapMode);
  const dataPanelVisible = mapMode === "data" && isDataPanelOpen;
  const { isOrgEditor } = useAuthZ();
  const { folders } = useFolders({});
  const projectFolder = useMemo(
    () => (project.folder_id && folders ? folders.find((f) => f.id === project.folder_id) : undefined),
    [folders, project.folder_id]
  );
  const isProjectEditor = useMemo(() => {
    // my_role from the single GET endpoint is authoritative when present
    if (project.my_role) {
      return project.my_role === "project-owner" || project.my_role === "project-editor";
    }
    // Folder grant fallback (e.g. shared via folder, not individual project share)
    if (projectFolder) {
      if (projectFolder.is_owned) return true;
      if (projectFolder.role === "folder-editor") return true;
      if (projectFolder.role === "folder-viewer") return false;
    }
    return isOrgEditor;
  }, [project.my_role, projectFolder, isOrgEditor]);

  // 1. Redux Global Selection
  // Assume array of IDs (number/string)
  const selectedLayerIds = useAppSelector((state) => state.layers.selectedLayerIds || []);

  const handleLayerDuplicate = async (layerId: string) => {
    try {
      await addProjectLayers(projectId, [layerId]);
      mutateProjectLayers();
    } catch (error) {
      toast.error(t("error_duplicating_layer"));
      throw error;
    }
  };

  // Wrapper functions to match ProjectLayerTree expectations
  const handleCreateGroup = async (groupData: { name: string; parent_id?: number }) => {
    await createProjectLayerGroup(projectId, groupData);
    if (projectLayerGroups) {
      mutateProjectLayerGroups();
    }
  };

  const handleUpdateGroup = async (groupData: { name?: string; groupId?: number }) => {
    if (groupData.groupId && groupData.name) {
      await updateProjectLayerGroup(projectId, groupData.groupId, { name: groupData.name });
      if (projectLayerGroups) {
        mutateProjectLayerGroups();
      }
    }
  };

  const handleDeleteGroup = async (groupData: { groupId?: number }) => {
    if (groupData.groupId) {
      await deleteProjectLayerGroup(projectId, groupData.groupId);
      mutateProjectLayerGroups();
      mutateProjectLayers();
    }
  };

  // Unified tree update handler - handles all tree changes
  const handleTreeUpdate = async (updatePayload: ProjectLayerTreeUpdate) => {
    try {
      // First, do optimistic updates to both caches to prevent visual flicker
      if (allProjectLayers) {
        // Update layers with new order, parent relationships, and properties
        const updatedLayers = allProjectLayers.map((layer) => {
          const updateItem = updatePayload.items.find(
            (item) => item.id === layer.id && item.type === "layer"
          );
          if (updateItem) {
            return {
              ...layer,
              order: updateItem.order,
              layer_project_group_id: updateItem.parent_id || null,
              // Update properties if provided (includes legend.collapsed, visibility, etc.)
              properties: updateItem.properties
                ? { ...layer.properties, ...updateItem.properties }
                : layer.properties,
            };
          }
          return layer;
        });
        mutateProjectLayers(updatedLayers, false);
      }

      if (projectLayerGroups) {
        // Update groups with new order, parent relationships, and properties
        const updatedGroups = projectLayerGroups.map((group) => {
          const updateItem = updatePayload.items.find(
            (item) => item.id === group.id && item.type === "group"
          );
          if (updateItem) {
            return {
              ...group,
              order: updateItem.order,
              parent_id: updateItem.parent_id || null,
              // Update properties if provided (includes expanded, visibility, etc.)
              properties: updateItem.properties
                ? { ...group.properties, ...updateItem.properties }
                : group.properties,
            };
          }
          return group;
        });
        mutateProjectLayerGroups(updatedGroups, false);
      }

      // Then sync with server using the batch update endpoint
      await updateProjectLayerTree(projectId, updatePayload);
    } catch (error) {
      console.error("Failed to update tree", error);
      toast.error(t("error_updating_tree"));

      // Revert optimistic updates on error by refreshing from server
      mutateProjectLayers();
      mutateProjectLayerGroups();
    }
  };

  const rightSidebar = {
    topItems: [
      {
        id: MapSidebarItemID.TOOLBOX,
        icon: ICON_NAME.TOOLBOX,
        name: t("tools"),
        component: <Toolbox />,
      },
    ],
  };

  // --- DYNAMIC CONTENT ---
  const activeRightComponent = useMemo(() => {
    // Check for ANY layer configuration panel ID
    const layerSettingsIds = [MapSidebarItemID.PROPERTIES, MapSidebarItemID.FILTER, MapSidebarItemID.STYLE];

    // A bundle is selected instead of a layer: same panel slot, its own panel.
    if (activeRight && layerSettingsIds.includes(activeRight) && selectedBundleId) {
      return <BundleSettingsPanel projectId={projectId} />;
    }
    if (activeRight && layerSettingsIds.includes(activeRight)) {
      // Return the new panel component
      return <LayerSettingsPanel projectId={projectId} projectLayers={projectLayers || []} />;
    }

    // B. STANDARD TOOLS
    return rightSidebar.topItems?.find((item) => item.id === activeRight)?.component;
  }, [activeRight, rightSidebar.topItems, projectId, projectLayers, selectedBundleId]);

  // --- INTERACTION LOGIC ---

  const handleToolboxToggle = async (open: boolean) => {
    if (open) {
      dispatch(setActiveRightPanel(MapSidebarItemID.TOOLBOX));
      dispatch(setSelectedLayers([])); // Clear tree
    } else {
      dispatch(setActiveRightPanel(undefined));
    }
  };

  // Keep Panel state consistent
  useEffect(() => {
    const layerSettingsIds = [MapSidebarItemID.PROPERTIES, MapSidebarItemID.FILTER, MapSidebarItemID.STYLE];
    const hasSelectedLayers = selectedLayerIds.length > 0;
    const hasValidSelectedLayer = selectedLayerIds.some((selectedId) =>
      projectLayers.some((layer) => layer.id === selectedId)
    );

    // A bundle occupies the same panel slot but is selected as a group, so it
    // has no entry in selectedLayerIds — without this it would be treated as
    // "nothing selected" and the panel closed the instant it opened.
    if (
      layerSettingsIds.includes(activeRight as MapSidebarItemID) &&
      !selectedBundleId &&
      (!hasSelectedLayers || !hasValidSelectedLayer)
    ) {
      dispatch(setSelectedLayers([]));
      dispatch(setActiveRightPanel(undefined));
    }
  }, [activeRight, selectedLayerIds, projectLayers, selectedBundleId, dispatch]);

  // Width occupied by the right-side stack (measure results, feature
  // editor panel, active right component). Used to size the fixed-popup
  // host below so it doesn't extend behind the panels.
  const measureVisible = measureTool.measureOpen || measureTool.measurements.length > 0;
  const rightStackWidth = useMemo(() => {
    const FEATURE_EDIT_PANEL_WIDTH = 320;
    const MEASURE_PANEL_WIDTH = 320;
    const widths: number[] = [];
    if (measureVisible) widths.push(MEASURE_PANEL_WIDTH);
    if (showFeatureEditPanel) widths.push(FEATURE_EDIT_PANEL_WIDTH);
    if (activeRight) widths.push(panelWidth);
    if (widths.length === 0) return 0;
    return widths.reduce((a, b) => a + b, 0) + GAP_SIZE * (widths.length - 1);
  }, [measureVisible, showFeatureEditPanel, activeRight]);

  const layerTree = (
    <ProjectLayerTree
      projectId={projectId}
      projectLayers={projectLayers || []}
      projectLayerGroups={projectLayerGroups || []}
      isLoading={false}
      onTreeUpdate={handleTreeUpdate}
      onLayerDuplicate={handleLayerDuplicate}
      onCreateGroup={handleCreateGroup}
      onUpdateGroup={handleUpdateGroup}
      onDeleteGroup={handleDeleteGroup}
      viewMode={isProjectEditor ? "edit" : "view"}
      projectOwnerId={project.owned_by?.id}
    />
  );
  // The right-hand panels belong to the data view, not the Explorer.
  const rightComponent = explorerActive ? undefined : activeRightComponent;
  const showFeaturePanel = !explorerActive && showFeatureEditPanel;

  const layout = (
    <>
      {/* The 10px margin to the map's edge is padding, not an offset: the
          column clips what overflows it, and a panel flush with the clip edge
          has its shadow cut square at the rounded corners. */}
      <Box
        {...{ [DATA_PANEL_HEIGHT_CONSUMER_ATTR]: "" }}
        sx={{
          position: "absolute",
          top: toolbarHeight,
          height: `calc(100% - ${toolbarHeight}px - var(${DATA_PANEL_HEIGHT_VAR}, 0px))`,
          left: 0,
          zIndex: (theme) => theme.zIndex.drawer + 1,
          pointerEvents: "none",
        }}>
        <Stack
          direction="column"
          sx={{
            height: "100%",
            boxSizing: "border-box",
            p: "10px",
            alignItems: "flex-start",
            flexWrap: "wrap",
            alignContent: "flex-start",
            rowGap: explorerActive ? `${EXPLORER_FOOT_GAP}px` : 4,
            columnGap: 2,
            overflow: "hidden",
          }}>
          {explorerActive ? (
            <Box sx={{ height: `calc(100% - ${EXPLORER_FOOT}px)`, flexShrink: 0 }}>
              <ExplorerLeftPanel layersTab={layerTree} />
            </Box>
          ) : (
            <FloatingPanel width={panelWidth} maxHeight="100%">
              {layerTree}
            </FloatingPanel>
          )}
          <Box sx={{ marginTop: "auto" }}>
            <Scalebar />
          </Box>
        </Stack>
        <Box
          // The Explorer's bottom panel grows up to just under these tools.
          {...{ [STRIP_TOP]: "" }}
          sx={{
            position: "absolute",
            left: `${leftWidth + GAP_SIZE + 10}px`,
            top: 10,
          }}>
          <SearchControl
            source={searchSource}
            layersById={searchLayersById}
            bbox={project?.max_extent ?? undefined}
            onExpandedChange={setSearchExpanded}
            onPanelOpenChange={setSearchPanelOpen}
          />
          {/* The results card is translucent and grows over this stack, so the
              buttons below it step aside while it is open. */}
          {!searchPanelOpen && (
            <>
              {isProjectEditor && !explorerActive && (
                <ToolboxCtrl onToggle={handleToolboxToggle} open={activeRight === MapSidebarItemID.TOOLBOX} />
              )}
              <MeasureButton {...measureTool} />
            </>
          )}
        </Box>
      </Box>

      {/* RIGHT OVERLAY */}
      <Stack
        {...{ [DATA_PANEL_HEIGHT_CONSUMER_ATTR]: "" }}
        direction="column"
        sx={{
          position: "absolute",
          top: toolbarHeight + 10,
          height: `calc(100% - ${toolbarHeight + 20}px - var(${DATA_PANEL_HEIGHT_VAR}, 0px))`,
          right:
            dataPanelVisible && activeRightComponent
              ? `${panelWidth + GAP_SIZE + 10}px`
              : explorerActive
                ? 10 + explorerRightRoom
                : 10,
          zIndex: (theme) => theme.zIndex.drawer + 1,
          pointerEvents: "none",
          alignItems: "flex-end",
        }}>
        {!dataPanelVisible && (
          <Stack
            direction="row"
            spacing={2}
            sx={{
              alignItems: "flex-start",
              flex: 1,
              minHeight: 0,
              overflow: "hidden",
            }}>
            <MeasureResultsPanel {...measureTool} />
            {showFeaturePanel && (
              <FloatingPanel width={320} maxHeight="100%" fillHeight>
                <FeatureEditPanel />
              </FloatingPanel>
            )}
            {rightComponent && (
              <FloatingPanel width={panelWidth} maxHeight="100%" fillHeight>
                {rightComponent}
              </FloatingPanel>
            )}
          </Stack>
        )}
        <Stack
          direction="column"
          alignItems="flex-end"
          sx={{
            mt: dataPanelVisible ? "auto" : 2,
            flexShrink: 0,
            pointerEvents: "none",
          }}>
          {/* In the Explorer the controls end on the panels' and the bar's
              line, EXPLORER_FOOT above the map's edge. */}
          <Stack
            direction="column"
            alignItems="flex-end"
            sx={{ mb: explorerActive ? `${EXPLORER_CONTROLS_LIFT + 4}px` : 1 }}>
            <Zoom tooltipZoomIn={t("zoom_in")} tooltipZoomOut={t("zoom_out")} />
            <Fullscren tooltipOpen={t("fullscreen")} tooltipExit={t("exit_fullscreen")} />
            <BasemapSelector
              styles={translatedBaseMaps}
              active={activeBasemap.value}
              editable
              basemapChange={async (basemap) => {
                await onProjectUpdate?.("basemap", basemap);
              }}
              onAdd={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
              onEdit={(id) => {
                const target =
                  (project?.custom_basemaps as CustomBasemap[] | undefined)?.find((c) => c.id === id) ?? null;
                if (target && project?.basemap !== id) {
                  // Ephemeral preview only — reverted on close, never persisted.
                  basemapBeforeEdit.current = project?.basemap ?? DEFAULT_BASEMAP;
                  setActiveBasemap(id);
                }
                setEditing(target);
                setDialogOpen(true);
              }}
            />
          </Stack>
          {/* -10px cancels the right-overlay's 10px bottom inset (height: calc(100% - toolbarHeight - 20px) at top: toolbarHeight+10) so the strip sits flush to the map's bottom edge. */}
          <Box sx={{ mb: "-10px" }}>
            <AttributionControl
              extraAttribution={activeBasemap.source === "custom" ? activeBasemap.attribution : null}
            />
          </Box>
        </Stack>
      </Stack>
      {/* Right panel + measure results — rendered separately when data panel is open so controls can be to the left */}
      {dataPanelVisible && (
        <Box
          {...{ [DATA_PANEL_HEIGHT_CONSUMER_ATTR]: "" }}
          sx={{
            position: "absolute",
            top: toolbarHeight + 10,
            height: `calc(100% - ${toolbarHeight + 20}px - var(${DATA_PANEL_HEIGHT_VAR}, 0px))`,
            right: 10,
            zIndex: (theme) => theme.zIndex.drawer + 1,
            pointerEvents: "none",
          }}>
          <Stack
            direction="row"
            spacing={2}
            sx={{ alignItems: "flex-start", height: "100%", overflow: "hidden" }}>
            <MeasureResultsPanel {...measureTool} />
            {showFeaturePanel && (
              <FloatingPanel width={320} maxHeight="100%" fillHeight>
                <FeatureEditPanel />
              </FloatingPanel>
            )}
            {rightComponent && (
              <FloatingPanel width={panelWidth} maxHeight="100%" fillHeight>
                {rightComponent}
              </FloatingPanel>
            )}
          </Stack>
        </Box>
      )}
      {/* Host for fixed-anchor feature popups. Sized to the visible map
          content area — top: below the app toolbar, bottom: above the
          data panel, left: past the always-mounted layer tree, right:
          past whichever right-side panels are open. PopupFixedHost
          positions its content to one of this Box's 4 corners, so the
          popup naturally respects the layout's chrome without any
          global offsets or portals. Same pattern as the top-left
          controls (Geocoder / ToolboxCtrl / MeasureButton). */}
      <Box
        {...{ [DATA_PANEL_HEIGHT_CONSUMER_ATTR]: "" }}
        sx={{
          position: "absolute",
          top: toolbarHeight + 10,
          left: leftWidth + GAP_SIZE + 10,
          right: (rightStackWidth ? rightStackWidth + GAP_SIZE : 0) + 10,
          bottom: `calc(10px + var(${DATA_PANEL_HEIGHT_VAR}, 0px))`,
          pointerEvents: "none",
          // Above layout controls (drawer + 1), so a popup at the top-left
          // corner correctly stacks on top of the Geocoder/Toolbox/Measure
          // button column.
          zIndex: (theme) => theme.zIndex.drawer + 2,
        }}>
        <MapFixedPopupSlot layers={projectLayers} />
      </Box>
      {explorerActive && explorerRight > 0 && (
        // As high as the left panel, ending at the same foot: the credits run
        // below the bar, clear of it.
        <Box
          sx={{
            position: "absolute",
            top: toolbarHeight + 10,
            bottom: 10 + EXPLORER_FOOT,
            right: 10,
            zIndex: (theme) => theme.zIndex.drawer + 1,
          }}>
          <ExplorerRightPanel />
        </Box>
      )}
      {explorerActive && (
        <Box
          sx={{
            position: "absolute",
            // On one line with the left panel's foot: the credits run below it.
            bottom: 10 + EXPLORER_FOOT,
            left: leftWidth + EXPLORER_BAR_GAP + 10,
            // To the map controls' column, the map's usual gap from it: the
            // bar spans the map (board 3).
            right: 10 + MAP_CONTROLS_WIDTH + GAP_SIZE + explorerRightRoom,
            zIndex: (theme) => theme.zIndex.drawer + 1,
            // Making room for the right panel eases in (spec › Motion).
            transition: "right 180ms ease-out",
            "@media (prefers-reduced-motion: reduce)": { transition: "none" },
          }}>
          {/* Squeezed by the right panel, the bar goes compact (spec). */}
          <ExplorerBottomBar compact={explorerRight === EXPLORER_RIGHT_PANEL_WIDTH} />
        </Box>
      )}
      <CustomBasemapDialog
        open={dialogOpen}
        initial={editing}
        projectLayers={projectLayers}
        onClose={() => {
          setDialogOpen(false);
          if (basemapBeforeEdit.current !== null) {
            setActiveBasemap(basemapBeforeEdit.current);
            basemapBeforeEdit.current = null;
          }
        }}
        onSubmit={async (payload) => {
          if (editing) {
            await editCustomBasemap(editing.id, payload);
          } else {
            await addCustomBasemap(payload, /* selectAfterAdd */ true);
          }
        }}
        onDelete={
          editing
            ? async () => {
                await deleteCustomBasemap(editing.id, DEFAULT_BASEMAP);
              }
            : undefined
        }
      />
    </>
  );

  return explorerActive && explorerBundleId ? (
    <ExplorerProvider bundleId={explorerBundleId}>{layout}</ExplorerProvider>
  ) : (
    layout
  );
};

export default DataProjectLayout;
