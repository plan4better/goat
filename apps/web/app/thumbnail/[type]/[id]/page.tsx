"use client";

import { Box } from "@mui/material";
import type { Map as MaplibreMap } from "maplibre-gl";
import { useParams, useSearchParams } from "next/navigation";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Map, MapProvider, type MapRef } from "react-map-gl/maplibre";

import { BUILDINGS_TILES_URL, TERRAIN_TILES_URL } from "@/lib/constants";
import { BASEMAPS, DEFAULT_BASEMAP, getBasemapUrl } from "@/lib/constants/basemaps";
import { isImageryBasemap } from "@/lib/scene/auto";
import { buildingsAnchor } from "@/lib/scene/compile";
import { extrudes } from "@/lib/style/compile/polygons";
import type { JsonObject } from "@/lib/style/json";
import { renderLayersOf } from "@/lib/style/render/viewLayers";
import { MAPLIBRE_MAP_OPTIONS } from "@/lib/utils/map/maplibre";
import { parseThumbnailData, thumbnailLayers, thumbnailView } from "@/lib/utils/map/thumbnail";

import { useScene } from "@/hooks/map/useScene";

import { StyledLayers } from "@/components/map/StyledLayers";

// Thumbnail dimensions
const THUMBNAIL_WIDTH = 800;
const THUMBNAIL_HEIGHT = 450;

// Default view state
const DEFAULT_VIEW_STATE = {
  latitude: 48.13,
  longitude: 11.57,
  zoom: 10,
  bearing: 0,
  pitch: 0,
};

/**
 * The renderer hands the payload over on `window`, set by an init script that
 * runs before any of this page's own code. It used to arrive in the `?data=`
 * query param, but the payload carries the whole layer list and the request
 * line counts against the web server's header budget: past Node's 16 KB
 * default the navigation came back 431 and this page never ran at all.
 * The query param still works, so a thumbnail URL stays pasteable by hand.
 */
function readInjectedThumbnailData(): string | null {
  if (typeof window === "undefined") return null;
  const injected = (window as { __THUMBNAIL_DATA__?: unknown }).__THUMBNAIL_DATA__;
  return typeof injected === "string" ? injected : null;
}

/**
 * Thumbnail page that renders a simple map view for Playwright screenshot capture.
 * This page is designed to be rendered without any UI chrome - just the map.
 *
 * URL pattern: /thumbnail/[type]/[id]?data=<base64-encoded-json>
 * - type: "project", "layer" or "bundle"
 * - id: UUID of the project, layer or bundle
 * - data: Base64-encoded JSON containing viewState, basemap, layers, and optional bounds
 *
 * The data param contains all necessary information to render the map,
 * avoiding the need for authenticated API calls.
 *
 * Playwright will navigate to this page and take a screenshot for thumbnail generation.
 */
