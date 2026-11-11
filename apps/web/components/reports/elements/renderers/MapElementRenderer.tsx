"use client";

import { Box, Chip, CircularProgress, useTheme } from "@mui/material";
import type { Map as MaplibreMap, StyleSpecification } from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Map, MapProvider, type MapRef, type ViewStateChangeEvent } from "react-map-gl/maplibre";

import { BUILDINGS_TILES_URL, TERRAIN_TILES_URL } from "@/lib/constants";
import { BASEMAPS, DEFAULT_BASEMAP, getBasemapUrl } from "@/lib/constants/basemaps";
import type { AtlasPage } from "@/lib/print/atlas-utils";
import { calculateMapViewport, zoomToScale } from "@/lib/print/atlas-utils";
import { mmToPx, SCREEN_DPI } from "@/lib/print/units";
import { isImageryBasemap, toneOf } from "@/lib/scene/auto";
import { buildingsAnchor } from "@/lib/scene/compile";
import { cameraFor, viewModeOf } from "@/lib/scene/view";
import { extrudes } from "@/lib/style/compile/polygons";
import type { Scene } from "@/lib/style/generated/types";
import type { JsonObject } from "@/lib/style/json";
import { MAPLIBRE_MAP_OPTIONS } from "@/lib/utils/map/maplibre";
import type { MapAtlasControl, ReportElement } from "@/lib/validations/reportLayout";

import type { Basemap } from "@/types/map/common";

import type { MapLayer } from "@/hooks/map/useMapLayers";
import { useScene } from "@/hooks/map/useScene";
import { useMapElementRenderLayers } from "@/hooks/reports/useMapElementRenderLayers";

import { StyledLayers } from "@/components/map/StyledLayers";

// Fallback for a map element whose project has not synced a basemap yet: the
// app's own Light basemap, rather than a second provider's copy of the same
// style.
const DEFAULT_BASEMAP_URL = getBasemapUrl("light");

// Default view state (centered on Europe)
const DEFAULT_VIEW_STATE = {
  latitude: 48.13,
  longitude: 11.57,
  zoom: 10,
  bearing: 0,
  pitch: 0,
};

interface MapElementRendererProps {
  element: ReportElement;
  basemapUrl?: string | StyleSpecification; // Live from project (synced) — string URL for vector basemaps, synthesized StyleSpecification for raster/solid customs
  layers?: MapLayer[]; // Live from project (synced): the map's layers with their styles
  /** The map's number locale; the viewer's language without one. */
  locale?: string;
  /** The project's 3D scene (map document `scene`), live also for locked layers (3D spec 10). */
  scene?: Scene | null;
  /** The project's basemap, for the scene's 3D buildings; the default basemap without one. */
  basemap?: Basemap;
  zoom?: number; // Page zoom level for scaling
  atlasPage?: AtlasPage | null; // Current atlas page (if atlas enabled)
  viewOnly?: boolean;
  onElementUpdate?: (elementId: string, config: Record<string, unknown>) => void;
  onNavigationModeChange?: (isNavigating: boolean) => void;
  onMapLoaded?: () => void; // Called when the map has finished loading
}

/**
 * Map element renderer for reports.
 *
 * - basemapUrl & layers: SYNCED live from project props
 * - viewState: SNAPSHOT stored in element.config (not synced), OR computed from atlas page bounds
 *
 * Atlas Mode:
 * - When atlasPage is provided, the map automatically fits to the feature bounds
 * - The map element can have atlas control settings that override default behavior
 *
 * Double-click to enter navigation mode (pan/zoom the map).
 * Press Escape to exit navigation mode.
 * View state changes are saved to element.config.
 */
