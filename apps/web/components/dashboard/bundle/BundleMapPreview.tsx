import { Box, Typography, useTheme } from "@mui/material";
import bbox from "@turf/bbox";
import "maplibre-gl/dist/maplibre-gl.css";
import React, { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { MapRef } from "react-map-gl/maplibre";
import { MapProvider } from "react-map-gl/maplibre";

import { useDatasetStyles } from "@/lib/api/map";
import { getBasemapUrl } from "@/lib/constants/basemaps";
import { DrawProvider } from "@/lib/providers/DrawProvider";
import type { ViewLayer } from "@/lib/style/render/viewLayers";
import { globalExtent, wktToGeoJSON } from "@/lib/utils/map/wkt";
import type { Layer } from "@/lib/validations/layer";

import { useCatalogBasemapStyle } from "@/hooks/catalog/useCatalogBasemapStyle";

import DetailMapAttribution from "@/components/dashboard/common/DetailMapAttribution";
import MapViewer from "@/components/map/MapViewer";

/**
 * A whole bundle on a map: every member that has geometry, drawn together.
 *
 * A dataset's map draws one layer; a bundle is several that only mean anything
 * beside each other — a street network is its edges and its nodes, a GTFS feed
 * its stops and its shapes. Each keeps its own default style, so the map reads
 * the way the project map does.
 *
 * Ordered points-over-lines, because a node drawn beneath the edge it joins is
 * invisible. Members without an extent are left out rather than collapsing the
 * bounds: a bundle mid-import has rows whose layers hold nothing yet.
 */

/** Top first. Points are the smallest marks on the map, so they go above the
 * lines and areas they belong to. */
const DRAW_ORDER: Record<string, number> = { point: 0, line: 1, polygon: 2 };

const BundleMapPreview: React.FC<{ layers: Layer[] }> = ({ layers }) => {
  const theme = useTheme();
  const { t } = useTranslation("common");
  const mapRef = useRef<MapRef | null>(null);
  // `MapViewer` needs a style from the first render; the light basemap stands
  // in where the theme lookup finds none.
  const basemapStyle = useCatalogBasemapStyle() ?? getBasemapUrl(null);

  const drawable = useMemo(
    () =>
      layers
        .filter((layer) => layer.type === "feature" || layer.type === "raster")
        .slice()
        .sort(
          (a, b) =>
            (DRAW_ORDER[a.feature_layer_geometry_type ?? ""] ?? 1) -
            (DRAW_ORDER[b.feature_layer_geometry_type ?? ""] ?? 1)
        ),
    [layers]
  );
  const ids = useMemo(() => drawable.map((layer) => layer.id), [drawable]);
  const { styles } = useDatasetStyles(ids);
  const viewLayers = useMemo<ViewLayer[]>(
    () =>
      drawable.map((layer) => ({ ...layer, visible: true, entry: {}, style: styles?.[layer.id] ?? null })),
    [drawable, styles]
  );

  /** One box around every member that has one. Falls back to the whole world,
   * which is what a single layer with no extent does. */
  const boundingBox = useMemo(() => {
    const extents = drawable.map((layer) => layer.extent).filter((extent): extent is string => !!extent);
    if (extents.length === 0) return bbox(wktToGeoJSON(globalExtent)) as [number, number, number, number];
    const boxes = extents.map((extent) => bbox(wktToGeoJSON(extent)));
    return [
      Math.min(...boxes.map((b) => b[0])),
      Math.min(...boxes.map((b) => b[1])),
      Math.max(...boxes.map((b) => b[2])),
      Math.max(...boxes.map((b) => b[3])),
    ] as [number, number, number, number];
  }, [drawable]);

  if (drawable.length === 0) {
    return (
      <Box
        sx={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: theme.palette.text.secondary,
        }}>
        <Typography variant="body2">{t("no_map_preview_available")}</Typography>
      </Box>
    );
  }

  return (
    <DrawProvider>
      <MapProvider>
        <Box sx={{ position: "relative", height: "100%" }}>
          <MapViewer
            mapRef={mapRef}
            layers={viewLayers}
            initialViewState={{
              bounds: boundingBox,
              fitBoundsOptions: { padding: 40 },
            }}
            mapStyle={basemapStyle}
            dragRotate={false}
            touchZoomRotate={false}
            activeFeatureMarker={false}
            containerSx={{
              position: "relative",
              display: "flex",
              height: "100%",
              overflow: "hidden",
            }}>
            <DetailMapAttribution maxWidth="62%" />
          </MapViewer>
        </Box>
      </MapProvider>
    </DrawProvider>
  );
};

export default BundleMapPreview;
