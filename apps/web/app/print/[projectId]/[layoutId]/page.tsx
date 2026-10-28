"use client";

import { Box, CircularProgress, Typography } from "@mui/material";
import type { StyleSpecification } from "maplibre-gl";
import { useParams, useSearchParams } from "next/navigation";
import React, { useCallback, useEffect, useMemo, useState } from "react";

import ThemeProvider from "@p4b/ui/theme/ThemeProvider";

import { useProject } from "@/lib/api/projects";
import { useReportLayout } from "@/lib/api/reportLayouts";
import type { AtlasPage } from "@/lib/print/atlas-utils";
import { resolveElementFrame } from "@/lib/print/elementFrame";
import { snapScalebarWidths } from "@/lib/print/scalebar";
import { mmToPx, resolvePageMm } from "@/lib/print/units";
import type { CustomBasemap } from "@/lib/validations/project";
import type { ReportLayoutConfig } from "@/lib/validations/reportLayout";

import { useBasemap } from "@/hooks/map/MapHooks";
import { type MapLayer, useMapLayers } from "@/hooks/map/useMapLayers";
import { useAtlasFeatures } from "@/hooks/reports/useAtlasFeatures";
import { usePrintConfig } from "@/hooks/reports/usePrintConfig";

import { ElementContentRenderer } from "@/components/reports/elements/renderers/ElementRenderers";

// Print DPI - higher quality for PDF output (used when generating the actual PDF)
// const PRINT_DPI = 300;
// Screen DPI for preview (Playwright captures at screen resolution)
const SCREEN_DPI = 96;

// Light theme settings for print preview (paper is always white)
const LIGHT_THEME_SETTINGS = {
  mode: "light" as const,
};

/**
 * Print-ready page that renders a report layout for Playwright PDF capture.
 * This page is designed to be rendered without any UI chrome - just the paper content.
 *
 * Playwright will navigate to this page and use page.pdf() to generate the PDF.
 *
 * Query params:
 * - page: Atlas page index (0-based). If not provided and atlas is enabled, renders page 0.
 */