const MapElementRenderer: React.FC<MapElementRendererProps> = ({
  element,
  basemapUrl,
  layers = [],
  locale,
  scene,
  basemap,
  zoom = 1,
  atlasPage,
  viewOnly = false,
  onElementUpdate,
  onNavigationModeChange,
  onMapLoaded,
}) => {
  const theme = useTheme();
  const { t, i18n } = useTranslation("common");
  const mapRef = useRef<MapRef>(null);
  const [isNavigationMode, setIsNavigationMode] = useState(false);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [loadedMap, setLoadedMap] = useState<MaplibreMap | null>(null);

  // Get snapshot view state from element config (NOT synced)
  // Use optional chaining directly to allow React to properly track changes
  const configViewState = element.config?.viewState;

  // Create a stable key for detecting config changes
  const configKey = JSON.stringify(configViewState);

  const lockLayers = element.config?.lock_layers === true;
  const lockedBasemapUrl = element.config?.locked_basemap_url as string | StyleSpecification | undefined;

  // Use locked basemap when layers are locked, otherwise live from props
  const mapStyleUrl: string | StyleSpecification =
    (lockLayers && lockedBasemapUrl) ? lockedBasemapUrl : (basemapUrl || DEFAULT_BASEMAP_URL);

  // Check if this map element is controlled by atlas
  const isAtlasControlled = element.config?.atlas?.enabled === true;
  // The locked or drawn layers, the atlas page's coverage layer hidden or filtered to its feature.
  const renderLayers = useMapElementRenderLayers(
    layers,
    (element.config ?? {}) as Record<string, unknown>,
    atlasPage
  );

  // Use controlled viewState to prevent map from changing when container resizes (page zoom)
  const [viewState, setViewState] = useState({
    latitude: configViewState?.latitude ?? DEFAULT_VIEW_STATE.latitude,
    longitude: configViewState?.longitude ?? DEFAULT_VIEW_STATE.longitude,
    zoom: configViewState?.zoom ?? DEFAULT_VIEW_STATE.zoom,
    bearing: configViewState?.bearing ?? DEFAULT_VIEW_STATE.bearing,
    pitch: configViewState?.pitch ?? DEFAULT_VIEW_STATE.pitch,
  });

  // Update viewState when element config changes (e.g., from config panel or after reload)
  // This syncs bearing (rotation) and zoom set via the config panel
  // Only update from config if NOT in atlas mode (or atlas not controlling this map)
  useEffect(() => {
    if (atlasPage && isAtlasControlled) return; // Atlas mode handles viewState separately

    const configBearing = configViewState?.bearing ?? DEFAULT_VIEW_STATE.bearing;
    const configZoom = configViewState?.zoom ?? DEFAULT_VIEW_STATE.zoom;
    const configLat = configViewState?.latitude ?? DEFAULT_VIEW_STATE.latitude;
    const configLng = configViewState?.longitude ?? DEFAULT_VIEW_STATE.longitude;
    const configPitch = configViewState?.pitch ?? DEFAULT_VIEW_STATE.pitch;

    setViewState({
      latitude: configLat,
      longitude: configLng,
      zoom: configZoom,
      bearing: configBearing,
      pitch: configPitch,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey, atlasPage, isAtlasControlled]);

  // Atlas mode: compute the target viewState from the atlas page bounds and the
  // element's pixel dimensions. This is a pure derivation — no imperative
  // map.fitBounds()/once("idle") dance and no dependence on the map being
  // mounted. Earlier versions called fitBounds imperatively; in print
  // (Playwright + non-interactive controlled <Map>) the imperative move was
  // either swallowed by the silent try/catch on a 0×0 canvas or undone by
  // the controlled-prop reapply, leaving every page at the saved snapshot.
  const atlasMode = (element.config?.atlas?.mode as string) ?? "best_fit";
  const atlasMarginPercent = (element.config?.atlas?.margin_percent as number) ?? 10;
  const atlasFixedScale = element.config?.atlas?.fixed_scale as number | null | undefined;
  const atlasPredefinedScales = element.config?.atlas?.predefined_scales as
    | number[]
    | null
    | undefined;

  useEffect(() => {
    if (!atlasPage || !isAtlasControlled) return;

    const widthPx = mmToPx(element.position.width, SCREEN_DPI);
    const heightPx = mmToPx(element.position.height, SCREEN_DPI);
    if (widthPx <= 0 || heightPx <= 0) return;

    const atlasControl: MapAtlasControl = {
      enabled: true,
      mode: atlasMode as MapAtlasControl["mode"],
      margin_percent: atlasMarginPercent,
      fixed_scale: atlasFixedScale ?? null,
      predefined_scales: atlasPredefinedScales ?? null,
    };

    const viewport = calculateMapViewport(atlasPage, atlasControl, widthPx, heightPx);
    // Cap zoom to match the previous fitBounds maxZoom: 18 behaviour
    // (avoids absurd zoom on tiny features like Points).
    const cappedZoom = Math.min(viewport.zoom, 18);

    const configBearing = configViewState?.bearing ?? DEFAULT_VIEW_STATE.bearing;

    // An atlas page fits its feature's bounds, which only a flat map shows as computed: it stays at pitch 0 (3D
    // spec 10), keeping the element's bearing.
    const newViewState = {
      latitude: viewport.center[1],
      longitude: viewport.center[0],
      zoom: cappedZoom,
      bearing: configBearing,
      pitch: 0,
      mode: "2d" as const,
      // Derived scale denominator for the atlas page. The scalebar's "numeric"
      // style prefers viewState.scale_denominator over the zoom-derived value,
      // so we must set it explicitly per page — otherwise a stored snapshot
      // value would be re-read and shown identically on every print page.
      scale_denominator: Math.round(zoomToScale(cappedZoom, viewport.center[1])),
    };

    setViewState(newViewState);

    // Writeback so the scalebar (which reads element.config.viewState) sees
    // the atlas-derived center/zoom/scale per page.
    if (onElementUpdate) {
      onElementUpdate(element.id, {
        ...element.config,
        viewState: newViewState,
      });
    }
    setAtlasViewStateReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    atlasPage,
    isAtlasControlled,
    atlasMode,
    atlasMarginPercent,
    atlasFixedScale,
    atlasPredefinedScales,
    element.position.width,
    element.position.height,
    configViewState?.bearing,
  ]);

  // Handle double-click to enter navigation mode
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (viewOnly) return;
      e.stopPropagation();
      e.preventDefault();
      setIsNavigationMode(true);
    },
    [viewOnly]
  );

  // Handle escape key to exit navigation mode
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape" && isNavigationMode) {
        setIsNavigationMode(false);
        e.stopPropagation();
      }
    },
    [isNavigationMode]
  );

  // Save view state when map is moved
  const handleMoveEnd = useCallback(
    (e: ViewStateChangeEvent) => {
      if (!isNavigationMode || !onElementUpdate) return;

      const { latitude, longitude, zoom, bearing, pitch } = e.viewState;
      onElementUpdate(element.id, {
        ...element.config,
        viewState: { latitude, longitude, zoom, bearing, pitch },
      });
    },
    [element.id, element.config, isNavigationMode, onElementUpdate]
  );

  // Handle blur to exit navigation mode
  const handleBlur = useCallback(() => {
    if (isNavigationMode) {
      setIsNavigationMode(false);
    }
  }, [isNavigationMode]);

  // Notify parent when navigation mode changes
  useEffect(() => {
    onNavigationModeChange?.(isNavigationMode);
  }, [isNavigationMode, onNavigationModeChange]);

  // Icons and patterns load on demand through the renderer's image resolver.
  const handleMapLoad = useCallback(() => {
    setMapLoaded(true);
    setLoadedMap(mapRef.current?.getMap() ?? null);
  }, []);

  // --- 3D (3D spec 10) --------------------------------------------------------
  // A tilted view prints in 3D with the project's live scene; MapLibre's default maxPitch of 60 would clamp it. An
  // atlas page is flat. Paper is white, so the automatic scene takes the light tone unless the basemap is dark.
  const atlasFlat = !!atlasPage && isAtlasControlled;
  const viewMode = atlasFlat ? "2d" : viewModeOf({ mode: configViewState?.mode, pitch: viewState.pitch });
  const sceneBasemap: Basemap = basemap ?? BASEMAPS.find((b) => b.value === DEFAULT_BASEMAP) ?? BASEMAPS[0];
  const projectExtrudes = useMemo(
    () => renderLayers.some((l) => l.entry.visible !== false && extrudes(l.style as unknown as JsonObject)),
    [renderLayers]
  );
  const appliedScene = useScene(loadedMap, {
    scene: scene ?? undefined,
    mode: viewMode,
    projection: "mercator",
    tone: toneOf(sceneBasemap, "light"),
    terrainUrl: TERRAIN_TILES_URL,
    buildingsUrl: BUILDINGS_TILES_URL,
    projectExtrudes,
    imagery: isImageryBasemap(sceneBasemap),
    basemap: sceneBasemap,
  });
  // A 3D print waits for the scene: an idle before terrain and sky are on the map would capture it without them.
  const sceneReady = viewMode === "2d" || appliedScene !== null;

  // Track if we've already notified parent that map is ready
  const hasNotifiedReady = useRef(false);
  // Track if atlas viewState writeback is done (only relevant for atlas-controlled maps)
  const [atlasViewStateReady, setAtlasViewStateReady] = useState(!isAtlasControlled);

  // For atlas-controlled maps, notify parent once atlas viewState is written back (and a 3D map once its scene is on)
  useEffect(() => {
    if (mapLoaded && atlasViewStateReady && sceneReady && !hasNotifiedReady.current) {
      hasNotifiedReady.current = true;
      onMapLoaded?.();
    }
  }, [mapLoaded, atlasViewStateReady, sceneReady, onMapLoaded]);

  // Handle map idle - called when the map has finished rendering
  // This is more reliable for print than onLoad which fires when style is loaded
  const handleMapIdle = useCallback(() => {
    // Only notify once when the map first becomes idle after loading
    // For atlas-controlled maps, the useEffect above handles notification
    if (mapLoaded && sceneReady && !hasNotifiedReady.current && !isAtlasControlled) {
      hasNotifiedReady.current = true;
      onMapLoaded?.();
    }
  }, [mapLoaded, sceneReady, onMapLoaded, isAtlasControlled]);

  // Calculate inverse scale to render map at native size
  // The parent container is already scaled by zoom, so we render the map
  // at 1/zoom size and scale it back up to fill the container
  const inverseZoom = 1 / zoom;

  return (
    <MapProvider>
      <Box
        tabIndex={0}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        sx={{
          width: "100%",
          height: "100%",
          position: "relative",
          cursor: isNavigationMode ? "grab" : "inherit",
          "&:active": isNavigationMode ? { cursor: "grabbing" } : {},
          // Override MapLibre's internal canvas cursor to stay consistent
          ...(isNavigationMode && {
            "& .maplibregl-canvas": {
              cursor: "inherit !important",
            },
          }),
          outline: "none",
          pointerEvents: "auto",
          overflow: "hidden",
        }}>
        {/* Map container with inverse scaling to maintain consistent appearance */}
        <Box
          sx={{
            width: `${100 * inverseZoom}%`,
            height: `${100 * inverseZoom}%`,
            transform: `scale(${zoom})`,
            transformOrigin: "top left",
            position: "relative",
            "& .maplibregl-ctrl-attrib": {
              display: "none",
            },
            "& .maplibregl-ctrl-logo": {
              display: "none",
            },
          }}>
          {/* Loading overlay */}
          {!mapLoaded && (
            <Box
              sx={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "#f5f5f5",
                zIndex: 5,
              }}>
              <CircularProgress size={24} />
            </Box>
          )}

          <Map
            {...MAPLIBRE_MAP_OPTIONS}
            ref={mapRef}
            style={{ width: "100%", height: "100%" }}
            {...viewState}
            pitch={atlasFlat ? 0 : viewState.pitch}
            maxPitch={cameraFor(viewMode).maxPitch}
            onMove={(e) => setViewState(e.viewState)}
            mapStyle={mapStyleUrl}
            attributionControl={false}
            dragPan={isNavigationMode}
            scrollZoom={isNavigationMode}
            dragRotate={false}
            touchZoomRotate={isNavigationMode}
            doubleClickZoom={false}
            onMoveEnd={handleMoveEnd}
            onLoad={handleMapLoad}
            onIdle={handleMapIdle}
            interactive={isNavigationMode}
            canvasContextAttributes={{ preserveDrawingBuffer: true }}>
            {renderLayers.length > 0 && (
              <StyledLayers
                layers={renderLayers}
                locale={locale || i18n.language}
                ground={buildingsAnchor(appliedScene)}
              />
            )}
          </Map>
        </Box>

        {/* Navigation mode indicator */}
        {!viewOnly && mapLoaded && (
          <Box
            sx={{
              position: "absolute",
              bottom: 8,
              left: 8,
              zIndex: 10,
            }}>
            {isNavigationMode ? (
              <Chip
                size="small"
                label={t("press_esc_to_exit")}
                sx={{
                  backgroundColor: theme.palette.primary.main,
                  color: "white",
                  fontSize: "0.7rem",
                  height: 20,
                }}
              />
            ) : (
              <Chip
                size="small"
                label={t("double_click_to_navigate")}
                sx={{
                  backgroundColor: "rgba(0,0,0,0.6)",
                  color: "white",
                  fontSize: "0.7rem",
                  height: 20,
                }}
              />
            )}
          </Box>
        )}
      </Box>
    </MapProvider>
  );
};

export default MapElementRenderer;
