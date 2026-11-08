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

/**
 * Search a place, buffer a point, or draw an area, on one editable map.
 *
 * In parts, so a host can put the controls where its own layout wants them: `useSpatialPicker`
 * holds what the controls and the map share, `SpatialPickerMap` is only the map, and the
 * controls below are separate pieces. `CatalogSpatialPicker` is the catalog dialog's layout of them.
 */

const SHAPE_COLOR = "#2BB381";

/** NUTS levels, as the statistical hierarchy defines them. */
const LEVEL_LABEL_KEYS: Record<number, string> = {
  0: "catalog_nuts_level_country",
  1: "catalog_nuts_level_state",
  2: "catalog_nuts_level_region",
  3: "catalog_nuts_level_district",
};

export type Mode = "region" | "point" | "polygon";

export const modeOf = (filter: CatalogSpatialFilter | null): Mode =>
  filter?.kind === "point" ? "point" : filter?.kind === "polygon" ? "polygon" : "region";

type MapProps = ComponentProps<typeof MapLibre>;

/** What the controls and the map share: the mode, the shape, the region search and the radius. */
export const useSpatialPicker = ({
  mode,
  value,
  onChange,
  onRegionAdded,
}: {
  /** Null is a plain map with nothing to pick. */
  mode: Mode | null;
  value: CatalogSpatialFilter | null;
  onChange: (filter: CatalogSpatialFilter | null) => void;
  onRegionAdded?: () => void;
}) => {
  const { t } = useTranslation("common");
  const [bufferKm, setBufferKm] = useState(value?.kind === "point" ? value.km : DEFAULT_BUFFER_KM);
  const [query, setQuery] = useState("");
  const buffer = value?.kind === "point" ? value.km : bufferKm;

  const { regions, isLoading } = useCatalogNutsRegions(query);
  const regionIds = useMemo(() => (value?.kind === "region" ? value.nutsIds : []), [value]);
  const { geometries, names } = useCatalogNutsGeometries(regionIds);

  const addRegion = (region: CatalogNutsRegion | null) => {
    if (!region) return;
    setQuery("");
    onRegionAdded?.();
    if (regionIds.includes(region.nuts_id)) return;
    const regionNames = value?.kind === "region" ? { ...value.names } : {};
    regionNames[region.nuts_id] = region.nuts_name;
    onChange({ kind: "region", nutsIds: [...regionIds, region.nuts_id], names: regionNames });
  };

  const removeRegion = (nutsId: string) => {
    if (value?.kind !== "region") return;
    const nutsIds = value.nutsIds.filter((id) => id !== nutsId);
    onChange(nutsIds.length ? { ...value, nutsIds } : null);
  };

  // The radius moves the point already placed, so the circle follows the slider while it is
  // dragged rather than only on the next click.
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

  return {
    mode,
    value,
    onChange,
    buffer,
    changeBuffer,
    query,
    setQuery,
    regions,
    isLoading,
    regionIds,
    geometries,
    names,
    addRegion,
    removeRegion,
    undoVertex,
    polygonVertices,
    hint,
  };
};

export type SpatialPicker = ReturnType<typeof useSpatialPicker>;

