"use client";

import { Box, Typography, useTheme } from "@mui/material";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { MapRef } from "react-map-gl/maplibre";
import { Layer as MapLayer, Map as MapLibre, Source } from "react-map-gl/maplibre";

import type { LngLatBounds } from "@/lib/utils/externalService";
import { MAPLIBRE_MAP_OPTIONS } from "@/lib/utils/map/maplibre";

import { useCatalogBasemapStyle } from "@/hooks/catalog/useCatalogBasemapStyle";

import DetailMapAttribution from "@/components/dashboard/common/DetailMapAttribution";

const GERMANY = { longitude: 10.4, latitude: 51.1, zoom: 4.5 };

/**
 * The picked layer drawn from the service itself, before it is added.
 *
 * Live tiles over the basemap, so what shows here is what the layer will show: a blank
 * preview means a blank layer, which is worth knowing before adding it.
 */
const ConnectPreview = ({
  source,
  bounds,
  height,
}: {
  source: { kind: "tiles" | "cog"; url: string } | null;
  bounds?: LngLatBounds;
  /** Fills its container when omitted. */
  height?: number;
}) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const basemapStyle = useCatalogBasemapStyle();
  const map = useRef<MapRef | null>(null);

  // Follow the selection: a newly picked layer may cover somewhere else entirely.
  const boundsKey = bounds?.join(",");
  useEffect(() => {
    if (!bounds) return;
    map.current?.fitBounds(bounds, { padding: 24, duration: 400, maxZoom: 16 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundsKey]);

  return (
    <Box
      sx={{
        position: "relative",
        height: height ?? "100%",
        minHeight: 180,
        borderRadius: 2,
        overflow: "hidden",
        border: `1px solid ${theme.palette.divider}`,
        flexShrink: 0,
      }}>
      <MapLibre
        {...MAPLIBRE_MAP_OPTIONS}
        ref={map}
        // Named: the dialog opens over the project map, inside the same `MapProvider`, and
        // a second id-less map there throws "Multiple maps with the same id: default".
        id="connect-service-preview"
        initialViewState={bounds ? { bounds, fitBoundsOptions: { padding: 24, maxZoom: 16 } } : GERMANY}
        style={{ width: "100%", height: "100%" }}
        mapStyle={basemapStyle}
        attributionControl={false}>
        {source && (
          <Source
            // A new address is a new source: MapLibre cannot swap a source's tiles in place.
            key={source.url}
            id="connect-service-preview-source"
            type="raster"
            tileSize={256}
            {...(source.kind === "cog" ? { url: source.url } : { tiles: [source.url] })}>
            <MapLayer id="connect-service-preview-layer" type="raster" />
          </Source>
        )}
        <DetailMapAttribution />
      </MapLibre>

      <Typography
        variant="caption"
        fontWeight={700}
        sx={{
          position: "absolute",
          left: 10,
          top: 10,
          px: 2.5,
          py: 0.75,
          borderRadius: 999,
          backgroundColor: theme.palette.background.paper,
          boxShadow: theme.shadows[1],
          pointerEvents: "none",
        }}>
        {t("connect_service_preview_badge")}
      </Typography>

      {!source && (
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.palette.mode === "dark" ? "rgba(0,0,0,0.45)" : "rgba(255,255,255,0.7)",
          }}>
          <Typography variant="body2" fontWeight={600} color="text.secondary">
            {t("connect_service_pick_to_preview")}
          </Typography>
        </Box>
      )}
    </Box>
  );
};

export default ConnectPreview;
