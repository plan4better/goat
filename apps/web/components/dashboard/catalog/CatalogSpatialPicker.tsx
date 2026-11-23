"use client";

import MapboxDraw from "@mapbox/mapbox-gl-draw";
import { Box, useTheme } from "@mui/material";
import bboxOf from "@turf/bbox";
import type { FilterSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { ComponentProps, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Layer as MapLayer, Map as MapLibre, MapProvider, type MapRef, Source } from "react-map-gl/maplibre";

import type { AreaPiece, FilterArea } from "@/lib/filter/area";
import { DrawProvider } from "@/lib/providers/DrawProvider";
import { MAPLIBRE_MAP_OPTIONS } from "@/lib/utils/map/maplibre";

import { useCatalogBasemapStyle } from "@/hooks/catalog/useCatalogBasemapStyle";

import DetailMapAttribution from "@/components/dashboard/common/DetailMapAttribution";
import { DrawControl } from "@/components/map/controls/Draw";
import { SETTINGS_PANE_HEIGHT } from "@/components/map/panels/common/SettingsColumn";
import { AreaChooser } from "@/components/map/panels/filter/area/AreaChooser";
import { AreaToolsProvider, useAreaTools } from "@/components/map/panels/filter/area/AreaTools";
import type { AreaHost } from "@/components/map/panels/filter/area/host";

/**
 * An area on a map of its own: the map the fetch dialog and the catalog's location filter pick
 * their area on with the area picker, and the catalog dialog's layout of the two.
 *
 * `SpatialPickerMap` is only the map: the area's pieces drawn, and the draw tool the picker
 * draws its shapes with. Its host gives it a `DrawProvider` and a `MapProvider` around the
 * picker too, so the picker reaches this map's draw tool and view by the map's id.
 */

const SHAPE_COLOR = "#2BB381";

type MapProps = ComponentProps<typeof MapLibre>;

const IS_POLYGON: FilterSpecification = ["==", ["geometry-type"], "Polygon"];
const IS_POINT: FilterSpecification = ["==", ["geometry-type"], "Point"];

/** The pieces that stay where they are, and the centres of the circles around a point. The map view piece is the box
 * its host draws over the map. */
const areaFeatures = (area: FilterArea | undefined): GeoJSON.FeatureCollection => ({
  type: "FeatureCollection",
  features: (area?.pieces ?? []).flatMap((piece): GeoJSON.Feature[] => {
    if (piece.kind === "view") return [];
    const features: GeoJSON.Feature[] = piece.polygons.map((coordinates) => ({
      type: "Feature",
      geometry: { type: "Polygon", coordinates },
      properties: {},
    }));
    if (piece.kind === "shape" && piece.center)
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: piece.center },
        properties: {},
      });
    return features;
  }),
});

/** What a piece is, without how big a circle is or where a drawn polygon's corners are: a new piece frames the map, a
 * new radius does not, nor does a polygon edited where the map shows it (and hidden meanwhile, the tool drawing it). */
const pieceKey = (piece: AreaPiece): string => {
  if (piece.kind === "features") return `${piece.source}:${piece.features.map((f) => f.id).join(",")}`;
  if (piece.kind === "shape") return piece.center ? `circle:${piece.center.join(",")}` : "shape";
  return `${piece.kind}:${piece.polygons.length}:${piece.polygons[0]?.[0]?.[0]?.join(",")}`;
};

/** The pieces the map is framed on; none while the area is the map view, which the map itself is. */
const frameKey = (area: FilterArea | undefined): string =>
  !area || area.pieces.some((piece) => piece.kind === "view") ? "" : area.pieces.map(pieceKey).join("|");

