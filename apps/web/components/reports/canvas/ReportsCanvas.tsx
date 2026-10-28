"use client";

import { useDroppable } from "@dnd-kit/core";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import FullscreenIcon from "@mui/icons-material/Fullscreen";
import NextIcon from "@mui/icons-material/NavigateNext";
import PrevIcon from "@mui/icons-material/NavigateBefore";
import RemoveIcon from "@mui/icons-material/Remove";
import { Box, IconButton, Stack, Tooltip, Typography, useTheme } from "@mui/material";
import { styled } from "@mui/material/styles";
import type { StyleSpecification } from "maplibre-gl";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Rnd } from "react-rnd";

import ThemeProvider from "@p4b/ui/theme/ThemeProvider";

import type { AtlasPage } from "@/lib/print/atlas-utils";
import { resolveElementFrame } from "@/lib/print/elementFrame";
import { mmToPx, pxToMm, resolvePageMm } from "@/lib/print/units";
import { setReportCanvasZoom } from "@/lib/store/map/slice";
import type { Project } from "@/lib/validations/project";
import type { ReportElement, ReportLayoutConfig } from "@/lib/validations/reportLayout";

import type { MapLayer } from "@/hooks/map/useMapLayers";
import { useBasemap } from "@/hooks/map/MapHooks";
import { useAtlasFeatures } from "@/hooks/reports/useAtlasFeatures";
import { usePrintConfig } from "@/hooks/reports/usePrintConfig";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { FixedRulerWrapper, RULER_SIZE } from "@/components/reports/canvas/Ruler";
import { ElementContentRenderer } from "@/components/reports/elements/renderers/ElementRenderers";

// Zoom levels
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.1;

// Snapping configuration
const SNAP_THRESHOLD_PX = 8; // Distance in pixels to trigger snap

// Snap guide types
interface SnapGuide {
  position: number; // Position in pixels
  orientation: "horizontal" | "vertical";
  type: "edge" | "center" | "margin";
}

// Default DPI for screen preview (standard screen resolution)
const SCREEN_DPI = 96;

// Minimum element size in mm
const MIN_ELEMENT_SIZE_MM = 10;

// Light theme settings for paper content - elements on paper should always render with light theme
// since the paper is white regardless of the app's dark/light mode
const PAPER_LIGHT_THEME_SETTINGS = {
  mode: "light" as const,
  locale: "en",
};

const CanvasContainer = styled(Box)(({ theme }) => ({
  flex: 1,
  minWidth: 0, // Important: allows flex child to shrink
  position: "relative",
  overflow: "hidden",
  backgroundColor: theme.palette.background.default,
}));

// Inner flex container for proper layout
const CanvasInner = styled(Box)({
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
});

// Styled wrapper for element content that removes internal padding/gaps
const ElementContentWrapper = styled(Box)({
  height: "100%",
  // Remove TipTap editor padding
  "& .ProseMirror": {
    padding: 0,
    margin: 0,
  },
  // Remove gutterBottom margins from Typography
  "& .MuiTypography-gutterBottom": {
    marginBottom: 0,
  },
  // Remove minHeight from chart containers
  "& > .MuiBox-root": {
    minHeight: "unset",
  },
});

const CanvasArea = styled(Box)({
  overflow: "auto",
  position: "absolute",
});

interface PaperProps {
  paperWidth: number;
  paperHeight: number;
  zoom: number;
  isOver: boolean;
}

const Paper = styled(Box, {
  shouldForwardProp: (prop) => !["paperWidth", "paperHeight", "zoom", "isOver"].includes(prop as string),
})<PaperProps>(({ theme, paperWidth, paperHeight, zoom, isOver }) => ({
  width: `${paperWidth * zoom}px`,
  height: `${paperHeight * zoom}px`,
  backgroundColor: "#ffffff",
  boxShadow: theme.shadows[4],
  position: "relative",
  flexShrink: 0,
  transition: "box-shadow 0.2s ease",
  border: isOver ? `2px dashed ${theme.palette.primary.main}` : "none",
}));

// Margin overlay to show printable area
interface MarginOverlayProps {
  margins: { top: number; right: number; bottom: number; left: number };
  zoom: number;
}

const MarginOverlay = styled(Box, {
  shouldForwardProp: (prop) => !["margins", "zoom"].includes(prop as string),
})<MarginOverlayProps>(({ margins, zoom }) => ({
  position: "absolute",
  top: mmToPx(margins.top, SCREEN_DPI) * zoom,
  right: mmToPx(margins.right, SCREEN_DPI) * zoom,
  bottom: mmToPx(margins.bottom, SCREEN_DPI) * zoom,
  left: mmToPx(margins.left, SCREEN_DPI) * zoom,
  border: "none", // Removed dashed border - users might expect it to print
  pointerEvents: "none",
}));

// Snap guide line component
interface SnapGuideLineProps {
  guide: SnapGuide;
  paperWidth: number;
  paperHeight: number;
}

const SnapGuideLine = styled(Box, {
  shouldForwardProp: (prop) => !["guide", "paperWidth", "paperHeight"].includes(prop as string),
})<SnapGuideLineProps>(({ guide, paperWidth, paperHeight }) => ({
  position: "absolute",
  pointerEvents: "none",
  zIndex: 1000,
  ...(guide.orientation === "vertical"
    ? {
        left: guide.position,
        top: 0,
        width: 0,
        height: paperHeight,
        borderLeft: "1px dashed #f50057",
      }
    : {
        top: guide.position,
        left: 0,
        height: 0,
        width: paperWidth,
        borderTop: "1px dashed #f50057",
      }),
}));