/** Search for a country, state, region or district; a pick joins the chosen regions. */
export const SpatialRegionSearch = ({ picker, label }: { picker: SpatialPicker; label?: string }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  return (
    <Autocomplete
      size="small"
      // Above any dialog it sits in, and outside a scrolling column that would clip it.
      slotProps={{
        popper: { sx: { zIndex: theme.zIndex.modal + 1 } },
        // The list in the panel's body2, like Selector's menu: hints and "no results" too.
        paper: { sx: { typography: "body2" } },
      }}
      options={picker.regions}
      loading={picker.isLoading}
      inputValue={picker.query}
      onInputChange={(_event, next) => picker.setQuery(next)}
      onChange={(_event, region) => picker.addRegion(region)}
      // Selections are the chips below, so the input returns to empty.
      value={null}
      blurOnSelect
      clearOnBlur
      getOptionLabel={(option) => option.nuts_name}
      isOptionEqualToValue={(a, b) => a.nuts_id === b.nuts_id}
      // The API already ranked and limited these.
      filterOptions={(options) => options}
      getOptionDisabled={(option) => picker.regionIds.includes(option.nuts_id)}
      noOptionsText={picker.query.length < 2 ? t("catalog_region_hint") : t("no_results")}
      renderOption={(props, option) => (
        <Box component="li" {...props} key={option.nuts_id}>
          <Stack direction="row" spacing={2.5} alignItems="center">
            <Icon
              iconName={ICON_NAME.LOCATION}
              style={{ fontSize: 14 }}
              htmlColor={theme.palette.primary.main}
            />
            <Stack>
              <Typography variant="body2" color="text.primary">
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
      renderInput={(params) => (
        <TextField
          {...params}
          placeholder={t("catalog_search_region")}
          inputProps={{ ...params.inputProps, "aria-label": label ?? t("catalog_search_region") }}
        />
      )}
    />
  );
};

/** The chosen regions, each removable. */
export const SpatialRegionChips = ({ picker }: { picker: SpatialPicker }) => {
  if (!picker.regionIds.length) return null;
  return (
    <Stack direction="row" spacing={1.5} useFlexGap flexWrap="wrap">
      {picker.regionIds.map((id) => (
        <Chip
          key={id}
          size="small"
          color="primary"
          variant="outlined"
          label={(picker.value?.kind === "region" && picker.value.names?.[id]) || picker.names[id] || id}
          onDelete={() => picker.removeRegion(id)}
        />
      ))}
    </Stack>
  );
};

/** The radius around the point, as a plain slider. */
export const SpatialBufferSlider = ({ picker }: { picker: SpatialPicker }) => {
  const { t } = useTranslation("common");
  return (
    <Slider
      size="small"
      value={picker.buffer}
      min={MIN_BUFFER_KM}
      max={MAX_BUFFER_KM}
      step={BUFFER_STEP_KM}
      aria-label={t("catalog_buffer_radius")}
      onChange={(_event, next) => picker.changeBuffer(next as number)}
      sx={{ mt: 1 }}
    />
  );
};

/**
 * Only the map: the shape being picked, and the clicks that pick it. The cursor is set on the
 * map itself, since the map's own canvas style would win over one set on a box around it.
 */
export const SpatialPickerMap = ({
  picker,
  mapId,
  initialViewState,
  onMoveEnd,
  onLoad,
  geometry,
  overlay,
  shapeColor = SHAPE_COLOR,
  frameEdits = false,
  sx,
}: {
  picker: SpatialPicker;
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
  /** The drawn area's colour. */
  shapeColor?: string;
  /** Frame the map on a newly placed point, or on a polygon once it has three corners. */
  frameEdits?: boolean;
  sx?: ComponentProps<typeof Box>["sx"];
}) => {
  const basemapStyle = useCatalogBasemapStyle();
  const { mode, value, onChange, buffer, geometries, regionIds, polygonVertices } = picker;

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
    mapRef.current?.fitBounds([box[0], box[1], box[2], box[3]], { padding: 48, maxZoom: 11, duration: 400 });
    // `value` is deliberately not a dependency: only a change of regions re-frames.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionKey, geometries]);

  // A newly placed point or a polygon's third corner frames the map on the shape; what is
  // already there when the map opens is framed by the opening view.
  const fitKey =
    value?.kind === "point"
      ? `point ${value.lng},${value.lat}`
      : value?.kind === "polygon" && value.ring.length >= 3
        ? "polygon"
        : "";
  const framedKey = useRef(fitKey);
  useEffect(() => {
    if (!frameEdits || fitKey === framedKey.current) return;
    framedKey.current = fitKey;
    if (!fitKey) return;
    const box = bboxOf(features) as number[];
    mapRef.current?.fitBounds([box[0], box[1], box[2], box[3]], { padding: 32, maxZoom: 13, duration: 400 });
    // `features` follows `value`; only a new key re-frames.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

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

  const picking = mode === "point" || mode === "polygon";

  return (
    <Box sx={{ position: "relative", ...sx }}>
      <MapLibre
        id={mapId}
        ref={mapRef}
        initialViewState={openingView}
        onClick={handleMapClick}
        onMoveEnd={onMoveEnd}
        onLoad={onLoad}
        cursor={picking ? "crosshair" : undefined}
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
      {overlay}
    </Box>
  );
};

/** The catalog's location filter: search, then the way of picking, the radius, a hint, and the map. */
const CatalogSpatialPicker = ({
  mode,
  value,
  onChange,
  modeSwitch,
  onRegionAdded,
  mapId,
}: {
  mode: Mode;
  value: CatalogSpatialFilter | null;
  onChange: (filter: CatalogSpatialFilter | null) => void;
  /** Shown between the region search and the hint. */
  modeSwitch?: ReactNode;
  onRegionAdded?: () => void;
  mapId: string;
}) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const picker = useSpatialPicker({ mode, value, onChange, onRegionAdded });

  return (
    <Stack spacing={4} sx={{ pt: 1 }}>
      <Box>
        <Typography variant="caption" fontWeight={600} color="text.secondary">
          {t("catalog_location")}
        </Typography>
        <Box sx={{ mt: 1.5 }}>
          <SpatialRegionSearch picker={picker} />
        </Box>
        {picker.regionIds.length > 0 && (
          <Box sx={{ mt: 2 }}>
            <SpatialRegionChips picker={picker} />
          </Box>
        )}
      </Box>

      {modeSwitch}

      {mode === "point" && (
        <Box>
          <Stack direction="row" alignItems="baseline" justifyContent="space-between">
            <Typography variant="body2" fontWeight={600}>
              {t("catalog_buffer_radius")}
            </Typography>
            <Chip size="small" color="primary" label={formatBuffer(picker.buffer)} />
          </Stack>
          <SpatialBufferSlider picker={picker} />
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
        <Icon
          iconName={ICON_NAME.CIRCLEINFO}
          style={{ fontSize: 14 }}
          htmlColor={theme.palette.primary.main}
        />
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
          {picker.hint}
        </Typography>
        {mode === "polygon" && picker.polygonVertices > 0 && (
          <Button size="small" onClick={picker.undoVertex}>
            {t("undo")}
          </Button>
        )}
      </Stack>

      <SpatialPickerMap
        picker={picker}
        mapId={mapId}
        sx={{
          height: 380,
          borderRadius: 2,
          overflow: "hidden",
          border: `1px solid ${theme.palette.divider}`,
        }}
      />
    </Stack>
  );
};

export default CatalogSpatialPicker;
