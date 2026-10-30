"use client";

import {
  Autocomplete,
  Box,
  Button,
  Chip,
  Slider,
  Stack,
  TextField,
  Typography,
  useTheme,
} from "@mui/material";
import bboxOf from "@turf/bbox";
import "maplibre-gl/dist/maplibre-gl.css";
import type { ComponentProps, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Layer as MapLayer, Map as MapLibre, type MapRef, Source } from "react-map-gl/maplibre";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useCatalogNutsRegions } from "@/lib/api/catalog";
import {
  BUFFER_STEP_KM,
  type CatalogSpatialFilter,
  DEFAULT_BUFFER_KM,
  MAX_BUFFER_KM,
  MIN_BUFFER_KM,
  formatBuffer,
  spatialFeatures,
} from "@/lib/catalog/spatial";
import type { CatalogNutsRegion } from "@/lib/validations/catalog";

import { useCatalogBasemapStyle } from "@/hooks/catalog/useCatalogBasemapStyle";
import { useCatalogNutsGeometries } from "@/hooks/catalog/useCatalogNutsGeometries";

import DetailMapAttribution from "@/components/dashboard/common/DetailMapAttribution";

/** Search a place, buffer a point, or draw an area, on one editable map. */

const SHAPE_COLOR = "#2BB381";

/** NUTS levels, as the statistical hierarchy defines them. */
const LEVEL_LABEL_KEYS: Record<number, string> = {
  0: "catalog_nuts_level_country",
  1: "catalog_nuts_level_state",
  2: "catalog_nuts_level_region",
  3: "catalog_nuts_level_district",
};

/** The inline strip keeps one height in every mode, so the map below it never resizes. */
const STRIP_HEIGHT = 84;

export type Mode = "region" | "point" | "polygon";

export const modeOf = (filter: CatalogSpatialFilter | null): Mode =>
  filter?.kind === "point" ? "point" : filter?.kind === "polygon" ? "polygon" : "region";

type MapProps = ComponentProps<typeof MapLibre>;