// Utility function to calculate snap guides from elements and page boundaries
const calculateSnapPoints = (
  elements: ReportElement[],
  currentElementId: string,
  paperWidthPx: number,
  paperHeightPx: number,
  margins: { top: number; right: number; bottom: number; left: number },
  zoom: number
): { horizontal: number[]; vertical: number[] } => {
  const horizontal: number[] = [];
  const vertical: number[] = [];

  // Page edges
  vertical.push(0); // Left edge
  vertical.push(paperWidthPx * zoom); // Right edge
  vertical.push((paperWidthPx * zoom) / 2); // Center vertical
  horizontal.push(0); // Top edge
  horizontal.push(paperHeightPx * zoom); // Bottom edge
  horizontal.push((paperHeightPx * zoom) / 2); // Center horizontal

  // Margin guides
  const marginLeft = mmToPx(margins.left, SCREEN_DPI) * zoom;
  const marginRight = paperWidthPx * zoom - mmToPx(margins.right, SCREEN_DPI) * zoom;
  const marginTop = mmToPx(margins.top, SCREEN_DPI) * zoom;
  const marginBottom = paperHeightPx * zoom - mmToPx(margins.bottom, SCREEN_DPI) * zoom;

  vertical.push(marginLeft);
  vertical.push(marginRight);
  horizontal.push(marginTop);
  horizontal.push(marginBottom);

  // Other elements' edges and centers
  elements
    .filter((el) => el.id !== currentElementId)
    .forEach((el) => {
      const elX = mmToPx(el.position.x, SCREEN_DPI) * zoom;
      const elY = mmToPx(el.position.y, SCREEN_DPI) * zoom;
      const elW = mmToPx(el.position.width, SCREEN_DPI) * zoom;
      const elH = mmToPx(el.position.height, SCREEN_DPI) * zoom;

      // Vertical snap points (for x position)
      vertical.push(elX); // Left edge
      vertical.push(elX + elW); // Right edge
      vertical.push(elX + elW / 2); // Center

      // Horizontal snap points (for y position)
      horizontal.push(elY); // Top edge
      horizontal.push(elY + elH); // Bottom edge
      horizontal.push(elY + elH / 2); // Center
    });

  return { horizontal, vertical };
};

// Find nearest snap point within threshold
const findSnapPosition = (
  value: number,
  snapPoints: number[],
  threshold: number
): { snapped: number; guide: number | null } => {
  let nearest = value;
  let nearestDist = Infinity;
  let guide: number | null = null;

  for (const point of snapPoints) {
    const dist = Math.abs(value - point);
    if (dist < threshold && dist < nearestDist) {
      nearest = point;
      nearestDist = dist;
      guide = point;
    }
  }

  return { snapped: nearest, guide };
};

const ToolbarContainer = styled(Box)(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: theme.spacing(1),
  gap: theme.spacing(1),
  backgroundColor: theme.palette.background.default,
  borderTop: `1px solid ${theme.palette.divider}`,
  flexShrink: 0, // Prevent toolbar from shrinking
}));

const ToolButton = styled(IconButton)(({ theme }) => ({
  backgroundColor: theme.palette.background.paper,
  border: `1px solid ${theme.palette.divider}`,
  borderRadius: "50%",
  width: 40,
  height: 40,
  "&:hover": {
    backgroundColor: theme.palette.action.hover,
  },
}));

// Element renderer component with drag and resize using react-rnd
interface ReportElementRendererProps {
  element: ReportElement;
  zoom: number;
  isSelected: boolean;
  basemapUrl?: string | StyleSpecification;
  projectLayers?: MapLayer[];
  /** The project's number locale. */
  locale?: string;
  allElements: ReportElement[];
  paperWidthPx: number;
  paperHeightPx: number;
  margins: { top: number; right: number; bottom: number; left: number };
  isSnappingEnabled: boolean;
  activeSnapGuides: SnapGuide[];
  atlasPage?: AtlasPage | null;
  featureAttributes?: string[];
  onSnapGuidesChange: (guides: SnapGuide[]) => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onUpdate: (id: string, updates: Partial<ReportElement>) => void;
  onInteractionEnd?: () => void;
}

