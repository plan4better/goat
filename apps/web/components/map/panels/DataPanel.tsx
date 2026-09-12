import { Box, useTheme } from "@mui/material";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { stopEditing } from "@/lib/store/featureEditor/slice";
import { setDataPanelHeight, setDataPanelLayerId, setIsDataPanelOpen } from "@/lib/store/map/slice";
import type { ProjectLayer } from "@/lib/validations/project";

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import ConfirmModal from "@/components/modals/Confirm";
import DatasetDownloadModal from "@/components/modals/DatasetDownload";
import EditableDataTable from "@/components/map/panels/EditableDataTable";

const MIN_PANEL_HEIGHT = 150;
const DEFAULT_PANEL_HEIGHT = 350;
const MAX_PANEL_HEIGHT_RATIO = 0.8; // Max 80% of container
const RESIZE_HANDLE_HEIGHT = 12;

/** CSS custom property name used to communicate panel height to sibling layout components */
export const DATA_PANEL_HEIGHT_VAR = "--data-panel-height";

/** DOM attribute marking elements that consume the height variable. During a
 * drag the variable is set inline on exactly these elements instead of on
 * `document.documentElement` — mutating a custom property on :root
 * restyles the whole document (~7ms per mousemove on a full map page), while
 * inline writes only restyle the consumers' subtrees. */
export const DATA_PANEL_HEIGHT_CONSUMER_ATTR = "data-panel-height-consumer";

interface DataPanelProps {
  projectLayers: ProjectLayer[];
  isEditor?: boolean;
}

