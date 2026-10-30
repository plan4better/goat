import { Box, InputAdornment, TextField } from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { SYSTEM_LAYERS_IDS } from "@/lib/constants";
import type { ProjectLayer, ProjectLayerGroup } from "@/lib/validations/project";
import type { LayerInformationSchema } from "@/lib/validations/widget";

import { useAppSelector } from "@/hooks/store/ContextHooks";

import { LayerGroupSwitcher } from "@/components/builder/widgets/information/LayerGroupSwitcher";
import TabsLayerLayout from "@/components/builder/widgets/information/TabsLayerLayout";
import { useWidgetLayerTree } from "@/components/builder/widgets/information/useWidgetLayerTree";
import { ProjectLayerTree } from "@/components/map/panels/layer/ProjectLayerTree";

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

  const {
    projectId,
    layers: allLayers,
    layerGroups: allGroups,
    updateTree: handleTreeUpdate,
  } = useWidgetLayerTree(viewOnly);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const opts = config.options as Record<string, any> | undefined;
  // Stable when unset, so memos and the switchers' play timer don't restart on every render
  const excludedLayers: number[] = useMemo(() => opts?.excluded_layers ?? [], [opts?.excluded_layers]);
  const legendHiddenLayers: number[] = useMemo(() => opts?.legend_hidden_layers ?? [], [opts?.legend_hidden_layers]);
  const legendSimpleLayers: number[] = useMemo(() => opts?.legend_simple_layers ?? [], [opts?.legend_simple_layers]);
  const downloadableLayers: number[] = opts?.downloadable_layers ?? [];
  const groupSwitchers = config.setup?.group_switchers;
  const outOfZoomBehavior = opts?.out_of_zoom_behavior ?? "hide";

  // Subscribe to currentZoom when we need it for zoom-based behavior (hide or dim)
  const currentZoom = useAppSelector((state) =>
    outOfZoomBehavior !== undefined ? state.map.currentZoom : undefined
  );

  const filteredLayers = useMemo(() => {
    return allLayers.filter((layer) => {
      if (layer.layer_id && SYSTEM_LAYERS_IDS.includes(layer.layer_id)) return false;
      // Excluded by checkbox in config
      if (excludedLayers.includes(layer.id)) return false;
      // Hidden from legend by "Show in legend" toggle
      if (legendHiddenLayers.includes(layer.id)) return false;
      // Hide layers outside zoom range (only when behavior is "hide")
      if (outOfZoomBehavior === "hide" && currentZoom !== undefined) {
        const minZoom = layer.properties?.min_zoom;
        const maxZoom = layer.properties?.max_zoom;
        if (minZoom !== undefined && maxZoom !== undefined) {
          if (currentZoom < minZoom || currentZoom > maxZoom) return false;
        }
      }
      if (searchText) {
        return layer.name?.toLowerCase().includes(searchText.toLowerCase());
      }
      return true;
    });
  }, [allLayers, currentZoom, searchText, excludedLayers, legendHiddenLayers, outOfZoomBehavior]);

  // Filter out groups that have no visible layers
  const filteredGroups = useMemo(() => {
    const visibleLayerGroupIds = new Set(
      filteredLayers.map((l) => l.layer_project_group_id).filter(Boolean)
    );
    return allGroups.filter((g) => visibleLayerGroupIds.has(g.id));
  }, [allGroups, filteredLayers]);

  // Groups shown one layer at a time: the switcher takes the place of the group's layers
  const groupContent = useMemo(() => {
    const content: Record<number, React.ReactNode> = {};
    allGroups.forEach((group) => {
      const switcher = groupSwitchers?.[group.id];
      if (!switcher) return;
      content[group.id] = (
        <LayerGroupSwitcher
          groupId={group.id}
          title={group.name}
          config={switcher}
          excludedLayers={excludedLayers}
          legendHiddenLayers={legendHiddenLayers}
          simpleLegendLayers={legendSimpleLayers}
          hideLegendHeading={!!opts?.hide_legend_heading}
          viewOnly={viewOnly}
        />
      );
    });
    return content;
  }, [allGroups, groupSwitchers, excludedLayers, legendHiddenLayers, legendSimpleLayers, opts?.hide_legend_heading, viewOnly]);

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
          onTreeUpdate={handleTreeUpdate}
          viewOnly={viewOnly}
          downloadableLayers={downloadableLayers}
          simpleLegendLayerIds={legendSimpleLayers}
          hideLegendHeading={!!opts?.hide_legend_heading}
          groupIcons={opts as Record<string, { url: string; source?: string }> | undefined}
          dimOutOfZoom={outOfZoomBehavior === "dim"}
          groupContent={groupContent}
        />
      ) : (
        <ProjectLayerTree
          projectId={projectId}
          projectLayers={filteredLayers}
          projectLayerGroups={filteredGroups}
          viewMode="view"
          isLoading={false}
          onTreeUpdate={handleTreeUpdate}
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
          groupContent={groupContent}
        />
      )}
    </Box>
  );
};
