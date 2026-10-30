import { Box } from "@mui/material";
import dynamic from "next/dynamic";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { v4 } from "uuid";

import { useFilteredProjectLayers } from "@/hooks/map/LayerPanelHooks";
import { DEFAULT_BASEMAP } from "@/lib/constants/basemaps";
import { setSelectedLayers, updateProjectLayer } from "@/lib/store/layer/slice";
import { duplicateWidget } from "@/lib/utils/builderWidgets";
import { useInteractionDispatcher } from "@/hooks/map/useInteractionDispatcher";
import type { InteractionRule } from "@/lib/validations/interaction";
import {
  removeTemporaryFilter,
  setActiveRightPanel,
  setCollapsedPanels,
  setSelectedBuilderItem,
} from "@/lib/store/map/slice";
import type { BuilderWidgetSchema, CustomBasemap } from "@/lib/validations/project";
import {
  type BuilderPanelSchema,
  type ControlKey,
  type CornerKey,
  type Project,
  type ProjectLayer,
  type ProjectLayerGroup,
  builderPanelSchema,
} from "@/lib/validations/project";

import { MapSidebarItemID } from "@/types/map/common";

import { useDashboardFont } from "@/hooks/dashboard/useDashboardFont";
import { useDashboardLanguageOverride } from "@/hooks/dashboard/useDashboardLanguageOverride";
import { useLayerStyleChange } from "@/hooks/map/LayerStyleHooks";
import { useBasemap } from "@/hooks/map/MapHooks";
import { useCustomBasemapMutations } from "@/hooks/map/useCustomBasemapMutations";
import { useMeasureTool } from "@/hooks/map/useMeasureTool";
import { MapFixedPopupSlot } from "@/components/map/popover/MapFixedPopupSlot";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import AddSectionButton from "@/components/builder/AddSectionButton";
import type { BuilderPanelSchemaWithPosition } from "@/components/builder/PanelContainer";
const Container = dynamic(() => import("@/components/builder/PanelContainer").then((m) => m.Container), { ssr: false });
import { ProjectInfo } from "@/components/builder/widgets/information/ProjectInfo";
import { FloatingPanel } from "@/components/common/FloatingPanel";
import Header from "@/components/header/Header";
import AttributionControl from "@/components/map/controls/Attribution";
import { BasemapSelector } from "@/components/map/controls/BasemapSelector";
import { CustomBasemapDialog } from "@/components/map/controls/CustomBasemapDialog";
import { Fullscren } from "@/components/map/controls/Fullscreen";
import Scalebar from "@/components/map/controls/Scalebar";
import { UserLocation } from "@/components/map/controls/UserLocation";
import { Zoom } from "@/components/map/controls/Zoom";
import { MeasureButton, MeasureResultsPanel } from "@/components/map/controls/measure";
import SearchControl from "@/components/map/controls/search/SearchControl";
import { usePublicSearchSource } from "@/components/map/controls/search/publicSearchLayers";
import ViewContainer from "@/components/map/panels/Container";
import PropertiesPanel from "@/components/map/panels/properties/Properties";
import SimpleLayerStyle from "@/components/map/panels/style/SimpleLayerStyle";

export interface PublicProjectLayoutProps {
  project?: Project;
  projectLayers?: ProjectLayer[];
  projectLayerGroups?: ProjectLayerGroup[];
  // Accepts (key, value, refresh?) or (partial, refresh?) — see handleProjectUpdate in app/map/[projectId]/page.tsx.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onProjectUpdate?: (keyOrPartial: any, valueOrRefresh?: any, refresh?: boolean) => void;
  // add property isEditing to the interface
  viewOnly?: boolean;
}