const ReportElementRenderer: React.FC<ReportElementRendererProps> = ({
  element,
  zoom,
  isSelected,
  basemapUrl,
  projectLayers,
  locale,
  allElements,
  paperWidthPx,
  paperHeightPx,
  margins,
  isSnappingEnabled,
  atlasPage,
  featureAttributes,
  onSnapGuidesChange,
  onSelect,
  onDelete,
  onUpdate,
  onInteractionEnd,
}) => {
  const { t } = useTranslation("common");
  const theme = useTheme();

  // Track if map element is in navigation mode (to disable widget dragging)
  const [isMapNavigating, setIsMapNavigating] = useState(false);

  // Convert mm position to pixels for display
  const x = mmToPx(element.position.x, SCREEN_DPI) * zoom;
  const y = mmToPx(element.position.y, SCREEN_DPI) * zoom;
  const width = mmToPx(element.position.width, SCREEN_DPI) * zoom;
  const height = mmToPx(element.position.height, SCREEN_DPI) * zoom;

  // Minimum size in pixels (accounting for zoom)
  // Dividers can be very thin, so allow smaller minimum height for them
  const minWidth = mmToPx(MIN_ELEMENT_SIZE_MM, SCREEN_DPI) * zoom;
  const minHeightMm = element.type === "divider" ? 1 : MIN_ELEMENT_SIZE_MM;
  const minHeight = mmToPx(minHeightMm, SCREEN_DPI) * zoom;

  // Calculate snap points from other elements and page boundaries
  const snapPoints = useMemo(
    () => calculateSnapPoints(allElements, element.id, paperWidthPx, paperHeightPx, margins, zoom),
    [allElements, element.id, paperWidthPx, paperHeightPx, margins, zoom]
  );

  // Handle click to select
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onSelect(element.id);
    },
    [element.id, onSelect]
  );

  // Handle drag with snapping
  const handleDrag = useCallback(
    (_e: unknown, data: { x: number; y: number }) => {
      // Skip snapping if disabled
      if (!isSnappingEnabled) {
        onSnapGuidesChange([]);
        return;
      }

      const guides: SnapGuide[] = [];

      // Check snapping for all edges of the dragged element
      const elementRight = data.x + width;
      const elementBottom = data.y + height;
      const elementCenterX = data.x + width / 2;
      const elementCenterY = data.y + height / 2;

      // Check left edge, right edge, and center for vertical snapping
      const leftSnap = findSnapPosition(data.x, snapPoints.vertical, SNAP_THRESHOLD_PX);
      const rightSnap = findSnapPosition(elementRight, snapPoints.vertical, SNAP_THRESHOLD_PX);
      const centerXSnap = findSnapPosition(elementCenterX, snapPoints.vertical, SNAP_THRESHOLD_PX);

      // Check top edge, bottom edge, and center for horizontal snapping
      const topSnap = findSnapPosition(data.y, snapPoints.horizontal, SNAP_THRESHOLD_PX);
      const bottomSnap = findSnapPosition(elementBottom, snapPoints.horizontal, SNAP_THRESHOLD_PX);
      const centerYSnap = findSnapPosition(elementCenterY, snapPoints.horizontal, SNAP_THRESHOLD_PX);

      // Add active guides
      if (leftSnap.guide !== null) {
        guides.push({ position: leftSnap.guide, orientation: "vertical", type: "edge" });
      }
      if (rightSnap.guide !== null && rightSnap.guide !== leftSnap.guide) {
        guides.push({ position: rightSnap.guide, orientation: "vertical", type: "edge" });
      }
      if (
        centerXSnap.guide !== null &&
        centerXSnap.guide !== leftSnap.guide &&
        centerXSnap.guide !== rightSnap.guide
      ) {
        guides.push({ position: centerXSnap.guide, orientation: "vertical", type: "center" });
      }
      if (topSnap.guide !== null) {
        guides.push({ position: topSnap.guide, orientation: "horizontal", type: "edge" });
      }
      if (bottomSnap.guide !== null && bottomSnap.guide !== topSnap.guide) {
        guides.push({ position: bottomSnap.guide, orientation: "horizontal", type: "edge" });
      }
      if (
        centerYSnap.guide !== null &&
        centerYSnap.guide !== topSnap.guide &&
        centerYSnap.guide !== bottomSnap.guide
      ) {
        guides.push({ position: centerYSnap.guide, orientation: "horizontal", type: "center" });
      }

      onSnapGuidesChange(guides);
    },
    [width, height, snapPoints, onSnapGuidesChange, isSnappingEnabled]
  );

  // Handle drag stop - convert pixels back to mm with snapping
  const handleDragStop = useCallback(
    (_e: unknown, data: { x: number; y: number }) => {
      // Clear snap guides
      onSnapGuidesChange([]);

      let snappedX = data.x;
      let snappedY = data.y;

      // Only apply snapping if enabled
      if (isSnappingEnabled) {
        const elementRight = data.x + width;
        const elementBottom = data.y + height;
        const elementCenterX = data.x + width / 2;
        const elementCenterY = data.y + height / 2;

        // Find best snap for X (prioritize left edge, then right, then center)
        const leftSnap = findSnapPosition(data.x, snapPoints.vertical, SNAP_THRESHOLD_PX);
        const rightSnap = findSnapPosition(elementRight, snapPoints.vertical, SNAP_THRESHOLD_PX);
        const centerXSnap = findSnapPosition(elementCenterX, snapPoints.vertical, SNAP_THRESHOLD_PX);

        if (leftSnap.guide !== null) {
          snappedX = leftSnap.snapped;
        } else if (rightSnap.guide !== null) {
          snappedX = rightSnap.snapped - width;
        } else if (centerXSnap.guide !== null) {
          snappedX = centerXSnap.snapped - width / 2;
        }

        // Find best snap for Y (prioritize top edge, then bottom, then center)
        const topSnap = findSnapPosition(data.y, snapPoints.horizontal, SNAP_THRESHOLD_PX);
        const bottomSnap = findSnapPosition(elementBottom, snapPoints.horizontal, SNAP_THRESHOLD_PX);
        const centerYSnap = findSnapPosition(elementCenterY, snapPoints.horizontal, SNAP_THRESHOLD_PX);

        if (topSnap.guide !== null) {
          snappedY = topSnap.snapped;
        } else if (bottomSnap.guide !== null) {
          snappedY = bottomSnap.snapped - height;
        } else if (centerYSnap.guide !== null) {
          snappedY = centerYSnap.snapped - height / 2;
        }
      }

      const newXMm = pxToMm(snappedX / zoom, SCREEN_DPI);
      const newYMm = pxToMm(snappedY / zoom, SCREEN_DPI);

      onUpdate(element.id, {
        position: {
          ...element.position,
          x: Math.max(0, newXMm),
          y: Math.max(0, newYMm),
        },
      });
      onInteractionEnd?.();
    },
    [
      element.id,
      element.position,
      onUpdate,
      onInteractionEnd,
      zoom,
      width,
      height,
      snapPoints,
      onSnapGuidesChange,
      isSnappingEnabled,
    ]
  );

  // Handle resize - show snap guides during resize
  const handleResize = useCallback(
    (
      _e: unknown,
      direction: string,
      ref: HTMLElement,
      _delta: unknown,
      position: { x: number; y: number }
    ) => {
      if (!isSnappingEnabled) return;

      const currentWidth = ref.offsetWidth;
      const currentHeight = ref.offsetHeight;
      const guides: SnapGuide[] = [];

      // Calculate current edges based on resize direction
      const left = position.x;
      const right = position.x + currentWidth;
      const top = position.y;
      const bottom = position.y + currentHeight;

      // Check which edges are being resized and show guides for those
      const isResizingLeft = direction.includes("Left") || direction === "left";
      const isResizingRight = direction.includes("Right") || direction === "right";
      const isResizingTop = direction.includes("top") || direction === "Top";
      const isResizingBottom = direction.includes("bottom") || direction === "Bottom";

      // Check snap for the edges being resized
      if (isResizingLeft) {
        const leftSnap = findSnapPosition(left, snapPoints.vertical, SNAP_THRESHOLD_PX);
        if (leftSnap.guide !== null) {
          guides.push({ position: leftSnap.guide, orientation: "vertical", type: "edge" });
        }
      }
      if (isResizingRight) {
        const rightSnap = findSnapPosition(right, snapPoints.vertical, SNAP_THRESHOLD_PX);
        if (rightSnap.guide !== null) {
          guides.push({ position: rightSnap.guide, orientation: "vertical", type: "edge" });
        }
      }
      if (isResizingTop) {
        const topSnap = findSnapPosition(top, snapPoints.horizontal, SNAP_THRESHOLD_PX);
        if (topSnap.guide !== null) {
          guides.push({ position: topSnap.guide, orientation: "horizontal", type: "edge" });
        }
      }
      if (isResizingBottom) {
        const bottomSnap = findSnapPosition(bottom, snapPoints.horizontal, SNAP_THRESHOLD_PX);
        if (bottomSnap.guide !== null) {
          guides.push({ position: bottomSnap.guide, orientation: "horizontal", type: "edge" });
        }
      }

      onSnapGuidesChange(guides);
    },
    [snapPoints, onSnapGuidesChange, isSnappingEnabled]
  );

  // Handle resize stop - convert pixels back to mm with snapping
  const handleResizeStop = useCallback(
    (
      _e: unknown,
      direction: string,
      ref: HTMLElement,
      _delta: unknown,
      position: { x: number; y: number }
    ) => {
      // Clear snap guides
      onSnapGuidesChange([]);

      let newX = position.x;
      let newY = position.y;
      let newWidth = ref.offsetWidth;
      let newHeight = ref.offsetHeight;

      // Only apply snapping if enabled
      if (isSnappingEnabled) {
        const left = position.x;
        const right = position.x + newWidth;
        const top = position.y;
        const bottom = position.y + newHeight;

        // Check which edges are being resized
        const isResizingLeft = direction.includes("Left") || direction === "left";
        const isResizingRight = direction.includes("Right") || direction === "right";
        const isResizingTop = direction.includes("top") || direction === "Top";
        const isResizingBottom = direction.includes("bottom") || direction === "Bottom";

        // Snap left edge (changes position and width)
        if (isResizingLeft) {
          const leftSnap = findSnapPosition(left, snapPoints.vertical, SNAP_THRESHOLD_PX);
          if (leftSnap.guide !== null) {
            const diff = left - leftSnap.snapped;
            newX = leftSnap.snapped;
            newWidth = newWidth + diff;
          }
        }

        // Snap right edge (changes only width)
        if (isResizingRight) {
          const rightSnap = findSnapPosition(right, snapPoints.vertical, SNAP_THRESHOLD_PX);
          if (rightSnap.guide !== null) {
            newWidth = rightSnap.snapped - newX;
          }
        }

        // Snap top edge (changes position and height)
        if (isResizingTop) {
          const topSnap = findSnapPosition(top, snapPoints.horizontal, SNAP_THRESHOLD_PX);
          if (topSnap.guide !== null) {
            const diff = top - topSnap.snapped;
            newY = topSnap.snapped;
            newHeight = newHeight + diff;
          }
        }

        // Snap bottom edge (changes only height)
        if (isResizingBottom) {
          const bottomSnap = findSnapPosition(bottom, snapPoints.horizontal, SNAP_THRESHOLD_PX);
          if (bottomSnap.guide !== null) {
            newHeight = bottomSnap.snapped - newY;
          }
        }
      }

      const newWidthMm = pxToMm(newWidth / zoom, SCREEN_DPI);
      const newHeightMm = pxToMm(newHeight / zoom, SCREEN_DPI);
      const newXMm = pxToMm(newX / zoom, SCREEN_DPI);
      const newYMm = pxToMm(newY / zoom, SCREEN_DPI);

      onUpdate(element.id, {
        position: {
          ...element.position,
          x: Math.max(0, newXMm),
          y: Math.max(0, newYMm),
          width: newWidthMm,
          height: newHeightMm,
        },
        // A scalebar's rectangle is refit to its bar after the update; the
        // dragged width is the maximum the bar may grow to.
        ...(element.type === "scalebar" && {
          config: { ...element.config, maxWidthMm: newWidthMm },
        }),
      });
      onInteractionEnd?.();
    },
    [
      element.id,
      element.type,
      element.config,
      element.position,
      onUpdate,
      onInteractionEnd,
      zoom,
      snapPoints,
      onSnapGuidesChange,
      isSnappingEnabled,
    ]
  );

  // Custom resize handle styles
  const resizeHandleStyles = {
    width: 10,
    height: 10,
    backgroundColor: theme.palette.primary.main,
    border: `1px solid ${theme.palette.background.paper}`,
    borderRadius: "2px",
  };

  const resizeHandleClasses = isSelected
    ? {
        topLeft: { ...resizeHandleStyles, top: -5, left: -5 },
        top: { ...resizeHandleStyles, top: -5, left: "50%", marginLeft: -5 },
        topRight: { ...resizeHandleStyles, top: -5, right: -5 },
        right: { ...resizeHandleStyles, top: "50%", right: -5, marginTop: -5 },
        bottomRight: { ...resizeHandleStyles, bottom: -5, right: -5 },
        bottom: { ...resizeHandleStyles, bottom: -5, left: "50%", marginLeft: -5 },
        bottomLeft: { ...resizeHandleStyles, bottom: -5, left: -5 },
        left: { ...resizeHandleStyles, top: "50%", left: -5, marginTop: -5 },
      }
    : undefined;

  const frame = resolveElementFrame(element.style, zoom);

  return (
    <Rnd
      position={{ x, y }}
      size={{ width, height }}
      minWidth={minWidth}
      minHeight={minHeight}
      onDrag={handleDrag}
      onDragStop={handleDragStop}
      onResize={handleResize}
      onResizeStop={handleResizeStop}
      enableResizing={isSelected && !isMapNavigating}
      disableDragging={!isSelected || isMapNavigating}
      cancel=".ProseMirror, .tiptap-toolbar, .MuiMenu-root, .MuiPopover-root, .legend-editable-text"
      bounds="parent"
      style={{
        zIndex: element.position.z_index,
        pointerEvents: isMapNavigating ? "none" : "auto",
      }}
      resizeHandleStyles={resizeHandleClasses}>
      <Box
        onClick={handleClick}
        sx={{
          width: "100%",
          height: "100%",
          backgroundColor: frame.backgroundColor,
          border: frame.border,
          // Selection indicator uses outline (doesn't affect layout/content position)
          outline: isSelected ? `2px solid ${theme.palette.primary.main}` : "none",
          outlineOffset: 0,
          borderRadius: 0,
          overflow: "hidden",
          cursor: isMapNavigating ? "default" : isSelected ? "move" : "pointer",
          pointerEvents: "auto",
          transition: "outline-color 0.2s ease",
          "&:hover": {
            outlineColor: isSelected ? theme.palette.primary.main : theme.palette.primary.light,
          },
        }}>
        {/* Quick actions toolbar - visible when selected */}
        {isSelected && (
          <Box
            onMouseDown={(e) => e.stopPropagation()}
            sx={{
              position: "absolute",
              top: 4,
              right: 4,
              zIndex: 10,
              display: "flex",
              gap: 0.5,
              backgroundColor: theme.palette.error.main,
              borderRadius: 1,
              padding: "2px",
            }}>
            <Tooltip title={t("delete")} placement="top" arrow>
              <IconButton
                size="small"
                disableRipple
                disableFocusRipple
                disableTouchRipple
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(element.id);
                }}
                sx={{
                  width: 24,
                  height: 24,
                  color: "white",
                  "&:hover": {
                    backgroundColor: "transparent",
                  },
                }}>
                <DeleteIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
          </Box>
        )}

        {/* Element content */}
        <ElementContentWrapper sx={{ pointerEvents: isSelected ? "auto" : "none" }}>
          <ElementContentRenderer
            element={element}
            allElements={allElements}
            width={width}
            height={height}
            zoom={zoom}
            basemapUrl={basemapUrl}
            projectLayers={projectLayers}
            locale={locale}
            atlasPage={atlasPage}
            featureAttributes={featureAttributes}
            viewOnly={!isSelected}
            onElementUpdate={(elementId, config) => {
              // Update element config (e.g., map view state)
              onUpdate(elementId, { config });
            }}
            onNavigationModeChange={setIsMapNavigating}
          />
        </ElementContentWrapper>
      </Box>
    </Rnd>
  );
};

