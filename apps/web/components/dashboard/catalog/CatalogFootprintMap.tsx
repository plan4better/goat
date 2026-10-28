import { Alert, Box, Paper, Skeleton, Typography, useTheme } from "@mui/material";
import bboxOf from "@turf/bbox";
import "maplibre-gl/dist/maplibre-gl.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MapGeoJSONFeature, MapLayerMouseEvent } from "react-map-gl/maplibre";
import { Layer as MapLayer, Map as MapLibre, Source } from "react-map-gl/maplibre";

import { useCatalogPreview, useCatalogStyle } from "@/lib/api/catalog";
import { CATALOG_SAMPLE_KEY, catalogSampleLayer } from "@/lib/catalog/style";
import { HIGHLIGHT } from "@/lib/style/compile/constants";
import type { Geometry } from "@/lib/style/compile/types";
import { buildLegend } from "@/lib/style/legend";
import { mapLayerIdsOf } from "@/lib/style/render/mapLayers";
import { INTERACTIVE_PARTS } from "@/lib/style/render/viewLayers";
import { detailPopupConfig } from "@/lib/utils/map/detailPopup";
import { MAPLIBRE_MAP_OPTIONS } from "@/lib/utils/map/maplibre";
import type { CatalogItem } from "@/lib/validations/catalog";
import type { PopupProperties } from "@/lib/validations/layer";

import { useCatalogBasemapStyle } from "@/hooks/catalog/useCatalogBasemapStyle";

import DetailMapAttribution from "@/components/dashboard/common/DetailMapAttribution";
import { StyledLayers } from "@/components/map/StyledLayers";
import { StyleLegend } from "@/components/map/legend/StyleLegend";
import { MapFeaturePopover } from "@/components/map/popover/MapFeaturePopover";
import type { LayerField } from "@/components/map/popover/formatFeatureProperties";

/** Where the dataset is, and — where the deployment allows it — what it contains. */

const FOOTPRINT_COLOR = "#2278CF";

/** Room kept clear for the credit strip, which sits in the same corner the panel is pinned to. */
const ATTRIBUTION_ROOM = 24;

type PickedFeature = {
  lngLat: { lng: number; lat: number };
  properties: Record<string, unknown>;
  /** The queried feature; its id marks it as the active one. */
  feature: MapGeoJSONFeature;
};

const PLAIN_LAYERS = ["catalog-geometry-fill", "catalog-geometry-line", "catalog-geometry-point"];

