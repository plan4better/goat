"use client";

import { Box, Stack, Typography, useTheme } from "@mui/material";
import bboxOf from "@turf/bbox";
import "maplibre-gl/dist/maplibre-gl.css";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Layer as MapLayer, Map as MapLibre, Source } from "react-map-gl/maplibre";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { type CatalogSpatialFilter, formatBuffer, spatialFeatures } from "@/lib/catalog/spatial";

import { useCatalogBasemapStyle } from "@/hooks/catalog/useCatalogBasemapStyle";
import { useCatalogNutsGeometries } from "@/hooks/catalog/useCatalogNutsGeometries";

import CatalogSpatialDialog from "@/components/dashboard/catalog/CatalogSpatialDialog";
import DetailMapAttribution from "@/components/dashboard/common/DetailMapAttribution";

/** The filter panel's Location section: a dashed call-to-action while empty; once set, a small map of
 * the shape with its label and an Edit affordance. */

const SHAPE_COLOR = "#2BB381";

const CatalogSpatialSection = ({
  filter,
  onChange,
}: {
  filter: CatalogSpatialFilter | null;
  onChange: (filter: CatalogSpatialFilter | null) => void;
}) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const basemapStyle = useCatalogBasemapStyle();
  const [open, setOpen] = useState(false);

  const regionIds = filter?.kind === "region" ? filter.nutsIds : [];
  const { geometries, names } = useCatalogNutsGeometries(regionIds);
  const features = useMemo(() => spatialFeatures(filter, geometries), [filter, geometries]);

  const bounds = useMemo(() => {
    if (!features.features.length) return undefined;
    const box = bboxOf(features) as number[];
    return [box[0], box[1], box[2], box[3]] as [number, number, number, number];
  }, [features]);

  /** What the filter says it is. */
  const label = useMemo(() => {
    if (!filter) return null;
    if (filter.kind === "point") {
      return `${filter.label ?? t("catalog_spatial_point")} · ${formatBuffer(filter.km)}`;
    }
    if (filter.kind === "polygon") {
      return t("catalog_spatial_area", { count: filter.ring.length });
    }
    return filter.nutsIds.map((id) => filter.names?.[id] ?? names[id] ?? id).join(", ");
  }, [filter, names, t]);

  return (
    <Box sx={{ borderBottom: `1px solid ${theme.palette.divider}` }}>
      <Box sx={{ px: 4, pt: 3, pb: 3 }}>
        <Stack direction="row" alignItems="center" spacing={2.5} sx={{ mb: 2.5 }}>
          <Icon
            iconName={ICON_NAME.LOCATION}
            style={{ fontSize: 14 }}
            htmlColor={theme.palette.text.secondary}
          />
          <Typography variant="body2" fontWeight={600} sx={{ flex: 1 }}>
            {t("catalog_location")}
          </Typography>
          {filter && (
            <Typography
              component="button"
              variant="caption"
              onClick={() => onChange(null)}
              sx={{
                background: "transparent",
                border: "none",
                p: 0,
                cursor: "pointer",
                // See the panel header: the `font` shorthand would drop the
                // variant's size and grow the row.
                fontFamily: "inherit",
                fontWeight: 600,
                color: theme.palette.primary.main,
              }}>
              {t("clear")}
            </Typography>
          )}
        </Stack>

        {filter ? (
          <Box
            sx={{
              position: "relative",
              overflow: "hidden",
              borderRadius: 2,
              border: `1px solid ${theme.palette.divider}`,
              backgroundColor: theme.palette.background.paper,
            }}>
            <Box sx={{ height: 96, position: "relative" }}>
              {bounds ? (
                <MapLibre
                  // See the dialog: an id of its own, so this and the project map
                  // never both register as "default".
                  id="catalog-spatial-preview"
                  // Non-interactive: this is a picture of the filter, and the map
                  // to change it is in the dialog.
                  interactive={false}
                  attributionControl={false}
                  initialViewState={{ bounds, fitBoundsOptions: { padding: 12, maxZoom: 11 } }}
                  style={{ width: "100%", height: "100%" }}
                  mapStyle={basemapStyle}>
                  <Source id="spatial-preview" type="geojson" data={features}>
                    <MapLayer
                      id="spatial-preview-fill"
                      type="fill"
                      paint={{ "fill-color": SHAPE_COLOR, "fill-opacity": 0.2 }}
                    />
                    <MapLayer
                      id="spatial-preview-line"
                      type="line"
                      paint={{ "line-color": SHAPE_COLOR, "line-width": 1.6 }}
                    />
                  </Source>
                  {/* Credited even at this size: the tiles and the data behind them are someone else's whether the map is 96px or full screen. */}
                  <DetailMapAttribution />
                </MapLibre>
              ) : (
                // A region whose outline has not arrived yet, or is unavailable.
                <Stack
                  alignItems="center"
                  justifyContent="center"
                  sx={{ height: "100%", backgroundColor: theme.palette.action.hover }}>
                  <Icon
                    iconName={ICON_NAME.GLOBE}
                    style={{ fontSize: 20 }}
                    htmlColor={theme.palette.primary.main}
                  />
                </Stack>
              )}
            </Box>
            <Stack
              direction="row"
              alignItems="center"
              spacing={2}
              sx={{ px: 2.75, py: 2.25, borderTop: `1px solid ${theme.palette.divider}` }}>
              <Typography
                variant="caption"
                fontWeight={600}
                noWrap
                sx={{ flex: 1, minWidth: 0 }}
                title={label ?? undefined}>
                {label}
              </Typography>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Icon
                  iconName={ICON_NAME.EDIT}
                  style={{ fontSize: 12 }}
                  htmlColor={theme.palette.primary.main}
                />
                <Typography variant="caption" fontWeight={600} color="primary">
                  {t("edit")}
                </Typography>
              </Stack>
            </Stack>

            {/* The whole card still opens the dialog, but as an overlay rather than a button wrapped around everything: the map credits its tile and data providers with links, and a link inside a button is invalid HTML — React says so, and the nested control cannot be relied on to get its own clicks. */}
            <Box
              component="button"
              type="button"
              aria-label={label ? `${t("edit")} — ${label}` : t("edit")}
              onClick={() => setOpen(true)}
              sx={{
                position: "absolute",
                inset: 0,
                p: 0,
                border: 0,
                background: "transparent",
                cursor: "pointer",
              }}
            />
          </Box>
        ) : (
          <Box
            component="button"
            type="button"
            onClick={() => setOpen(true)}
            sx={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 2,
              width: "100%",
              px: 3,
              py: 4.5,
              font: "inherit",
              cursor: "pointer",
              borderRadius: 2,
              border: `1.5px dashed ${theme.palette.divider}`,
              backgroundColor: theme.palette.action.hover,
              transition: theme.transitions.create(["border-color", "background-color"]),
              "&:hover": { borderColor: theme.palette.primary.main },
            }}>
            <Stack
              alignItems="center"
              justifyContent="center"
              sx={{
                width: 34,
                height: 34,
                borderRadius: "50%",
                backgroundColor: theme.palette.background.paper,
              }}>
              <Icon
                iconName={ICON_NAME.LOCATION}
                style={{ fontSize: 17 }}
                htmlColor={theme.palette.primary.main}
              />
            </Stack>
            <Typography variant="body2" fontWeight={700}>
              {t("catalog_set_spatial_filter")}
            </Typography>
            <Typography variant="caption" color="text.secondary" align="center">
              {t("catalog_spatial_filter_hint")}
            </Typography>
          </Box>
        )}
      </Box>

      <CatalogSpatialDialog
        open={open}
        initial={filter}
        onClose={() => setOpen(false)}
        onApply={(next) => {
          onChange(next);
          setOpen(false);
        }}
      />
    </Box>
  );
};

export default CatalogSpatialSection;