interface ReportsCanvasProps {
  project?: Project;
  projectLayers?: MapLayer[];
  reportConfig?: ReportLayoutConfig;
  selectedElementId?: string | null;
  onElementSelect?: (elementId: string | null) => void;
  onElementUpdate?: (elementId: string, updates: Partial<ReportElement>) => void;
  onElementDelete?: (elementId: string) => void;
}

const ReportsCanvas: React.FC<ReportsCanvasProps> = ({
  project,
  projectLayers,
  reportConfig,
  selectedElementId,
  onElementSelect,
  onElementUpdate,
  onElementDelete,
}) => {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const zoom = useAppSelector((state) => state.map.reportCanvasZoom);
  // Read through a ref so setZoom stays referentially stable: listeners bound once
  // (the ctrl+wheel handler) would otherwise keep resolving the functional form
  // against the zoom captured when they were bound.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const setZoom = useCallback(
    (val: number | ((prev: number) => number)) => {
      dispatch(setReportCanvasZoom(typeof val === "function" ? val(zoomRef.current) : val));
    },
    [dispatch]
  );
  // Set once the user picks their own zoom level, which stops the auto-fit below.
  const hasUserZoomedRef = useRef(false);
  const [atlasPageIndex, setAtlasPageIndex] = useState(0);
  const paperRef = useRef<HTMLDivElement>(null);
  const canvasWrapperRef = useRef<HTMLDivElement>(null);
  const canvasAreaRef = useRef<HTMLDivElement>(null);

  // Track recent drag/resize to prevent click-deselect after interaction
  const lastInteractionRef = useRef<number>(0);

  // State for snap guides (shown during drag)
  const [activeSnapGuides, setActiveSnapGuides] = useState<SnapGuide[]>([]);

  // Scroll position and viewport size for fixed rulers
  const [scrollPosition, setScrollPosition] = useState({ left: 0, top: 0 });
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });

  // Panning state
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0, scrollLeft: 0, scrollTop: 0 });

  // Get basemap style from project (synced live). Vector → URL string, raster/solid → synthesized StyleSpecification.
  const { mapStyle: basemapUrl } = useBasemap(project);

  // Print config (atlas limits from backend)
  const { atlasMaxPages } = usePrintConfig();

  // Atlas features
  const {
    atlasResult: _atlasResult, // Available for future use (e.g., overview bounds)
    currentPage: currentAtlasPage,
    totalPages: atlasTotalPages,
    isLoading: isAtlasLoading,
  } = useAtlasFeatures({
    atlasConfig: reportConfig?.atlas,
    projectLayers,
    currentPageIndex: atlasPageIndex,
    atlasMaxPages,
  });

  // Derive feature attribute names from first atlas page for dynamic text menu
  const featureAttributes = useMemo(() => {
    const props = currentAtlasPage?.feature?.properties;
    return props ? Object.keys(props).sort() : [];
  }, [currentAtlasPage]);

  // Effective page info (atlas or single page)
  const isAtlasEnabled = reportConfig?.atlas?.enabled && atlasTotalPages > 0;
  const totalPages = isAtlasEnabled ? atlasTotalPages : 1;
  const currentPage = isAtlasEnabled ? atlasPageIndex + 1 : 1; // 1-based for display

  // Reset atlas page index when atlas configuration changes
  useEffect(() => {
    setAtlasPageIndex(0);
  }, [reportConfig?.atlas?.coverage]);

  // Extract page config from report or use defaults
  const pageConfig = useMemo(() => {
    return (
      reportConfig?.page ?? {
        size: "A4" as const,
        orientation: "portrait" as const,
        margins: { top: 10, right: 10, bottom: 10, left: 10 },
        snapToGuides: false,
        showRulers: false,
      }
    );
  }, [reportConfig]);

  // Check if snapping is enabled
  const isSnappingEnabled = pageConfig.snapToGuides ?? false;

  // Check if rulers should be shown
  const showRulers = pageConfig.showRulers ?? false;

  // Get elements from config
  const elements = useMemo(() => {
    return reportConfig?.elements ?? [];
  }, [reportConfig]);

  // Get paper dimensions in pixels based on size, orientation, and DPI
  const paperDimensions = useMemo(() => {
    const { width: widthMm, height: heightMm } = resolvePageMm(pageConfig);

    // Convert mm to pixels at screen DPI for preview
    const widthPx = mmToPx(widthMm, SCREEN_DPI);
    const heightPx = mmToPx(heightMm, SCREEN_DPI);

    return {
      widthMm,
      heightMm,
      widthPx,
      heightPx,
    };
  }, [pageConfig]);

  // Droppable area for the paper
  const { setNodeRef, isOver } = useDroppable({
    id: "report-canvas",
    data: {
      type: "canvas",
    },
  });

  // Combine refs
  const combinedRef = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node);
      (paperRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
    },
    [setNodeRef]
  );

  const handleZoomIn = () => {
    hasUserZoomedRef.current = true;
    setZoom((prev) => Math.min(prev + ZOOM_STEP, MAX_ZOOM));
  };

  const handleZoomOut = () => {
    hasUserZoomedRef.current = true;
    setZoom((prev) => Math.max(prev - ZOOM_STEP, MIN_ZOOM));
  };

  const handleFitToScreen = useCallback(() => {
    // Calculate zoom to fit paper in viewport with some padding
    const padding = 40; // Padding around the paper
    const availableWidth = viewportSize.width - RULER_SIZE - padding * 2;
    const availableHeight = viewportSize.height - RULER_SIZE - padding * 2;

    const zoomX = availableWidth / paperDimensions.widthPx;
    const zoomY = availableHeight / paperDimensions.heightPx;

    // Use the smaller zoom to ensure paper fits both dimensions
    const fitZoom = Math.min(zoomX, zoomY);

    // Clamp to valid zoom range
    const clampedZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, fitZoom));

    setZoom(clampedZoom);
  }, [viewportSize, paperDimensions, setZoom]);

  // Open on the whole page rather than a corner of it, and re-fit when the page
  // size or the available area changes. Stops as soon as the user zooms manually.
  useEffect(() => {
    if (hasUserZoomedRef.current) return;
    if (!viewportSize.width || !viewportSize.height) return;
    handleFitToScreen();
  }, [
    viewportSize.width,
    viewportSize.height,
    paperDimensions.widthPx,
    paperDimensions.heightPx,
    handleFitToScreen,
  ]);

  const handlePrevPage = () => {
    setAtlasPageIndex((prev) => Math.max(prev - 1, 0));
  };

  const handleNextPage = () => {
    setAtlasPageIndex((prev) => Math.min(prev + 1, totalPages - 1));
  };

  const handleCanvasClick = () => {
    // Skip deselect if a drag/resize just ended (prevents losing selection when mouseup lands on paper)
    if (Date.now() - lastInteractionRef.current < 200) return;
    // Deselect element when clicking on empty canvas area
    onElementSelect?.(null);
  };

  // Panning with Space + Drag or Middle Mouse Button
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept space when user is typing in an input, textarea, or contenteditable element
      const activeElement = document.activeElement;
      const isEditing =
        activeElement?.tagName === "INPUT" ||
        activeElement?.tagName === "TEXTAREA" ||
        activeElement?.getAttribute("contenteditable") === "true" ||
        activeElement?.closest("[contenteditable='true']") !== null;

      if (e.code === "Space" && !e.repeat && !isEditing) {
        e.preventDefault();
        setIsSpacePressed(true);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        setIsSpacePressed(false);
        setIsPanning(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  // Track scroll position for fixed rulers
  useEffect(() => {
    const canvasArea = canvasAreaRef.current;
    if (!canvasArea) return;

    const handleScroll = () => {
      setScrollPosition({
        left: canvasArea.scrollLeft,
        top: canvasArea.scrollTop,
      });
    };

    // Initial scroll position
    handleScroll();

    canvasArea.addEventListener("scroll", handleScroll);
    return () => canvasArea.removeEventListener("scroll", handleScroll);
  }, []);

  // Track viewport size for fixed rulers - measure from wrapper to get full area
  useEffect(() => {
    const canvasWrapper = canvasWrapperRef.current;
    if (!canvasWrapper) return;

    const updateViewportSize = () => {
      setViewportSize({
        width: canvasWrapper.clientWidth,
        height: canvasWrapper.clientHeight,
      });
    };

    // Initial size
    updateViewportSize();

    const resizeObserver = new ResizeObserver(updateViewportSize);
    resizeObserver.observe(canvasWrapper);

    return () => resizeObserver.disconnect();
  }, []);

  const handlePanStart = useCallback(
    (e: React.MouseEvent) => {
      // Start panning on Space + left click OR middle mouse button
      if ((isSpacePressed && e.button === 0) || e.button === 1) {
        e.preventDefault();
        const canvasArea = canvasAreaRef.current;
        if (canvasArea) {
          setIsPanning(true);
          setPanStart({
            x: e.clientX,
            y: e.clientY,
            scrollLeft: canvasArea.scrollLeft,
            scrollTop: canvasArea.scrollTop,
          });
        }
      }
    },
    [isSpacePressed]
  );

  const handlePanMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isPanning) return;
      e.preventDefault();
      const canvasArea = canvasAreaRef.current;
      if (canvasArea) {
        const deltaX = e.clientX - panStart.x;
        const deltaY = e.clientY - panStart.y;
        canvasArea.scrollLeft = panStart.scrollLeft - deltaX;
        canvasArea.scrollTop = panStart.scrollTop - deltaY;
      }
    },
    [isPanning, panStart]
  );

  const handlePanEnd = useCallback(() => {
    setIsPanning(false);
  }, []);

  // Handle scroll wheel zoom (Ctrl + scroll to avoid conflict with map widget)
  // Must use native listener with { passive: false } to allow preventDefault
  useEffect(() => {
    const el = canvasAreaRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      hasUserZoomedRef.current = true;
      if (e.deltaY < 0) {
        setZoom((prev) => Math.min(prev + ZOOM_STEP, MAX_ZOOM));
      } else {
        setZoom((prev) => Math.max(prev - ZOOM_STEP, MIN_ZOOM));
      }
    };
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [setZoom]);

  // Cursor style based on panning state
  const canvasCursor = isPanning ? "grabbing" : isSpacePressed ? "grab" : "default";

  // Calculate paper offset for fixed rulers
  // The paper is centered in a flex container with 100px padding
  // We need to calculate where the paper actually starts based on viewport and paper size
  const CANVAS_PADDING = 100;
  const paperOffset = useMemo(() => {
    const paperWidthWithZoom = paperDimensions.widthPx * zoom;
    const paperHeightWithZoom = paperDimensions.heightPx * zoom;

    // The inner container has minWidth/minHeight 100% and centers content
    // Calculate the actual content size (paper + padding on both sides)
    const contentWidth = paperWidthWithZoom + CANVAS_PADDING * 2;
    const contentHeight = paperHeightWithZoom + CANVAS_PADDING * 2;

    // Get the actual canvas area size (viewport minus ruler if shown)
    const canvasWidth = viewportSize.width - (showRulers ? RULER_SIZE : 0);
    const canvasHeight = viewportSize.height - (showRulers ? RULER_SIZE : 0);

    // When content is smaller than viewport, flexbox centers it
    // When content is larger, it starts at 0 and creates scroll
    let paperX = CANVAS_PADDING;
    let paperY = CANVAS_PADDING;

    if (contentWidth < canvasWidth) {
      // Content is centered horizontally
      paperX = (canvasWidth - paperWidthWithZoom) / 2;
    }

    if (contentHeight < canvasHeight) {
      // Content is centered vertically
      paperY = (canvasHeight - paperHeightWithZoom) / 2;
    }

    return { x: paperX, y: paperY };
  }, [paperDimensions, zoom, viewportSize, showRulers]);

  return (
    <CanvasContainer>
      <CanvasInner>
        {/* Canvas area wrapper - contains both rulers and scrollable area */}
        <Box
          ref={canvasWrapperRef}
          sx={{
            flex: 1,
            minHeight: 0,
            position: "relative",
            overflow: "hidden",
          }}>
          {/* Fixed Rulers - positioned relative to canvas area only */}
          <FixedRulerWrapper
            widthMm={paperDimensions.widthMm}
            heightMm={paperDimensions.heightMm}
            zoom={zoom}
            dpi={SCREEN_DPI}
            show={showRulers}
            scrollLeft={scrollPosition.left}
            scrollTop={scrollPosition.top}
            viewportWidth={viewportSize.width - RULER_SIZE}
            viewportHeight={viewportSize.height - RULER_SIZE}
            paperOffsetX={paperOffset.x}
            paperOffsetY={paperOffset.y}
          />

          <CanvasArea
            ref={canvasAreaRef}
            onMouseDown={handlePanStart}
            onMouseMove={handlePanMove}
            onMouseUp={handlePanEnd}
            onMouseLeave={handlePanEnd}
            onClick={handleCanvasClick}
            sx={{
              cursor: canvasCursor,
              // Position canvas area next to rulers
              width: showRulers ? `calc(100% - ${RULER_SIZE}px)` : "100%",
              height: showRulers ? `calc(100% - ${RULER_SIZE}px)` : "100%",
              position: "absolute",
              top: showRulers ? RULER_SIZE : 0,
              left: showRulers ? RULER_SIZE : 0,
            }}>
            {/* Inner container - large scrollable workspace like QGIS */}
            <Box
              sx={{
                // Create a large workspace area with the paper centered
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                // Generous padding around paper for scroll space (like QGIS infinite canvas feel)
                padding: "100px",
                // Explicit size to ensure the paper + padding fits and can scroll in both directions
                // This prevents the flexbox centering from cutting off the left side when zoomed
                width: `max(100%, ${paperDimensions.widthPx * zoom + 200}px)`,
                minHeight: "100%",
                boxSizing: "border-box",
              }}>
              {/* Paper container */}
              <Box
                sx={{
                  position: "relative",
                  flexShrink: 0, // Prevent compression - allow scrolling instead
                }}>
                <Paper
                  ref={combinedRef}
                  data-paper="true"
                  data-zoom={zoom}
                  paperWidth={paperDimensions.widthPx}
                  paperHeight={paperDimensions.heightPx}
                  zoom={zoom}
                  isOver={isOver}
                  onClick={handleCanvasClick}>
                  {/* Margin guides */}
                  <MarginOverlay margins={pageConfig.margins} zoom={zoom} />

                  {/* Snap guide lines */}
                  {activeSnapGuides.map((guide, index) => (
                    <SnapGuideLine
                      key={`${guide.orientation}-${guide.position}-${index}`}
                      guide={guide}
                      paperWidth={paperDimensions.widthPx * zoom}
                      paperHeight={paperDimensions.heightPx * zoom}
                    />
                  ))}

                  {/* Render elements - wrapped in light theme so content always renders correctly on white paper */}
                  <ThemeProvider settings={PAPER_LIGHT_THEME_SETTINGS}>
                    {elements.map((element) => (
                      <ReportElementRenderer
                        key={element.id}
                        element={element}
                        zoom={zoom}
                        isSelected={selectedElementId === element.id}
                        basemapUrl={basemapUrl}
                        locale={project?.locale ?? undefined}
                        projectLayers={projectLayers}
                        allElements={elements}
                        paperWidthPx={paperDimensions.widthPx}
                        paperHeightPx={paperDimensions.heightPx}
                        margins={pageConfig.margins}
                        isSnappingEnabled={isSnappingEnabled}
                        activeSnapGuides={activeSnapGuides}
                        atlasPage={currentAtlasPage}
                        featureAttributes={featureAttributes}
                        onSnapGuidesChange={setActiveSnapGuides}
                        onSelect={(id) => onElementSelect?.(id)}
                        onDelete={(id) => onElementDelete?.(id)}
                        onUpdate={(id, updates) => onElementUpdate?.(id, updates)}
                        onInteractionEnd={() => {
                          lastInteractionRef.current = Date.now();
                        }}
                      />
                    ))}
                  </ThemeProvider>

                  {/* Drop indicator */}
                  {isOver && elements.length === 0 && (
                    <Box
                      sx={{
                        position: "absolute",
                        inset: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: "rgba(0, 0, 0, 0.05)",
                        pointerEvents: "none",
                      }}>
                      <Typography variant="body2" color="text.secondary">
                        {t("drop_element_here")}
                      </Typography>
                    </Box>
                  )}

                  {/* Show page info when no report selected */}
                  {!reportConfig && (
                    <Box
                      sx={{
                        position: "absolute",
                        inset: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexDirection: "column",
                        gap: 1,
                      }}>
                      <Typography variant="body2" color="text.secondary">
                        {t("select_or_create_report")}
                      </Typography>
                      <Typography variant="caption" color="text.disabled">
                        {paperDimensions.widthMm} × {paperDimensions.heightMm} mm
                      </Typography>
                    </Box>
                  )}

                  {/* Empty state when report selected but no elements */}
                  {reportConfig && elements.length === 0 && !isOver && (
                    <Box
                      sx={{
                        position: "absolute",
                        inset: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexDirection: "column",
                        gap: 1,
                      }}>
                      <Typography variant="body2" color="text.secondary">
                        {t("drag_elements_to_canvas")}
                      </Typography>
                    </Box>
                  )}
                </Paper>
              </Box>
            </Box>
          </CanvasArea>
        </Box>

        {/* Bottom Toolbar */}
        <ToolbarContainer>
          <Stack direction="row" spacing={1} alignItems="center">
            {/* Page Navigation - show when atlas enabled (even while loading) */}
            {(isAtlasEnabled || (reportConfig?.atlas?.enabled && isAtlasLoading)) && (
              <>
                <Tooltip title={t("previous_page")}>
                  <span>
                    <ToolButton onClick={handlePrevPage} disabled={currentPage <= 1 || isAtlasLoading}>
                      <PrevIcon />
                    </ToolButton>
                  </span>
                </Tooltip>

                {isAtlasLoading ? (
                  <Typography variant="body2" sx={{ minWidth: 100, textAlign: "center" }}>
                    {t("loading")}
                  </Typography>
                ) : (
                  <Stack direction="row" spacing={0.5} alignItems="center">
                    <Box
                      component="input"
                      type="number"
                      min={1}
                      max={totalPages}
                      value={currentPage}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        const page = parseInt(e.target.value, 10);
                        if (!isNaN(page) && page >= 1 && page <= totalPages) {
                          setAtlasPageIndex(page - 1);
                        }
                      }}
                      sx={{
                        width: 48,
                        height: 32,
                        px: 1,
                        textAlign: "center",
                        border: 1,
                        borderColor: "divider",
                        borderRadius: 1,
                        fontSize: 14,
                        bgcolor: "background.paper",
                        color: "text.primary",
                        "&:focus": {
                          outline: "none",
                          borderColor: "primary.main",
                        },
                        "&::-webkit-inner-spin-button, &::-webkit-outer-spin-button": {
                          WebkitAppearance: "none",
                          margin: 0,
                        },
                        MozAppearance: "textfield",
                      }}
                    />
                    <Typography variant="body2" color="text.secondary">
                      / {totalPages}
                    </Typography>
                  </Stack>
                )}

                <Tooltip title={t("next_page")}>
                  <span>
                    <ToolButton
                      onClick={handleNextPage}
                      disabled={currentPage >= totalPages || isAtlasLoading}>
                      <NextIcon />
                    </ToolButton>
                  </span>
                </Tooltip>
              </>
            )}
          </Stack>

          {/* Page Label (center) */}
          <Box sx={{ flex: 1, display: "flex", justifyContent: "center", minWidth: 0 }}>
            {currentAtlasPage?.label && (
              <Typography
                variant="body1"
                fontWeight={500}
                sx={{
                  maxWidth: 400,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  px: 2,
                }}>
                {currentAtlasPage.label}
              </Typography>
            )}
          </Box>

          {/* Zoom Controls */}
          <Stack direction="row" spacing={0.5} alignItems="center">
            <Tooltip title={t("zoom_out")}>
              <ToolButton onClick={handleZoomOut} disabled={zoom <= MIN_ZOOM}>
                <RemoveIcon />
              </ToolButton>
            </Tooltip>

            <Typography variant="body2" sx={{ minWidth: 50, textAlign: "center" }}>
              {Math.round(zoom * 100)}%
            </Typography>

            <Tooltip title={t("zoom_in")}>
              <ToolButton onClick={handleZoomIn} disabled={zoom >= MAX_ZOOM}>
                <AddIcon />
              </ToolButton>
            </Tooltip>

            <Tooltip title={t("fit_to_screen")}>
              <ToolButton onClick={handleFitToScreen}>
                <FullscreenIcon />
              </ToolButton>
            </Tooltip>
          </Stack>
        </ToolbarContainer>
      </CanvasInner>
    </CanvasContainer>
  );
};

export default ReportsCanvas;