const CatalogFootprintMap = ({
  item,
  /** Fills its container instead of standing at a fixed height. */
  fill,
}: {
  item: CatalogItem;
  fill?: boolean;
}) => {
  const { t, i18n } = useTranslation("common");
  const theme = useTheme();
  const basemapStyle = useCatalogBasemapStyle();
  const { preview, isLoading } = useCatalogPreview(item.id);

  const footprint = useMemo<GeoJSON.FeatureCollection | null>(() => {
    if (!item.geometry) return null;
    return {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: item.geometry, properties: {} }],
    };
  }, [item.geometry]);

  const sample = useMemo<GeoJSON.FeatureCollection | null>(() => {
    // A preview of a dataset without geometry is rows, not shapes — there is no
    // map for this component to be on in that case, but the sample is still
    // filtered rather than trusted to be drawable.
    const drawable = (preview?.features ?? []).filter(
      (feature): feature is GeoJSON.Feature => !!feature.geometry
    );
    return drawable.length ? { type: "FeatureCollection", features: drawable } : null;
  }, [preview]);
  const shown = sample ?? footprint;

  // Only worth fetching a style when there is data to draw with it.
  const styleHref = item.assets?.style?.href;
  const { style, isLoading: styleLoading } = useCatalogStyle(styleHref, !!sample);
  const geometryType = item.properties["goat:geometryType"] ?? undefined;
  /** The dataset's own rendering, and some of its data to draw with it. */
  const styledSample = !!catalogSampleLayer(style, geometryType, sample);
  /** The style is still on its way, so nothing is drawn with the right paint yet.
   *
   * Without this the sample renders twice: once in the plain footprint colour
   * while the style request is in flight, then again in the dataset's own
   * colours when it lands — a visible flash of the wrong rendering. Holding the
   * features back until the answer is in costs the few hundred milliseconds
   * nobody was using anyway. A dataset with no style published (108 of 10,793)
   * has nothing to wait for, and a style that fails to load or cannot be drawn
   * falls through to the plain rendering, which is what it is for. */
  const awaitingStyle = !!sample && !!styleHref && styleLoading;

  /** Field definitions for the popup, from what the dataset published. */
  const fields = useMemo<LayerField[]>(
    () =>
      (item.properties["table:columns"] ?? []).map((column) => ({
        name: column.name,
        type: column.type ?? "text",
      })),
    [item.properties]
  );

  /** The map's rendered height, and how much of its bottom the attribution takes. */
  const mapBox = useRef<HTMLDivElement | null>(null);
  const [panelHeight, setPanelHeight] = useState(420);
  const [attributionRoom, setAttributionRoom] = useState(ATTRIBUTION_ROOM);
  const measure = useCallback(() => {
    const node = mapBox.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    setPanelHeight(box.height);
    // Distance from the top of the credit strip to the bottom of the map.
    const attribution = node.querySelector("[data-catalog-attribution]");
    if (!attribution) return;
    const room = box.bottom - attribution.getBoundingClientRect().top;
    if (room > 0 && room < box.height) setAttributionRoom(room);
  }, []);
  useEffect(() => {
    const node = mapBox.current;
    if (!node) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure]);

  /** A popup configuration for a dataset that has none. */
  const popup = useMemo<PopupProperties>(
    () => detailPopupConfig(fields, panelHeight, attributionRoom),
    [fields, panelHeight, attributionRoom]
  );

  /** Hover previews, a click pins; a pin outranks the hover and ignores it until dismissed. */
  const [picked, setPicked] = useState<PickedFeature | null>(null);
  const [hovered, setHovered] = useState<PickedFeature | null>(null);
  const active = picked ?? hovered;
  /** Whether the cursor is over a feature, so the pointer means something. */
  const [hovering, setHovering] = useState(false);

  /** The sample drawn with the dataset's style, its active feature marked by the renderer. */
  const activeId = typeof active?.feature.id === "number" ? active.feature.id : undefined;
  const sampleLayer = useMemo(
    () => catalogSampleLayer(style, geometryType, sample, activeId),
    [style, geometryType, sample, activeId]
  );
  const legend = useMemo(
    () =>
      sampleLayer
        ? buildLegend(sampleLayer.style as never, { geometry: sampleLayer.geometry as Geometry, zoom: 12 })
        : null,
    [sampleLayer]
  );

  /** The sample feature under a pointer position. */
  const featureAt = (event: MapLayerMouseEvent) => {
    const wanted = styledSample
      ? mapLayerIdsOf(event.target, CATALOG_SAMPLE_KEY, { kinds: INTERACTIVE_PARTS })
      : PLAIN_LAYERS;
    // Read from `getStyle()`: `getLayer()` returns nothing through react-map-gl's
    // wrapper, and querying a layer the style has yet to add logs an error.
    const present = new Set((event.target.getStyle()?.layers ?? []).map((layer) => layer.id));
    const layers = wanted.filter((id) => present.has(id));
    if (!layers.length) return undefined;
    const { x, y } = event.point;
    // A two-point box, never `event.point`: an unrecognised point argument makes
    // `queryRenderedFeatures` fall back to the whole viewport and return the first
    // feature anywhere on the map. The 5px reach also makes a 3px dot clickable.
    const box: [[number, number], [number, number]] = [
      [x - 5, y - 5],
      [x + 5, y + 5],
    ];
    return event.target.queryRenderedFeatures(box, { layers }).at(0);
  };

  const asPicked = (event: MapLayerMouseEvent, hit: MapGeoJSONFeature): PickedFeature => ({
    lngLat: { lng: event.lngLat.lng, lat: event.lngLat.lat },
    properties: (hit.properties ?? {}) as Record<string, unknown>,
    feature: hit,
  });

  const onMapClick = (event: MapLayerMouseEvent) => {
    if (!sample) return;
    const hit = featureAt(event);
    // A click on the basemap unpins. Same gesture, both directions -- which is
    // what lets the panel do without a close control.
    setPicked(hit ? asPicked(event, hit) : null);
  };

  const onMapMouseMove = (event: MapLayerMouseEvent) => {
    if (!sample) return;
    const hit = featureAt(event);
    setHovering(!!hit);
    // A pinned panel is the reader's, not the cursor's.
    if (picked) return;
    setHovered((prev) => {
      if (!hit) return prev ? null : prev;
      // Same feature under the cursor: keep the previous object.
      if (prev && prev.feature.id === hit.id) return prev;
      return asPicked(event, hit);
    });
  };

  /** Escape dismisses the panel. */
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setPicked(null);
      setHovered(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  /** The dataset's whole extent, drawn around the part of it being shown.
   *
   * The sample is a slice — measured across the catalog, anywhere from 0.26% to
   * half of the extent it comes from — so without this the map gives no way to
   * tell whether the dataset stops where the features do. */
  const extentOutline = useMemo<GeoJSON.FeatureCollection | null>(() => {
    const box = item.bbox;
    if (!sample || !box || box.length < 4) return null;
    const [west, south, east, north] = box;
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [west, south],
                [east, south],
                [east, north],
                [west, north],
                [west, south],
              ],
            ],
          },
        },
      ],
    };
  }, [item.bbox, sample]);

  const initialViewState = useMemo(() => {
    // The sample's own extent, not the item's. A sample can sit in a corner of
    // its dataset, so framing the dataset draws the preview as a speck in an
    // empty map; the outline above is what keeps the dataset's size legible.
    const box = (shown ? (bboxOf(shown) as number[]) : null) ?? item.bbox;
    if (!box || box.length < 4) return { longitude: 10, latitude: 51, zoom: 3 };
    return {
      bounds: [box[0], box[1], box[2], box[3]] as [number, number, number, number],
      fitBoundsOptions: { padding: 40 },
    };
  }, [item.bbox, shown]);

  if (!shown) {
    return <Alert severity="info">{t("catalog_no_geometry")}</Alert>;
  }

  return (
    <Box sx={fill ? { position: "absolute", inset: 0 } : undefined}>
      {isLoading && <Skeleton variant="rectangular" height={4} sx={{ mb: 1 }} />}
      <Box
        ref={mapBox}
        sx={{
          ...(fill
            ? { position: "absolute", inset: 0 }
            : { height: 420, borderRadius: 1, overflow: "hidden" }),
        }}>
        <MapLibre
          {...MAPLIBRE_MAP_OPTIONS}
          // Named for the same reason as the catalog's other maps: it must not
          // collide with a host page's own map inside a shared `MapProvider`.
          id="catalog-footprint"
          initialViewState={initialViewState}
          style={{ width: "100%", height: "100%" }}
          mapStyle={basemapStyle}
          // GOAT's own strip replaces it, below.
          attributionControl={false}
          cursor={hovering ? "pointer" : "grab"}
          onClick={onMapClick}
          onMouseMove={onMapMouseMove}
          onMouseOut={() => {
            setHovering(false);
            // The preview follows the cursor off the map; a pinned panel stays.
            setHovered(null);
          }}
          // The credit strip only exists once the map has loaded.
          onLoad={measure}
          // Moving the map would leave the panel describing a feature that is no
          // longer in view, so it drops both the pin and the preview.
          onMoveStart={() => {
            setPicked(null);
            setHovered(null);
          }}>
          {/* Drawn first so the sample sits on top of it. Two lines, not one: a
              pale casing under a dark dash, so the outline reads over whatever
              the basemap puts beneath it — light terrain, dark water, imagery —
              without having to pick a colour that wins against all of them. */}
          {extentOutline && (
            <Source id="catalog-extent" type="geojson" data={extentOutline}>
              <MapLayer
                id="catalog-extent-casing"
                type="line"
                paint={{
                  "line-color": theme.palette.background.paper,
                  "line-width": 4,
                  "line-opacity": 0.45,
                }}
              />
              <MapLayer
                id="catalog-extent-outline"
                type="line"
                paint={{
                  "line-color": theme.palette.text.secondary,
                  "line-width": 1.5,
                  "line-dasharray": [4, 4],
                  "line-opacity": 0.5,
                }}
              />
            </Source>
          )}

          {/* The dataset's own rendering through the map compiler; the active feature is marked by feature state. */}
          {!awaitingStyle && sampleLayer && <StyledLayers layers={[sampleLayer]} locale={i18n.language} />}

          {/* `generateId`: the active feature is matched by id, and preview GeoJSON carries none. */}
          {!styledSample && (
            <Source id="catalog-geometry" type="geojson" data={shown} generateId>
              {/* Layers stay direct children — `Source` injects its id only into
                  children it can see, and a wrapping fragment hides them. */}
              {!awaitingStyle && (
                <MapLayer
                  id="catalog-geometry-fill"
                  type="fill"
                  paint={{ "fill-color": FOOTPRINT_COLOR, "fill-opacity": sample ? 0.35 : 0.12 }}
                  filter={["==", ["geometry-type"], "Polygon"]}
                />
              )}
              {!awaitingStyle && (
                <MapLayer
                  id="catalog-geometry-line"
                  type="line"
                  paint={{ "line-color": FOOTPRINT_COLOR, "line-width": 1.5 }}
                />
              )}
              {!awaitingStyle && (
                <MapLayer
                  id="catalog-geometry-point"
                  type="circle"
                  paint={{ "circle-color": FOOTPRINT_COLOR, "circle-radius": 3 }}
                  filter={["==", ["geometry-type"], "Point"]}
                />
              )}

              {/* The app's highlight of the active feature. */}
              {active?.feature.id !== undefined && (
                <MapLayer
                  id="catalog-geometry-highlight-line"
                  type="line"
                  paint={{ "line-color": HIGHLIGHT.color, "line-width": HIGHLIGHT.width }}
                  filter={["all", ["==", ["id"], active.feature.id], ["!=", ["geometry-type"], "Point"]]}
                />
              )}
              {active?.feature.id !== undefined && (
                <MapLayer
                  id="catalog-geometry-highlight-point"
                  type="circle"
                  paint={{ "circle-color": HIGHLIGHT.color, "circle-opacity": 0.8, "circle-radius": 8 }}
                  filter={["all", ["==", ["id"], active.feature.id], ["==", ["geometry-type"], "Point"]]}
                />
              )}
            </Source>
          )}

          {active && (
            <Box
              sx={{
                // A hover preview must not take the pointer: it opens over the
                // features being swept, and the `mouseout` that follows would clear
                // the hover and flicker the panel. Pinned, it becomes interactive.
                ...(picked ? null : { "&, & *": { pointerEvents: "none !important" } }),
              }}>
              <MapFeaturePopover
                fields={fields}
                popup={popup}
                properties={active.properties}
                lngLat={active.lngLat}
                onClose={() => {
                  setPicked(null);
                  setHovered(null);
                }}
              />
            </Box>
          )}

          {/* Capped: the legend owns the bottom-left of this map. */}
          <DetailMapAttribution maxWidth={styledSample ? "62%" : "100%"} />
        </MapLibre>

        {/* What the map is showing, in the one corner the legend and the credit
            strip leave free. The dashed outline says the same thing spatially;
            this puts a number on it. */}
        {!!sample && !!preview && (
          <Paper
            elevation={0}
            sx={{
              position: "absolute",
              left: 8,
              top: 8,
              px: 1.25,
              py: 0.5,
              borderRadius: 1.5,
              backgroundColor: theme.palette.background.paper,
              opacity: 0.96,
              zIndex: 2,
              pointerEvents: "none",
            }}>
            <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
              {typeof preview["goat:total"] === "number" &&
              preview["goat:total"] > sample.features.length
                ? t("catalog_preview_sample_of", {
                    shown: sample.features.length,
                    total: preview["goat:total"],
                  })
                : t("catalog_preview_sample")}
            </Typography>
          </Paper>
        )}

        {/* The dataset's legend, drawn by the Layers panel's own component from the
            same style the features use. */}
        {styledSample && (
          <Paper
            elevation={0}
            sx={{
              position: "absolute",
              left: 8,
              bottom: 8,
              maxWidth: 280,
              maxHeight: "70%",
              overflowY: "auto",
              px: 2,
              py: 1.5,
              borderRadius: 1.5,
              backgroundColor: theme.palette.background.paper,
              opacity: 0.96,
              // Above the credit strip, which sets a z-index of its own and would
              // otherwise cover the legend where the two meet on a narrow map.
              zIndex: 2,
            }}>
            {/* Headings kept: the field a classification reads turns a column of swatches into an explanation. */}
            {legend && <StyleLegend legend={legend} variant="tree" />}
          </Paper>
        )}
      </Box>
    </Box>
  );
};

export default CatalogFootprintMap;
