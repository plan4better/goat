"use client";

import centroid from "@turf/centroid";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { setPopupPreview } from "@/lib/store/map/slice";
import type { ViewLayer } from "@/lib/style/render/viewLayers";

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { featureSwatchIcon } from "@/components/map/legend/StyleLegend";
import { MapFeaturePopover } from "@/components/map/popover/MapFeaturePopover";
import { layerPopup } from "@/components/map/popover/normalizePopup";
import { findPopupLayer, popupFields, popupFieldsLayerId } from "@/components/map/popover/popupVisibility";

export interface MapFixedPopupSlotProps {
  /** The map's layers, each with its active style (the popup is the style's). */
  layers: ViewLayer[] | undefined;
}

/**
 * Layout-level renderer for fixed-anchor popups.
 *
 * Why this exists: the maplibre `<Map>` creates its own stacking context
 * and clips child positioning to its own bounds, so rendering the fixed
 * popup inside MapViewer made it dependent on the map's parent
 * positioning rather than the layout's own chrome (toolbar / panels).
 * Layouts now mount this slot inside a Box that already sits within the
 * visible map area, and the popup positions to one of that Box's
 * corners via PopupFixedHost — same pattern as the top-left controls
 * (Geocoder, ToolboxCtrl, MeasureButton).
 *
 * In-place popups stay inside MapViewer because they anchor to map
 * coordinates and need `useMap`.
 */
export function MapFixedPopupSlot({ layers }: MapFixedPopupSlotProps) {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const popupInfo = useAppSelector((s) => s.map.popupInfo);
  const popupPreview = useAppSelector((s) => s.map.popupPreview);
  const highlightedFeature = useAppSelector((s) => s.map.highlightedFeature);

  // Mirror MapViewer's lookup: the clicked ProjectLayer's own id wins (the
  // same dataset can back several project layers), with a dataset-id fallback.
  const clickedLayer = useMemo(
    () => findPopupLayer(popupInfo?.layerId, layers, popupInfo?.projectLayerId),
    [popupInfo?.layerId, popupInfo?.projectLayerId, layers],
  );

  const activePopupConfig = useMemo(
    () => popupInfo?.popup ?? layerPopup(clickedLayer, popupInfo?.featureProperties, { t }),
    [clickedLayer, popupInfo?.popup, popupInfo?.featureProperties, t],
  );

  const previewLayer = useMemo(() => {
    if (!popupPreview?.layerId || !layers) return undefined;
    const target = popupPreview.layerId;
    return layers.find((l) => l.layer_id === target || l.id.toString() === target);
  }, [popupPreview?.layerId, layers]);

  const previewPopupConfig = useMemo(() => layerPopup(previewLayer), [previewLayer]);

  // Same feature-property resolution as the popover body below, so the
  // header icon of a layer styled by a field shows the clicked feature's class.
  const clickedFeatureProperties = (popupInfo?.featureProperties ??
    highlightedFeature?.properties ??
    popupInfo?.properties) as Record<string, unknown> | undefined;
  const clickedLayerIcon = useMemo(
    () => featureSwatchIcon(clickedLayer, clickedFeatureProperties),
    [clickedLayer, clickedFeatureProperties],
  );
  const previewIcon = useMemo(
    () => featureSwatchIcon(previewLayer, popupPreview?.feature?.properties ?? undefined),
    [previewLayer, popupPreview?.feature?.properties],
  );

  const previewCentroid = useMemo(() => {
    if (!popupPreview) return null;
    try {
      const c = centroid({
        type: "Feature",
        properties: {},
        geometry: popupPreview.feature.geometry as GeoJSON.Geometry,
      });
      const [lng, lat] = c.geometry.coordinates;
      return { lng, lat };
    } catch {
      return null;
    }
  }, [popupPreview]);

  const showClicked =
    Boolean(popupInfo) && activePopupConfig?.layout === "pinned";
  const showPreview =
    !popupInfo &&
    Boolean(popupPreview) &&
    Boolean(previewLayer) &&
    previewPopupConfig?.layout === "pinned" &&
    Boolean(previewCentroid);

  return (
    <>
      {showClicked && popupInfo && activePopupConfig && (
        <MapFeaturePopover
          layerId={popupFieldsLayerId(popupInfo.layerId, clickedLayer)}
          fields={popupFields(clickedLayer, popupInfo.featureProperties ?? popupInfo.properties)}
          layerName={popupInfo.title}
          popup={activePopupConfig}
          properties={
            (popupInfo.featureProperties ??
              highlightedFeature?.properties ??
              popupInfo.properties ??
              {}) as Record<string, unknown>
          }
          lngLat={{ lng: popupInfo.lngLat[0], lat: popupInfo.lngLat[1] }}
          onClose={popupInfo.onClose}
          layerIcon={clickedLayerIcon}
        />
      )}
      {showPreview &&
        popupPreview &&
        previewLayer &&
        previewPopupConfig &&
        previewCentroid && (
          <MapFeaturePopover
            layerId={popupPreview.layerId}
            layerName={previewLayer.name ?? ""}
            popup={previewPopupConfig}
            properties={popupPreview.feature.properties}
            lngLat={previewCentroid}
            onClose={() => dispatch(setPopupPreview(null))}
            layerIcon={previewIcon}
          />
        )}
    </>
  );
}
