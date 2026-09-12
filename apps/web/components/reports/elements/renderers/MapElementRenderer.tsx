"use client";

import { Box, Chip, CircularProgress, useTheme } from "@mui/material";
import type { StyleSpecification } from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Map, MapProvider, type MapRef, type ViewStateChangeEvent } from "react-map-gl/maplibre";

import { getBasemapUrl } from "@/lib/constants/basemaps";
import { PATTERN_IMAGES } from "@/lib/constants/pattern-images";
import type { AtlasPage } from "@/lib/print/atlas-utils";
import { calculateMapViewport, zoomToScale } from "@/lib/print/atlas-utils";
import { mmToPx, SCREEN_DPI } from "@/lib/print/units";
import { addOrUpdateMarkerImages, addPatternImages } from "@/lib/transformers/map-image";
import type { FeatureLayerPointProperties } from "@/lib/validations/layer";
import type { ProjectLayer } from "@/lib/validations/project";
import type { MapAtlasControl, ReportElement } from "@/lib/validations/reportLayout";

import Layers from "@/components/map/Layers";

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
  layers?: ProjectLayer[]; // Live from project (synced)
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
  zoom = 1,
  atlasPage,
  viewOnly = false,
  onElementUpdate,
  onNavigationModeChange,
  onMapLoaded,
}) => {
  const theme = useTheme();
  const mapRef = useRef<MapRef>(null);
  const [isNavigationMode, setIsNavigationMode] = useState(false);
  const [mapLoaded, setMapLoaded] = useState(false);

  // Get snapshot view state from element config (NOT synced)
  // Use optional chaining directly to allow React to properly track changes
  const configViewState = element.config?.viewState;

  // Create a stable key for detecting config changes
  const configKey = JSON.stringify(configViewState);

  // Layer lock settings from config
  const lockLayers = element.config?.lock_layers === true;
  const lockStyles = element.config?.lock_styles === true;
  const lockedLayerIds = element.config?.locked_layer_ids as number[] | undefined;
  const lockedLayerStyles = element.config?.locked_layer_styles as Record<string, Record<string, unknown>> | undefined;
  const lockedBasemapUrl = element.config?.locked_basemap_url as string | StyleSpecification | undefined;

  // Use locked basemap when layers are locked, otherwise live from props
  const mapStyleUrl: string | StyleSpecification =
    (lockLayers && lockedBasemapUrl) ? lockedBasemapUrl : (basemapUrl || DEFAULT_BASEMAP_URL);

  // Check if this map element is controlled by atlas
  const isAtlasControlled = element.config?.atlas?.enabled === true;

  // Filter and transform layers based on lock state
  const visibleLayers = useMemo(() => {
    let filtered: ProjectLayer[];

    if (lockLayers && lockedLayerIds) {
      // Locked: only show the locked layer IDs with forced visibility
      // (layer visibility from the project should NOT affect locked maps)
      filtered = layers
        .filter((layer) => lockedLayerIds.includes(layer.id))
        .map((layer) => ({
          ...layer,
          properties: { ...layer.properties, visibility: true },
        }));
    } else {
      // Normal: filter by visibility
      filtered = layers.filter((layer) => {
        const props = layer.properties as Record<string, unknown>;
        return props.visibility !== false;
      });
    }

    // If styles are also locked, overlay frozen properties onto matching layers
    if (lockLayers && lockStyles && lockedLayerStyles) {
      filtered = filtered.map((layer) => {
        const frozenProps = lockedLayerStyles[String(layer.id)];
        if (frozenProps) {
          return { ...layer, properties: frozenProps };
        }
        return layer;
      });
    }

    // Atlas coverage layer hiding (filter-to-current-feature is applied
    // client-side via the atlasFilter prop on <Layers> below, so the
    // tile URL stays stable across page changes and tiles aren't refetched).
    if (
      atlasPage &&
      isAtlasControlled &&
      atlasPage.coverageLayerProjectId &&
      atlasPage.hiddenCoverageLayer
    ) {
      filtered = filtered.filter((layer) => layer.id !== atlasPage.coverageLayerProjectId);
    }

    return filtered;
  }, [layers, lockLayers, lockStyles, lockedLayerIds, lockedLayerStyles, atlasPage, isAtlasControlled]);

  // Atlas filter: applied client-side to the coverage layer's MapLibre filter
  // so changing pages doesn't change the tile URL (no setTiles refetch).
  const atlasFilter = useMemo(() => {
    if (
      !atlasPage ||
      !isAtlasControlled ||
      !atlasPage.coverageLayerProjectId ||
      !atlasPage.filterToCurrentFeature ||
      !atlasPage.feature
    ) {
      return undefined;
    }
    return {
      layerId: atlasPage.coverageLayerProjectId,
      featureId: atlasPage.feature.id,
    };
  }, [atlasPage, isAtlasControlled]);

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
    const configPitch = configViewState?.pitch ?? DEFAULT_VIEW_STATE.pitch;

    const newViewState = {
      latitude: viewport.center[1],
      longitude: viewport.center[0],
      zoom: cappedZoom,
      bearing: configBearing,
      pitch: configPitch,
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
    configViewState?.pitch,
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

  // Handle map load - load marker and pattern images for layers
  const handleMapLoad = useCallback(() => {
    if (mapRef.current) {
      // Load marker images for point layers with custom markers
      visibleLayers.forEach((layer) => {
        if (layer.type === "feature" && layer.feature_layer_geometry_type === "point") {
          const pointFeatureProperties = layer.properties as FeatureLayerPointProperties;
          addOrUpdateMarkerImages(layer.id, pointFeatureProperties, mapRef.current);
        }
      });

      // Load pattern images
      addPatternImages(PATTERN_IMAGES ?? [], mapRef.current);
    }
    setMapLoaded(true);
  }, [visibleLayers]);

  // Track if we've already notified parent that map is ready
  const hasNotifiedReady = useRef(false);
  // Track if atlas viewState writeback is done (only relevant for atlas-controlled maps)
  const [atlasViewStateReady, setAtlasViewStateReady] = useState(!isAtlasControlled);

  // For atlas-controlled maps, notify parent once atlas viewState is written back
  useEffect(() => {
    if (mapLoaded && atlasViewStateReady && !hasNotifiedReady.current) {
      hasNotifiedReady.current = true;
      onMapLoaded?.();
    }
  }, [mapLoaded, atlasViewStateReady, onMapLoaded]);

  // Handle map idle - called when the map has finished rendering
  // This is more reliable for print than onLoad which fires when style is loaded
  const handleMapIdle = useCallback(() => {
    // Only notify once when the map first becomes idle after loading
    // For atlas-controlled maps, the useEffect above handles notification
    if (mapLoaded && !hasNotifiedReady.current && !isAtlasControlled) {
      hasNotifiedReady.current = true;
      onMapLoaded?.();
    }
  }, [mapLoaded, onMapLoaded, isAtlasControlled]);

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
            ref={mapRef}
            style={{ width: "100%", height: "100%" }}
            {...viewState}
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
            {visibleLayers.length > 0 && <Layers layers={visibleLayers} atlasFilter={atlasFilter} />}
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
                label="Press ESC to exit"
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
                label="Double-click to navigate"
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
