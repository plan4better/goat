import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Box, IconButton, Stack, Typography, useTheme } from "@mui/material";
import { alpha } from "@mui/material";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { setCollapsedPanels } from "@/lib/store/map/slice";
import type {
  BuilderPanelSchema,
  BuilderWidgetSchema,
  ProjectLayer,
  ProjectLayerGroup,
} from "@/lib/validations/project";
import type { TabsContainerSchema } from "@/lib/validations/widget";

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import ExpandCollapseButton from "@/components/builder/ExpandCollapsePanelButton";
import WidgetWrapper from "@/components/builder/widgets/WidgetWrapper";

export interface BuilderPanelSchemaWithPosition extends BuilderPanelSchema {
  orientation?: "horizontal" | "vertical";
  element: {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  };
}

interface ContainerProps {
  panel: BuilderPanelSchemaWithPosition; // A single panel
  projectLayers: ProjectLayer[];
  projectLayerGroups: ProjectLayerGroup[];
  selected?: boolean; // Whether the panel is selected
  onClick?: () => void;
  onChangeOrder?: (panelId: string, position: "top" | "bottom" | "left" | "right") => void;
  onWidgetDelete?: (widgetId: string) => void;
  onWidgetDuplicate?: (widgetId: string) => void;
  onWidgetUpdate?: (updatedWidget: BuilderWidgetSchema) => void;
  viewOnly?: boolean;
}

const ChangeOrderButton: React.FC<{
  onClick?: () => void;
  position: "left" | "top" | "bottom" | "right";
  iconName: ICON_NAME;
  isVisible: boolean;
}> = ({ onClick, position, iconName, isVisible }) => {
  const styles = {
    left: { position: "absolute", left: 0, top: "50%", transform: "translateY(-50%)" },
    top: { position: "absolute", top: 0, left: "50%", transform: "translateX(-50%)" },
    bottom: { position: "absolute", bottom: 0, left: "50%", transform: "translateX(-50%)" },
    right: { position: "absolute", right: 0, top: "50%", transform: "translateY(-50%)" },
  };

  return (
    <IconButton
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      sx={{
        ...styles[position],
        pointerEvents: isVisible ? "all" : "none",
        opacity: isVisible ? 1 : 0,
        backgroundColor: "background.default",
        transform: isVisible ? styles[position].transform : `${styles[position].transform} scale(0.9)`,
        transition: "opacity 0.3s, transform 0.3s",
        cursor: "pointer",
        "&:hover": {
          backgroundColor: "background.default",
          color: "primary.main",
        },
        zIndex: 2,
      }}>
      <Icon iconName={iconName} htmlColor="inherit" fontSize="small" />
    </IconButton>
  );
};