const DataPanel: React.FC<DataPanelProps> = ({ projectLayers, isEditor = true }) => {
  const theme = useTheme();
  const dispatch = useAppDispatch();
  const [isDragging, setIsDragging] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const dragStartRef = useRef<{ y: number; height: number; maxHeight: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const heightRef = useRef(DEFAULT_PANEL_HEIGHT);

  const [isDownloadOpen, setIsDownloadOpen] = useState(false);
  const isDataPanelOpen = useAppSelector((state) => state.map.isDataPanelOpen);
  const dataPanelLayerId = useAppSelector((state) => state.map.dataPanelLayerId);
  const mapMode = useAppSelector((state) => state.map.mapMode);

  // Find the data panel's project layer (independent of layer tree selection)
  const activeProjectLayer = dataPanelLayerId
    ? projectLayers.find((l) => l.id === dataPanelLayerId)
    : undefined;

  // An edit session is bound to ONE layer. If the panel switches to a
  // different layer, the floating edit toolbar and the table would silently
  // target different layers — end the session instead (with a confirmation
  // when unsaved edits would be discarded).
  const { t } = useTranslation("common");
  const editingLayerId = useAppSelector((state) => state.featureEditor.activeLayerId);
  const hasPendingEdits = useAppSelector(
    (state) => Object.keys(state.featureEditor.pendingFeatures).length > 0
  );
  const [layerSwitchConfirmOpen, setLayerSwitchConfirmOpen] = useState(false);
  useEffect(() => {
    if (!editingLayerId || !activeProjectLayer) return;
    if (activeProjectLayer.layer_id === editingLayerId) {
      setLayerSwitchConfirmOpen(false);
      return;
    }
    // Only while the table is on screen. The mismatch this guards against is a
    // visible one — a toolbar and a table naming different layers — and a
    // closed panel shows neither. Acting regardless meant a session started
    // anywhere else was ended by whatever layer the panel had last been
    // pointed at.
    if (!isDataPanelOpen) return;
    if (hasPendingEdits) {
      setLayerSwitchConfirmOpen(true);
    } else {
      dispatch(stopEditing());
    }
  }, [activeProjectLayer, editingLayerId, hasPendingEdits, isDataPanelOpen, dispatch]);

  /**
   * A session ends when its layer leaves the project.
   *
   * Removing the layer — or the bundle it belongs to — leaves the editor
   * pointed at something the project no longer contains: the floating toolbar
   * stays up, the map keeps taking edits, and there is nothing left to save
   * them to. Unlike a layer *switch*, there is nothing to confirm, because
   * cancelling could only return the session to a layer that has gone.
   *
   * `wasPresent` separates "removed" from "not loaded yet": the list is empty
   * on first render, and ending a session then would kill one that had just
   * started. Once the edited layer has been seen in the list, its absence is
   * a removal — including when it was the project's only layer.
   */
  const editedLayerWasPresent = useRef(false);
  useEffect(() => {
    if (!editingLayerId) {
      editedLayerWasPresent.current = false;
      return;
    }
    if (projectLayers.some((layer) => layer.layer_id === editingLayerId)) {
      editedLayerWasPresent.current = true;
      return;
    }
    if (!editedLayerWasPresent.current) return;
    // Said out loud only when it costs something: edits that cannot be saved
    // anywhere are being dropped, and the editor closing on its own would
    // otherwise look like a glitch.
    if (hasPendingEdits) {
      toast.info(t("editing_ended_layer_removed"));
    }
    dispatch(stopEditing());
  }, [projectLayers, editingLayerId, hasPendingEdits, dispatch, t]);

  const handleLayerSwitchConfirm = useCallback(() => {
    dispatch(stopEditing());
    setLayerSwitchConfirmOpen(false);
  }, [dispatch]);

  const handleLayerSwitchCancel = useCallback(() => {
    // Return the panel to the layer being edited; if that layer is no longer
    // in the project, the session has nothing to return to — end it.
    const editingProjectLayer = projectLayers.find((l) => l.layer_id === editingLayerId);
    if (editingProjectLayer) {
      dispatch(setDataPanelLayerId(editingProjectLayer.id));
    } else {
      dispatch(stopEditing());
    }
    setLayerSwitchConfirmOpen(false);
  }, [projectLayers, editingLayerId, dispatch]);

  // Single source of truth: set the CSS variable on :root.
  // Both the panel itself and sibling layout components read from this variable.
  const syncHeight = useCallback((height: number) => {
    heightRef.current = height;
    document.documentElement.style.setProperty(DATA_PANEL_HEIGHT_VAR, `${height}px`);
  }, []);

  // Document-level drag handlers. Per-frame we resize ONLY the panel via its
  // inline style: writing the CSS variable lives on document.documentElement,
  // and mutating a custom property on :root invalidates style for the entire
  // document — ~7ms of style recalc per mousemove on a full map page. Sibling
  // overlays consume the variable and therefore snap once on release instead
  // of tracking every frame, which is imperceptible for floating overlays.
  const consumersRef = useRef<HTMLElement[]>([]);

  const handleDragMove = useCallback((event: MouseEvent) => {
    if (!dragStartRef.current) return;
    const { y, height, maxHeight } = dragStartRef.current;
    const newHeight = Math.min(maxHeight, Math.max(MIN_PANEL_HEIGHT, height + (y - event.clientY)));
    heightRef.current = newHeight;
    if (containerRef.current) containerRef.current.style.height = `${newHeight}px`;
    for (const el of consumersRef.current) {
      el.style.setProperty(DATA_PANEL_HEIGHT_VAR, `${newHeight}px`);
    }
  }, []);

  const handleDragEnd = useCallback(() => {
    setIsDragging(false);
    dragStartRef.current = null;
    if (containerRef.current) containerRef.current.style.height = "";
    for (const el of consumersRef.current) {
      el.style.removeProperty(DATA_PANEL_HEIGHT_VAR);
    }
    consumersRef.current = [];
    syncHeight(heightRef.current);
    dispatch(setDataPanelHeight(heightRef.current));
  }, [dispatch, syncHeight]);

  useEffect(() => {
    if (isDragging) {
      document.body.style.userSelect = "none";
      document.body.style.cursor = "ns-resize";
      window.addEventListener("mousemove", handleDragMove);
      window.addEventListener("mouseup", handleDragEnd);
      return () => {
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        window.removeEventListener("mousemove", handleDragMove);
        window.removeEventListener("mouseup", handleDragEnd);
      };
    }
  }, [isDragging, handleDragMove, handleDragEnd]);

  // Sync CSS var when panel visibility changes
  const isVisible = mapMode === "data" && isDataPanelOpen && !!activeProjectLayer;
  useEffect(() => {
    if (isVisible) {
      syncHeight(heightRef.current);
      dispatch(setDataPanelHeight(heightRef.current));
    } else {
      document.documentElement.style.setProperty(DATA_PANEL_HEIGHT_VAR, "0px");
    }
  }, [isVisible, syncHeight, dispatch]);

  // Also clean up on unmount
  useEffect(() => {
    return () => {
      document.documentElement.style.setProperty(DATA_PANEL_HEIGHT_VAR, "0px");
    };
  }, []);

  // Stable references: EditableDataTable is memoized, so these must not be
  // recreated on every DataPanel render (drag start/end toggles isDragging).
  const handleClose = useCallback(() => {
    setIsExpanded(false);
    dispatch(setIsDataPanelOpen(false));
    // Reset CSS var to 0 but keep heightRef at the stored height so reopening works
    document.documentElement.style.setProperty(DATA_PANEL_HEIGHT_VAR, "0px");
  }, [dispatch]);

  const handleToggleExpand = useCallback(() => {
    setIsExpanded((expanded) => {
      if (expanded) {
        // Collapse back to previous height — restore CSS var so overlays adjust
        syncHeight(heightRef.current);
        return false;
      }
      // Expand to fill container — keep CSS var at current height so overlays stay in place
      return true;
    });
  }, [syncHeight]);

  const handleOpenDownload = useCallback(() => setIsDownloadOpen(true), []);

  // Only render in data mode when panel is open with an active layer
  if (mapMode !== "data" || !isDataPanelOpen || !activeProjectLayer) {
    return null;
  }

  const handleDragStart = (event: React.MouseEvent) => {
    if (isExpanded) return; // No drag resize when expanded
    event.preventDefault();
    setIsDragging(true);
    consumersRef.current = Array.from(
      document.querySelectorAll<HTMLElement>(`[${DATA_PANEL_HEIGHT_CONSUMER_ATTR}]`)
    );
    const parentHeight = containerRef.current?.parentElement?.clientHeight ?? 800;
    dragStartRef.current = {
      y: event.clientY,
      height: heightRef.current,
      maxHeight: parentHeight * MAX_PANEL_HEIGHT_RATIO,
    };
  };


  return (
    <Box
      ref={containerRef}
      sx={{
        position: isExpanded ? "fixed" : "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        ...(isExpanded ? { top: 0 } : {}),
        height: isExpanded ? "100vh" : `var(${DATA_PANEL_HEIGHT_VAR}, ${DEFAULT_PANEL_HEIGHT}px)`,
        display: "flex",
        flexDirection: "column",
        zIndex: isExpanded ? 1300 : 10,
        transition: isDragging ? "none" : "height 0.15s ease-out",
        pointerEvents: "auto",
      }}>
      {/* Resize handle — full width top edge (hidden when expanded) */}
      {!isExpanded && (
        <Box
          onMouseDown={handleDragStart}
          sx={{
            position: "absolute",
            top: -2,
            left: 0,
            right: 0,
            height: RESIZE_HANDLE_HEIGHT,
            cursor: "ns-resize",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1,
            borderTop: isDragging ? `4px solid ${theme.palette.primary.main}` : "2px solid transparent",
            "&:hover .drag-pill": {
              backgroundColor: theme.palette.text.secondary,
            },
          }}>
          {/* Visual drag indicator pill */}
          <Box
            className="drag-pill"
            sx={{
              width: 32,
              height: 4,
              borderRadius: 2,
              backgroundColor: isDragging
                ? theme.palette.primary.main
                : theme.palette.action.disabled,
              transition: "background-color 0.15s ease",
            }}
          />
        </Box>
      )}

      {/* Table content — includes its own toolbar/header */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          backgroundColor: theme.palette.background.paper,
          transition: "background-color 0.15s ease-out",
        }}>
        <EditableDataTable
          layerId={activeProjectLayer.layer_id}
          projectLayer={activeProjectLayer}
          layerName={activeProjectLayer.name}
          isExpanded={isExpanded}
          isEditor={isEditor}
          onToggleExpand={handleToggleExpand}
          onClose={handleClose}
          onDownload={handleOpenDownload}
        />
        <DatasetDownloadModal
          open={isDownloadOpen}
          onClose={() => setIsDownloadOpen(false)}
          dataset={activeProjectLayer}
        />
        <ConfirmModal
          open={layerSwitchConfirmOpen}
          title={t("stop_editing")}
          body={t("discard_edits_confirmation")}
          closeText={t("cancel")}
          confirmText={t("stop_editing")}
          onClose={handleLayerSwitchCancel}
          onConfirm={handleLayerSwitchConfirm}
        />
      </Box>
    </Box>
  );
};

export default DataPanel;
