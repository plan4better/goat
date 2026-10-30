import { Box, Tab, Tabs, Typography, useTheme } from "@mui/material";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { Icon, ICON_NAME } from "@p4b/ui/components/Icon";

import { emitInteractionEvent } from "@/lib/store/interaction/slice";
import type { ProjectLayer, ProjectLayerGroup, ProjectLayerTreeUpdate } from "@/lib/validations/project";
import type { LayerInformationSchema } from "@/lib/validations/widget";

import { useAppDispatch } from "@/hooks/store/ContextHooks";

import { MaskedImageIcon } from "@/components/map/panels/style/other/MaskedImageIcon";

import { ProjectLayerTree, VisibilityToggle } from "@/components/map/panels/layer/ProjectLayerTree";

/** Horizontal travel (px) before a touch counts as a group swipe rather than a tap or a scroll. */
const SWIPE_MIN_DISTANCE = 40;

interface TabsLayerLayoutProps {
  projectId: string;
  projectLayers: ProjectLayer[];
  projectLayerGroups: ProjectLayerGroup[];
  config: LayerInformationSchema;
  onTreeUpdate: (payload: ProjectLayerTreeUpdate) => Promise<void>;
  viewOnly?: boolean;
  downloadableLayers?: number[];
  simpleLegendLayerIds?: number[];
  hideLegendHeading?: boolean;
  groupIcons?: Record<string, { url: string; source?: string }>;
  dimOutOfZoom?: boolean;
  /** Content shown for a group tab instead of its layers, keyed by group ID */
  groupContent?: Record<number, React.ReactNode>;
}