export default function ThumbnailPage() {
  const params = useParams();
  const searchParams = useSearchParams();

  const type = params.type as "project" | "layer" | "bundle";
  const id = params.id as string;
  const dataParam = searchParams.get("data");

  const [mounted, setMounted] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [mapLoaded, setMapLoaded] = useState(false);
  const mapRef = React.useRef<MapRef>(null);
  const [loadedMap, setLoadedMap] = useState<MaplibreMap | null>(null);

  // Ensure client-side only rendering to avoid hydration mismatch
  useEffect(() => {
    setMounted(true);
  }, []);

  // Parse thumbnail data from the URL param, or from what the renderer
  // injected on `window`. Recomputed once `mounted` flips, because `window`
  // is not readable during the server render that precedes it.
  const thumbnailData = useMemo(() => {
    return parseThumbnailData(dataParam ?? readInjectedThumbnailData());
  }, [dataParam, mounted]); // eslint-disable-line react-hooks/exhaustive-deps

  // Extract data from thumbnailData or use defaults
  const viewState = useMemo(() => {
    if (thumbnailData?.viewState) {
      return {
        latitude: thumbnailData.viewState.latitude ?? DEFAULT_VIEW_STATE.latitude,
        longitude: thumbnailData.viewState.longitude ?? DEFAULT_VIEW_STATE.longitude,
        zoom: thumbnailData.viewState.zoom ?? DEFAULT_VIEW_STATE.zoom,
        bearing: thumbnailData.viewState.bearing ?? DEFAULT_VIEW_STATE.bearing,
        pitch: thumbnailData.viewState.pitch ?? DEFAULT_VIEW_STATE.pitch,
      };
    }
    return DEFAULT_VIEW_STATE;
  }, [thumbnailData]);

  const viewLayers = useMemo(() => thumbnailLayers(thumbnailData?.layers), [thumbnailData]);
  const layersToRender = useMemo(() => renderLayersOf(viewLayers), [viewLayers]);

  const bounds = useMemo(() => {
    return thumbnailData?.bounds ?? null;
  }, [thumbnailData]);

  // Whether to use fitBounds or initial viewState
  // Default: use bounds if provided, unless explicitly set to false
  const useBounds = useMemo(() => {
    if (thumbnailData?.useBounds !== undefined) {
      return thumbnailData.useBounds;
    }
    // Default to using bounds if they are provided
    return bounds !== null;
  }, [thumbnailData, bounds]);

  const basemapUrl = useMemo(() => {
    if (thumbnailData?.basemap) {
      return getBasemapUrl(thumbnailData.basemap);
    }
    return getBasemapUrl(DEFAULT_BASEMAP);
  }, [thumbnailData]);

  // A project's saved 2D or 3D view with its scene (3D spec 10); a layer thumbnail stays flat. The light tone: the
  // thumbnail is drawn on white, whatever the viewer's theme.
  const view = useMemo(
    () =>
      thumbnailView(
        thumbnailData ?? { viewState: DEFAULT_VIEW_STATE, basemap: DEFAULT_BASEMAP, layers: [] },
        type
      ),
    [thumbnailData, type]
  );
  const basemap =
    BASEMAPS.find((b) => b.value === thumbnailData?.basemap) ??
    BASEMAPS.find((b) => b.value === DEFAULT_BASEMAP) ??
    BASEMAPS[0];
  const projectExtrudes = useMemo(
    () => viewLayers.some((l) => l.visible && l.style && extrudes(l.style.document as unknown as JsonObject)),
    [viewLayers]
  );
  const appliedScene = useScene(loadedMap, {
    scene: view.scene,
    mode: view.mode,
    projection: view.projection,
    tone: "light",
    terrainUrl: TERRAIN_TILES_URL,
    buildingsUrl: BUILDINGS_TILES_URL,
    projectExtrudes,
    imagery: isImageryBasemap(basemap),
    basemap,
  });

  // Handle map load
  const handleMapLoad = useCallback(() => {
    setMapLoaded(true);
    setLoadedMap(mapRef.current?.getMap() ?? null);

    if (mapRef.current) {
      // Icons and patterns load on demand through the renderer's image resolver.
      // Fit bounds if provided and useBounds is true
      // This ensures the thumbnail shows all content within the bounds
      if (bounds && useBounds) {
        const [west, south, east, north] = bounds;

        // Calculate appropriate padding based on thumbnail type
        // For single layers, use moderate padding for visual balance
        // For projects and bundles, which draw several layers together, use
        // slightly more padding for context
        const isLayer = type === "layer";
        const padding = isLayer ? 30 : 40;

        mapRef.current?.fitBounds(
          [
            [west, south],
            [east, north],
          ],
          {
            padding,
            duration: 0,
            // Allow higher zoom for single layers to show detail
            maxZoom: isLayer ? 18 : 16,
          }
        );
      }
    }
  }, [bounds, useBounds, type]);

  // Signal to Playwright that the page is ready
  useEffect(() => {
    // Data is ready if we have valid thumbnailData
    const isDataLoaded = thumbnailData !== null;
    // A 3D view waits for its scene: captured before terrain and sky are on, the thumbnail would show neither.
    const sceneReady = view.mode === "2d" || appliedScene !== null;

    if (isDataLoaded && mapLoaded && sceneReady) {
      // Give additional delay for map tiles to fully render
      const timer = setTimeout(() => {
        setIsReady(true);
        // Add a data attribute that Playwright can check
        document.body.setAttribute("data-thumbnail-ready", "true");
      }, 1500); // 1.5 second delay to allow map tiles to render
      return () => clearTimeout(timer);
    }
  }, [thumbnailData, mapLoaded, view.mode, appliedScene]);

  // Show empty placeholder during SSR/initial mount to avoid hydration mismatch
  if (!mounted) {
    return (
      <Box
        sx={{
          width: THUMBNAIL_WIDTH,
          height: THUMBNAIL_HEIGHT,
          backgroundColor: "#fff",
        }}
      />
    );
  }

  // Error state - no data provided or invalid data
  if (!thumbnailData) {
    return (
      <Box
        sx={{
          width: THUMBNAIL_WIDTH,
          height: THUMBNAIL_HEIGHT,
          backgroundColor: "#fff",
        }}
      />
    );
  }

  return (
    <Box
      id="thumbnail-container"
      sx={{
        width: THUMBNAIL_WIDTH,
        height: THUMBNAIL_HEIGHT,
        backgroundColor: "#fff",
        padding: 0,
        margin: 0,
        overflow: "hidden",
      }}>
      <MapProvider>
        <Map
          {...MAPLIBRE_MAP_OPTIONS}
          ref={mapRef}
          mapStyle={basemapUrl}
          initialViewState={viewState}
          maxPitch={view.maxPitch}
          style={{ width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT }}
          attributionControl={false}
          logoPosition="bottom-left"
          canvasContextAttributes={{ preserveDrawingBuffer: true }} // Required for screenshot
          onLoad={handleMapLoad}
          interactive={false} // Disable interactivity for thumbnails
        >
          {mapLoaded && layersToRender.length > 0 && (
            <StyledLayers layers={layersToRender} locale="en" ground={buildingsAnchor(appliedScene)} />
          )}
        </Map>
      </MapProvider>

      {/* Hidden metadata for Playwright */}
      <div
        id="thumbnail-metadata"
        data-ready={isReady}
        data-type={type}
        data-id={id}
        data-layer-count={layersToRender.length}
        style={{ display: "none" }}
      />
    </Box>
  );
}
