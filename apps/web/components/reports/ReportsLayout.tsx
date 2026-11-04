"use client";

import type { DragEndEvent, DragStartEvent, UniqueIdentifier } from "@dnd-kit/core";
import { DndContext, DragOverlay, pointerWithin } from "@dnd-kit/core";
import { Box, Card, CardHeader, Stack, Typography, useTheme } from "@mui/material";
import React, { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import { v4 as uuidv4 } from "uuid";

import { Icon } from "@p4b/ui/components/Icon";

import { useProjectInitialViewState } from "@/lib/api/projects";
import { getReportLayout, updateReportLayout, useReportLayouts } from "@/lib/api/reportLayouts";
import { materializeMapElements } from "@/lib/print/mapElements";
import { snapScalebarWidths } from "@/lib/print/scalebar";
import type { Project, ProjectLayer } from "@/lib/validations/project";
import type {
  ReportElement,
  ReportElementType,
  ReportLayout,
  ReportLayoutConfig,
  ReportLayoutUpdate,
} from "@/lib/validations/reportLayout";

import { useBasemap } from "@/hooks/map/MapHooks";
import type { LayoutRequest } from "@/hooks/map/useMapUrlIntent";
import { useRevisionedSaver } from "@/hooks/useRevisionedSaver";

import ConflictBanner from "@/components/common/ConflictBanner";

import ReportsCanvas from "./canvas/ReportsCanvas";
import { reportElementIconMap } from "./elements/ReportElementIconMap";
import ReportsConfigPanel from "./panels/ReportsConfigPanel";
import ReportsElementsPanel from "./panels/ReportsElementsPanel";

export interface ReportsLayoutProps {
  project?: Project;
  projectLayers?: ProjectLayer[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onProjectUpdate?: (key: string, value: any, refresh?: boolean) => void;
  /** A `?layout=<id>` to select (a template result or the assistant), kept by
   * the map page's useMapUrlIntent and applied once by the panel. */
  layoutRequest?: LayoutRequest | null;
}

// Dragging element preview (shown during drag)
interface DragPreviewProps {
  elementType: ReportElementType;
}

const DragPreview: React.FC<DragPreviewProps> = ({ elementType }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  return (
    <Card
      sx={{
        cursor: "grabbing",
        maxWidth: "130px",
        borderRadius: "6px",
        opacity: 0.9,
        transform: "scale(1.05)",
        boxShadow: theme.shadows[8],
      }}>
      <CardHeader
        sx={{
          px: 2,
          py: 4,
          ".MuiCardHeader-content": {
            width: "100%",
            color: theme.palette.primary.main,
          },
        }}
        title={
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            spacing={2}
            style={{
              color: theme.palette.primary.main,
            }}>
            <Typography variant="body2" fontWeight="bold" noWrap color="inherit">
              {t(elementType)}
            </Typography>
            <Icon
              iconName={reportElementIconMap[elementType]}
              style={{
                fontSize: "1.2rem",
                color: "inherit",
              }}
            />
          </Stack>
        }
      />
    </Card>
  );
};

const ReportsLayout: React.FC<ReportsLayoutProps> = ({
  project,
  projectLayers = [],
  onProjectUpdate: _onProjectUpdate,
  layoutRequest = null,
}) => {
  const { t } = useTranslation("common");
  // Shared state for the selected report layout
  const [selectedReport, setSelectedReport] = useState<ReportLayout | null>(null);
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [activeElementType, setActiveElementType] = useState<ReportElementType | null>(null);

  // Get project's initial view state for creating map element snapshots
  const { initialView } = useProjectInitialViewState(project?.id ?? "");
  const { mapStyle: basemapUrl } = useBasemap(project);

  // SWR cache for report layouts — used to keep cache in sync with local changes
  const { mutate: mutateLayouts } = useReportLayouts(project?.id);

  // Ref to track the latest selectedReport for API calls (avoids stale closures)
  const selectedReportRef = useRef(selectedReport);
  selectedReportRef.current = selectedReport;

  // Every save of a layout, here and in the settings panel, goes out in turn
  // on the revision the layout was opened at or last saved as. When core
  // refuses one because the open layout changed elsewhere, the banner shows
  // and its later changes wait for Reload or Keep mine.
  const openLayoutId = useRef<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const projectId = project?.id;
  const { saver: layoutSaver, conflict } = useRevisionedSaver<ReportLayoutUpdate>({
    send: async (id, update, baseRevision) => {
      if (!projectId) throw new Error("No project to save the layout in");
      const updated = await updateReportLayout(projectId, id, { ...update, base_revision: baseRevision });
      const revision = updated?.revision;
      if (typeof revision === "number") {
        // The layout list is what the next opening of the layout reads, also
        // after leaving the layouts and coming back. An entry tagged newer
        // is a read of the stored layout itself and stays as it is.
        mutateLayouts(
          (cached) =>
            cached?.map((r) =>
              r.id === id && !(typeof r.revision === "number" && r.revision > revision)
                ? { ...r, revision }
                : r
            ),
          { revalidate: false }
        );
        setSelectedReport((prev) => (prev?.id === id ? { ...prev, revision } : prev));
      }
      return revision;
    },
    isOpen: (id) => openLayoutId.current === id,
  });

  /** Saves a layout in turn. `listRevision` is the list's tag of a layout
   * that is not open (a rename): the open one keeps the revision its own
   * content is based on, whatever a newer list read says. */
  const saveLayout = useCallback(
    (layoutId: string, update: ReportLayoutUpdate, listRevision?: number) => {
      if (layoutId !== openLayoutId.current) layoutSaver.seed(layoutId, listRevision);
      return layoutSaver.save(layoutId, update);
    },
    [layoutSaver]
  );

  // The open layout's config as it is here, written into the layout list
  // (its name and the rest stay the list's: the settings panel renames there).
  // It is tagged with the revision this config is based on, never with the
  // list's: a list read may carry another person's newer version, and the
  // next opening must not take that revision for this config.
  const rememberLayout = useCallback(
    (report: ReportLayout) => {
      const revision = layoutSaver.revisionOf(report.id) ?? report.revision;
      mutateLayouts(
        (cached) => cached?.map((r) => (r.id === report.id ? { ...r, config: report.config, revision } : r)),
        { revalidate: false }
      );
    },
    [layoutSaver, mutateLayouts]
  );

  // Persist report changes: sync SWR cache and save to API
  const persistReport = useCallback(
    (report: ReportLayout) => {
      rememberLayout(report);
      saveLayout(report.id, { config: report.config }).catch((error) => {
        console.error("Failed to update report layout:", error);
      });
    },
    [rememberLayout, saveLayout]
  );

  // What a map element is filled in from when a layout is opened. Read through
  // a ref so the selection handler keeps one identity: the config panel
  // re-runs its selection effect whenever that identity changes.
  const mapElementContextRef = useRef({ initialView, projectLayers, basemapUrl });
  mapElementContextRef.current = { initialView, projectLayers, basemapUrl };

  // Handle report selection - deselect element when switching layouts
  const handleSelectReport = useCallback(
    (report: ReportLayout | null) => {
      setSelectedElementId(null);
      const opened = (report?.id ?? null) !== openLayoutId.current;
      // Another layout opened: a conflict on the last one no longer applies.
      if (opened) layoutSaver.dismiss();
      openLayoutId.current = report?.id ?? null;
      if (!report) {
        setSelectedReport(null);
        return;
      }
      layoutSaver.seed(report.id, report.revision);
      // A change the settings panel made to the open layout.
      if (!opened) rememberLayout(report);
      const saved = report.config.elements ?? [];
      // A layout that came from a template, or from a project with other
      // layer ids, has map elements without a view or with a lock snapshot
      // that names no layer here. Fill those in from this project and save,
      // so the lock freezes what the user first sees.
      const materialized = materializeMapElements(saved, mapElementContextRef.current);
      // Refit scalebar rectangles saved before the snap existed, or by an older
      // map view. Shown only; persisted with the next edit.
      const elements = snapScalebarWidths(materialized);
      if (elements === saved) {
        setSelectedReport(report);
        return;
      }
      const updatedReport: ReportLayout = { ...report, config: { ...report.config, elements } };
      setSelectedReport(updatedReport);
      if (materialized !== saved) persistReport(updatedReport);
    },
    [persistReport, rememberLayout, layoutSaver]
  );

  // Reload: the stored layout over the open one, and the settings panel reads
  // its page and atlas settings again.
  const reloadLayout = useCallback(async () => {
    const open = layoutSaver.conflict;
    if (!open || !projectId) return;
    try {
      const stored = await getReportLayout(projectId, open.id);
      layoutSaver.dismiss();
      if (typeof stored.revision === "number") layoutSaver.setRevision(stored.id, stored.revision);
      mutateLayouts((cached) => cached?.map((r) => (r.id === stored.id ? stored : r)), { revalidate: false });
      handleSelectReport(stored);
      setReloads((count) => count + 1);
    } catch (error) {
      console.error("Failed to reload report layout:", error);
    }
  }, [layoutSaver, projectId, mutateLayouts, handleSelectReport]);

  // Keep mine: the open layout as it is now, on top of the stored one. When
  // that fails, the layout stays as it is here and its next change saves it,
  // on the revision the conflict reported.
  const keepLayout = useCallback(async () => {
    const report = selectedReportRef.current;
    // A list read may have brought the other version into the list since the
    // conflict: the list gets this layout back first, so the answer's
    // revision tags the version that is kept.
    if (report) rememberLayout(report);
    try {
      await layoutSaver.keepMine(report ? { config: report.config } : undefined);
    } catch (error) {
      console.error("Failed to save report layout:", error);
      toast.error(t("error_saving_changes"));
    }
  }, [layoutSaver, rememberLayout, t]);

  // Handle drag start
  const handleDragStart = useCallback((event: DragStartEvent) => {
    const { active } = event;
    setActiveId(active.id);

    // Get the element type from the dragged item
    const data = active.data.current;
    if (data?.type === "report-element" && data?.elementType) {
      setActiveElementType(data.elementType as ReportElementType);
    }
  }, []);

  // Handle drag end
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;

      setActiveId(null);
      setActiveElementType(null);

      // If dropped over the canvas and we have a valid element type
      if (over?.id === "report-canvas" && selectedReportRef.current) {
        const data = active.data.current;
        if (data?.type === "report-element" && data?.elementType) {
          const elementType = data.elementType as ReportElementType;

          // Get the canvas/paper element to calculate relative position
          const paperElement = document.querySelector('[data-paper="true"]');
          const paperRect = paperElement?.getBoundingClientRect();

          // Default sizes based on element type (in mm)
          const getDefaultWidth = () => {
            if (elementType === "map") return 180;
            if (elementType === "legend") return 40;
            if (elementType === "divider") return 150;
            return 60;
          };
          const getDefaultHeight = () => {
            if (elementType === "map") return 120;
            if (elementType === "legend") return 80;
            if (elementType === "divider") return 2;
            return 30;
          };
          const defaultWidth = getDefaultWidth();
          const defaultHeight = getDefaultHeight();

          // Use functional updater to get latest state
          let newElementId: string | null = null;
          setSelectedReport((prev) => {
            if (!prev) return prev;

            // Calculate stacking offset based on existing elements (so new elements don't overlap perfectly)
            const existingCount = prev.config.elements?.length ?? 0;
            const stackOffset = existingCount * 5; // 5mm offset per existing element

            // Calculate position - center the element at 20% from top-left as default
            let posX = 20 + stackOffset; // mm from left
            let posY = 20 + stackOffset; // mm from top

            // Use the dragged element's final translated position to place where the user actually dropped
            const translated = active.rect.current.translated;
            if (paperRect && translated) {
              const dropX = translated.left + translated.width / 2 - paperRect.left;
              const dropY = translated.top + translated.height / 2 - paperRect.top;
              const zoomAttr = paperElement?.getAttribute("data-zoom");
              const currentZoom = zoomAttr ? parseFloat(zoomAttr) : paperRect.width / (210 * (96 / 25.4));
              const pxPerMm = 96 / 25.4;
              posX = Math.max(5, dropX / currentZoom / pxPerMm - defaultWidth / 2);
              posY = Math.max(5, dropY / currentZoom / pxPerMm - defaultHeight / 2);
            }

            // Create a new element
            const newElement: ReportElement = {
              id: uuidv4(),
              type: elementType,
              position: {
                x: Math.round(posX),
                y: Math.round(posY),
                width: defaultWidth,
                height: defaultHeight,
                z_index: existingCount + 1,
              },
              config:
                elementType === "map"
                  ? {
                      viewState: {
                        latitude: initialView?.latitude ?? 48.13,
                        longitude: initialView?.longitude ?? 11.57,
                        zoom: initialView?.zoom ?? 10,
                        bearing: initialView?.bearing ?? 0,
                        pitch: initialView?.pitch ?? 0,
                      },
                    }
                  : elementType === "legend"
                    ? {
                        title: { text: t("legend") },
                        mapElementId: prev.config.elements?.find((el) => el.type === "map")?.id ?? null,
                      }
                    : elementType === "north_arrow" || elementType === "scalebar"
                      ? {
                          mapElementId: prev.config.elements?.find((el) => el.type === "map")?.id ?? null,
                        }
                      : {},
              style: {
                padding: 0,
                opacity: 1,
                ...(elementType === "map" && {
                  border: { enabled: true, color: "#cccccc", width: 0.5 },
                }),
                ...(elementType === "legend" && {
                  background: { enabled: true, color: "#ffffff", opacity: 0.9 },
                }),
              },
            };

            newElementId = newElement.id;

            const updatedConfig: ReportLayoutConfig = {
              ...prev.config,
              elements: snapScalebarWidths([...(prev.config.elements ?? []), newElement]),
            };

            const updatedReport = {
              ...prev,
              config: updatedConfig,
            };

            queueMicrotask(() => persistReport(updatedReport));

            return updatedReport;
          });

          // Select the newly added element
          if (newElementId) {
            setSelectedElementId(newElementId);
          }
        }
      }
    },
    [initialView, persistReport]
  );

  // Handle element selection on canvas
  const handleElementSelect = useCallback((elementId: string | null) => {
    setSelectedElementId(elementId);
  }, []);

  // Handle element update (position, size, config changes)
  // Uses functional state updater to avoid stale closure issues with rapid updates
  const handleElementUpdate = useCallback(
    (elementId: string, updates: Partial<ReportElement>) => {
      setSelectedReport((prev) => {
        if (!prev) return prev;

        const updatedElements = prev.config.elements?.map((el) =>
          el.id === elementId ? { ...el, ...updates } : el
        );

        // A map move or a scalebar setting changes the bar, so refit the
        // scalebar rectangles in the same update.
        const updatedConfig: ReportLayoutConfig = {
          ...prev.config,
          elements: snapScalebarWidths(updatedElements ?? []),
        };

        const updatedReport = {
          ...prev,
          config: updatedConfig,
        };

        // Schedule persistence outside React's render phase
        queueMicrotask(() => persistReport(updatedReport));

        return updatedReport;
      });
    },
    [persistReport]
  );

  // Handle element delete
  const handleElementDelete = useCallback(
    (elementId: string) => {
      setSelectedReport((prev) => {
        if (!prev) return prev;

        const updatedElements = prev.config.elements?.filter((el) => el.id !== elementId);

        const updatedConfig: ReportLayoutConfig = {
          ...prev.config,
          elements: updatedElements ?? [],
        };

        const updatedReport = {
          ...prev,
          config: updatedConfig,
        };

        queueMicrotask(() => persistReport(updatedReport));

        return updatedReport;
      });

      // Clear selection if deleted element was selected
      setSelectedElementId((prevId) => (prevId === elementId ? null : prevId));
    },
    [persistReport]
  );

  return (
    <DndContext onDragStart={handleDragStart} onDragEnd={handleDragEnd} collisionDetection={pointerWithin}>
      <Box
        sx={{
          position: "relative",
          width: "100%",
          height: "100%",
          display: "flex",
          overflow: "hidden",
          backgroundColor: "background.default",
        }}>
        {/* Left Panel - Report Settings */}
        <ReportsConfigPanel
          project={project}
          projectLayers={projectLayers}
          selectedReport={selectedReport}
          onSelectReport={handleSelectReport}
          onSaveLayout={saveLayout}
          reloads={reloads}
          layoutRequest={layoutRequest}
        />

        {/* Middle Section - Canvas */}
        <ReportsCanvas
          project={project}
          projectLayers={projectLayers}
          reportConfig={selectedReport?.config}
          selectedElementId={selectedElementId}
          onElementSelect={handleElementSelect}
          onElementUpdate={handleElementUpdate}
          onElementDelete={handleElementDelete}
        />

        {/* Right Panel - Elements & History */}
        <ReportsElementsPanel
          project={project}
          projectLayers={projectLayers}
          selectedReport={selectedReport}
          selectedElementId={selectedElementId}
          onElementSelect={handleElementSelect}
          onElementUpdate={handleElementUpdate}
          onElementDelete={handleElementDelete}
        />

        {conflict && (
          <ConflictBanner
            document="report_layout"
            conflict={conflict}
            onReload={reloadLayout}
            onKeepMine={keepLayout}
          />
        )}
      </Box>

      {/* Drag Overlay */}
      <DragOverlay dropAnimation={null}>
        {activeId && activeElementType ? <DragPreview elementType={activeElementType} /> : null}
      </DragOverlay>
    </DndContext>
  );
};

export default ReportsLayout;
