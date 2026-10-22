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

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import DetailMapAttribution from "@/components/dashboard/common/DetailMapAttribution";

/** The spatial filter tool: search a place, buffer a point, or draw an area, on one editable map. */

const SHAPE_COLOR = "#2BB381";

/** NUTS levels, as the statistical hierarchy defines them. */
const LEVEL_LABEL_KEYS: Record<number, string> = {
  0: "catalog_nuts_level_country",
  1: "catalog_nuts_level_state",
  2: "catalog_nuts_level_region",
  3: "catalog_nuts_level_district",
};

export type Mode = "region" | "point" | "polygon";

const modeOf = (filter: CatalogSpatialFilter | null): Mode =>
  filter?.kind === "point" ? "point" : filter?.kind === "polygon" ? "polygon" : "region";

const CatalogSpatialDialog = ({
  open,
  initial,
  initialMode,
  onClose,
  onApply,
}: {
  open: boolean;
  initial: CatalogSpatialFilter | null;
  /** The mode to open in when nothing is in force yet. */
  initialMode?: Mode;
  onClose: () => void;
  onApply: (filter: CatalogSpatialFilter | null) => void;
}) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const basemapStyle = useCatalogBasemapStyle();

  const [mode, setMode] = useState<Mode>(() => (initial ? modeOf(initial) : (initialMode ?? "region")));
  const [draft, setDraft] = useState<CatalogSpatialFilter | null>(initial);
  const [bufferKm, setBufferKm] = useState(initial?.kind === "point" ? initial.km : DEFAULT_BUFFER_KM);
  const [query, setQuery] = useState("");

  // Reopening the dialog must show what is actually in force, not the draft from
  // the last time it was open.
  useEffect(() => {
    if (!open) return;
    setMode(initial ? modeOf(initial) : (initialMode ?? "region"));
    setDraft(initial);
    setBufferKm(initial?.kind === "point" ? initial.km : DEFAULT_BUFFER_KM);
    setQuery("");
  }, [open, initial, initialMode]);

  const { regions, isLoading } = useCatalogNutsRegions(query);
  const regionIds = draft?.kind === "region" ? draft.nutsIds : [];
  const { geometries, names } = useCatalogNutsGeometries(regionIds);

  const features = useMemo(() => spatialFeatures(draft, geometries), [draft, geometries]);

  /** Framing. */
  const mapRef = useRef<MapRef | null>(null);
  /** Opens on the shape already in force; otherwise on Europe. */
  const initialViewState = useMemo(() => {
    const existing = spatialFeatures(initial, geometries);
    if (existing.features.length) {
      const box = bboxOf(existing) as number[];
      return {
        bounds: [box[0], box[1], box[2], box[3]] as [number, number, number, number],
        fitBoundsOptions: { padding: 48, maxZoom: 11 },
      };
    }
    return { longitude: 10, latitude: 51, zoom: 3.4 };
    // Only the filter the dialog opened with matters; later edits move the map through `fitBounds`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const regionKey = regionIds.join(",");
  useEffect(() => {
    if (!regionKey) return;
    const regionFeatures = spatialFeatures(draft, geometries);
    if (!regionFeatures.features.length) return;
    const box = bboxOf(regionFeatures) as number[];
    mapRef.current?.fitBounds([box[0], box[1], box[2], box[3]], {
      padding: 48,
      maxZoom: 11,
      duration: 400,
    });
    // `draft` is deliberately not a dependency: only a change of regions re-frames.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionKey, geometries]);

  const addRegion = (region: CatalogNutsRegion | null) => {
    if (!region) return;
    setQuery("");
    setDraft((current) => {
      const ids = current?.kind === "region" ? current.nutsIds : [];
      if (ids.includes(region.nuts_id)) return current;
      const names = current?.kind === "region" ? { ...current.names } : {};
      names[region.nuts_id] = region.nuts_name;
      return { kind: "region", nutsIds: [...ids, region.nuts_id], names };
    });
    setMode("region");
  };

  const removeRegion = (nutsId: string) =>
    setDraft((current) => {
      if (current?.kind !== "region") return current;
      const nutsIds = current.nutsIds.filter((id) => id !== nutsId);
      return nutsIds.length ? { ...current, nutsIds } : null;
    });

  /** Clicking the map means different things per mode; in region mode, nothing. */
  const handleMapClick = useCallback(
    (event: { lngLat: { lng: number; lat: number } }) => {
      const point: [number, number] = [event.lngLat.lng, event.lngLat.lat];
      if (mode === "point") {
        setDraft({ kind: "point", lng: point[0], lat: point[1], km: bufferKm });
        return;
      }
      if (mode === "polygon") {
        setDraft((current) => {
          const ring = current?.kind === "polygon" ? current.ring : [];
          return { kind: "polygon", ring: [...ring, point] };
        });
      }
    },
    [mode, bufferKm]
  );

  // The slider moves the buffer of the point already placed, so the circle
  // responds while dragging rather than only on the next click.
  useEffect(() => {
    setDraft((current) =>
      current?.kind === "point" && current.km !== bufferKm ? { ...current, km: bufferKm } : current
    );
  }, [bufferKm]);

  const switchMode = (next: Mode) => {
    setMode(next);
    // A shape from another mode cannot be reinterpreted, so switching clears it.
    setDraft((current) => (current && modeOf(current) !== next ? null : current));
  };

  const undoVertex = () =>
    setDraft((current) => {
      if (current?.kind !== "polygon") return current;
      const ring = current.ring.slice(0, -1);
      return ring.length ? { ...current, ring } : null;
    });

  const polygonVertices = draft?.kind === "polygon" ? draft.ring.length : 0;
  const canApply =
    (draft?.kind === "region" && draft.nutsIds.length > 0) ||
    draft?.kind === "point" ||
    (draft?.kind === "polygon" && draft.ring.length >= 3);

  const hint =
    mode === "region"
      ? t("catalog_spatial_hint_region")
      : mode === "point"
        ? t("catalog_spatial_hint_point")
        : polygonVertices === 0
          ? t("catalog_spatial_hint_polygon")
          : t("catalog_spatial_hint_polygon_progress", { count: polygonVertices });

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      icon={ICON_NAME.GLOBE}
      title={t("catalog_set_spatial_filter")}
      subtitle={t("catalog_spatial_dialog_subtitle")}
      maxWidth={900}
      footer={
        <AppDialogFooter
          onCancel={onClose}
          primaryLabel={t("apply")}
          onPrimary={() => onApply(canApply ? draft : null)}
          // Enabled when there is a shape to apply, or an existing filter that
          // clearing the draft would remove.
          primaryDisabled={!canApply && !initial}
          extra={
            <Button
              onClick={() => setDraft(null)}
              disabled={!draft}
              startIcon={<Icon iconName={ICON_NAME.TRASH} style={{ fontSize: 13 }} />}>
              {t("clear_all")}
            </Button>
          }
        />
      }>
      <Stack spacing={4} sx={{ pt: 1 }}>
        <Box>
          <Typography variant="caption" fontWeight={600} color="text.secondary">
            {t("catalog_location")}
          </Typography>
          <Autocomplete
            size="small"
            sx={{ mt: 1.5 }}
            options={regions}
            loading={isLoading}
            inputValue={query}
            onInputChange={(_event, value) => setQuery(value)}
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
          {regionIds.length > 0 && (
            <Stack direction="row" spacing={1.5} useFlexGap flexWrap="wrap" sx={{ mt: 2 }}>
              {regionIds.map((id) => (
                <Chip
                  key={id}
                  size="small"
                  color="primary"
                  variant="outlined"
                  label={(draft?.kind === "region" && draft.names?.[id]) || names[id] || id}
                  onDelete={() => removeRegion(id)}
                />
              ))}
            </Stack>
          )}
        </Box>

        <Box>
          <Typography variant="caption" fontWeight={600} color="text.secondary">
            {t("catalog_selection_type")}
          </Typography>
          <Stack
            direction="row"
            sx={{
              mt: 1.5,
              borderRadius: 2.5,
              overflow: "hidden",
              border: `1.5px solid ${theme.palette.primary.main}`,
            }}>
            {(
              [
                { id: "region" as Mode, label: t("catalog_mode_region"), icon: ICON_NAME.GLOBE },
                { id: "point" as Mode, label: t("catalog_mode_point"), icon: ICON_NAME.LOCATION },
                {
                  id: "polygon" as Mode,
                  label: t("catalog_mode_polygon"),
                  icon: ICON_NAME.POLYGON_FEATURE,
                },
              ] as const
            ).map((tool, index) => (
              <Box
                key={tool.id}
                component="button"
                type="button"
                onClick={() => switchMode(tool.id)}
                sx={{
                  flex: 1,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 2.5,
                  py: 3,
                  px: 2.5,
                  cursor: "pointer",
                  font: "inherit",
                  fontSize: 14,
                  fontWeight: 600,
                  border: "none",
                  borderLeft: index > 0 ? `1.5px solid ${theme.palette.primary.main}` : undefined,
                  color: theme.palette.primary.main,
                  backgroundColor: tool.id === mode ? theme.palette.action.selected : "transparent",
                }}>
                <Icon iconName={tool.icon} style={{ fontSize: 15 }} htmlColor={theme.palette.primary.main} />
                {tool.label}
              </Box>
            ))}
          </Stack>
        </Box>

        {mode === "point" && (
          <Box>
            <Stack direction="row" alignItems="baseline" justifyContent="space-between">
              <Typography variant="body2" fontWeight={600}>
                {t("catalog_buffer_radius")}
              </Typography>
              <Chip size="small" color="primary" label={formatBuffer(bufferKm)} />
            </Stack>
            <Slider
              size="small"
              value={bufferKm}
              min={MIN_BUFFER_KM}
              max={MAX_BUFFER_KM}
              step={BUFFER_STEP_KM}
              onChange={(_event, value) => setBufferKm(value as number)}
              sx={{ mt: 1 }}
            />
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
            {hint}
          </Typography>
          {mode === "polygon" && polygonVertices > 0 && (
            <Button size="small" onClick={undoVertex}>
              {t("undo")}
            </Button>
          )}
        </Stack>

        <Box
          sx={{
            height: 380,
            borderRadius: 2,
            overflow: "hidden",
            border: `1px solid ${theme.palette.divider}`,
            cursor: mode === "region" ? "grab" : "crosshair",
          }}>
          <MapLibre
            // A distinct id, because this map can share a `MapProvider` with the
            // project map (the Add Layer modal opens over it) and react-map-gl
            // registers every id-less map as "default" — two of those is a crash.
            id="catalog-spatial-dialog"
            ref={mapRef}
            initialViewState={initialViewState}
            onClick={handleMapClick}
            style={{ width: "100%", height: "100%" }}
            mapStyle={basemapStyle}
            // Ours replaces it, at the end of the map's children.
            attributionControl={false}>
            <Source id="spatial-draft" type="geojson" data={features}>
              <MapLayer
                id="spatial-draft-fill"
                type="fill"
                paint={{ "fill-color": SHAPE_COLOR, "fill-opacity": 0.18 }}
              />
              <MapLayer
                id="spatial-draft-line"
                type="line"
                paint={{
                  "line-color": SHAPE_COLOR,
                  "line-width": 2,
                  // An open ring is dashed: it says "not finished" without a label.
                  "line-dasharray": mode === "polygon" && polygonVertices < 3 ? [2, 1.5] : [1],
                }}
              />
            </Source>
            {draft?.kind === "polygon" && (
              <Source
                id="spatial-draft-vertices"
                type="geojson"
                data={{
                  type: "FeatureCollection",
                  features: draft.ring.map((position) => ({
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
                    "circle-stroke-color": SHAPE_COLOR,
                    "circle-stroke-width": 2,
                  }}
                />
              </Source>
            )}
            {draft?.kind === "point" && (
              <Source
                id="spatial-draft-centre"
                type="geojson"
                data={{
                  type: "Feature",
                  geometry: { type: "Point", coordinates: [draft.lng, draft.lat] },
                  properties: {},
                }}>
                <MapLayer
                  id="spatial-draft-centre-dot"
                  type="circle"
                  paint={{
                    "circle-radius": 5,
                    "circle-color": SHAPE_COLOR,
                    "circle-stroke-color": "#FFFFFF",
                    "circle-stroke-width": 2,
                  }}
                />
              </Source>
            )}
            <DetailMapAttribution />
          </MapLibre>
        </Box>
      </Stack>
    </AppDialog>
  );
};

export default CatalogSpatialDialog;
