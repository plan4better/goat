import MapboxDraw from "@mapbox/mapbox-gl-draw";
import type { Theme } from "@mui/material";
import { Box, useMediaQuery, useTheme } from "@mui/material";
import centroid from "@turf/centroid";
import type { MapGeoJSONFeature, StyleSpecification } from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Map, type MapLayerMouseEvent, type MapLayerTouchEvent, type MapRef, type ViewState } from "react-map-gl/maplibre";
import type { ViewStateChangeEvent } from "react-map-gl/maplibre";
import { v4 } from "uuid";

import {
  setClickedFeatureForFilter,
  setCurrentZoom,
  setHighlightedFeature,
  setPopupInfo,
  setPopupPreview,
} from "@/lib/store/map/slice";
import { HEXAGON_PART, hexagonPopup, hexagonValues, isHexagon } from "@/lib/style/h3Popup";
import { rasterPopupLayer, rasterValuesAt } from "@/lib/style/raster/popup";
import { carryProjectLayers, mapLayerIdsOf, projectLayerOf } from "@/lib/style/render/mapLayers";
import {
  INTERACTIVE_PARTS,
  type ViewLayer,
  clusterFeatureOf,
  topFeature,
  zoomToCluster,
} from "@/lib/style/render/viewLayers";
import { applyMapLanguage } from "@/hooks/map/MapHooks";
import { MAPLIBRE_MAP_OPTIONS } from "@/lib/utils/map/maplibre";
import createPulsingDot from "@/lib/utils/map/pulsing-dot-image";
import { type PopupTrigger, splitPopupProperties } from "@/lib/utils/map/popupProperties";

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { useFeatureEditor } from "@/hooks/map/useFeatureEditor";
import { useRenderLayers } from "@/hooks/map/useRenderLayers";
import GeocoderLayer from "@/components/map/GeocoderLayer";
import { type EditedLayer, StyledLayers, useLiveLayer } from "@/components/map/StyledLayers";
import ToolboxLayers from "@/components/map/ToolboxLayers";
import UserLocationLayer from "@/components/map/UserLocationLayer";
import DrawControl from "@/components/map/controls/Draw";
import FeatureEditToolbar from "@/components/map/controls/FeatureEditToolbar";
import ConfirmModal from "@/components/modals/Confirm";
import MapPopoverEditor from "@/components/map/controls/PopoverEditor";
import { MeasureLabels } from "@/components/map/controls/measure";
import { featureSwatchIcon } from "@/components/map/legend/StyleLegend";
import { ActiveFeaturePulseLayer } from "@/components/map/popover/ActiveFeaturePulseLayer";
import { MapFeaturePopover } from "@/components/map/popover/MapFeaturePopover";
import { layerPopup } from "@/components/map/popover/normalizePopup";
import {
  findPopupLayer,
  layerHighlightsActiveFeature,
  shouldClosePopupForHiddenLayer,
  shouldHighlightActivePopupFeature,
} from "@/components/map/popover/popupVisibility";

interface MapProps {
  mapRef: React.RefObject<MapRef | null> | null;
  initialViewState?: Partial<ViewState> & {
    bounds?: [number, number, number, number];
    fitBoundsOptions?: {
      offset?: [number, number];
      minZoom?: number;
      maxZoom?: number;
      padding?: number | { top: number; bottom: number; left: number; right: number };
    };
  };
  maxExtent?: [number, number, number, number];
  minZoom?: number;
  maxZoom?: number;
  mapStyle: string | StyleSpecification;
  /** Top first, each with its active style. */
  layers: ViewLayer[];
  /** Layers whose style panel is open: drawn from their editor store. */
  editing?: EditedLayer[];
  /** The map's number locale (the map document's); the viewer's language when unset. */
  locale?: string | null;
  onMove?: ((e: ViewStateChangeEvent) => void | undefined) | undefined;
  onMoveEnd?: ((e: ViewStateChangeEvent) => void | undefined) | undefined;
  onClick?: (e: MapLayerMouseEvent) => void;
  onLoad?: () => void;
  dragRotate?: boolean | undefined;
  touchZoomRotate?: boolean | undefined;
  children?: React.ReactNode;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  containerSx?: any;
  isEditor?: boolean;
  /** Whether the active popup feature gets the pulse (click) or dot (hover)
   * marker on top of its highlight. Off for maps that only need the
   * highlight, such as the dataset preview. */
  activeFeatureMarker?: boolean;
}

/**
 * Fixed accent for the active-feature highlight. Independent of the (possibly
 * branded) theme so the marker stays legible on every dashboard and basemap.
 */
const ACTIVE_FEATURE_PULSE_COLOR = "#2BB381";

const triggerOf = (layer: ViewLayer): PopupTrigger | undefined => {
  const config = layerPopup(layer);
  return config && config.enabled !== false ? config.trigger : undefined;
};

/** The dataset a popup reads its fields from: a project layer's `layer_id`, a dataset's own id. */
const datasetOf = (layer: ViewLayer): string => String(layer.layer_id ?? layer.id);

