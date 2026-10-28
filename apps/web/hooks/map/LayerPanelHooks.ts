import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { useProjectLayers } from "@/lib/api/projects";
import { SYSTEM_LAYERS_IDS } from "@/lib/constants";
import { filterSelectableProjectLayers } from "@/lib/utils/map/layer";
import type { LayerType } from "@/lib/validations/layer";
import type { ProjectLayer } from "@/lib/validations/project";

import { ContentActions, MapLayerActions } from "@/types/common";

import { useAppSelector } from "@/hooks/store/ContextHooks";

import type { PopperMenuItem } from "@/components/common/PopperMenu";

export const useLayerSettingsMoreMenu = () => {
  const { t } = useTranslation("common");

  const getLayerMoreMenuOptions = useCallback(function getLayerMoreMenuOptions(
    layerType: ProjectLayer["type"],
    viewChart?: boolean,
    _inCatalog?: boolean,
    readOnly?: boolean,
    canEdit?: boolean,
    mapView?: boolean,
  ): PopperMenuItem[] {
    if (readOnly) {
      const readOnlyOptions: PopperMenuItem[] = [
        ...(layerType !== "table"
          ? [
              {
                id: MapLayerActions.ZOOM_TO,
                label: t("zoom_to"),
                icon: ICON_NAME.ZOOM_IN,
              },
            ]
          : []),
        ...(layerType !== "table"
          ? [
              {
                id: MapLayerActions.STYLE,
                label: t("style"),
                icon: ICON_NAME.STYLE,
              },
            ]
          : []),
        {
          id: ContentActions.DOWNLOAD,
          label: t("download"),
          icon: ICON_NAME.DOWNLOAD,
        },
        {
          id: ContentActions.INFO,
          label: t("data_source_info"),
          icon: ICON_NAME.CIRCLEINFO,
        },
      ];
      return readOnlyOptions;
    }

    if (layerType === "feature") {
      const featureOptions: PopperMenuItem[] = [
        ...(!mapView
          ? [
              {
                id: MapLayerActions.PROPERTIES,
                label: t("properties"),
                icon: ICON_NAME.CIRCLEINFO,
              },
              {
                id: MapLayerActions.STYLE,
                label: t("style"),
                icon: ICON_NAME.STYLE,
              },
            ]
          : []),
        {
          id: MapLayerActions.ZOOM_TO,
          label: t("zoom_to"),
          icon: ICON_NAME.ZOOM_IN,
        },
        {
          id: ContentActions.TABLE,
          label: t("open_data_table"),
          icon: ICON_NAME.TABLE,
        },
        ...(viewChart
          ? [
              {
                id: MapLayerActions.CHART,
                label: t("view_chart"),
                icon: ICON_NAME.CHART,
              },
            ]
          : []),
        ...(canEdit !== false
          ? [
              {
                id: MapLayerActions.EDIT_FEATURES,
                label: t("edit_features"),
                icon: ICON_NAME.EDITPEN,
              },
            ]
          : []),
        {
          id: MapLayerActions.DUPLICATE,
          label: t("duplicate"),
          icon: ICON_NAME.COPY,
        },
        {
          id: MapLayerActions.RENAME,
          label: t("rename"),
          icon: ICON_NAME.EDIT,
        },
        {
          id: ContentActions.DOWNLOAD,
          label: t("download"),
          icon: ICON_NAME.DOWNLOAD,
        },
        {
          id: ContentActions.DELETE,
          label: t("delete"),
          icon: ICON_NAME.TRASH,
          color: "error.main",
        },
      ];
      return featureOptions;
    }
    if (layerType === "table") {
      const tableOptions = [
        {
          id: MapLayerActions.PROPERTIES,
          label: t("properties"),
          icon: ICON_NAME.CIRCLEINFO,
        },
        {
          id: ContentActions.TABLE,
          label: t("open_data_table"),
          icon: ICON_NAME.TABLE,
        },
        ...(viewChart
          ? [
              {
                id: MapLayerActions.CHART,
                label: t("view_chart"),
                icon: ICON_NAME.CHART,
              },
            ]
          : []),
        ...(canEdit !== false
          ? [
              {
                id: MapLayerActions.EDIT_FEATURES,
                label: t("edit_features"),
                icon: ICON_NAME.EDITPEN,
              },
            ]
          : []),
        {
          id: MapLayerActions.RENAME,
          label: t("rename"),
          icon: ICON_NAME.EDIT,
        },
        {
          id: ContentActions.DOWNLOAD,
          label: t("download"),
          icon: ICON_NAME.DOWNLOAD,
        },
        {
          id: ContentActions.DELETE,
          label: t("delete"),
          icon: ICON_NAME.TRASH,
          color: "error.main",
        },
      ];

      return tableOptions;
    }
    if (layerType === "raster") {
      const rasterOptions: PopperMenuItem[] = [
        ...(!mapView
          ? [
              {
                id: MapLayerActions.PROPERTIES,
                label: t("properties"),
                icon: ICON_NAME.CIRCLEINFO,
              },
              {
                id: MapLayerActions.STYLE,
                label: t("style"),
                icon: ICON_NAME.STYLE,
              },
            ]
          : []),
        {
          id: MapLayerActions.ZOOM_TO,
          label: t("zoom_to"),
          icon: ICON_NAME.ZOOM_IN,
        },
        {
          id: MapLayerActions.DUPLICATE,
          label: t("duplicate"),
          icon: ICON_NAME.COPY,
        },
        {
          id: MapLayerActions.RENAME,
          label: t("rename"),
          icon: ICON_NAME.EDIT,
        },
        {
          id: ContentActions.DELETE,
          label: t("delete"),
          icon: ICON_NAME.TRASH,
          color: "error.main",
        },
      ];

      return rasterOptions;
    }

    return [];
  }, [t]);

  const [activeLayer, setActiveLayer] = useState<ProjectLayer>();
  const [moreMenuState, setMoreMenuState] = useState<PopperMenuItem>();

  const closeMoreMenu = () => {
    setActiveLayer(undefined);
    setMoreMenuState(undefined);
  };

  const openMoreMenu = useCallback((menuItem: PopperMenuItem, layerItem: ProjectLayer) => {
    setActiveLayer(layerItem);
    setMoreMenuState(menuItem);
  }, []);

  return {
    getLayerMoreMenuOptions,
    activeLayer,
    moreMenuState,
    closeMoreMenu,
    openMoreMenu,
  };
};

export const useFilterQueries = (projectId: string) => {
  const { layers: projectLayers, mutate } = useProjectLayers(projectId);
  const activeLayerId = useAppSelector((state) => state.layers.activeLayerId);
  const activeLayer = projectLayers?.find((layer) => layer.id === activeLayerId);

  return { activeLayer, mutate };
};

export const useFilteredProjectLayers = (
  projectId: string,
  excludeLayerTypes: LayerType[] = [],
  excludeLayerIds: string[] = [...SYSTEM_LAYERS_IDS]
) => {
  const { layers: projectLayers, mutate, isLoading, isError, isValidating } = useProjectLayers(projectId);
  const sortedLayers = useMemo(() => {
    // D7: a locked layer never appears in a picker — the user has no
    // access of their own to it, so there is nothing to configure.
    const filteredLayers = filterSelectableProjectLayers(
      projectLayers,
      excludeLayerTypes,
      excludeLayerIds
    );

    return filteredLayers.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }, [projectLayers, excludeLayerTypes, excludeLayerIds]);

  return { layers: sortedLayers, mutate, isLoading, isError, isValidating };
};