const PublicProjectLayout = ({
  projectLayers = [],
  projectLayerGroups = [],
  project,
  onProjectUpdate,
  viewOnly,
}: PublicProjectLayoutProps) => {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();

  // Apply dashboard language override only for public/shared view
  useDashboardLanguageOverride(project?.builder_config?.settings?.language, viewOnly);
  const dashboardFont = useDashboardFont(project);

  // Layer style change hook
  const { handleStyleChange } = useLayerStyleChange(projectLayers, viewOnly);

  // Measure tool - using the reusable hook
  const measureTool = useMeasureTool();

  const {
    source: searchSource,
    layersById: searchLayersById,
    placeholder: searchPlaceholder,
  } = usePublicSearchSource(
    project,
    projectLayers
  );

  const { translatedBaseMaps, activeBasemap, setActiveBasemap } = useBasemap(project);
  // Ephemeral preview of a non-active basemap while its edit dialog is open;
  // restored on close (never persisted).
  const basemapBeforeEdit = useRef<string | null>(null);
  const mapMode = useAppSelector((state) => state.map.mapMode);
  const editable = mapMode !== "public";
  const { addCustomBasemap, editCustomBasemap, deleteCustomBasemap } =
    useCustomBasemapMutations(project, onProjectUpdate);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CustomBasemap | null>(null);
  const temporaryFilters = useAppSelector((state) => state.map.temporaryFilters);
  const selectedPanel = useAppSelector((state) => state.map.selectedBuilderItem) as BuilderPanelSchema;
  const collapsedPanels = useAppSelector((state) => state.map.collapsedPanels);
  const builderConfig = project?.builder_config;
  const panels = useMemo(() => builderConfig?.interface ?? [], [builderConfig]);

  // Interaction dispatcher
  const interactionRules = useMemo(
    () => (builderConfig?.interactions ?? []) as InteractionRule[],
    [builderConfig]
  );

  // SWR cache for editor mode (skipped in viewOnly to avoid an unnecessary fetch)
  const { mutate: mutateProjectLayers } = useFilteredProjectLayers(
    viewOnly ? "" : (project?.id ?? "")
  );

  const handleVisibilitySync = useCallback(
    (layerId: number, visible: boolean) => {
      const layer = projectLayers.find((l) => l.id === layerId);
      if (!layer) return;
      const currentVisibility = layer.properties?.visibility ?? true;
      if (currentVisibility === visible) return;
      // Update Redux (used by public view + map renderer)
      dispatch(
        updateProjectLayer({
          id: layerId,
          changes: {
            properties: { ...layer.properties, visibility: visible },
          },
        })
      );
      // Update SWR cache (used by editor preview's layer tree)
      if (!viewOnly) {
        mutateProjectLayers(
          (current) =>
            current?.map((l) =>
              l.id === layerId
                ? { ...l, properties: { ...l.properties, visibility: visible } }
                : l
            ),
          false
        );
      }
    },
    [projectLayers, dispatch, mutateProjectLayers, viewOnly]
  );

  useInteractionDispatcher({
    rules: interactionRules,
    onVisibilitySync: handleVisibilitySync,
  });

  const COLLAPSED_SIZE = 40; // Should match the collapsedSize in Container component

  // Initialize collapsed state from panel config once per project load.
  const initializedProjectIdRef = useRef<string | null>(null);
  useEffect(() => {
    const projectId = project?.id || null;
    if (!projectId || initializedProjectIdRef.current === projectId || panels.length === 0) return;

    initializedProjectIdRef.current = projectId;
    const defaults: Record<string, boolean> = {};
    panels.forEach((panel) => {
      defaults[panel.id] = Boolean(
        panel.config?.options?.collapsible && panel.config?.options?.collapsed_default
      );
    });

    dispatch(setCollapsedPanels(defaults));
  }, [dispatch, panels, project?.id]);
  const activeRight = useAppSelector((state) => state.map.activeRightPanel);

  // Layer settings logic (public version)
  const selectedLayerIds = useAppSelector((state) => state.layers.selectedLayerIds || []);
  const activeLayer = useMemo(() => {
    if (selectedLayerIds.length === 1) {
      return projectLayers.find((l) => l.id === selectedLayerIds[0]);
    }
    return null;
  }, [selectedLayerIds, projectLayers]);

  const activeRightComponent = useMemo(() => {
    // Check for layer configuration panel ID (public version - only Properties and Style)
    const layerSettingsIds = [MapSidebarItemID.PROPERTIES, MapSidebarItemID.STYLE];

    if (activeRight && layerSettingsIds.includes(activeRight) && activeLayer) {
      let title = "Layer Settings";
      let content: React.ReactNode = null;

      if (activeRight === MapSidebarItemID.PROPERTIES) {
        title = `${t("data_source_info")}: ${activeLayer.name || t("layer")}`;
        content = <PropertiesPanel activeLayer={activeLayer} />;
      } else if (activeRight === MapSidebarItemID.STYLE) {
        title = `${t("style")}: ${activeLayer.name || t("layer")}`;
        content = <SimpleLayerStyle activeLayer={activeLayer} onStyleChange={handleStyleChange} />;
      }

      return { title, content };
    }
    return null;
  }, [activeRight, activeLayer, handleStyleChange, t]);

  const handleClose = () => {
    dispatch(setSelectedLayers([]));
    dispatch(setActiveRightPanel(undefined));
  };

  // Count total number of panels top, bottom, left, right using useMemo
  const topPanels = useMemo(() => panels.filter((panel) => panel.position === "top"), [panels]);
  const bottomPanels = useMemo(() => panels.filter((panel) => panel.position === "bottom"), [panels]);
  const leftPanels = useMemo(() => panels.filter((panel) => panel.position === "left"), [panels]);
  const rightPanels = useMemo(() => panels.filter((panel) => panel.position === "right"), [panels]);

  // Returns the configured size for a panel (width for left/right, height for top/bottom)
  const getPanelConfigSize = (panel: BuilderPanelSchema) => {
    if (panel.position === "left" || panel.position === "right") {
      return panel.config?.size?.width ?? 300;
    }
    return panel.config?.size?.height ?? 300;
  };

  // Helper function to get actual panel size considering collapsed state
  const getPanelSize = (panel: BuilderPanelSchema) => {
    const isCollapsed = !!collapsedPanels?.[panel.id];
    return isCollapsed ? COLLAPSED_SIZE : getPanelConfigSize(panel);
  };

  // Calculate the actual occupied space for each position considering collapsed panels
  const getOccupiedSpace = useMemo(() => {
    const leftSpace = leftPanels.reduce((total, panel) => total + getPanelSize(panel), 0);
    const rightSpace = rightPanels.reduce((total, panel) => total + getPanelSize(panel), 0);
    const topSpace = topPanels.reduce((total, panel) => total + getPanelSize(panel), 0);
    const bottomSpace = bottomPanels.reduce((total, panel) => total + getPanelSize(panel), 0);

    return { left: leftSpace, right: rightSpace, top: topSpace, bottom: bottomSpace };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftPanels, rightPanels, topPanels, bottomPanels, collapsedPanels]);

  // Width occupied by the secondary right overlay (measure results +
  // editor-side panel) that PublicProjectLayout stacks on top of the
  // builder right panel. Used to size the fixed-popup host so it
  // doesn't sit behind these panels. Only counts panels that are
  // actually visible — a measure button enabled but not opened
  // contributes nothing.
  const measureVisible =
    measureTool.measureOpen || measureTool.measurements.length > 0;
  const editorRightWidth = useMemo(() => {
    const MEASURE_PANEL_WIDTH = 320;
    const STYLE_PANEL_WIDTH = 320;
    const DEFAULT_PANEL_WIDTH = 400;
    const widths: number[] = [];
    if (measureVisible) widths.push(MEASURE_PANEL_WIDTH);
    if (activeRightComponent) {
      widths.push(activeRight === MapSidebarItemID.STYLE ? STYLE_PANEL_WIDTH : DEFAULT_PANEL_WIDTH);
    }
    if (widths.length === 0) return 0;
    // 16px gap between adjacent panels (matches the overlay's `gap: 2`).
    return widths.reduce((a, b) => a + b, 0) + 16 * (widths.length - 1);
  }, [measureVisible, activeRightComponent, activeRight]);

  const panelsWithPosition: BuilderPanelSchemaWithPosition[] = useMemo(() => {
    return panels.map((panel, index) => {
      // Calculate cumulative space for each position before current panel
      let leftSpaceBefore = 0;
      let rightSpaceBefore = 0;
      let topSpaceBefore = 0;
      let bottomSpaceBefore = 0;

      for (let i = 0; i < index; i++) {
        const prevPanel = panels[i];
        const prevPanelSize = getPanelSize(prevPanel);

        switch (prevPanel.position) {
          case "left":
            leftSpaceBefore += prevPanelSize;
            break;
          case "right":
            rightSpaceBefore += prevPanelSize;
            break;
          case "top":
            topSpaceBefore += prevPanelSize;
            break;
          case "bottom":
            bottomSpaceBefore += prevPanelSize;
            break;
        }
      }

      switch (panel.position) {
        case "left":
          return {
            ...panel,
            orientation: "vertical",
            element: {
              left: leftSpaceBefore,
              top: topSpaceBefore,
              bottom: bottomSpaceBefore,
              width: getPanelConfigSize(panel),
            },
          };
        case "right":
          return {
            ...panel,
            orientation: "vertical",
            element: {
              right: rightSpaceBefore,
              top: topSpaceBefore,
              bottom: bottomSpaceBefore,
              width: getPanelConfigSize(panel),
            },
          };
        case "top":
          return {
            ...panel,
            orientation: "horizontal",
            element: {
              top: topSpaceBefore,
              left: leftSpaceBefore,
              right: rightSpaceBefore,
              height: getPanelConfigSize(panel),
            },
          };
        case "bottom":
          return {
            ...panel,
            orientation: "horizontal",
            element: {
              bottom: bottomSpaceBefore,
              left: leftSpaceBefore,
              right: rightSpaceBefore,
              height: getPanelConfigSize(panel), // Keep original height for smooth transition
            },
          };
        default:
          return {
            ...panel,
            element: {
              left: 0,
              top: 0,
              right: 0,
              bottom: 0,
            },
          };
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panels, collapsedPanels]);

  // Check if a panel can be added to a specific position
  const canAddPanel = (position: "top" | "bottom" | "left" | "right") => {
    const topPanelCount = topPanels.length;
    const bottomPanelCount = bottomPanels.length;
    const leftPanelCount = leftPanels.length;
    const rightPanelCount = rightPanels.length;
    // Rules for top and bottom panels
    if ((position === "top" || position === "bottom") && (topPanelCount || bottomPanelCount)) {
      return false;
    }
    // Rules for left and right panels
    if ((position === "left" || position === "right") && leftPanelCount + rightPanelCount >= 2) {
      return false;
    }

    return true;
  };

  const handleChangeOrder = (panelId: string, direction: "left" | "right" | "top" | "bottom") => {
    const prevPanels = panels;
    const newPanels = [...prevPanels];
    const currentIndex = newPanels.findIndex((p) => p.id === panelId);
    if (currentIndex === -1) return prevPanels;

    const currentPanel = newPanels[currentIndex];
    const position = currentPanel.position;
    let targetIndex = currentIndex;

    // Helper function to find nearest panel in direction
    const findNeighbor = (start: number, step: number, condition: (p: BuilderPanelSchema) => boolean) => {
      let i = start + step;
      while (i >= 0 && i < newPanels.length) {
        if (condition(newPanels[i])) return i;
        i += step;
      }
      return -1;
    };

    if (position === "top" || position === "bottom") {
      // Horizontal movement for top/bottom panels
      const step = direction === "left" ? -1 : 1;
      targetIndex = findNeighbor(currentIndex, step, (p) => p.position === "left" || p.position === "right");
    } else if (position === "left" || position === "right") {
      if (direction === "left" || direction === "right") {
        // Horizontal movement within side group
        const sameSidePanels = newPanels
          .map((p, i) => ({ p, i }))
          .filter(({ p }) => p.position === position)
          .sort((a, b) => a.i - b.i);

        const groupIndex = sameSidePanels.findIndex(({ p }) => p.id === panelId);
        if (groupIndex === -1) return prevPanels;

        const newGroupIndex = direction === "left" ? groupIndex - 1 : groupIndex + 1;
        if (newGroupIndex >= 0 && newGroupIndex < sameSidePanels.length) {
          targetIndex = sameSidePanels[newGroupIndex].i;
        }
      } else {
        // Vertical movement to top/bottom
        const targetPosition = direction === "top" ? "top" : "bottom";
        const existing = newPanels.findIndex((p) => p.position === targetPosition);

        if (existing === -1) {
          // Convert to top/bottom panel
          newPanels[currentIndex].position = targetPosition;
          return [...newPanels];
        } else {
          // Swap with existing top/bottom panel
          targetIndex = existing;
        }
      }
    }

    if (targetIndex !== currentIndex && targetIndex !== -1) {
      [newPanels[currentIndex], newPanels[targetIndex]] = [newPanels[targetIndex], newPanels[currentIndex]];
    }

    const builderConfig = {
      ...project?.builder_config,
      interface: newPanels,
    };

    onProjectUpdate?.("builder_config", builderConfig);
  };

  const handlePanelClick = (panel: BuilderPanelSchema) => {
    if (viewOnly) return;
    dispatch(setSelectedBuilderItem(panel));
  };

  const onWidgetDelete = (widgetId: string) => {
    if (viewOnly) return;
    const updatedPanels = panels.map((panel) => {
      if (panel.widgets) {
        panel.widgets = panel.widgets.filter((widget) => widget.id !== widgetId);
      }
      return panel;
    });
    const builderConfig = {
      ...project?.builder_config,
      interface: updatedPanels,
    };
    onProjectUpdate?.("builder_config", builderConfig);
    dispatch(setSelectedBuilderItem(undefined));
    // Remove any temporary filters associated with the deleted widget
    const associatedFilters = temporaryFilters.filter((filter) => filter.id === widgetId);
    associatedFilters.forEach((filter) => {
      dispatch(removeTemporaryFilter(filter.id));
    });
  };

  const onWidgetDuplicate = (widgetId: string) => {
    if (viewOnly) return;
    const duplicated = duplicateWidget(panels, widgetId);
    if (!duplicated) return;
    const builderConfig = {
      ...project?.builder_config,
      interface: duplicated.panels,
    };
    onProjectUpdate?.("builder_config", builderConfig);
    dispatch(setSelectedBuilderItem(duplicated.copy));
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onWidgetUpdate = (updatedWidget: BuilderWidgetSchema) => {
    if (viewOnly) return;
    const updatedPanels = panels.map((panel) => {
      if (panel.widgets) {
        panel.widgets = panel.widgets.map((widget) => {
          if (widget.id === updatedWidget.id) {
            return { ...widget, ...updatedWidget };
          }
          return widget;
        });
      }
      return panel;
    });
    const builderConfig = {
      ...project?.builder_config,
      interface: updatedPanels,
    };
    onProjectUpdate?.("builder_config", builderConfig);
    dispatch(setSelectedBuilderItem(updatedWidget));
  };

  // Add a new panel to the specified position
  const onAddSection = async (position: "top" | "bottom" | "left" | "right") => {
    if (canAddPanel(position)) {
      const newPanelObj = {
        position: position,
        config: {},
        type: "panel",
        widgets: [],
        id: v4(),
      };
      const _newPanel = builderPanelSchema.safeParse(newPanelObj);
      if (_newPanel.success) {
        const newPanel = _newPanel.data;
        const updatedPanels = [...panels, newPanel];
        const builderConfig = {
          ...project?.builder_config,
          interface: updatedPanels,
        };
        await onProjectUpdate?.("builder_config", builderConfig);
      } else {
        console.error("Invalid panel data:", _newPanel.error);
      }
    }
  };

  const addSectionStylePosition = useMemo(() => {
    return {
      top: getOccupiedSpace.top,
      left: getOccupiedSpace.left,
      right: getOccupiedSpace.right,
      bottom: getOccupiedSpace.bottom,
    };
  }, [getOccupiedSpace]);

  // Calculate control positions based on actual occupied space
  const controlPositions = useMemo(() => {
    return {
      topLeft: {
        left: getOccupiedSpace.left,
        top: getOccupiedSpace.top,
      },
      topRight: {
        right: getOccupiedSpace.right,
        top: getOccupiedSpace.top,
      },
      bottomRight: {
        right: getOccupiedSpace.right,
        bottom: getOccupiedSpace.bottom,
      },
      bottomLeft: {
        left: getOccupiedSpace.left,
        bottom: getOccupiedSpace.bottom,
      },
    };
  }, [getOccupiedSpace]);

  const controlsByCorner = useMemo(() => {
    const positions = builderConfig?.settings?.control_positions as Record<CornerKey, ControlKey[]> | undefined;
    return positions ?? {
      "top-left": ["location", "measure"] as ControlKey[],
      "top-right": [] as ControlKey[],
      "bottom-left": [] as ControlKey[],
      "bottom-right": ["zoom_controls", "basemap", "fullscreen"] as ControlKey[],
    };
  }, [builderConfig]);

  const allowedStyles = useMemo(() => {
    const allowed = builderConfig?.settings.allowed_basemaps;
    if (!allowed) return translatedBaseMaps;
    return translatedBaseMaps.filter((b) => b.source === "custom" || allowed.includes(b.value));
  }, [builderConfig, translatedBaseMaps]);

  // The search card is translucent and grows downward when results open, so the
  // other controls sharing its corner are hidden for the duration instead of
  // showing through it (or being shoved out of the way).
  const [searchPanelOpen, setSearchPanelOpen] = useState(false);

  const renderControl = useCallback(
    (key: ControlKey, corner: CornerKey): React.ReactNode => {
      const isRightCorner = corner === "top-right" || corner === "bottom-right";
      switch (key) {
        case "location":
          return searchSource?.mode === "public" && (searchSource.placesEnabled || searchSource.hasLayers) ? (
            <SearchControl
              key="location"
              source={searchSource}
              layersById={searchLayersById}
              placeholder={searchPlaceholder}
              bbox={project?.max_extent ?? undefined}
              onPanelOpenChange={setSearchPanelOpen}
            />
          ) : null;
        case "measure":
          return (
            <MeasureButton
              key="measure"
              {...measureTool}
              placement={isRightCorner ? "left" : "right"}
            />
          );
        case "zoom_controls":
          return <Zoom key="zoom_controls" tooltipZoomIn={t("zoom_in")} tooltipZoomOut={t("zoom_out")} />;
        case "basemap":
          return allowedStyles.length > 0 ? (
            <BasemapSelector
              key="basemap"
              styles={allowedStyles}
              active={activeBasemap.value}
              editable={editable}
              basemapChange={async (basemap) => {
                await onProjectUpdate?.("basemap", basemap);
              }}
              onAdd={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
              onEdit={(id) => {
                const target =
                  (project?.custom_basemaps as CustomBasemap[] | undefined)?.find(
                    (c) => c.id === id
                  ) ?? null;
                if (target && project?.basemap !== id) {
                  // Ephemeral preview only — reverted on close, never persisted.
                  basemapBeforeEdit.current = project?.basemap ?? DEFAULT_BASEMAP;
                  setActiveBasemap(id);
                }
                setEditing(target);
                setDialogOpen(true);
              }}
            />
          ) : null;
        case "fullscreen":
          return <Fullscren key="fullscreen" tooltipOpen={t("fullscreen")} tooltipExit={t("exit_fullscreen")} />;
        case "find_my_location":
          return <UserLocation key="find_my_location" tooltip={t("find_location")} />;
        case "project_info":
          return project ? (
            <ProjectInfo
              key="project_info"
              project={project}
              viewOnly={viewOnly}
              onProjectUpdate={onProjectUpdate}
            />
          ) : null;
        default:
          return null;
      }
    },
    [
      t,
      measureTool,
      allowedStyles,
      activeBasemap,
      searchSource,
      searchLayersById,
      searchPlaceholder,
      onProjectUpdate,
      project,
      viewOnly,
      editable,
    ]
  );

  const cornerSxMap: Record<CornerKey, object> = {
    "top-left": { ...controlPositions.topLeft },
    "top-right": { ...controlPositions.topRight },
    "bottom-left": { ...controlPositions.bottomLeft },
    "bottom-right": { ...controlPositions.bottomRight },
  };

  return (
    <Box sx={{ height: "100%", width: "100%", display: "flex", flexDirection: "column", fontFamily: dashboardFont }}>
      {project && builderConfig?.settings?.toolbar && (
        <Header showHambugerMenu={false} mapHeader={true} project={project} viewOnly />
      )}
      <Box
        display="flex"
        sx={{
          zIndex: 1,
          position: "relative",
          height: "100%",
          flexGrow: 1,
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "space-between",
          pointerEvents: "none",
        }}>
        <Box
          sx={{
            width: "100%",
            height: "100%",
            position: "absolute",
            zIndex: 2,
          }}>
          {/* Left Panel */}
          {panelsWithPosition?.length > 0 && (
            <>
              {panelsWithPosition.map((panel: BuilderPanelSchemaWithPosition) => (
                <Container
                  key={panel.id}
                  panel={panel}
                  projectLayers={projectLayers}
                  projectLayerGroups={projectLayerGroups}
                  viewOnly={viewOnly}
                  selected={selectedPanel?.type === "panel" && selectedPanel?.id === panel.id}
                  onChangeOrder={handleChangeOrder}
                  onWidgetDelete={onWidgetDelete}
                  onWidgetDuplicate={onWidgetDuplicate}
                  onWidgetUpdate={onWidgetUpdate}
                  onClick={() => handlePanelClick(panel)}
                />
              ))}
            </>
          )}
          {/* Center Content */}
          {!viewOnly && (
            <Box
              sx={{
                flexGrow: 1,
                position: "absolute",
                ...addSectionStylePosition,
                transition: "all 0.3s",
              }}>
              {/* Render AddSectionButton only if the panel can be added */}
              {["top", "bottom", "left", "right"].map((position) => {
                const canAdd = canAddPanel(position as "top" | "bottom" | "left" | "right");
                return (
                  canAdd && (
                    <AddSectionButton
                      key={position}
                      position={position as "top" | "bottom" | "left" | "right"}
                      onClick={() => onAddSection(position as "top" | "bottom" | "left" | "right")}
                    />
                  )
                );
              })}
            </Box>
          )}

          {/* Right Floating Panel - Measure Results and Layer Settings */}
          {Object.values(builderConfig?.settings?.control_positions ?? {}).some((arr) => (arr as ControlKey[]).includes("measure")) || activeRightComponent ? (
            <Box
              sx={{
                position: "absolute",
                right: getOccupiedSpace.right + 16,
                top: getOccupiedSpace.top + 16,
                bottom: getOccupiedSpace.bottom + 16,
                zIndex: 10000,
                pointerEvents: "none",
                transition: "all 0.3s",
                display: "flex",
                flexDirection: "row",
                alignItems: "flex-start",
                gap: 2,
              }}>
              {/* Measurement Results Panel */}
              {Object.values(builderConfig?.settings?.control_positions ?? {}).some((arr) => (arr as ControlKey[]).includes("measure")) && (
                <MeasureResultsPanel {...measureTool} />
              )}
              {/* Layer Settings Panel */}
              {activeRightComponent && (
                <FloatingPanel
                  width={activeRight === MapSidebarItemID.STYLE ? 320 : 400}
                  minHeight="auto"
                  maxHeight="50vh"
                  fillHeight={activeRight !== MapSidebarItemID.STYLE}>
                  <Box
                    sx={{
                      height: activeRight === MapSidebarItemID.STYLE ? "auto" : "100%",
                      display: "flex",
                      flexDirection: "column",
                    }}>
                    <ViewContainer
                      title={activeRightComponent.title}
                      disablePadding={true}
                      close={handleClose}
                      body={activeRightComponent.content}
                    />
                  </Box>
                </FloatingPanel>
              )}
            </Box>
          ) : null}

          {/* Bottom-right always renders because it permanently contains AttributionControl */}
          <Box
            sx={{
              position: "absolute",
              ...cornerSxMap["bottom-right"],
              m: 2,
              zIndex: 2,
              transition: "all 0.3s",
            }}>
            {(searchPanelOpen && controlsByCorner["bottom-right"].includes("location")
              ? (["location"] as ControlKey[])
              : controlsByCorner["bottom-right"]
            ).map((c) => renderControl(c, "bottom-right"))}
            {/* -8px pulls the strip down to sit flush with the map's bottom edge (cancels the residual bottom inset of this bottom-right control box). */}
            <Box sx={{ mb: "-8px" }}>
              <AttributionControl
                extraAttribution={
                  activeBasemap.source === "custom" ? activeBasemap.attribution : null
                }
              />
            </Box>
          </Box>

          {/* Scalebar — bottom-left is reserved exclusively for the scalebar */}
          {builderConfig?.settings?.scalebar !== false && (
            <Box
              sx={{
                position: "absolute",
                bottom: getOccupiedSpace.bottom,
                left: getOccupiedSpace.left,
                m: 2,
                zIndex: 2,
                pointerEvents: "none",
                transition: "all 0.3s",
              }}>
              <Scalebar />
            </Box>
          )}

          {/* Other corners only render when at least one control is assigned.
              bottom-left is reserved for the scalebar. */}
          {(["top-left", "top-right"] as CornerKey[]).map((corner) => {
            const controls = controlsByCorner[corner];
            if (controls.length === 0) return null;
            return (
              <Box
                key={corner}
                sx={{
                  position: "absolute",
                  ...cornerSxMap[corner],
                  m: 2,
                  zIndex: 2,
                  transition: "all 0.3s",
                }}>
                {(searchPanelOpen && controls.includes("location")
              ? (["location"] as ControlKey[])
              : controls
            ).map((c) => renderControl(c, corner))}
              </Box>
            );
          })}
          {/* Host for fixed-anchor feature popups. Sized to the visible
              map content area inside this layout's panel chrome.
              PopupFixedHost positions its content to one of this Box's 4
              corners, so the popup respects the layout's panels without
              any global state. Rendered inside the inner flex container
              (position: relative) so the absolute offsets resolve
              against the map-content area, not the viewport. */}
          <Box
            sx={{
              position: "absolute",
              top: getOccupiedSpace.top + 16,
              bottom: getOccupiedSpace.bottom + 16,
              left: getOccupiedSpace.left + 16,
              right:
                getOccupiedSpace.right +
                16 +
                (editorRightWidth ? editorRightWidth + 16 : 0),
              pointerEvents: "none",
              zIndex: (theme) => theme.zIndex.drawer + 2,
            }}>
            <MapFixedPopupSlot layers={projectLayers} />
          </Box>
        </Box>
      </Box>
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
    </Box>
  );
};

export default PublicProjectLayout;