export const Container: React.FC<ContainerProps> = ({
  panel,
  projectLayers,
  projectLayerGroups,
  selected,
  onClick,
  onChangeOrder,
  onWidgetDelete,
  onWidgetDuplicate,
  onWidgetUpdate,
  viewOnly,
}) => {
  const theme = useTheme();
  const { t } = useTranslation("common");
  const [isHovered, setIsHovered] = useState(false);
  const handleMouseEnter = () => setIsHovered(true);
  const handleMouseLeave = () => setIsHovered(false);
  const dispatch = useAppDispatch();

  // Get all widget IDs that are assigned to tabs within THIS panel
  const widgetsAssignedToTabs = useMemo(() => {
    const assignedIds = new Set<string>();
    panel.widgets?.forEach((widget) => {
      if (widget.config?.type === "tabs") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tabsConfig = widget.config as any;
        tabsConfig.tabs?.forEach((tab: { widgetIds?: string[] }) => {
          tab.widgetIds?.forEach((id: string) => assignedIds.add(id));
        });
      }
    });
    return assignedIds;
  }, [panel.widgets]);

  // Filter widgets: show all widgets EXCEPT those assigned to tabs (unless they are tabs themselves)
  const visibleWidgets = useMemo(() => {
    return (
      panel.widgets?.filter(
        (widget) => widget.config?.type === "tabs" || !widgetsAssignedToTabs.has(widget.id)
      ) || []
    );
  }, [panel.widgets, widgetsAssignedToTabs]);

  const widgetIds = visibleWidgets.map((widget) => widget.id);
  const sortingStrategy =
    panel.orientation === "horizontal" ? horizontalListSortingStrategy : verticalListSortingStrategy;

  const { setNodeRef } = useDroppable({
    id: panel.id,
    data: panel,
  });

  const collapsedPanels = useAppSelector((state) => state.map.collapsedPanels);
  const isCollapsed = !!collapsedPanels?.[panel.id];

  const panelBgColor = panel.config?.appearance?.backgroundColor || theme.palette.background.paper;

  const handleToggleCollapse = () => {
    dispatch(setCollapsedPanels({ [panel.id]: !isCollapsed }));
  };

  const shouldForceFullWidth = (widget: BuilderWidgetSchema) => {
    if (widget.config?.type !== "tabs") return false;
    if (panel.orientation !== "horizontal") return false;
    return Boolean((widget.config as TabsContainerSchema)?.setup?.full_width);
  };

  const shouldFillAvailableHeight = (widget: BuilderWidgetSchema) => {
    return widget.config?.type === "tabs" || widget.config?.type === "table";
  };

  // In horizontal panels, widgets share width equally; tables/tabs fill height, others are capped
  const getHorizontalWidgetSx = (widget: BuilderWidgetSchema) => {
    if (panel.orientation !== "horizontal" || isCollapsed) return {};
    return {
      flex: "1 1 0%",
      minWidth: 0,
      height: "100%",
      overflow: shouldFillAvailableHeight(widget) ? "hidden" : "auto",
    };
  };

  const collapsedSize = 40; // width/height of mini sidebar

  return (
    // OUTER SECTION
    <Box
      ref={setNodeRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={onClick}
      sx={{
        ...panel.element,
        position: "absolute",
        ...(isHovered && !viewOnly && { outline: `1px solid ${theme.palette.primary.main}`, zIndex: 10 }),
        ...(selected && !viewOnly && { outline: `2px solid ${theme.palette.primary.main}`, zIndex: 11 }),
        cursor: "pointer",
        overflow: "hidden",
        transition: "all 0.3s",
        pointerEvents: "all",
        ...(viewOnly && {
          cursor: "default",
        }),
        ...(panel.config?.options?.style === "default" && {
          boxShadow: `rgba(0, 0, 0, 0.2) 0px 0px ${panel.config.appearance.shadow}px`,
        }),
        ...(isCollapsed && {
          ...(panel.orientation === "horizontal" && {
            height: collapsedSize,
          }),
          ...(panel.orientation === "vertical" && {
            width: collapsedSize,
          }),
        }),
      }}>
      {/* Conditional Buttons */}
      {!!panel.element?.left && !viewOnly && (
        <ChangeOrderButton
          onClick={() => onChangeOrder?.(panel.id, "left")}
          position="left"
          iconName={ICON_NAME.CHEVRON_LEFT}
          isVisible={isHovered}
        />
      )}
      {!!panel.element?.top && !viewOnly && (
        <ChangeOrderButton
          onClick={() => onChangeOrder?.(panel.id, "top")}
          position="top"
          iconName={ICON_NAME.CHEVRON_UP}
          isVisible={isHovered}
        />
      )}
      {!!panel.element?.bottom && !viewOnly && (
        <ChangeOrderButton
          onClick={() => onChangeOrder?.(panel.id, "bottom")}
          position="bottom"
          iconName={ICON_NAME.CHEVRON_DOWN}
          isVisible={isHovered}
        />
      )}
      {!!panel.element?.right && !viewOnly && (
        <ChangeOrderButton
          onClick={() => onChangeOrder?.(panel.id, "right")}
          position="right"
          iconName={ICON_NAME.CHEVRON_RIGHT}
          isVisible={isHovered}
        />
      )}
      <Box
        sx={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          ...(panel.orientation === "horizontal" && {
            flexDirection: "row",
          }),
          ...(panel.orientation === "vertical" && {
            flexDirection: "column",
          }),
          transition: "all 0.3s",
          ...(panel.config?.options?.style !== "default" && {
            justifyContent: panel.config?.position?.alignItems,
          }),
        }}>
        {/* INNER SECTION  */}
        <Stack
          direction="column"
          sx={{
            display: "flex",
            transition: "all 0.3s",
            // Apply default styles when collapsed, regardless of the original style
            ...(isCollapsed && {
              position: "relative",
              width: "100%",
              height: "100%",
              backgroundColor: alpha(panelBgColor, 0.7),
              boxShadow: `rgba(0,0,0,0.2) 0px 0px 4px`,
              borderRadius: 0,
              margin: 0,
              backdropFilter: "none",
            }),
            // Only apply special styles when NOT collapsed
            ...(!isCollapsed && {
              ...(panel.config?.options?.style === "default" && {
                width: "100%",
                height: "100%",
                backgroundColor: alpha(panelBgColor, panel.config?.appearance?.opacity),
                backdropFilter: `blur(${panel.config.appearance.backgroundBlur}px)`,
              }),
              ...(panel.config?.options?.style === "rounded" && {
                ...(panel.orientation === "horizontal" && {
                  height: "calc(100% - 1rem)",
                  width: "fit-content",
                  minWidth: "220px",
                }),
                ...(panel.orientation === "vertical" && {
                  height: "fit-content",
                  width: "calc(100% - 1rem)",
                  maxWidth: "calc(100% - 1rem)",
                  maxHeight: "calc(100% - 1rem)",
                }),
                borderRadius: "1rem",
                margin: "0.5rem",
                backgroundColor: alpha(panelBgColor, panel.config?.appearance?.opacity),
                backdropFilter: `blur(${panel.config.appearance.backgroundBlur}px)`,
                boxShadow: `rgba(0, 0, 0, 0.2) 0px 0px ${panel.config.appearance.shadow}px`,
              }),
              ...(panel.config?.options?.style === "floated" && {
                ...(panel.orientation === "horizontal" && {
                  width: "fit-content",
                  maxWidth: "100%",
                }),
                ...(panel.orientation === "vertical" && {
                  height: "fit-content",
                  maxHeight: "100%",
                }),
                borderRadius: "1rem",
                backgroundColor: "transparent",
              }),
              ...(panel.widgets?.length === 0 && {
                backgroundColor: alpha(panelBgColor, panel.config?.appearance?.opacity),
                ...(panel.config?.options?.style !== "default" && {
                  height: "calc(100% - 1rem)",
                  width: "calc(100% - 1rem)",
                }),
                ...(panel.config?.options?.style === "floated" && {
                  backdropFilter: `blur(${panel.config.appearance.backgroundBlur}px)`,
                  boxShadow: `rgba(0, 0, 0, 0.2) 0px 0px ${panel.config.appearance.shadow}px`,
                  margin: "0.5rem",
                }),
              }),
            }),
          }}>
          <Box
            sx={{
              width: "100%",
              height: "100%",
              display: "flex",
              position: "relative",
              alignSelf: "stretch",
              ...(panel.orientation === "horizontal" && {
                flexDirection: "row",
                overflow: isCollapsed ? "hidden" : "auto hidden",
              }),
              ...(panel.orientation === "vertical" && {
                flexDirection: "column",
                overflow: isCollapsed ? "hidden" : "hidden auto",
              }),
              gap: isCollapsed ? 0 : `${panel?.config?.position?.spacing}rem`,
              padding: isCollapsed ? 0 : `${panel?.config?.position?.padding ?? 0}rem`,
              transition: "all 0.3s",
              ...(panel.config?.options?.style === "default" && {
                justifyContent: panel.config?.position?.alignItems,
              }),
            }}>
            {/* Show empty message if widgets array is empty */}
            {visibleWidgets.length === 0 ? (
              <Stack
                width="100%"
                height="100%"
                alignItems="center"
                direction="column"
                display="flex"
                justifyContent="center">
                {!viewOnly && !isCollapsed && (
                  <>
                    <Icon
                      iconName={ICON_NAME.CUBE}
                      htmlColor={theme.palette.text.secondary}
                      fontSize="small"
                    />
                    <Typography variant="body2" fontWeight="bold" color="textSecondary">
                      {t("drag_and_drop_widgets_here")}
                    </Typography>
                  </>
                )}
              </Stack>
            ) : !viewOnly ? (
              <SortableContext items={widgetIds} strategy={sortingStrategy}>
                {visibleWidgets.map((widget) => (
                  <Box
                    key={widget.id}
                    sx={{
                      transition: "all 0.3s",
                      ...getHorizontalWidgetSx(widget),
                      // Hide widgets when collapsed but maintain their size for smooth transition
                      ...(isCollapsed && {
                        opacity: 0,
                        visibility: "hidden",
                        position: "absolute",
                      }),
                      ...(!isCollapsed && {
                        ...(shouldForceFullWidth(widget) && {
                          flex: "1 1 100%",
                          width: "100%",
                          minWidth: 0,
                        }),
                        ...(panel.orientation === "horizontal" && shouldFillAvailableHeight(widget) && {
                          flex: 1,
                          minHeight: 0,
                          overflow: "hidden",
                        }),
                        ...(panel.config?.options?.style === "floated" && {
                          justifyContent: "center",
                          alignItems: "center",
                          backgroundColor: alpha(
                            panelBgColor,
                            panel.config?.appearance?.opacity
                          ),
                          backdropFilter: `blur(${panel.config.appearance.backgroundBlur}px)`,
                          boxShadow: `rgba(0, 0, 0, 0.2) 0px 0px ${panel.config.appearance.shadow}px`,
                          margin: "0.5rem",
                          borderRadius: "1rem",
                          height: "fit-content",
                          width: "calc(100% - 1rem)",
                        }),
                      }),
                    }}>
                    <WidgetWrapper
                      widget={widget}
                      projectLayers={projectLayers}
                      projectLayerGroups={projectLayerGroups}
                      viewOnly={viewOnly}
                      onWidgetDelete={onWidgetDelete}
                      onWidgetDuplicate={onWidgetDuplicate}
                      onSelectPanel={onClick}
                      onWidgetUpdate={onWidgetUpdate}
                      panelWidgets={panel.widgets}
                    />
                  </Box>
                ))}
              </SortableContext>
            ) : (
              // Render normally if viewOnly
              visibleWidgets.map((widget) => (
                <Box
                  key={widget.id}
                  sx={{
                    transition: "all 0.3s",
                    ...getHorizontalWidgetSx(widget),
                    // Hide widgets when collapsed but maintain their size for smooth transition
                    ...(isCollapsed && {
                      opacity: 0,
                      visibility: "hidden",
                      position: "absolute",
                    }),
                    ...(!isCollapsed && {
                      ...(shouldForceFullWidth(widget) && {
                        flex: "1 1 100%",
                        width: "100%",
                        minWidth: 0,
                      }),
                      ...(panel.orientation === "horizontal" && shouldFillAvailableHeight(widget) && {
                        flex: 1,
                        minHeight: 0,
                        overflow: "hidden",
                      }),
                      ...(panel.config?.options?.style === "floated" && {
                        justifyContent: "center",
                        alignItems: "center",
                        backgroundColor: alpha(
                          panelBgColor,
                          panel.config?.appearance?.opacity
                        ),
                        backdropFilter: `blur(${panel.config.appearance.backgroundBlur}px)`,
                        boxShadow: `rgba(0, 0, 0, 0.2) 0px 0px ${panel.config.appearance.shadow}px`,
                        margin: "0.5rem",
                        borderRadius: "1rem",
                        height: "fit-content",
                        width: "calc(100% - 1rem)",
                      }),
                    }),
                  }}>
                  <WidgetWrapper
                    widget={widget}
                    projectLayers={projectLayers}
                    projectLayerGroups={projectLayerGroups}
                    viewOnly={viewOnly}
                    panelWidgets={panel.widgets}
                  />
                </Box>
              ))
            )}
          </Box>
          {isCollapsed && panel.config?.options?.collapsed_label && (
            <Box
              sx={{
                position: "absolute",
                inset: 0,
                display: "flex",
                // Vertical panels: label at top so it doesn't overlap the centered button.
                // Horizontal panels: label at left for the same reason.
                alignItems: panel.orientation === "vertical" ? "flex-start" : "center",
                justifyContent: panel.orientation === "horizontal" ? "flex-start" : "center",
                padding:
                  panel.orientation === "vertical"
                    ? "16px 8px 0 8px"
                    : "0 0 0 12px",
                pointerEvents: "none",
                overflow: "hidden",
                zIndex: 1,
              }}>
              <Box
                sx={(theme) => ({
                  fontSize: theme.typography.body2.fontSize,
                  fontWeight: 700,
                  lineHeight: theme.typography.body2.lineHeight,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  // Vertical panels run the text top-to-bottom (bottom-to-top on the
                  // left) with a real vertical box, so it starts at the panel's top
                  // edge and ends before the centered collapse button.
                  ...(panel.orientation === "vertical"
                    ? {
                        writingMode: "vertical-rl",
                        ...(panel.position === "left" && { transform: "rotate(180deg)" }),
                        maxHeight: "calc(50% - 40px)",
                      }
                    : { maxWidth: "80%" }),
                  userSelect: "none",
                  "& p": { margin: 0, display: "inline" },
                  "& a": { color: theme.palette.primary.main, textDecoration: "underline" },
                  "& .info-chip": {
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 14,
                    height: 14,
                    borderRadius: "50%",
                    border: `1.5px solid ${theme.palette.grey[500]}`,
                    backgroundColor: "transparent",
                    color: theme.palette.grey[500],
                    fontSize: 9,
                    fontWeight: 700,
                    fontStyle: "normal",
                    fontFamily: "serif",
                    lineHeight: 1,
                    verticalAlign: "middle",
                    marginInline: "2px",
                    boxSizing: "border-box",
                  },
                })}
                dangerouslySetInnerHTML={{ __html: panel.config.options.collapsed_label }}
              />
            </Box>
          )}
        </Stack>
        {panel.config?.options?.collapsible &&
          (panel.config?.options?.style === "default" || panel.config?.options?.style === "rounded") && (
            <ExpandCollapseButton
              position={panel.position}
              expanded={!isCollapsed}
              onClick={handleToggleCollapse}
              isVisible={viewOnly || isHovered || isCollapsed}
            />
          )}
      </Box>
    </Box>
  );
};
