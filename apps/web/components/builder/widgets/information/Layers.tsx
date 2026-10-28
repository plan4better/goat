import { Box, InputAdornment, TextField } from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useProjectLayerGroups } from "@/lib/api/projects";
import { SYSTEM_LAYERS_IDS } from "@/lib/constants";
import type { ProjectLayer, ProjectLayerGroup } from "@/lib/validations/project";
import type { LayerInformationSchema } from "@/lib/validations/widget";

import { useLayerTreeState } from "@/hooks/map/useLayerTreeState";
import { type MapLayer, useMapLayers, withMapGroups } from "@/hooks/map/useMapLayers";
import { useAppSelector } from "@/hooks/store/ContextHooks";

import { ProjectLayerTree } from "@/components/map/panels/layer/ProjectLayerTree";
import TabsLayerLayout from "@/components/builder/widgets/information/TabsLayerLayout";

interface LayerInformationProps {
  widgetId: string;
  config: LayerInformationSchema;
  projectLayers: ProjectLayer[];
  projectLayerGroups: ProjectLayerGroup[];
  viewOnly?: boolean;
}

export const LayerInformationWidget = ({
  widgetId,
  config: configProp,
  projectLayers: _publishedProjectLayers,
  projectLayerGroups: _publishedProjectLayerGroups,
  viewOnly,
}: LayerInformationProps) => {
  const { t } = useTranslation("common");
  const { projectId } = useParams() as { projectId: string };
  const [searchText, setSearchText] = useState("");

  // In edit mode, read the latest config from Redux for instant updates — but ONLY for THIS widget
  const selectedBuilderItem = useAppSelector((state) =>
    !viewOnly ? state.map.selectedBuilderItem : undefined
  );
  const config =
    selectedBuilderItem?.type === "widget" &&
    selectedBuilderItem.id === widgetId &&
    selectedBuilderItem.config?.type === "layers"
      ? (selectedBuilderItem.config as LayerInformationSchema)
      : configProp;

  // A published dashboard keeps its map layers (view state included) in the store; the builder reads the project's.
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const opts = config.options as Record<string, any> | undefined;
  const excludedLayers: number[] = opts?.excluded_layers ?? [];
  const legendHiddenLayers: number[] = opts?.legend_hidden_layers ?? [];
  const legendSimpleLayers: number[] = opts?.legend_simple_layers ?? [];
  const downloadableLayers: number[] = opts?.downloadable_layers ?? [];
  const outOfZoomBehavior = opts?.out_of_zoom_behavior ?? "hide";

  // Subscribe to currentZoom when we need it for zoom-based behavior (hide or dim)
  const currentZoom = useAppSelector((state) =>
    outOfZoomBehavior !== undefined ? state.map.currentZoom : undefined
  );

  const filteredLayers = useMemo(() => {
    const layersToUse = viewOnly ? reduxProjectLayers : editProjectLayers || [];
    return layersToUse.filter((layer) => {
      if (layer.layer_id && SYSTEM_LAYERS_IDS.includes(layer.layer_id)) return false;
      // Excluded by checkbox in config
      if (excludedLayers.includes(layer.id)) return false;
      // Hidden from legend by "Show in legend" toggle
      if (legendHiddenLayers.includes(layer.id)) return false;
      // Hide layers outside zoom range (only when behavior is "hide")
      if (outOfZoomBehavior === "hide" && currentZoom !== undefined && layer.style) {
        const { min_zoom: minZoom, max_zoom: maxZoom } = layer.style.document as {
          min_zoom?: number;
          max_zoom?: number;
        };
        if (currentZoom < (minZoom ?? 0) || currentZoom > (maxZoom ?? 24)) return false;
      }
      if (searchText) {
        return layer.name?.toLowerCase().includes(searchText.toLowerCase());
      }
      return true;
    });
  }, [viewOnly, reduxProjectLayers, editProjectLayers, currentZoom, searchText, excludedLayers, legendHiddenLayers, outOfZoomBehavior]);

  // Filter out groups that have no visible layers
  const allGroups = viewOnly ? reduxProjectLayerGroups : editProjectLayerGroups || [];
  const filteredGroups = useMemo(() => {
    const visibleLayerGroupIds = new Set(
      filteredLayers.map((l) => l.layer_project_group_id).filter(Boolean)
    );
    return allGroups.filter((g) => visibleLayerGroupIds.has(g.id));
  }, [allGroups, filteredLayers]);

  const options = config.options;
  const layoutStyle = options?.layout_style || "tree";

  return (
    <Box>
      {/* Search bar */}
      {options?.show_search && (
        <Box sx={{ px: 1, pb: 1 }}>
          <TextField
            size="small"
            fullWidth
            placeholder={t("search_layers")}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 18, color: "text.disabled" }} />
                </InputAdornment>
              ),
            }}
            sx={{
              "& .MuiOutlinedInput-root": { height: 32 },
              "& .MuiOutlinedInput-input": { fontSize: 13 },
            }}
          />
        </Box>
      )}

      {layoutStyle === "tabs" ? (
        <TabsLayerLayout
          projectId={projectId}
          projectLayers={filteredLayers}
          projectLayerGroups={filteredGroups}
          config={config}
          onLayerStateChange={treeState.onLayerStateChange}
          onGroupStateChange={treeState.onGroupStateChange}
          onLayerTimeChange={treeState.onLayerTimeChange}
          viewOnly={viewOnly}
          downloadableLayers={downloadableLayers}
          simpleLegendLayerIds={legendSimpleLayers}
          hideLegendHeading={!!opts?.hide_legend_heading}
          groupIcons={opts as Record<string, { url: string; source?: string }> | undefined}
          dimOutOfZoom={outOfZoomBehavior === "dim"}
        />
      ) : (
        <ProjectLayerTree
          projectId={projectId}
          projectLayers={filteredLayers}
          projectLayerGroups={filteredGroups}
          viewMode="view"
          isLoading={false}
          onLayerStateChange={treeState.onLayerStateChange}
          onGroupStateChange={treeState.onGroupStateChange}
          onLayerTimeChange={treeState.onLayerTimeChange}
          toggleStyle={options?.toggle_style}
          togglePosition={options?.toggle_position}
          moreOptionsStyle={options?.more_options_style}
          allowedActions={{
            style: options?.show_style_action ?? true,
            viewData: options?.show_view_data_action ?? true,
            properties: options?.show_properties_action ?? true,
            zoomTo: options?.show_zoom_to_action ?? true,
          }}
          downloadableLayers={downloadableLayers}
          simpleLegendLayerIds={legendSimpleLayers}
          hideLegendHeading={!!opts?.hide_legend_heading}
          groupIcons={opts as Record<string, { url: string; source?: string }> | undefined}
          dimOutOfZoom={outOfZoomBehavior === "dim"}
          groupInfo={config.setup?.group_info}
        />
      )}
    </Box>
  );
};