/** The least time between two cell value reads while hovering a raster file, in ms. */
const RASTER_HOVER_INTERVAL = 100;

const MapViewer: React.FC<MapProps> = ({
  mapRef,
  initialViewState,
  mapStyle,
  layers,
  editing,
  locale,
  onMove,
  onMoveEnd,
  onClick,
  onLoad,
  dragRotate = false,
  touchZoomRotate = false,
  maxExtent,
  minZoom,
  maxZoom,
  children,
  containerSx,
  isEditor,
  activeFeatureMarker = true,
}) => {
  const { t, i18n } = useTranslation("common");
  const theme = useTheme();
  const dispatch = useAppDispatch();
  const isGetInfoActive = useAppSelector((state) => state.map.isMapGetInfoActive);
  const mapCursor = useAppSelector((state) => state.map.mapCursor);
  const highlightedFeature = useAppSelector((state) => state.map.highlightedFeature);
  const popupInfo = useAppSelector((state) => state.map.popupInfo);
  const popupEditor = useAppSelector((state) => state.map.popupEditor);
  const popupPreview = useAppSelector((state) => state.map.popupPreview);
  const mapMode = useAppSelector((state) => state.map.mapMode);

  // --- Basemap swap without tearing down project layers ---------------------
  // react-map-gl is given the basemap once (frozen prop). Changing the basemap
  // then goes through an imperative setStyle with transformStyle that carries
  // the project sources/layers (stable "src-*" ids from the renderer) across the
  // style change, so MapLibre's diff leaves them mounted and their tiles are
  // NOT refetched. Feeding the changed style through the prop instead would make
  // react-map-gl replace the whole style, dropping and re-adding every source.
  //
  // react-map-gl creates the map asynchronously, so the basemap can change
  // before there is a map to swap (e.g. the editor correcting a basemap left in
  // Redux by the previously opened project). That change stays pending here and
  // handleMapLoad applies it, instead of it being dropped.
  const initialMapStyleRef = useRef(mapStyle);
  const appliedMapStyleRef = useRef(mapStyle);
  const latestMapStyleRef = useRef(mapStyle);
  latestMapStyleRef.current = mapStyle;
  const applyPendingMapStyle = useCallback(() => {
    const target = latestMapStyleRef.current;
    if (target === appliedMapStyleRef.current) return;
    const map = mapRef?.current?.getMap();
    if (!map) return;
    const swap = () => {
      // handleMapLoad may already have applied it while this waited for idle.
      if (appliedMapStyleRef.current === target) return;
      map.setStyle(target, {
        diff: true,
        // The project layers stay on top of the new basemap; the renderer places them again on style.load and
        // the custom basemap's layer settings restack them on styledata.
        transformStyle: carryProjectLayers,
      });
      appliedMapStyleRef.current = target;
    };
    if (map.isStyleLoaded()) swap();
    else map.once("idle", swap);
  }, [mapRef]);
  useEffect(() => {
    applyPendingMapStyle();
  }, [mapStyle, applyPendingMapStyle]);

  // Look up the layer that owns the currently-clicked feature. The clicked
  // ProjectLayer's own id (`projectLayerId`) wins — the same dataset can back
  // several project layers with different popup configs — with a fallback to
  // the dataset-id match for popups dispatched without one.
  // While its style panel is open, a layer's popup is the edited one (the map draws the same document).
  const clickedPopupLayer = useLiveLayer(
    useMemo(
      () => findPopupLayer(popupInfo?.layerId, layers, popupInfo?.projectLayerId),
      [popupInfo?.layerId, popupInfo?.projectLayerId, layers],
    ),
    editing,
  );

  // The popup is the style's (spec 7.4) in today's popup configuration.
  const activePopupConfig = useMemo(
    () => popupInfo?.popup ?? layerPopup(clickedPopupLayer, popupInfo?.featureProperties),
    [clickedPopupLayer, popupInfo?.popup, popupInfo?.featureProperties],
  );

  // Same lookup pattern as `clickedPopupLayer` above, but for the live-preview
  // controller (Popup section "Show preview" toggle). `popupPreview.layerId`
  // is the dataset id; we match against ProjectLayer.layer_id or Layer.id.
  const storedPreviewLayer = useMemo(() => {
    if (!popupPreview?.layerId || !layers) return undefined;
    const target = popupPreview.layerId;
    return layers.find(
      (l) =>
        (l as { layer_id?: string }).layer_id === target ||
        l.id.toString() === target,
    );
  }, [popupPreview?.layerId, layers]);

  const previewLayer = useLiveLayer(storedPreviewLayer, editing);
  const previewPopupConfig = useMemo(() => layerPopup(previewLayer), [previewLayer]);

  // Small layer-style icon shown in the popup header. Mirrors the preview
  // icon the Layers panel renders (see ProjectLayerTree.tsx ~L1134) so
  // the popup feels consistent with the rest of the UI. Helper lives in
  // LayerIcon.tsx alongside the component it builds.
  const clickedFeatureProperties = (popupInfo?.featureProperties ??
    highlightedFeature?.properties ??
    popupInfo?.properties) as Record<string, unknown> | undefined;
  const clickedPopupLayerIcon = useMemo(
    () => featureSwatchIcon(clickedPopupLayer, clickedFeatureProperties),
    [clickedPopupLayer, clickedFeatureProperties],
  );
  const previewLayerIcon = useMemo(
    () => featureSwatchIcon(previewLayer, popupPreview?.feature?.properties ?? undefined),
    [previewLayer, popupPreview?.feature?.properties],
  );

  // Centroid of the preview feature, used both for the popover anchor and the
  // active-feature pulse position. `@turf/centroid` handles Point, LineString,
  // and Polygon geometries uniformly.
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

  const featureEditorHandlers = useFeatureEditor(mapRef);

  // The renderer's layers that clicks and hovers find features on (pending edits included), read from its registry
  // after every change.
  const [drawnLayerIds, setDrawnLayerIds] = useState<string[]>([]);
  const interactiveLayerIds = useMemo(() => {
    const map = mapRef?.current?.getMap();
    if (!map) return [];
    const keys = new Set(drawnLayerIds.map((id) => projectLayerOf(map, id)));
    return [...keys].flatMap((key) =>
      key === undefined ? [] : mapLayerIdsOf(map, key, { kinds: [...INTERACTIVE_PARTS, HEXAGON_PART] }),
    );
  }, [drawnLayerIds, mapRef]);

  // A raster file's popup (spec 9.7): the cell values under the pointer, from the raster service; the latest pointer
  // position wins over answers still on their way.
  const rasterRequestRef = useRef(0);
  const lastRasterHoverRef = useRef(0);
  const openRasterPopup = (lngLat: { lng: number; lat: number }, trigger: "click" | "hover"): boolean => {
    const map = mapRef?.current?.getMap();
    const layer = map ? rasterPopupLayer(layers ?? [], trigger) : undefined;
    if (!map || !layer) return false;
    const activeLayerId = popupInfo?.layerId;
    if (activeLayerId && activeLayerId !== datasetOf(layer)) return false;
    const request = ++rasterRequestRef.current;
    void rasterValuesAt(layer, lngLat).then((values) => {
      if (request !== rasterRequestRef.current) return;
      if (!values) {
        if (trigger === "hover" && hoverPopupKeyRef.current !== undefined) {
          hoverPopupKeyRef.current = undefined;
          dispatch(setPopupInfo(undefined));
        }
        return;
      }
      if (trigger === "hover") hoverPopupKeyRef.current = `raster:${layer.id}`;
      dispatch(
        setPopupInfo({
          lngLat: [lngLat.lng, lngLat.lat],
          properties: values as unknown as Record<string, string>,
          featureProperties: values,
          triggeredBy: trigger,
          title: layer.name ?? "",
          layerId: datasetOf(layer),
          projectLayerId: layer.id.toString(),
          onClose: handlePopoverClose,
        }),
      );
    });
    return true;
  };

  const handlePopoverClose = () => {
    dispatch(setPopupInfo(undefined));
    dispatch(setHighlightedFeature(undefined));
    hoverPopupKeyRef.current = undefined;
  };

  // A hexagon groups many points: its popup shows its own values, and there is no single feature to highlight.
  const openHexagonPopup = (
    layer: ViewLayer,
    feature: MapGeoJSONFeature,
    lngLat: { lng: number; lat: number },
    trigger: "click" | "hover",
  ) => {
    dispatch(setHighlightedFeature(undefined));
    dispatch(
      setPopupInfo({
        lngLat: [lngLat.lng, lngLat.lat],
        title: layer.name ?? "",
        layerId: datasetOf(layer),
        projectLayerId: layer.id.toString(),
        featureProperties: hexagonValues(feature.properties),
        popup: hexagonPopup(layerPopup(layer), layer.style?.document, t),
        triggeredBy: trigger,
        onClose: handlePopoverClose,
      }),
    );
  };

  // Close a feature popup when its owning layer is hidden or removed. popupInfo
  // lives in Redux independently of layer visibility, so toggling the layer off
  // in the Layers panel (or deleting it) would otherwise leave the popup and its
  // active-feature pulse stranded on the map. This runs in MapViewer — mounted
  // by every layout — so it covers all popup hosts (the in-place popup here, the
  // pinned popup rendered by MapFixedPopupSlot, and the mobile bottom sheet),
  // which all read the same popupInfo.
  useEffect(() => {
    if (
      popupInfo &&
      shouldClosePopupForHiddenLayer(popupInfo.layerId, layers, popupInfo.projectLayerId)
    ) {
      popupInfo.onClose();
    }
  }, [popupInfo, layers]);

  // Tracks the (layerId-featureId) key of the popup currently shown via
  // hover trigger. Used to avoid re-dispatching on every mousemove while
  // still over the same feature, and to clear the popup when the cursor
  // leaves all hover-trigger features.
  const hoverPopupKeyRef = useRef<string | undefined>(undefined);

  // Touch start point — used by the touch-tap fallback below. Maplibre's
  // own tap-to-click conversion is blocked by MapboxDraw's mode
  // handlers on touch devices, so we recognize taps ourselves from
  // touchstart/touchend pairs.
  const touchStartPointRef = useRef<{ x: number; y: number } | null>(null);

  // Tools that take over the click/hover space — popup interaction must
  // step out of the way while any of these is active so we don't fight
  // the measure/edit/draw UX with stray popups.
  const activeMeasureTool = useAppSelector((s) => s.map.activeMeasureTool);
  const editorActiveLayerId = useAppSelector((s) => s.featureEditor.activeLayerId);
  const popupInteractionsBlocked = Boolean(activeMeasureTool) || Boolean(editorActiveLayerId);

  const handleMapClick = (e: MapLayerMouseEvent) => {
    // Skip all popup logic while a measure / draw / edit tool owns the
    // click — those tools have their own click handlers and a stray
    // popup would fight the UX.
    if (popupInteractionsBlocked) return;
    let features = e.features;

    // Expand the hit-test area when no features are directly under the
    // reported click point. Two cases this matters for:
    //  - Touch devices: the synthetic click coordinate is reported as a
    //    single pixel, but the finger covers many — thin features
    //    (lines, small points) often fall outside that single pixel.
    //  - Desktop hairline strokes: the same problem at smaller scale.
    // Re-querying within a small bounding box recovers the feature
    // without changing behavior when there's already a direct hit.
    if ((!features || features.length === 0) && mapRef?.current) {
      const TAP_BUFFER = 8;
      const map = mapRef.current.getMap();
      const bbox: [[number, number], [number, number]] = [
        [e.point.x - TAP_BUFFER, e.point.y - TAP_BUFFER],
        [e.point.x + TAP_BUFFER, e.point.y + TAP_BUFFER],
      ];
      features = map.queryRenderedFeatures(bbox, {
        // Unlike react-map-gl's event delegation (which ignores unknown ids),
        // queryRenderedFeatures throws if ANY id is absent from the style.
        // interactiveLayerIds includes cluster sub-layer ids that only exist in
        // certain marker modes (and can be transiently missing during style
        // reloads), so restrict the query to layers currently in the style.
        layers: interactiveLayerIds.filter((id) => map.getLayer(id)),
      }) as typeof features;
    }

    const map = mapRef?.current?.getMap();

    // Cluster click: zoom to where the cluster breaks apart.
    const clusterFeature = map ? clusterFeatureOf(map, features) : undefined;
    if (map && clusterFeature) {
      void zoomToCluster(map, clusterFeature);
      return;
    }

    // Track whether the popup block already highlighted a feature
    let didHighlight = false;

    if (map && features && features.length > 0 && isGetInfoActive) {
      // The topmost feature whose layer opens its popup on click. Once a popup is open for one layer, a click on
      // another layer's feature does not replace it (the user closes it first); the same layer may update.
      const activeLayerId = popupInfo?.layerId;
      const hit = topFeature(map, features, layers, (layer) => {
        const trigger = triggerOf(layer);
        if (trigger !== "click" && trigger !== "click_and_hover") return false;
        return !activeLayerId || datasetOf(layer) === activeLayerId;
      });
      // A click always supersedes any hover-driven popup state.
      hoverPopupKeyRef.current = undefined;

      if (hit && isHexagon(hit.feature)) {
        openHexagonPopup(hit.layer, hit.feature, e.lngLat, "click");
      } else if (hit) {
        const { feature: interactiveFeature, layer: interactiveLayer } = hit;
        dispatch(setHighlightedFeature(interactiveFeature));
        didHighlight = true;

        let lngLat: [number, number] = [e.lngLat.lng, e.lngLat.lat];
        if (interactiveFeature.geometry.type === "Point" && interactiveFeature.geometry.coordinates) {
          lngLat = [interactiveFeature.geometry.coordinates[0], interactiveFeature.geometry.coordinates[1]];
        }

        const { properties: primitiveProperties, jsonProperties } = splitPopupProperties(
          interactiveFeature.properties
        );
        dispatch(
          setPopupInfo({
            lngLat,
            properties: primitiveProperties,
            jsonProperties: jsonProperties,
            // Full unfiltered feature properties — snapshotted here so the
            // new MapFeaturePopover doesn't read live from highlightedFeature
            // (which mutates on unrelated UI events like changing the
            // selected layer in the Layers panel).
            featureProperties: interactiveFeature.properties as Record<string, unknown>,
            triggeredBy: "click",
            title: interactiveLayer.name ?? "",
            // queryables expects the dataset id, not the project layer id.
            layerId: datasetOf(interactiveLayer),
            projectLayerId: interactiveLayer.id.toString(),
            onClose: handlePopoverClose,
          })
        );
      } else {
        // No interactive features were found in the click stack.
        dispatch(setHighlightedFeature(undefined));
        if (!openRasterPopup(e.lngLat, "click")) dispatch(setPopupInfo(undefined));
      }
    } else {
      // No features clicked or get info tool is not active.
      dispatch(setHighlightedFeature(undefined));
      if (!(map && isGetInfoActive && openRasterPopup(e.lngLat, "click"))) dispatch(setPopupInfo(undefined));
    }

    // Click-to-filter: dispatch clicked feature independently of popup interaction settings.
    // This finds the topmost feature from ANY layer (regardless of interaction type).
    const filterHit =
      map && (mapMode === "builder" || mapMode === "public")
        ? topFeature(
            map,
            features?.filter((f) => !isHexagon(f)),
            layers,
            () => true,
          )
        : undefined;
    if (filterHit) {
      // Only highlight if the popup block didn't already handle it — and
      // only when this layer's popup enables the active-feature highlight.
      // Otherwise click-to-filter would recolor the feature even for layers
      // whose popup (and thus "Highlight active feature") is off, leaving a
      // highlight with no popup. Filtering below still runs regardless.
      const cfg = layerPopup(filterHit.layer);
      if (!didHighlight && cfg && layerHighlightsActiveFeature(cfg.enabled, cfg.highlight_active_feature)) {
        dispatch(setHighlightedFeature(filterHit.feature));
      }
      dispatch(
        setClickedFeatureForFilter({
          layerProjectId: filterHit.layer.id as number,
          properties: filterHit.feature.properties,
          timestamp: Date.now(),
        })
      );
    }

    if (onClick) {
      onClick(e);
    }
  };

  // Manual tap → click synthesis for touch devices. Maplibre's own
  // tap-to-click recognizer doesn't fire `click` here because
  // MapboxDraw's mode handlers preempt the tap on touch (its `onTap`
  // runs even in idle simple_select), so we recognize taps ourselves
  // and forward them to `handleMapClick`. Drags/pans (movement above
  // TAP_TOLERANCE_PX) fall through to maplibre's gesture handling
  // untouched.
  const TAP_TOLERANCE_PX = 8;
  const handleMapTouchStart = (e: MapLayerTouchEvent) => {
    // Multi-touch is always a gesture (pinch/rotate), never a tap.
    if (e.points?.length !== 1) {
      touchStartPointRef.current = null;
      return;
    }
    touchStartPointRef.current = { x: e.point.x, y: e.point.y };
  };
  const handleMapTouchEnd = (e: MapLayerTouchEvent) => {
    const start = touchStartPointRef.current;
    touchStartPointRef.current = null;
    if (!start) return;
    const dx = e.point.x - start.x;
    const dy = e.point.y - start.y;
    if (dx * dx + dy * dy > TAP_TOLERANCE_PX * TAP_TOLERANCE_PX) return;
    // MapTouchEvent has the same `point`, `lngLat`, `features` shape
    // that `handleMapClick` reads from, so the cast is safe.
    handleMapClick(e as unknown as MapLayerMouseEvent);
  };

  const handleMapOverImmediate = (e: MapLayerMouseEvent) => {
    // Extract features immediately
    const features = e.features;
    if (mapRef?.current) {
      // This is a hack to change the cursor to a pointer when hovering over a feature
      // It's not recommended to change the state of a component through internal methods
      // However, this is the only way to do it with the current version of react-map-gl
      // See https://github.com/visgl/react-map-gl/issues/579#issuecomment-1275163348
      const map = mapRef.current.getMap();
      if (mapCursor) {
        map.getCanvas().style.cursor = mapCursor;
      } else {
        map.getCanvas().style.cursor = features?.length ? "pointer" : "";
      }
    }

    if (!isGetInfoActive) return;
    // Don't fire hover popups while another tool owns the interaction
    // (measure / draw / edit) — see the click handler for the same guard.
    if (popupInteractionsBlocked) return;

    // A click-pinned popup is sticky: subsequent hovers (even within the
    // same layer) shouldn't move it. User must close it explicitly to
    // navigate to a different feature.
    if (popupInfo?.triggeredBy === "click") return;

    // The topmost feature whose layer shows its popup on hover. Once a popup is open for one layer, hovers on OTHER
    // layers are ignored until that popup closes.
    const activeLayerId = popupInfo?.layerId;
    const map = mapRef?.current?.getMap();
    const hit = map
      ? topFeature(map, features, layers, (layer) => {
          const trigger = triggerOf(layer);
          if (trigger !== "hover" && trigger !== "click_and_hover") return false;
          return !activeLayerId || datasetOf(layer) === activeLayerId;
        })
      : undefined;
    const hoverFeature = hit?.feature;
    const hoverLayer = hit?.layer;

    // Stable key so we only dispatch when the hovered feature changes.
    const hoverKey =
      hoverFeature && hoverLayer
        ? isHexagon(hoverFeature)
          ? `${hoverLayer.id}:h3:${hoverFeature.properties?.cell ?? ""}`
          : `${hoverLayer.id}:${hoverFeature.id ?? hoverFeature.properties?.id ?? ""}`
        : undefined;

    // Without a feature under the pointer, a file's cell values while hovering, at a limited rate.
    if (!hoverKey && map && rasterPopupLayer(layers ?? [], "hover")) {
      const now = Date.now();
      if (now - lastRasterHoverRef.current < RASTER_HOVER_INTERVAL) return;
      lastRasterHoverRef.current = now;
      if (openRasterPopup(e.lngLat, "hover")) return;
    }

    if (hoverKey === hoverPopupKeyRef.current) return;

    if (hoverFeature && hoverLayer && hoverKey && isHexagon(hoverFeature)) {
      hoverPopupKeyRef.current = hoverKey;
      openHexagonPopup(hoverLayer, hoverFeature, e.lngLat, "hover");
    } else if (hoverFeature && hoverLayer && hoverKey) {
      hoverPopupKeyRef.current = hoverKey;

      const featureLngLat: [number, number] =
        hoverFeature.geometry?.type === "Point" &&
        Array.isArray((hoverFeature.geometry as GeoJSON.Point).coordinates)
          ? ((hoverFeature.geometry as GeoJSON.Point).coordinates as [number, number])
          : [e.lngLat.lng, e.lngLat.lat];

      dispatch(setHighlightedFeature(hoverFeature));
      dispatch(
        setPopupInfo({
          lngLat: featureLngLat,
          title: hoverLayer.name ?? "",
          layerId: datasetOf(hoverLayer),
          projectLayerId: hoverLayer.id.toString(),
          // The new MapFeaturePopover uses featureProperties for token
          // substitution. `properties` is kept (same payload) so the
          // legacy renderer still works if it ever picks up a hover.
          featureProperties: hoverFeature.properties as Record<string, unknown>,
          properties: hoverFeature.properties as Record<string, string>,
          triggeredBy: "hover",
          onClose: handlePopoverClose,
        }),
      );
    } else if (hoverPopupKeyRef.current !== undefined) {
      // Cursor left all hover-trigger features — close the hover popup.
      // We only get here if the current popup was hover-originated
      // (click handler resets the ref).
      hoverPopupKeyRef.current = undefined;
      dispatch(setPopupInfo(undefined));
      dispatch(setHighlightedFeature(undefined));
    }
  };

  // Store ref to last dispatched zoom to avoid unnecessary Redux updates
  const lastDispatchedZoomRef = useRef<number | undefined>(undefined);
  const pendingZoomRef = useRef<number | undefined>(undefined);
  const zoomDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMapLoad = useCallback(() => {
    if (mapRef?.current) {
      // Style images (icons, patterns) load on demand through the renderer's resolver.
      // load geolocation images
      const geolocationPulsingDot = createPulsingDot(mapRef.current);
      mapRef.current.addImage("geolocation-pulsing-dot", geolocationPulsingDot, { pixelRatio: 2 });

      // Active-feature highlight for MapFeaturePopover. Deliberately NOT the
      // theme primary: on a branded dashboard that can be any color (a dark
      // brand ink renders as an unreadable smudge over the basemap), so the
      // highlight keeps a fixed, always-legible accent.
      mapRef.current.addImage(
        "popup-active-pulsing-dot",
        createPulsingDot(mapRef.current, {
          color: ACTIVE_FEATURE_PULSE_COLOR,
          innerBorder: false, // crisp edge on dark basemaps
          size: 100, // larger canvas → bigger blast radius
          innerRatio: 0.18, // keep the inner dot small (9 internal px)
          duration: 1800, // slower expansion
          idleTime: 400, // a touch more breathing room between rings
        }),
        { pixelRatio: 2 },
      );

      // Static (non-pulsing) variant of the popup-active dot. Used for
      // hover-triggered popups where the pulse animation would be too
      // attention-grabbing for a transient highlight — same dot
      // dimensions and color, no expanding ring.
      mapRef.current.addImage(
        "popup-active-static-dot",
        createPulsingDot(mapRef.current, {
          color: ACTIVE_FEATURE_PULSE_COLOR,
          innerBorder: false,
          size: 100,
          innerRatio: 0.18,
          staticOnly: true,
        }),
        { pixelRatio: 2 },
      );

      // set current zoom (rounded to 1 decimal place for consistency)
      const map = mapRef.current.getMap();
      const zoom = map.getZoom();
      const roundedZoom = Math.round(zoom * 10) / 10;
      lastDispatchedZoomRef.current = roundedZoom;
      dispatch(setCurrentZoom(roundedZoom));

      // Apply label language based on current locale
      applyMapLanguage(map, i18n.language);

      applyPendingMapStyle();
    }
    onLoad && onLoad();
  }, [mapRef, onLoad, dispatch, i18n.language, applyPendingMapStyle]);

  // Re-apply label language when locale changes or basemap style reloads
  useEffect(() => {
    if (!mapRef?.current) return;
    const map = mapRef.current.getMap();
    const apply = () => applyMapLanguage(map, i18n.language);
    // Apply now if style is already loaded
    if (map.isStyleLoaded()) {
      apply();
    }
    // Also apply whenever a new style finishes loading (basemap switch)
    map.on("styledata", apply);
    return () => {
      map.off("styledata", apply);
    };
  }, [i18n.language, mapRef, mapStyle]);

  const _onMove = useCallback(
    (e: ViewStateChangeEvent) => {
      if (onMove) {
        onMove(e);
      }
      if (mapRef?.current) {
        const map = mapRef.current.getMap();
        const zoom = map.getZoom();
        // Round to 1 decimal place to avoid excessive Redux updates during smooth zoom/pan
        // This prevents re-renders of components subscribed to currentZoom (like LayerTree)
        const roundedZoom = Math.round(zoom * 10) / 10;
        if (lastDispatchedZoomRef.current !== roundedZoom) {
          // Debounce the Redux dispatch — zoom visibility dimming in the layer tree
          // doesn't need real-time updates during zoom animation
          pendingZoomRef.current = roundedZoom;
          if (zoomDebounceRef.current) {
            clearTimeout(zoomDebounceRef.current);
          }
          zoomDebounceRef.current = setTimeout(() => {
            if (pendingZoomRef.current !== undefined) {
              lastDispatchedZoomRef.current = pendingZoomRef.current;
              dispatch(setCurrentZoom(pendingZoomRef.current));
            }
          }, 150);
        }
      }
    },
    [dispatch, onMove, mapRef]
  );

  const isMobile = useMediaQuery((theme: Theme) => theme.breakpoints.down("md"));

  // "Highlight active feature" (popup.highlight_active_feature) governs ALL active-object highlighting: with a popup
  // open but its highlight off, the feature is not marked either. Highlights without a popup (click to filter, the
  // data table, the geocoder) are unaffected.
  const highlighted = shouldHighlightActivePopupFeature(
    Boolean(popupInfo && activePopupConfig),
    activePopupConfig?.highlight_active_feature,
  )
    ? highlightedFeature
    : undefined;
  const highlightLayerId = highlighted?.layer?.id;
  const highlightId = highlighted?.id;
  const highlight = useMemo(() => {
    if (highlightLayerId === undefined || highlightId === undefined || highlightId === null) return undefined;
    const map = mapRef?.current?.getMap();
    // A rendered feature names its MapLibre layer; the data table's names the project layer itself.
    const key = (map && projectLayerOf(map, String(highlightLayerId))) ?? String(highlightLayerId);
    return { key, id: highlightId as number | string };
  }, [highlightLayerId, highlightId, mapRef]);
  const renderLayers = useRenderLayers(layers, { highlight });

  return (
    <>
      <Box
        sx={{
          position: "relative",
          width: "100%",
          ".maplibregl-ctrl .maplibregl-ctrl-logo": {
            display: "none",
          },
          height: `100%`,
          ".maplibregl-popup-content": {
            padding: 0,
            borderRadius: "6px",
            background: theme.palette.background.paper,
          },
          ".maplibregl-popup-anchor-top .maplibregl-popup-tip, .maplibregl-popup-anchor-top-left .maplibregl-popup-tip, .maplibregl-popup-anchor-top-right .maplibregl-popup-tip":
            {
              borderBottomColor: theme.palette.background.paper,
            },
          ".maplibregl-popup-anchor-bottom .maplibregl-popup-tip, .maplibregl-popup-anchor-bottom-right .maplibregl-popup-tip, .maplibregl-popup-anchor-bottom-left .maplibregl-popup-tip":
            {
              borderTopColor: theme.palette.background.paper,
            },
          ".maplibregl-popup-anchor-left .maplibregl-popup-tip": {
            borderRightColor: theme.palette.background.paper,
          },
          ".maplibregl-popup-anchor-right .maplibregl-popup-tip": {
            borderLeftColor: theme.palette.background.paper,
          },
          // Measure label popup styles (chip-like, no arrow, no pointer events)
          ".measure-label-popup": {
            pointerEvents: "none",
          },
          ".measure-label-popup .maplibregl-popup-content": {
            padding: 0,
            background: "transparent",
            boxShadow: "none",
            borderRadius: "16px",
            pointerEvents: "none",
          },
          ".measure-label-popup .maplibregl-popup-tip": {
            display: "none",
          },
          // Feature popup (new): no tip, transparent maplibre wrapper so
          // the popover's translucent background + backdrop blur show through.
          ".goat-feature-popup .maplibregl-popup-tip": {
            display: "none",
          },
          ".goat-feature-popup .maplibregl-popup-content": {
            background: "transparent",
            boxShadow: "none",
            padding: 0,
          },
          ...containerSx,
        }}>
        <Map
          {...MAPLIBRE_MAP_OPTIONS}
          id="map"
          ref={mapRef}
          style={{ width: "100%", height: "100%" }}
          initialViewState={initialViewState}
          mapStyle={initialMapStyleRef.current}
          interactiveLayerIds={interactiveLayerIds}
          dragRotate={dragRotate}
          touchZoomRotate={touchZoomRotate}
          attributionControl={false}
          // MapLibre's own UI strings; the canvas is announced by this title.
          locale={{ "Map.Title": t("map") }}
          onMoveEnd={onMoveEnd}
          onClick={handleMapClick}
          onTouchStart={handleMapTouchStart}
          onTouchEnd={handleMapTouchEnd}
          onMouseMove={handleMapOverImmediate}
          onMove={_onMove}
          maxBounds={maxExtent}
          minZoom={minZoom}
          maxZoom={maxZoom}
          onLoad={handleMapLoad}>
          <DrawControl
            position="top-right"
            displayControlsDefault={false}
            defaultMode={MapboxDraw.constants.modes.SIMPLE_SELECT}
          />
          <StyledLayers
            layers={renderLayers}
            editing={editing}
            locale={locale || i18n.language}
            onLayersChange={setDrawnLayerIds}
          />
          <GeocoderLayer />
          <UserLocationLayer />
          <ToolboxLayers />
          <MeasureLabels />
          {popupInfo && activePopupConfig && (
            <>
              {/* Fixed-anchor popups are rendered by the active layout
                  via <MapFixedPopupSlot>, so they pick up the layout's
                  toolbar / panel positioning the same way Geocoder /
                  ToolboxCtrl / MeasureButton do. Only the in-place
                  variant lives inside <Map>, where it needs useMap to
                  anchor to feature coordinates. On mobile the popup
                  content lives in the bottom drawer instead, but the
                  active-feature pulse below still marks the feature
                  on the map. */}
              {!isMobile && activePopupConfig.layout !== "pinned" && (
                <MapFeaturePopover
                  key={highlightedFeature?.id ?? v4()}
                  layerId={popupInfo.layerId ?? ""}
                  layerName={popupInfo.title}
                  popup={activePopupConfig}
                  properties={
                    // Prefer the click-time snapshot stored on popupInfo so
                    // the popup stays bound to the originally-clicked feature.
                    // Fall back to the live highlightedFeature (e.g. for
                    // older popupInfo payloads dispatched before this field
                    // existed) and then to popupInfo.properties as last resort.
                    (popupInfo.featureProperties ??
                      highlightedFeature?.properties ??
                      popupInfo.properties ??
                      {}) as Record<string, unknown>
                  }
                  lngLat={{ lng: popupInfo.lngLat[0], lat: popupInfo.lngLat[1] }}
                  onClose={popupInfo.onClose}
                  layerIcon={clickedPopupLayerIcon}
                />
              )}
              <ActiveFeaturePulseLayer
                lngLat={{ lng: popupInfo.lngLat[0], lat: popupInfo.lngLat[1] }}
                visible={activeFeatureMarker && activePopupConfig.highlight_active_feature}
                // Pulse for click-triggered popups; static dot for hover.
                // Hover is transient — the pulse is overkill.
                pulse={popupInfo.triggeredBy !== "hover"}
              />
            </>
          )}
          {!isMobile &&
            popupPreview &&
            previewLayer &&
            previewPopupConfig &&
            previewCentroid &&
            // Hide the live preview while a real click/hover popup is
            // showing — they'd visually overlap and the real popup
            // demonstrates the same styling anyway. Preview returns
            // automatically when the real popup closes.
            !popupInfo && (
              <>
                {/* Fixed-anchor preview lives in the layout — see comment
                    on the click-popup branch above. */}
                {previewPopupConfig.layout !== "pinned" && (
                  <MapFeaturePopover
                    layerId={popupPreview.layerId}
                    layerName={previewLayer.name ?? ""}
                    popup={previewPopupConfig}
                    properties={popupPreview.feature.properties}
                    lngLat={previewCentroid}
                    onClose={() => dispatch(setPopupPreview(null))}
                    layerIcon={previewLayerIcon}
                  />
                )}
                <ActiveFeaturePulseLayer
                  lngLat={previewCentroid}
                  visible={previewPopupConfig.highlight_active_feature}
                />
              </>
            )}
          {!isMobile && popupEditor && isEditor && (
            <MapPopoverEditor
              key={popupEditor.feature?.id || popupEditor.feature?.properties?.id || v4()}
              {...popupEditor}
            />
          )}
        </Map>
        <FeatureEditToolbar
          onSave={featureEditorHandlers.handleSave}
          onDiscard={featureEditorHandlers.handleDiscardRequest}
          onStopEditing={featureEditorHandlers.handleStopEditingRequest}
          onUndo={featureEditorHandlers.handleUndo}
          onRedo={featureEditorHandlers.handleRedo}
          hasUndo={featureEditorHandlers.hasUndo}
          hasRedo={featureEditorHandlers.hasRedo}
        />
        <ConfirmModal
          open={featureEditorHandlers.discardConfirmOpen}
          title={t("discard_edits")}
          body={t("discard_edits_confirmation")}
          closeText={t("cancel")}
          confirmText={t("discard_edits")}
          onClose={featureEditorHandlers.handleDiscardCancel}
          onConfirm={featureEditorHandlers.handleDiscardConfirm}
        />
        <ConfirmModal
          open={featureEditorHandlers.stopConfirmOpen}
          title={t("stop_editing")}
          body={t("discard_edits_confirmation")}
          closeText={t("cancel")}
          confirmText={t("stop_editing")}
          onClose={featureEditorHandlers.handleStopCancel}
          onConfirm={featureEditorHandlers.handleStopConfirm}
        />
        {children}
      </Box>
    </>
  );
};

export default MapViewer;