const TabsLayerLayout = ({
  projectId,
  projectLayers,
  projectLayerGroups,
  config,
  onTreeUpdate,
  downloadableLayers,
  simpleLegendLayerIds,
  hideLegendHeading,
  groupIcons,
  dimOutOfZoom,
  groupContent,
}: TabsLayerLayoutProps) => {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const theme = useTheme();
  const options = config.options;

  const topLevelGroups = useMemo(
    () =>
      projectLayerGroups
        .filter((g) => !g.parent_id)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [projectLayerGroups]
  );

  const [activeTab, setActiveTab] = useState(0);
  const activeGroup = topLevelGroups[activeTab];

  const goToTab = useCallback(
    (index: number) => {
      setActiveTab(index);
      const group = topLevelGroups[index];
      if (group) {
        dispatch(emitInteractionEvent({ type: "group_activated", sourceId: group.id }));
      }
    },
    [topLevelGroups, dispatch]
  );

  // Horizontal swipe moves between groups on touch devices.
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    // Ignore pinch/multi-touch — those belong to the map or the browser
    touchStartRef.current =
      e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }, []);

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const start = touchStartRef.current;
      touchStartRef.current = null;
      if (!start || topLevelGroups.length < 2) return;

      const touch = e.changedTouches[0];
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      // Require a deliberate, horizontally-dominant gesture: scrolling a long
      // layer list vertically must never flip to another group.
      if (Math.abs(dx) < SWIPE_MIN_DISTANCE || Math.abs(dx) <= Math.abs(dy)) return;

      const next = activeTab + (dx < 0 ? 1 : -1);
      // No wrap-around — running off the end should feel like a wall, so the
      // tab strip stays the source of truth for where you are in the list.
      if (next < 0 || next >= topLevelGroups.length) return;
      goToTab(next);
    },
    [activeTab, topLevelGroups.length, goToTab]
  );

  // Filter layers to active group and strip group ID so they render as root items
  const activeGroupLayers = useMemo(() => {
    const layers = !activeGroup
      ? projectLayers
      : projectLayers.filter((l) => l.layer_project_group_id === activeGroup.id);
    return layers.map((l) => ({ ...l, layer_project_group_id: null }));
  }, [activeGroup, projectLayers]);

  // Wrap onTreeUpdate to restore the original group ID before sending updates
  const handleTreeUpdate = useCallback(
    async (payload: ProjectLayerTreeUpdate) => {
      const fixedPayload: ProjectLayerTreeUpdate = {
        items: payload.items.map((item) => {
          if (item.type === "layer" && activeGroup) {
            return { ...item, parent_id: activeGroup.id };
          }
          return item;
        }),
      };
      await onTreeUpdate(fixedPayload);
    },
    [onTreeUpdate, activeGroup]
  );

  const togglableLayers = useMemo(
    () => activeGroupLayers.filter((l) => l.type !== "table"),
    [activeGroupLayers]
  );

  const allVisible = useMemo(
    () => togglableLayers.every((l) => l.properties?.visibility !== false),
    [togglableLayers]
  );

  // Whether any layer in each top-level group is visible (for tab active state)
  const groupHasVisibleLayer = useMemo(() => {
    const map: Record<number, boolean> = {};
    for (const group of topLevelGroups) {
      map[group.id] = projectLayers.some(
        (l) => l.layer_project_group_id === group.id && l.properties?.visibility !== false
      );
    }
    return map;
  }, [topLevelGroups, projectLayers]);

  const handleToggleAll = useCallback(async () => {
    if (togglableLayers.length === 0) return;
    const newVisibility = !allVisible;
    const payload: ProjectLayerTreeUpdate = {
      items: togglableLayers.map((layer, index) => ({
        id: layer.id,
        type: "layer" as const,
        order: index,
        parent_id: null,
        properties: {
          ...(layer.properties ?? {}),
          visibility: newVisibility,
        },
      })),
    };
    togglableLayers.forEach((layer) => {
      dispatch(emitInteractionEvent({ type: "visibility_changed", sourceId: layer.id, value: newVisibility }));
    });
    try {
      await handleTreeUpdate(payload);
    } catch {
      toast.error(t("error_updating_visibility"));
    }
  }, [togglableLayers, allVisible, dispatch, handleTreeUpdate, t]);

  if (topLevelGroups.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ p: 2, textAlign: "center" }}>
        {t("no_groups_found")}
      </Typography>
    );
  }

  const iconOnly = options?.show_group_name === false;
  const togglePosition = options?.toggle_position ?? "left";
  const showAllToggle = options?.show_all_toggle !== false && togglableLayers.length > 0;

  return (
    // `swiper-no-swiping` is Swiper's built-in opt-out class. On mobile these
    // widgets sit inside a horizontal Swiper that pages between dashboard
    // panels; without this, that swiper claims every horizontal gesture and
    // the group swipe below never fires. Two carousels cannot share an axis.
    // Inert on desktop, where there is no Swiper.
    <Box className="swiper-no-swiping">
      <Tabs
        value={activeTab}
        onChange={(_, newValue) => goToTab(newValue)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ borderBottom: 1, borderColor: "divider", minHeight: 32 }}>
        {topLevelGroups.map((group) => {
          const iconColor = groupHasVisibleLayer[group.id]
            ? theme.palette.action.active
            : theme.palette.text.disabled;
          return (
            <Tab
              key={group.id}
              label={
                iconOnly ? undefined : (
                  <Box component="span" sx={{ display: "inline-flex", alignItems: "center" }}>
                    {group.name}
                  </Box>
                )
              }
              icon={
                options?.show_group_icons ? (
                  groupIcons?.[`group_icon_${group.id}`]?.url ? (
                    <MaskedImageIcon
                      imageUrl={groupIcons[`group_icon_${group.id}`].url}
                      dimension="16px"
                      applyMask={groupIcons[`group_icon_${group.id}`].source === "library"}
                      imgColor={iconColor}
                    />
                  ) : (
                    <Icon iconName={ICON_NAME.LAYERS} style={{ fontSize: 14, color: iconColor }} />
                  )
                ) : undefined
              }
              iconPosition="start"
              sx={{
                minHeight: 32,
                textTransform: "none",
                fontSize: "0.8125rem",
                py: 0,
                ...(iconOnly && { minWidth: 40, px: 0.5 }),
              }}
            />
          );
        })}
      </Tabs>
      {/* Swipe handlers sit here rather than on the wrapper so they exclude the
          tab strip above — that strip is `variant="scrollable"` and owns its own
          horizontal drag when the groups overflow. */}
      <Box onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
        {/* A group shown one layer at a time gets its switcher instead of the tree */}
        {activeGroup && groupContent?.[activeGroup.id] ? (
          // Keep slider drags from reaching the swipe handlers, which would change the tab
          <Box
            sx={{ px: 1, py: 1 }}
            onTouchStart={(e) => e.stopPropagation()}
            onTouchEnd={(e) => e.stopPropagation()}>
            {groupContent[activeGroup.id]}
          </Box>
        ) : (
          /* Reuse ProjectLayerTree — same rendering as tree mode, just filtered to active group */
          <ProjectLayerTree
            projectId={projectId}
            projectLayers={activeGroupLayers}
            projectLayerGroups={[]}
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
            simpleLegendLayerIds={simpleLegendLayerIds}
            hideLegendHeading={hideLegendHeading}
            groupIcons={groupIcons}
            dimOutOfZoom={dimOutOfZoom}
            headerContent={
              showAllToggle ? (
                <Box
                  onClick={handleToggleAll}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    py: 0.25,
                    mb: 0.5,
                    borderBottom: 1,
                    borderColor: "divider",
                    cursor: "pointer",
                    "&:hover": { bgcolor: "action.hover" },
                  }}>
                  {togglePosition === "left" && (
                    <Box onClick={(e) => e.stopPropagation()} sx={{ display: "flex", alignItems: "center" }}>
                      <VisibilityToggle
                        toggleStyle={options?.toggle_style ?? "eye"}
                        visible={allVisible}
                        compact
                        onToggle={handleToggleAll}
                      />
                    </Box>
                  )}
                  <Typography variant="body2" sx={{ flex: 1, fontWeight: 500 }}>
                    {t("show_all")}
                  </Typography>
                  {togglePosition !== "left" && (
                    <Box
                      onClick={(e) => e.stopPropagation()}
                      sx={{ display: "flex", alignItems: "center", pl: 1 }}>
                      <VisibilityToggle
                        toggleStyle={options?.toggle_style ?? "eye"}
                        visible={allVisible}
                        onToggle={handleToggleAll}
                      />
                    </Box>
                  )}
                </Box>
              ) : undefined
            }
          />
        )}
      </Box>
    </Box>
  );
};

export default TabsLayerLayout;