export default function PrintPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const projectId = params.projectId as string;
  const layoutId = params.layoutId as string;

  // Get atlas page index from query params (0-based)
  const atlasPageIndex = searchParams.get("page") ? parseInt(searchParams.get("page")!, 10) : 0;

  const { reportLayout, isLoading, isError } = useReportLayout(projectId, layoutId);
  const { project, isLoading: isProjectLoading } = useProject(projectId);
  const { layers: mapLayers, isLoading: isLayersLoading } = useMapLayers(projectId, {
    revalidateOnMount: true,
  });
  const { mapStyle, setActiveBasemap } = useBasemap(project);

  // Populate the Redux active basemap so <Layers> can apply the custom
  // basemap's layer_config (label visibility, layer stacking). Unlike the
  // interactive map page, the print route is a fresh isolated store that
  // nothing else dispatches into — without this, layer_config is empty and
  // hidden basemap layers (e.g. disabled labels) render in the PDF. Keyed on
  // a stable string so SWR revalidations don't force needless style reloads.
  const activeBasemapValue = project?.basemap;
  const activeBasemapLayerConfigKey = useMemo(() => {
    const customs = (project?.custom_basemaps as CustomBasemap[] | undefined) ?? [];
    const active = customs.find((c) => c.id === activeBasemapValue);
    return JSON.stringify(active && active.type === "vector" ? (active.layer_config ?? null) : null);
  }, [project?.custom_basemaps, activeBasemapValue]);
  useEffect(() => {
    if (activeBasemapValue) setActiveBasemap(activeBasemapValue);
    // setActiveBasemap is recreated on each render; the stable deps above gate
    // when we actually need to re-sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBasemapValue, activeBasemapLayerConfigKey]);

  // The map's layers in the map document's order, with their visibility and styles (tables draw nothing).
  const projectLayers = useMemo(() => mapLayers.filter((layer) => layer.type !== "table"), [mapLayers]);
  const [isReady, setIsReady] = useState(false);

  // Print config (atlas limits from backend)
  const { atlasMaxPages } = usePrintConfig();

  // Atlas support - fetch features and generate pages
  const {
    atlasResult,
    currentPage: currentAtlasPage,
    isLoading: isAtlasLoading,
    totalPages: atlasTotalPages,
  } = useAtlasFeatures({
    atlasConfig: reportLayout?.config?.atlas,
    projectLayers,
    currentPageIndex: atlasPageIndex,
    atlasMaxPages,
  });

  // Check if atlas is enabled
  const isAtlasEnabled = reportLayout?.config?.atlas?.enabled === true;

  // Track map loading state
  const [mapsLoadedCount, setMapsLoadedCount] = useState(0);

  // Count how many map elements there are
  const mapElementCount = useMemo(() => {
    if (!reportLayout?.config?.elements) return 0;
    return reportLayout.config.elements.filter((el) => el.type === "map").length;
  }, [reportLayout]);

  // Callback for when a map finishes loading
  const handleMapLoaded = useCallback(() => {
    setMapsLoadedCount((prev) => prev + 1);
  }, []);

  // Check if all maps are loaded
  const allMapsLoaded = mapElementCount === 0 || mapsLoadedCount >= mapElementCount;

  // Check if atlas data is ready (if atlas is enabled)
  const atlasReady = !isAtlasEnabled || (!isAtlasLoading && (atlasResult !== null || atlasTotalPages === 0));

  // Signal to Playwright that the page is ready for printing
  // Wait for data to load AND all maps to be loaded AND atlas data (if enabled)
  useEffect(() => {
    if (reportLayout && !isLoading && !isProjectLoading && !isLayersLoading && allMapsLoaded && atlasReady) {
      // Give additional delay for map tiles to fully render
      // Keep this short since Playwright also waits for networkidle
      const timer = setTimeout(() => {
        setIsReady(true);
        // Add a data attribute that Playwright can check
        document.body.setAttribute("data-print-ready", "true");
      }, 1000); // 1 second delay to allow map tiles to render
      return () => clearTimeout(timer);
    }
  }, [reportLayout, isLoading, isProjectLoading, isLayersLoading, allMapsLoaded, atlasReady]);

  // Set document title based on layout name (used as PDF filename)
  useEffect(() => {
    if (reportLayout?.name) {
      document.title = reportLayout.name;
    }
  }, [reportLayout?.name]);

  // Extract page config
  const pageConfig = useMemo(() => {
    return (
      reportLayout?.config?.page ?? {
        size: "A4" as const,
        orientation: "portrait" as const,
        margins: { top: 10, right: 10, bottom: 10, left: 10 },
      }
    );
  }, [reportLayout]);

  // Calculate paper dimensions in pixels at screen DPI
  const paperDimensions = useMemo(() => {
    const { width: widthMm, height: heightMm } = resolvePageMm(pageConfig);

    return {
      widthMm,
      heightMm,
      widthPx: mmToPx(widthMm, SCREEN_DPI),
      heightPx: mmToPx(heightMm, SCREEN_DPI),
    };
  }, [pageConfig]);

  if (isLoading || isProjectLoading || isLayersLoading || (isAtlasEnabled && isAtlasLoading)) {
    return (
      <Box
        sx={{
          width: "100vw",
          height: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#fff",
        }}>
        <CircularProgress />
      </Box>
    );
  }

  if (isError || !reportLayout) {
    return (
      <Box
        sx={{
          width: "100vw",
          height: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#fff",
        }}>
        <Typography color="error">Failed to load report layout</Typography>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        width: paperDimensions.widthPx,
        height: paperDimensions.heightPx,
        backgroundColor: "#fff",
        padding: 0,
        margin: 0,
        // Hide scrollbars for print
        overflow: "hidden",
        "@media print": {
          backgroundColor: "transparent",
        },
      }}>
      {/* Paper */}
      <Box
        id="print-paper"
        sx={{
          width: paperDimensions.widthPx,
          height: paperDimensions.heightPx,
          backgroundColor: "#ffffff",
          position: "relative",
          boxSizing: "border-box",
          // For print, no shadow
          "@media print": {
            boxShadow: "none",
            margin: 0,
          },
        }}>
        {/* Report elements - positioned relative to the paper, not the margins */}
        {/* Wrap with light theme since paper is always white */}
        <ThemeProvider settings={LIGHT_THEME_SETTINGS}>
          <ReportElements
            config={reportLayout.config}
            basemapUrl={mapStyle}
            projectLayers={projectLayers}
            locale={project?.locale ?? undefined}
            atlasPage={currentAtlasPage}
            onMapLoaded={handleMapLoaded}
          />
        </ThemeProvider>
      </Box>

      {/* Hidden metadata for Playwright */}
      <div
        id="print-metadata"
        data-ready={isReady}
        data-width-mm={paperDimensions.widthMm}
        data-height-mm={paperDimensions.heightMm}
        data-orientation={pageConfig.orientation}
        data-atlas-enabled={isAtlasEnabled}
        data-atlas-total-pages={atlasTotalPages}
        data-atlas-current-page={atlasPageIndex}
        data-atlas-feature-properties={
          currentAtlasPage?.feature?.properties
            ? JSON.stringify(currentAtlasPage.feature.properties)
            : undefined
        }
        data-atlas-page-label={currentAtlasPage?.label || undefined}
        style={{ display: "none" }}
      />
    </Box>
  );
}

