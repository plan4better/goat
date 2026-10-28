import LayersIcon from "@mui/icons-material/Layers";
import { Box, Stack, Tab, Tabs, Typography } from "@mui/material";
import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useProjectMap } from "@/lib/api/map";
import { useFeatureCount } from "@/lib/api/processes";
import { setSelectedLayers } from "@/lib/store/layer/slice";
import { setActiveRightPanel } from "@/lib/store/map/slice";
import type { Geometry } from "@/lib/style/compile/types";
import { sourceOf } from "@/lib/style/layerSource";
import { canSetDefaultStyle } from "@/lib/utils/layerPermissions";

import { MapSidebarItemID } from "@/types/map/common";

import { useLazyTabs } from "@/hooks/map/useLazyTabs";
import type { MapLayer } from "@/hooks/map/useMapLayers";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";
import { useLayerStyle } from "@/hooks/style/useLayerStyle";

import Container from "@/components/map/panels/Container";
import FilterImpl from "@/components/map/panels/filter/Filter";
import PropertiesPanelImpl from "@/components/map/panels/properties/Properties";
import { NamedStyles } from "@/components/map/panels/styleEditor/NamedStyles";
import { ProjectStylePanel } from "@/components/map/panels/styleEditor/ProjectStylePanel";
import { type EditorLayer, StyleHeader } from "@/components/map/panels/styleEditor/StyleEditor";

// Tab switches flip local state in this component; without memo every switch
// re-renders all mounted tab trees (~500ms of render work in dev). The trees
// read live state from redux/SWR internally, so blocking parent-driven renders
// loses nothing.
const Filter = React.memo(FilterImpl);
const PropertiesPanel = React.memo(PropertiesPanelImpl);

interface LayerSettingsPanelProps {
  projectId: string;
  /** The map's layers: the Style tab edits the active style of the selected one. */
  projectLayers?: MapLayer[];
}

// Helper function to get max tab index for layer type
const getMaxTabIndex = (layerType: string | undefined): number => {
  if (layerType === "raster" || layerType === "table") return 1; // 0, 1
  return 2; // 0, 1, 2
};

// Helper function to clamp tab value
const clampTabValue = (value: number, layerType: string | undefined): number => {
  const max = getMaxTabIndex(layerType);
  return Math.max(0, Math.min(value, max));
};

// 1. Helper function to map Redux ID to Tab Index
const getTabFromPanelId = (panelId: string | undefined, layerType: string | undefined): number => {
  if (layerType === "raster") {
    // Only Style (0) and Metadata (1)
    if (panelId === MapSidebarItemID.PROPERTIES) return 1;
    if (panelId === MapSidebarItemID.STYLE) return 0;
    return 0; // Default to Style for raster
  }
  if (layerType === "table") {
    // Only Filter (0) and Metadata (1)
    if (panelId === MapSidebarItemID.PROPERTIES) return 1;
    if (panelId === MapSidebarItemID.FILTER) return 0;
    return 0; // Default to Filter for table
  }
  // Default: vector (Style, Filter, Metadata)
  if (panelId === MapSidebarItemID.FILTER) return 1;
  if (panelId === MapSidebarItemID.PROPERTIES) return 2;
  if (panelId === MapSidebarItemID.STYLE) return 0;
  return 0; // Default to Style for vector
};

