import { Box } from "@mui/material";
import bbox from "@turf/bbox";
import "maplibre-gl/dist/maplibre-gl.css";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MapRef } from "react-map-gl/maplibre";
import { MapProvider } from "react-map-gl/maplibre";

import { useDatasetStyle } from "@/lib/api/map";
import { useLoadedRasterValues } from "@/lib/api/rasters";
import { getBasemapUrl } from "@/lib/constants/basemaps";
import { DrawProvider } from "@/lib/providers/DrawProvider";
import { setHighlightedFeature, setPopupInfo } from "@/lib/store/map/slice";
import type { LayerStyle } from "@/lib/style/generated/types";
import type { JsonObject } from "@/lib/style/json";
import { coverageUrl } from "@/lib/style/layerSource";
import { buildLegend, informative } from "@/lib/style/legend";
import { fromPopupConfig } from "@/lib/style/popup";
import { valueQuery, valuesUrl } from "@/lib/style/raster/values";
import type { ViewLayer } from "@/lib/style/render/viewLayers";
import { basemapTone } from "@/lib/style/tone";
import { detailPopupConfig } from "@/lib/utils/map/detailPopup";
import { storedBounds } from "@/lib/utils/map/extentBounds";
import { resolveLayerBounds } from "@/lib/utils/map/layerExtent";
import { fitBounds } from "@/lib/utils/map/navigate";
import { globalExtent, wktToGeoJSON } from "@/lib/utils/map/wkt";
import type { Layer } from "@/lib/validations/layer";

import { useCatalogBasemap } from "@/hooks/catalog/useCatalogBasemapStyle";
import useLayerFields from "@/hooks/map/CommonHooks";
import { useAppDispatch } from "@/hooks/store/ContextHooks";

import DetailMapAttribution from "@/components/dashboard/common/DetailMapAttribution";
import DetailMapLegend from "@/components/dashboard/common/DetailMapLegend";
import MapViewer from "@/components/map/MapViewer";
import { MapFixedPopupSlot } from "@/components/map/popover/MapFixedPopupSlot";

/** Room kept clear for the credit strip, which sits in the corner opposite the pinned panel. */
const ATTRIBUTION_ROOM = 24;

/** `useLayerFields` defaults this to a fresh array, which would give its result
 * a new identity every render and defeat the memos below. */
const HIDDEN_FIELDS = ["layer_id", "id", "h3_3", "h3_6", "geom", "geometry"];

interface DatasetMapPreviewProps {
  dataset: Layer;
}

/** An owned layer on a map: the layer's own tiles in its default style, under
 * the chrome the catalog's detail map wears. It fills the box it is placed in,
 * which is where its height comes from. */
const DatasetMapPreview: React.FC<DatasetMapPreviewProps> = ({ dataset }) => {
  const mapRef = useRef<MapRef | null>(null);
  // `MapViewer` needs a style from the first render; the light basemap stands
  // in where the theme lookup finds none.
  const catalogBasemap = useCatalogBasemap();
  const basemapStyle = catalogBasemap?.url ?? getBasemapUrl(null);
  const geojson = wktToGeoJSON(dataset.extent || globalExtent);
  const boundingBox = bbox(geojson);
  // A dataset stored without an extent (a COG, a map service) opens on the world; the area the file or the service
  // tells replaces it once read.
  const hasExtent = !!storedBounds(dataset);
  useEffect(() => {
    if (hasExtent) return;
    let live = true;
    resolveLayerBounds({ ...dataset, layer_id: dataset.id }).then((found) => {
      if (live && found && mapRef.current) fitBounds(mapRef.current, found, 40, 18, 0);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset.id, hasExtent]);
  const dispatch = useAppDispatch();
  const { layerFields } = useLayerFields(dataset.id, undefined, HIDDEN_FIELDS);
  const { style } = useDatasetStyle(dataset.id);

  // `popupInfo` and the highlight live in the shared map store, so a panel left
  // open here would survive into the next dialog or a project map.
  useEffect(
    () => () => {
      dispatch(setPopupInfo(undefined));
      dispatch(setHighlightedFeature(undefined));
    },
    [dispatch]
  );

  /** The map's rendered height, which the pinned feature panel is sized
   * against. Measured on the box wrapping `MapViewer`, which fills the frame
   * the map is placed in. */
  const mapBox = useRef<HTMLDivElement | null>(null);
  const [panelHeight, setPanelHeight] = useState(420);
  const measure = useCallback(() => {
    const node = mapBox.current;
    if (node) setPanelHeight(node.getBoundingClientRect().height);
  }, []);
  useEffect(() => {
    const node = mapBox.current;
    if (!node) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure]);

  /** A popup configuration for a dataset that has none: hover previews a
   * feature, a click pins it. Raster layers have no features to read. */
  const popup = useMemo(
    () =>
      dataset.type === "raster" ? undefined : detailPopupConfig(layerFields, panelHeight, ATTRIBUTION_ROOM),
    [dataset.type, layerFields, panelHeight]
  );

  // The dataset in its default style, shown, with the detail popup in place of its own.
  const layers = useMemo<ViewLayer[]>(() => {
    if (!style) return [];
    const document = popup
      ? ({ ...style.document, popup: fromPopupConfig(popup, style.document.popup) } as LayerStyle)
      : style.document;
    return [{ ...dataset, visible: true, entry: {}, style: { ...style, document } }];
  }, [dataset, popup, style]);

  const geometry = dataset.feature_layer_geometry_type?.toLowerCase();
  // A raster file's classes read the minimum and maximum of the values the map loaded for it, as in the project.
  const query =
    style?.document.kind === "raster" ? valueQuery(style.document as unknown as JsonObject) : null;
  const valueRange = useLoadedRasterValues(
    query ? valuesUrl(coverageUrl(String(dataset.id)), query) : undefined
  )?.range;
  const legend = useMemo(
    () =>
      style
        ? buildLegend(style.document as unknown as JsonObject, {
            geometry:
              geometry === "point" || geometry === "line" || geometry === "polygon" ? geometry : undefined,
            zoom: 12,
            serviceLegendUrl: (dataset.other_properties as { legend_urls?: string[] } | null)
              ?.legend_urls?.[0],
            valueRange,
          })
        : null,
    [style, geometry, dataset.other_properties, valueRange]
  );

  return (
    <DrawProvider>
      <MapProvider>
        <Box ref={mapBox} sx={{ position: "relative", height: "100%" }}>
          <MapViewer
            mapRef={mapRef}
            layers={layers}
            initialViewState={{
              bounds: boundingBox as [number, number, number, number],
              fitBoundsOptions: { padding: 40 },
            }}
            mapStyle={basemapStyle}
            layerTone={basemapTone(catalogBasemap)}
            touchZoomRotate={false}
            // The highlight alone marks the hovered feature, as on the catalog map.
            activeFeatureMarker={false}
            containerSx={{
              position: "relative",
              display: "flex",
              height: "100%",
              overflow: "hidden",
            }}>
            {/* Capped: the legend owns the bottom-left of this map. */}
            <DetailMapAttribution maxWidth="62%" />

            {/* `MapViewer` renders in-place popups only; a pinned one is drawn by
                this slot, which anchors to the nearest positioned box — here
                `MapViewer`'s own root. */}
            <MapFixedPopupSlot layers={layers} />

            {/* The dataset's legend, from the style the features are rendered with, only where it says more than the
                base look. */}
            <DetailMapLegend legend={legend && informative(legend) ? legend : null} />
          </MapViewer>
        </Box>
      </MapProvider>
    </DrawProvider>
  );
};

export default DatasetMapPreview;