/**
 * Renders the report elements on the page
 */
interface ReportElementsProps {
  config: ReportLayoutConfig;
  basemapUrl?: string | StyleSpecification;
  projectLayers?: MapLayer[];
  /** The project's number locale. */
  locale?: string;
  atlasPage?: AtlasPage | null;
  onMapLoaded?: () => void;
}

const ReportElements: React.FC<ReportElementsProps> = ({
  config,
  basemapUrl,
  projectLayers,
  locale,
  atlasPage,
  onMapLoaded,
}) => {
  // Local mutable copy of elements so the atlas effect can write back the
  // per-page viewState for the scalebar to read. Initialised once from the
  // saved config; we deliberately do NOT keep it in sync with `config.elements`
  // afterwards, because in the print context PrintPage re-renders (e.g. when
  // mapsLoadedCount increments) cause `config.elements` to be re-evaluated and
  // a sync-effect would race against the atlas writeback — overwriting it on
  // every page and leaving the scalebar stuck at the persisted snapshot.
  const [elements, setElements] = useState(() => snapScalebarWidths(config.elements || []));

  // Handle element config updates (e.g. map writing back viewState after atlas page change)
  const handleElementUpdate = useCallback((elementId: string, newConfig: Record<string, unknown>) => {
    // The atlas map writes its view state back per page; refit the scalebar
    // rectangles to the bar for that page in the same update.
    setElements((prev) =>
      snapScalebarWidths(prev.map((el) => (el.id === elementId ? { ...el, config: newConfig } : el)))
    );
  }, []);

  if (elements.length === 0) {
    // Show placeholder for empty reports
    return (
      <Box
        sx={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#ccc",
          fontSize: "14px",
        }}>
        No elements in this report
      </Box>
    );
  }

  // Render elements - positions are stored in mm, need to convert to px
  return (
    <>
      {elements.map((element) => {
        const widthPx = mmToPx(element.position.width, SCREEN_DPI);
        const heightPx = mmToPx(element.position.height, SCREEN_DPI);

        const frame = resolveElementFrame(element.style);

        return (
          <Box
            key={element.id}
            data-element-type={element.type}
            sx={{
              position: "absolute",
              // Convert mm positions to pixels at SCREEN_DPI (96)
              left: mmToPx(element.position.x, SCREEN_DPI),
              top: mmToPx(element.position.y, SCREEN_DPI),
              width: widthPx,
              height: heightPx,
              zIndex: element.position.z_index,
              backgroundColor: frame.backgroundColor,
              opacity: element.style?.opacity ?? 1,
              // No rounded borders in print view
              borderRadius: 0,
              border: frame.border,
              overflow: "hidden",
              // Ensure backgrounds print correctly
              WebkitPrintColorAdjust: "exact",
              printColorAdjust: "exact",
            }}>
            {/* Element content using shared renderer */}
            <ElementContentRenderer
              element={element}
              allElements={elements}
              width={widthPx}
              height={heightPx}
              basemapUrl={basemapUrl}
              projectLayers={projectLayers}
              locale={locale}
              atlasPage={atlasPage}
              viewOnly
              onElementUpdate={handleElementUpdate}
              onMapLoaded={onMapLoaded}
            />
          </Box>
        );
      })}
    </>
  );
};