const LayerSettingsPanel = ({ projectId, projectLayers = [] }: LayerSettingsPanelProps) => {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();

  const activeRightPanel = useAppSelector((state) => state.map.activeRightPanel);
  const selectedLayerIds = useAppSelector((state) => state.layers.selectedLayerIds || []);

  const activeLayer = useMemo(() => {
    if (selectedLayerIds.length === 1) {
      return projectLayers.find((l) => l.id === selectedLayerIds[0]);
    }
    return null;
  }, [selectedLayerIds, projectLayers]);

  const layerType = activeLayer?.type;
  const store = useLayerStyle(projectId, layerType === "table" ? undefined : (activeLayer ?? undefined));
  const { setLayerState, mutate } = useProjectMap(projectId);
  const { featureCount } = useFeatureCount(activeLayer?.layer_id ?? undefined);
  const editorLayer = useMemo<EditorLayer>(() => {
    const g = activeLayer?.feature_layer_geometry_type?.toLowerCase();
    const geometry = (g === "point" || g === "line" || g === "polygon" ? g : undefined) as
      | Geometry
      | undefined;
    const source = activeLayer ? sourceOf(activeLayer) : undefined;
    const kind: EditorLayer["kind"] =
      activeLayer?.type !== "raster" ? "vector" : source?.kind === "cog" ? "raster" : "service";
    return {
      id: String(activeLayer?.id ?? ""),
      name: activeLayer?.name ?? t("layer_settings"),
      geometry,
      kind,
    };
  }, [activeLayer, t]);

  const [activeTab, setActiveTab] = useState(() =>
    clampTabValue(getTabFromPanelId(activeRightPanel, layerType), layerType)
  );

  // 3. Keep syncing if Redux changes while panel is open
  useEffect(() => {
    const newTab = clampTabValue(getTabFromPanelId(activeRightPanel, layerType), layerType);
    setActiveTab(newTab);
  }, [activeRightPanel, layerType]);

  const isTabLive = useLazyTabs(activeTab, activeLayer?.id);

  const handleClose = () => {
    dispatch(setSelectedLayers([]));
    dispatch(setActiveRightPanel(undefined));
  };

  // Manual Tab Click Logic
  const handleTabChange = (newValue: number) => {
    setActiveTab(newValue);
    if (layerType === "raster") {
      // 0: Style, 1: Metadata
      if (newValue === 0) dispatch(setActiveRightPanel(MapSidebarItemID.STYLE));
      if (newValue === 1) dispatch(setActiveRightPanel(MapSidebarItemID.PROPERTIES));
    } else if (layerType === "table") {
      // 0: Filter, 1: Metadata
      if (newValue === 0) dispatch(setActiveRightPanel(MapSidebarItemID.FILTER));
      if (newValue === 1) dispatch(setActiveRightPanel(MapSidebarItemID.PROPERTIES));
    } else {
      // vector: 0: Style, 1: Filter, 2: Metadata
      if (newValue === 0) dispatch(setActiveRightPanel(MapSidebarItemID.STYLE));
      if (newValue === 1) dispatch(setActiveRightPanel(MapSidebarItemID.FILTER));
      if (newValue === 2) dispatch(setActiveRightPanel(MapSidebarItemID.PROPERTIES));
    }
  };

  const renderContent = () => {
    // ... (Multi selection logic same as before)
    if (selectedLayerIds.length > 1) {
      return (
        <Stack
          alignItems="center"
          justifyContent="center"
          spacing={2}
          sx={{ height: "100%", p: 4, textAlign: "center", color: "text.secondary" }}>
          <LayersIcon sx={{ fontSize: 48, color: "action.active" }} />
          <Typography variant="h6">{t("layers_selected", { count: selectedLayerIds.length })}</Typography>
          <Typography variant="body2">
            {t("bulk_actions_description", { defaultValue: "Select a single layer to edit styles." })}
          </Typography>
        </Stack>
      );
    }

    // ... (Single selection logic)
    if (selectedLayerIds.length === 1 && activeLayer) {
      // The named styles head the style tab: only the style changes with them.
      const namedStyles = activeLayer.style ? (
        <NamedStyles
          projectId={projectId}
          layer={activeLayer}
          store={store}
          kind={editorLayer.kind}
          geometry={editorLayer.geometry}
          canSetDefault={canSetDefaultStyle(activeLayer)}
          onSwitch={(styleId) => setLayerState(activeLayer.id, { active_style_id: styleId })}
          onChanged={() => mutate()}
        />
      ) : undefined;
      return (
        <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
          <Box sx={{ borderBottom: 1, borderColor: "divider" }}>
            <Tabs
              value={activeTab}
              onChange={(_, v) => handleTabChange(v)}
              variant="fullWidth"
              aria-label={t("layer_settings")}>
              {layerType === "raster" && <Tab label={t("style")} />}
              {layerType === "table" && <Tab label={t("filter")} />}
              {layerType !== "raster" && layerType !== "table" && <Tab label={t("style")} />}
              {layerType !== "raster" && layerType !== "table" && <Tab label={t("filter")} />}
              <Tab label={t("metadata.title")} />
            </Tabs>
          </Box>
          {/* The style panel scrolls its own sections; the other tabs scroll here. */}
          <Box
            sx={{
              flexGrow: 1,
              minHeight: 0,
              overflowY: activeTab === 0 && layerType !== "table" ? "hidden" : "auto",
              p: 0,
            }}>
            {/* Raster: Style (0), Metadata (1) */}
            {layerType === "raster" && (
              <>
                <Box role="tabpanel" hidden={activeTab !== 0} sx={{ height: "100%" }}>
                  {isTabLive(0) && (
                    <ProjectStylePanel projectId={projectId} layer={activeLayer} top={namedStyles} />
                  )}
                </Box>
                <Box role="tabpanel" hidden={activeTab !== 1} sx={{ height: "100%" }}>
                  {isTabLive(1) && <PropertiesPanel activeLayer={activeLayer} />}
                </Box>
              </>
            )}
            {/* Table: Filter (0), Metadata (1) */}
            {layerType === "table" && (
              <>
                <Box role="tabpanel" hidden={activeTab !== 0} sx={{ height: "100%" }}>
                  {isTabLive(0) && <Filter activeLayer={activeLayer} projectId={projectId} />}
                </Box>
                <Box role="tabpanel" hidden={activeTab !== 1} sx={{ height: "100%" }}>
                  {isTabLive(1) && <PropertiesPanel activeLayer={activeLayer} />}
                </Box>
              </>
            )}
            {/* Vector: Style (0), Filter (1), Metadata (2) */}
            {layerType !== "raster" && layerType !== "table" && (
              <>
                <Box role="tabpanel" hidden={activeTab !== 0} sx={{ height: "100%" }}>
                  {isTabLive(0) && (
                    <ProjectStylePanel projectId={projectId} layer={activeLayer} top={namedStyles} />
                  )}
                </Box>
                <Box role="tabpanel" hidden={activeTab !== 1} sx={{ height: "100%" }}>
                  {isTabLive(1) && <Filter activeLayer={activeLayer} projectId={projectId} />}
                </Box>
                <Box role="tabpanel" hidden={activeTab !== 2} sx={{ height: "100%" }}>
                  {isTabLive(2) && <PropertiesPanel activeLayer={activeLayer} />}
                </Box>
              </>
            )}
          </Box>
        </Box>
      );
    }
    return null;
  };

  return (
    <Box sx={{ height: "100%" }}>
      <Container
        header={
          <StyleHeader
            layer={editorLayer}
            store={store}
            featureCount={layerType === "raster" || layerType === "table" ? undefined : featureCount}
            noHint={!activeLayer || layerType === "table"}
          />
        }
        disablePadding={true}
        close={handleClose}
        body={renderContent()}
      />
    </Box>
  );
};
export default LayerSettingsPanel;
