"use client";

import type { DraggableAttributes } from "@dnd-kit/core";
import type { SyntheticListenerMap } from "@dnd-kit/core/dist/hooks/utilities";
import { Box, IconButton, Tooltip, alpha, useTheme } from "@mui/material";
import type { SxProps, Theme } from "@mui/material";
import React from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

export interface ElementWrapperProps {
  children: React.ReactNode;
  isSelected: boolean;
  onSelect?: () => void;
  onDelete?: () => void;
  onDuplicate?: () => void;
  /** Additional drag attributes for dnd-kit */
  dragAttributes?: DraggableAttributes;
  /** Additional drag listeners for dnd-kit */
  dragListeners?: SyntheticListenerMap | { onMouseDown?: (e: React.MouseEvent) => void };
  /** Whether to show the drag handle in the control panel */
  showDragHandle?: boolean;
  /** Whether the element is currently being dragged */
  isDragging?: boolean;
  /** Custom cursor style */
  cursor?: string;
  /** Additional styles for the outer container */
  containerSx?: SxProps<Theme>;
  /** Additional styles for the content box */
  contentSx?: SxProps<Theme>;
  /** Children to render in the control panel after default buttons */
  controlPanelExtra?: React.ReactNode;
  /** Render resize handles when selected */
  renderResizeHandles?: () => React.ReactNode;
  /** Disable pointer events on content when not selected (for reports) */
  disableContentPointerEvents?: boolean;
}

/**
 * Shared wrapper component for widget/element items.
 * Provides consistent look and feel across builder and reports:
 * - Selection border highlighting
 * - Control panel with drag grip and delete button
 * - Hover state styling
 */
export const ElementWrapper: React.FC<ElementWrapperProps> = ({
  children,
  isSelected,
  onSelect,
  onDelete,
  onDuplicate,
  dragAttributes,
  dragListeners,
  showDragHandle = true,
  isDragging = false,
  cursor,
  containerSx,
  contentSx,
  controlPanelExtra,
  renderResizeHandles,
  disableContentPointerEvents = false,
}) => {
  const { t } = useTranslation("common");
  const theme = useTheme();

  const defaultCursor = isDragging ? "grabbing" : isSelected ? "grab" : "pointer";

  return (
    <Box
      onClick={(e) => {
        e.stopPropagation();
        onSelect?.();
      }}
      sx={{
        width: "100%",
        p: 1,
        pointerEvents: "all",
        position: "relative",
        "&:hover": {
          "& > .content-box": {
            borderColor: isSelected ? theme.palette.primary.main : alpha(theme.palette.primary.main, 0.4),
          },
        },
        ...containerSx,
      }}>
      {/* Control Panel - visible when selected */}
      {isSelected && (
        <Box
          sx={{
            position: "absolute",
            top: 8,
            right: 8,
            zIndex: 10,
            borderTopRightRadius: "1rem",
            borderTopLeftRadius: "0rem",
            borderBottomRightRadius: "0rem",
            borderBottomLeftRadius: "0.5rem",
            display: "flex",
            gap: 0.5,
            backgroundColor: theme.palette.primary.main,
            boxShadow: 0,
          }}>
          {showDragHandle && (
            <Tooltip title={t("drag_to_move")} placement="top" arrow>
              <IconButton
                sx={{ borderRadius: 0, color: "white", cursor: "move" }}
                {...(dragAttributes || {})}
                {...(dragListeners || {})}>
                <Icon iconName={ICON_NAME.GRIP_VERTICAL} style={{ fontSize: "12px" }} />
              </IconButton>
            </Tooltip>
          )}
          {controlPanelExtra}
          {onDuplicate && (
            <Tooltip title={t("duplicate")} placement="top" arrow>
              <IconButton
                aria-label={t("duplicate")}
                sx={{ borderRadius: 0, color: "white" }}
                onClick={(e) => {
                  e.stopPropagation();
                  onDuplicate();
                }}>
                <Icon iconName={ICON_NAME.CLONE} style={{ fontSize: "12px" }} />
              </IconButton>
            </Tooltip>
          )}
          {onDelete && (
            <Tooltip title={t("delete")} placement="top" arrow>
              <IconButton
                sx={{ borderRadius: 0, color: "white" }}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}>
                <Icon iconName={ICON_NAME.TRASH} style={{ fontSize: "12px" }} />
              </IconButton>
            </Tooltip>
          )}
        </Box>
      )}

      {/* Content box with border */}
      <Box
        className="content-box"
        sx={{
          borderRadius: 2,
          border: "2px solid",
          borderColor: isSelected ? theme.palette.primary.main : "transparent",
          transition: "border-color 0.2s ease",
          pointerEvents: disableContentPointerEvents && !isSelected ? "none" : "all",
          cursor: cursor ?? defaultCursor,
          ...contentSx,
        }}>
        {children}
      </Box>

      {/* Resize handles - rendered by parent if provided */}
      {isSelected && renderResizeHandles?.()}
    </Box>
  );
};

export default ElementWrapper;