/** Only the map: the area's pieces, framed whenever a piece comes or goes, and the draw tool. */
export const SpatialPickerMap = ({
  area,
  mapId,
  initialViewState,
  onMoveEnd,
  onLoad,
  overlay,
  layers,
  shapeColor = SHAPE_COLOR,
  cursor,
  sx,
}: {
  area: FilterArea | undefined;
  /** Distinct per use: the picker finds this map by it. */
  mapId: string;
  /** Otherwise it opens on the area, or on Europe. */
  initialViewState?: MapProps["initialViewState"];
  onMoveEnd?: MapProps["onMoveEnd"];
  onLoad?: MapProps["onLoad"];
  /** Drawn over the map box. */
  overlay?: ReactNode;
  /** Map layers drawn under the picked area, such as where a source has data. */
  layers?: ReactNode;
  /** The drawn area's colour. */
  shapeColor?: string;
  /** Set on the map itself: the map's own canvas style would win over one set on a box around it. */
  cursor?: string;
  sx?: ComponentProps<typeof Box>["sx"];
}) => {
  const basemapStyle = useCatalogBasemapStyle();
  const features = useMemo(() => areaFeatures(area), [area]);
  const mapRef = useRef<MapRef | null>(null);
  // Only the view the map opens with; later pieces move it through `fitBounds`.
  const [openingView] = useState(() => {
    if (initialViewState) return initialViewState;
    if (features.features.length) {
      const box = bboxOf(features) as number[];
      return {
        bounds: [box[0], box[1], box[2], box[3]] as [number, number, number, number],
        fitBoundsOptions: { padding: 48, maxZoom: 11 },
      };
    }
    return { longitude: 10, latitude: 51, zoom: 3.4 };
  });

  const key = frameKey(area);
  const framedKey = useRef(key);
  useEffect(() => {
    if (key === framedKey.current) return;
    framedKey.current = key;
    if (!key || !features.features.length) return;
    const box = bboxOf(features) as number[];
    mapRef.current?.fitBounds([box[0], box[1], box[2], box[3]], { padding: 48, maxZoom: 13, duration: 400 });
    // `features` follows `area`; only another set of pieces frames again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <Box sx={{ position: "relative", ...sx }}>
      <MapLibre
        {...MAPLIBRE_MAP_OPTIONS}
        id={mapId}
        ref={mapRef}
        initialViewState={openingView}
        onMoveEnd={onMoveEnd}
        onLoad={onLoad}
        cursor={cursor}
        style={{ width: "100%", height: "100%" }}
        mapStyle={basemapStyle}
        // Ours replaces it, at the end of the map's children.
        attributionControl={false}>
        {layers}
        <DrawControl displayControlsDefault={false} defaultMode={MapboxDraw.constants.modes.SIMPLE_SELECT} />
        <Source id="spatial-draft" type="geojson" data={features}>
          <MapLayer
            id="spatial-draft-fill"
            type="fill"
            filter={IS_POLYGON}
            paint={{ "fill-color": shapeColor, "fill-opacity": 0.18 }}
          />
          <MapLayer
            id="spatial-draft-line"
            type="line"
            filter={IS_POLYGON}
            paint={{ "line-color": shapeColor, "line-width": 2 }}
          />
          <MapLayer
            id="spatial-draft-centre-dot"
            type="circle"
            filter={IS_POINT}
            paint={{
              "circle-radius": 5,
              "circle-color": shapeColor,
              "circle-stroke-color": "#FFFFFF",
              "circle-stroke-width": 2,
            }}
          />
        </Source>
        <DetailMapAttribution />
      </MapLibre>
      {overlay}
    </Box>
  );
};

/** The catalog's map: the crosshair while a shape is drawn on it, a shape being edited drawn by the tool alone. */
const CatalogMap = ({ mapId }: { mapId: string }) => {
  const theme = useTheme();
  const { drawing, outline } = useAreaTools();
  return (
    <SpatialPickerMap
      area={outline}
      mapId={mapId}
      cursor={drawing ? "crosshair" : undefined}
      // Framed inside the dialog's padding, as the dashboard's other maps are. A height of its
      // own on a phone, where the body's height is not set and the map inside (sized at 100%)
      // would collapse to nothing.
      sx={{
        flex: 1,
        minHeight: 280,
        height: { xs: 320, md: "auto" },
        mr: { md: 4 },
        mx: { xs: 4, md: 0 },
        my: 4,
        borderRadius: 2,
        overflow: "hidden",
        border: `1px solid ${theme.palette.divider}`,
      }}
    />
  );
};

/**
 * The catalog's location filter: the area picker in a column, and the map framed beside it.
 */
const CatalogSpatialPicker = ({ host }: { host: AreaHost }) => {
  const { t } = useTranslation("common");
  return (
    <DrawProvider>
      <MapProvider>
        <AreaToolsProvider host={host}>
          <Box
            sx={{
              display: "flex",
              flexDirection: { xs: "column", md: "row" },
              flex: 1,
              minHeight: 0,
              height: SETTINGS_PANE_HEIGHT,
            }}>
            <Box
              sx={{
                width: { xs: "100%", md: 320 },
                flexShrink: 0,
                overflowY: "auto",
                px: 1,
                py: 3,
              }}>
              <AreaChooser emptyText={t("fetch_features_area_none")} />
            </Box>
            <CatalogMap mapId={host.map.id} />
          </Box>
        </AreaToolsProvider>
      </MapProvider>
    </DrawProvider>
  );
};

export default CatalogSpatialPicker;