const CatalogSpatialPicker = ({
  mode,
  value,
  onChange,
  variant = "dialog",
  modeSwitch,
  onRegionAdded,
  mapId,
  initialViewState,
  onMoveEnd,
  onLoad,
  geometry,
  overlay,
  viewHint,
  shapeColor = SHAPE_COLOR,
}: {
  /** Null is a plain map with nothing to pick. */
  mode: Mode | null;
  value: CatalogSpatialFilter | null;
  onChange: (filter: CatalogSpatialFilter | null) => void;
  /** "dialog" stacks the controls over a fixed-height map; "inline" puts them in one strip over a map that fills the space. */
  variant?: "dialog" | "inline";
  /** Shown between the region search and the hint in the dialog layout. */
  modeSwitch?: ReactNode;
  onRegionAdded?: () => void;
  /** Distinct per use: this map can share a `MapProvider` with the project map. */
  mapId: string;
  /** Otherwise it opens on the value, or on Europe. */
  initialViewState?: MapProps["initialViewState"];
  onMoveEnd?: MapProps["onMoveEnd"];
  onLoad?: MapProps["onLoad"];
  /** An area with no record of how it was picked: drawn, and framed on open, until a shape is picked. */
  geometry?: GeoJSON.Geometry | null;
  /** Drawn over the map box. */
  overlay?: ReactNode;
  /** The inline strip's text when there is nothing to pick (mode null). */
  viewHint?: ReactNode;
  /** The drawn area's colour. */
  shapeColor?: string;
}) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const basemapStyle = useCatalogBasemapStyle();
  const inline = variant === "inline";

  const [bufferKm, setBufferKm] = useState(value?.kind === "point" ? value.km : DEFAULT_BUFFER_KM);
  const [query, setQuery] = useState("");
  const buffer = value?.kind === "point" ? value.km : bufferKm;

  const { regions, isLoading } = useCatalogNutsRegions(query);
  const regionIds = value?.kind === "region" ? value.nutsIds : [];
  const { geometries, names } = useCatalogNutsGeometries(regionIds);

  const shapes = useCallback((): GeoJSON.FeatureCollection => {
    const picked = spatialFeatures(value, geometries);
    if (!picked.features.length && geometry)
      picked.features.push({ type: "Feature", geometry, properties: {} });
    return picked;
  }, [value, geometries, geometry]);
  const features = useMemo(() => shapes(), [shapes]);

  const mapRef = useRef<MapRef | null>(null);
  // Only the view the map opens with; later edits move it through `fitBounds`.
  const [openingView] = useState(() => {
    if (initialViewState) return initialViewState;
    const existing = shapes();
    if (existing.features.length) {
      const box = bboxOf(existing) as number[];
      return {
        bounds: [box[0], box[1], box[2], box[3]] as [number, number, number, number],
        fitBoundsOptions: { padding: 48, maxZoom: 11 },
      };
    }
    return { longitude: 10, latitude: 51, zoom: 3.4 };
  });

  const regionKey = regionIds.join(",");
  useEffect(() => {
    if (!regionKey) return;
    const regionFeatures = spatialFeatures(value, geometries);
    if (!regionFeatures.features.length) return;
    const box = bboxOf(regionFeatures) as number[];
    mapRef.current?.fitBounds([box[0], box[1], box[2], box[3]], {
      padding: 48,
      maxZoom: 11,
      duration: 400,
    });
    // `value` is deliberately not a dependency: only a change of regions re-frames.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionKey, geometries]);

  // Inline, a newly placed point or a polygon's third corner frames the map on the shape;
  // what is already there when the map opens is framed by the opening view.
  const fitKey =
    value?.kind === "point"
      ? `point ${value.lng},${value.lat}`
      : value?.kind === "polygon" && value.ring.length >= 3
        ? "polygon"
        : "";
  const framedKey = useRef(fitKey);
  useEffect(() => {
    if (!inline || fitKey === framedKey.current) return;
    framedKey.current = fitKey;
    if (!fitKey) return;
    const box = bboxOf(features) as number[];
    mapRef.current?.fitBounds([box[0], box[1], box[2], box[3]], { padding: 32, maxZoom: 13, duration: 400 });
    // `features` follows `value`; only a new key re-frames.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  const addRegion = (region: CatalogNutsRegion | null) => {
    if (!region) return;
    setQuery("");
    onRegionAdded?.();
    const ids = value?.kind === "region" ? value.nutsIds : [];
    if (ids.includes(region.nuts_id)) return;
    const regionNames = value?.kind === "region" ? { ...value.names } : {};
    regionNames[region.nuts_id] = region.nuts_name;
    onChange({ kind: "region", nutsIds: [...ids, region.nuts_id], names: regionNames });
  };

  const removeRegion = (nutsId: string) => {
    if (value?.kind !== "region") return;
    const nutsIds = value.nutsIds.filter((id) => id !== nutsId);
    onChange(nutsIds.length ? { ...value, nutsIds } : null);
  };

  /** Clicking the map means different things per mode; in region mode, nothing. */
  const handleMapClick = useCallback(
    (event: { lngLat: { lng: number; lat: number } }) => {
      const point: [number, number] = [event.lngLat.lng, event.lngLat.lat];
      if (mode === "point") {
        onChange({ kind: "point", lng: point[0], lat: point[1], km: buffer });
        return;
      }
      if (mode === "polygon") {
        const ring = value?.kind === "polygon" ? value.ring : [];
        onChange({ kind: "polygon", ring: [...ring, point] });
      }
    },
    [mode, buffer, value, onChange]
  );

  // The slider moves the buffer of the point already placed, so the circle
  // responds while dragging rather than only on the next click.
  const changeBuffer = (km: number) => {
    setBufferKm(km);
    if (value?.kind === "point" && value.km !== km) onChange({ ...value, km });
  };

  const undoVertex = () => {
    if (value?.kind !== "polygon") return;
    const ring = value.ring.slice(0, -1);
    onChange(ring.length ? { ...value, ring } : null);
  };

  const polygonVertices = value?.kind === "polygon" ? value.ring.length : 0;

  const hint =
    mode === "region"
      ? t("catalog_spatial_hint_region")
      : mode === "point"
        ? t("catalog_spatial_hint_point")
        : polygonVertices === 0
          ? t("catalog_spatial_hint_polygon")
          : t("catalog_spatial_hint_polygon_progress", { count: polygonVertices });

  const regionSearch = (
    <Autocomplete
      size="small"
      options={regions}
      loading={isLoading}
      inputValue={query}
      onInputChange={(_event, next) => setQuery(next)}
      onChange={(_event, region) => addRegion(region)}
      // Selections are the chips below, so the input returns to empty.
      value={null}
      blurOnSelect
      clearOnBlur
      getOptionLabel={(option) => option.nuts_name}
      isOptionEqualToValue={(a, b) => a.nuts_id === b.nuts_id}
      // The API already ranked and limited these.
      filterOptions={(options) => options}
      getOptionDisabled={(option) => regionIds.includes(option.nuts_id)}
      noOptionsText={query.length < 2 ? t("catalog_region_hint") : t("no_results")}
      renderOption={(props, option) => (
        <Box component="li" {...props} key={option.nuts_id}>
          <Stack direction="row" spacing={2.5} alignItems="center">
            <Icon
              iconName={ICON_NAME.LOCATION}
              style={{ fontSize: 14 }}
              htmlColor={theme.palette.primary.main}
            />
            <Stack>
              <Typography variant="body2" fontWeight={600}>
                {option.nuts_name}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {option.nuts_id}
                {LEVEL_LABEL_KEYS[option.level] ? ` · ${t(LEVEL_LABEL_KEYS[option.level])}` : ""}
              </Typography>
            </Stack>
          </Stack>
        </Box>
      )}
      renderInput={(params) => <TextField {...params} placeholder={t("catalog_search_region")} />}
    />
  );

  const regionChips = regionIds.length > 0 && (
    <Stack
      direction="row"
      spacing={1.5}
      useFlexGap
      // Inline, one scrolling row: wrapping would grow the strip.
      flexWrap={inline ? "nowrap" : "wrap"}
      sx={inline ? { mt: 1.5, overflowX: "auto", overflowY: "hidden" } : { mt: 2 }}>
      {regionIds.map((id) => (
        <Chip
          key={id}
          size="small"
          color="primary"
          variant="outlined"
          label={(value?.kind === "region" && value.names?.[id]) || names[id] || id}
          onDelete={() => removeRegion(id)}
        />
      ))}
    </Stack>
  );

  const bufferSlider = (
    <Slider
      size="small"
      value={buffer}
      min={MIN_BUFFER_KM}
      max={MAX_BUFFER_KM}
      step={BUFFER_STEP_KM}
      aria-label={t("catalog_buffer_radius")}
      onChange={(_event, next) => changeBuffer(next as number)}
      sx={inline ? { flex: 1 } : { mt: 1 }}
    />
  );

  const undoButton = mode === "polygon" && polygonVertices > 0 && (
    <Button size="small" onClick={undoVertex}>
      {t("undo")}
    </Button>
  );

  const hintIcon = (
    <Icon iconName={ICON_NAME.CIRCLEINFO} style={{ fontSize: 14 }} htmlColor={theme.palette.primary.main} />
  );

  const map = (
    <MapLibre
      id={mapId}
      ref={mapRef}
      initialViewState={openingView}
      onClick={handleMapClick}
      onMoveEnd={onMoveEnd}
      onLoad={onLoad}
      style={{ width: "100%", height: "100%" }}
      mapStyle={basemapStyle}
      // Ours replaces it, at the end of the map's children.
      attributionControl={false}>
      <Source id="spatial-draft" type="geojson" data={features}>
        <MapLayer
          id="spatial-draft-fill"
          type="fill"
          paint={{ "fill-color": shapeColor, "fill-opacity": 0.18 }}
        />
        <MapLayer
          id="spatial-draft-line"
          type="line"
          paint={{
            "line-color": shapeColor,
            "line-width": 2,
            // An open ring is dashed: it says "not finished" without a label.
            "line-dasharray": mode === "polygon" && polygonVertices < 3 ? [2, 1.5] : [1],
          }}
        />
      </Source>
      {value?.kind === "polygon" && (
        <Source
          id="spatial-draft-vertices"
          type="geojson"
          data={{
            type: "FeatureCollection",
            features: value.ring.map((position) => ({
              type: "Feature",
              geometry: { type: "Point", coordinates: position },
              properties: {},
            })),
          }}>
          <MapLayer
            id="spatial-draft-vertex"
            type="circle"
            paint={{
              "circle-radius": 4,
              "circle-color": "#FFFFFF",
              "circle-stroke-color": shapeColor,
              "circle-stroke-width": 2,
            }}
          />
        </Source>
      )}
      {value?.kind === "point" && (
        <Source
          id="spatial-draft-centre"
          type="geojson"
          data={{
            type: "Feature",
            geometry: { type: "Point", coordinates: [value.lng, value.lat] },
            properties: {},
          }}>
          <MapLayer
            id="spatial-draft-centre-dot"
            type="circle"
            paint={{
              "circle-radius": 5,
              "circle-color": shapeColor,
              "circle-stroke-color": "#FFFFFF",
              "circle-stroke-width": 2,
            }}
          />
        </Source>
      )}
      <DetailMapAttribution />
    </MapLibre>
  );

  const cursor = mode === "point" || mode === "polygon" ? "crosshair" : "grab";

  if (inline)
    return (
      <Stack spacing={2.5} sx={{ flex: 1, minHeight: 0 }}>
        <Box sx={{ height: STRIP_HEIGHT, flexShrink: 0 }}>
          {mode === "region" ? (
            <>
              {regionSearch}
              {regionChips || (
                <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1.5 }}>
                  {hint}
                </Typography>
              )}
            </>
          ) : mode === "point" ? (
            <>
              <Stack direction="row" spacing={3} alignItems="center" sx={{ height: 40 }}>
                <Typography variant="body2" fontWeight={600} sx={{ whiteSpace: "nowrap" }}>
                  {t("catalog_buffer_radius")}
                </Typography>
                {bufferSlider}
                <Chip size="small" color="primary" label={formatBuffer(buffer)} />
                {value?.kind === "point" && (
                  <Button size="small" onClick={() => onChange(null)}>
                    {t("clear_all")}
                  </Button>
                )}
              </Stack>
              <Typography variant="caption" color="text.secondary">
                {hint}
              </Typography>
            </>
          ) : (
            <Stack direction="row" spacing={2.5} alignItems="center" sx={{ minHeight: 40 }}>
              {hintIcon}
              <Typography variant="caption" color="text.secondary" sx={{ flex: 1, lineHeight: 1.45 }}>
                {mode === "polygon" ? hint : viewHint}
              </Typography>
              {undoButton}
              {mode === "polygon" && polygonVertices > 0 && (
                <Button size="small" onClick={() => onChange(null)}>
                  {t("clear_all")}
                </Button>
              )}
            </Stack>
          )}
        </Box>
        <Box sx={{ position: "relative", flex: 1, minHeight: 240, cursor }}>
          {map}
          {overlay}
        </Box>
      </Stack>
    );

  return (
    <Stack spacing={4} sx={{ pt: 1 }}>
      <Box>
        <Typography variant="caption" fontWeight={600} color="text.secondary">
          {t("catalog_location")}
        </Typography>
        <Box sx={{ mt: 1.5 }}>{regionSearch}</Box>
        {regionChips}
      </Box>

      {modeSwitch}

      {mode === "point" && (
        <Box>
          <Stack direction="row" alignItems="baseline" justifyContent="space-between">
            <Typography variant="body2" fontWeight={600}>
              {t("catalog_buffer_radius")}
            </Typography>
            <Chip size="small" color="primary" label={formatBuffer(buffer)} />
          </Stack>
          {bufferSlider}
        </Box>
      )}

      <Stack
        direction="row"
        spacing={2.5}
        alignItems="center"
        sx={{
          px: 3.5,
          py: 2.5,
          borderRadius: 2,
          border: `1px solid ${theme.palette.divider}`,
          backgroundColor: theme.palette.action.hover,
        }}>
        {hintIcon}
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
          {hint}
        </Typography>
        {undoButton}
      </Stack>

      <Box
        sx={{
          position: "relative",
          height: 380,
          borderRadius: 2,
          overflow: "hidden",
          border: `1px solid ${theme.palette.divider}`,
          cursor,
        }}>
        {map}
        {overlay}
      </Box>
    </Stack>
  );
};

export default CatalogSpatialPicker;
