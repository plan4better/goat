import { cogProtocol } from "@geomatico/maplibre-cog-protocol";
import MapboxDraw from "@mapbox/mapbox-gl-draw";
import type { Theme } from "@mui/material";
import { Box, useMediaQuery, useTheme } from "@mui/material";
import centroid from "@turf/centroid";
import maplibregl from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Map, type MapGeoJSONFeature, type MapLayerMouseEvent, type MapLayerTouchEvent, type MapRef, type ViewState } from "react-map-gl/maplibre";
import type { ViewStateChangeEvent } from "react-map-gl/maplibre";
import { v4 } from "uuid";

import { PATTERN_IMAGES } from "@/lib/constants/pattern-images";
import {
  setClickedFeatureForFilter,
  setCurrentZoom,
  setHighlightedFeature,
  setPopupInfo,
  setPopupPreview,
} from "@/lib/store/map/slice";
import { addOrUpdateMarkerImages, addPatternImages } from "@/lib/transformers/map-image";
import { applyMapLanguage } from "@/hooks/map/MapHooks";
import createPulsingDot from "@/lib/utils/map/pulsing-dot-image";
import {
  buildPopupFieldConfig,
  getEffectivePopupTrigger,
  popupFieldInfo,
  selectPopupProperties,
  splitPopupProperties,
} from "@/lib/utils/map/popupProperties";
import {
  type FeatureLayerPointProperties,
  type Layer,
  type PopupProperties,
} from "@/lib/validations/layer";
import type { ProjectLayer } from "@/lib/validations/project";

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { useFeatureEditor } from "@/hooks/map/useFeatureEditor";
import { ExplorerMapLayers } from "@/components/explorer/ExplorerMapLayers";
import GeocoderLayer from "@/components/map/GeocoderLayer";
import Layers from "@/components/map/Layers";
import ToolboxLayers from "@/components/map/ToolboxLayers";
import UserLocationLayer from "@/components/map/UserLocationLayer";
import DrawControl from "@/components/map/controls/Draw";
import FeatureEditToolbar from "@/components/map/controls/FeatureEditToolbar";
import ConfirmModal from "@/components/modals/Confirm";
import MapPopoverEditor from "@/components/map/controls/PopoverEditor";
import { MeasureLabels } from "@/components/map/controls/measure";
import { buildLayerIcon } from "@/components/map/panels/layer/legend/LayerIcon";
import { seedPopupFromInteraction } from "@/components/map/panels/style/popup/seedFromLegacy";
import { ActiveFeaturePulseLayer } from "@/components/map/popover/ActiveFeaturePulseLayer";
import { MapFeaturePopover } from "@/components/map/popover/MapFeaturePopover";
import { normalizePopup } from "@/components/map/popover/normalizePopup";
import {
  findPopupLayer,
  layerHighlightsActiveFeature,
  shouldClosePopupForHiddenLayer,
  shouldHighlightActivePopupFeature,
} from "@/components/map/popover/popupVisibility";

maplibregl.addProtocol("cog", cogProtocol);

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
  mapStyle: string | maplibregl.StyleSpecification;
  layers: ProjectLayer[] | Layer[];
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

const MapViewer: React.FC<MapProps> = ({
  mapRef,
  initialViewState,
  mapStyle,
  layers,
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
  // the project sources/layers (stable "src-*" ids from Layers.tsx) across the
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
        transformStyle: (previous, next) => {
          if (!previous) return next;
          // Carry every project source (and the layers bound to it) from the
          // old style into the new basemap style, unchanged.
          const sources = { ...next.sources };
          for (const [id, src] of Object.entries(previous.sources ?? {})) {
            if (id.startsWith("src-")) sources[id] = src;
          }
          const carriedLayers = (previous.layers ?? []).filter(
            (l) => "source" in l && typeof l.source === "string" && l.source.startsWith("src-")
          );
          // Append on top of the basemap layers; the basemapLayerConfig effect
          // in <Layers> re-applies any promote/restack afterwards on styledata.
          return { ...next, sources, layers: [...next.layers, ...carriedLayers] };
        },
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
  const clickedPopupLayer = useMemo(
    // Explicit type argument: `layers` is a union of arrays
    // (ProjectLayer[] | Layer[]), which generic inference can't unify.
    () =>
      findPopupLayer<ProjectLayer | Layer>(popupInfo?.layerId, layers, popupInfo?.projectLayerId),
    [popupInfo?.layerId, popupInfo?.projectLayerId, layers],
  );

  // `popup` only exists on feature-layer property variants; non-feature layers
  // (raster/table/etc) carry differently-shaped properties. Narrow once here so
  // the JSX stays readable. Layers without an explicit `popup` block fall
  // through to `seedPopupFromInteraction`, which synthesizes a new-style popup
  // from the legacy `interaction` config — so every clickable layer renders the
  // new popup without a migration step. The popup editor seeds the same way.
  const activePopupConfig = useMemo<PopupProperties | undefined>(() => {
    if (!clickedPopupLayer) return undefined;
    const props = clickedPopupLayer.properties as
      | { popup?: PopupProperties; interaction?: { type?: string; content?: never[] } }
      | undefined;
    if (props?.popup) return normalizePopup(props.popup);
    return normalizePopup(seedPopupFromInteraction(props?.interaction));
  }, [clickedPopupLayer]);

  // Same lookup pattern as `clickedPopupLayer` above, but for the live-preview
  // controller (Popup section "Show preview" toggle). `popupPreview.layerId`
  // is the dataset id; we match against ProjectLayer.layer_id or Layer.id.
  const previewLayer = useMemo(() => {
    if (!popupPreview?.layerId || !layers) return undefined;
    const target = popupPreview.layerId;
    return layers.find(
      (l) =>
        (l as { layer_id?: string }).layer_id === target ||
        l.id.toString() === target,
    );
  }, [popupPreview?.layerId, layers]);

  const previewPopupConfig = useMemo<PopupProperties | undefined>(() => {
    if (!previewLayer) return undefined;
    const props = previewLayer.properties as
      | { popup?: PopupProperties; interaction?: { type?: string; content?: never[] } }
      | undefined;
    if (props?.popup) return normalizePopup(props.popup);
    return normalizePopup(seedPopupFromInteraction(props?.interaction));
  }, [previewLayer]);

  // Small layer-style icon shown in the popup header. Mirrors the preview
  // icon the Layers panel renders (see ProjectLayerTree.tsx ~L1134) so
  // the popup feels consistent with the rest of the UI. Helper lives in
  // LayerIcon.tsx alongside the component it builds.
  const clickedFeatureProperties = (popupInfo?.featureProperties ??
    highlightedFeature?.properties ??
    popupInfo?.properties) as Record<string, unknown> | undefined;
  const clickedPopupLayerIcon = useMemo(
    () => buildLayerIcon(clickedPopupLayer, clickedFeatureProperties),
    [clickedPopupLayer, clickedFeatureProperties],
  );
  const previewLayerIcon = useMemo(
    () => buildLayerIcon(previewLayer, popupPreview?.feature?.properties ?? undefined),
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

  const pendingFeaturesExist = useAppSelector(
    (state) => Object.keys(state.featureEditor.pendingFeatures).length > 0
  );
  const interactiveLayerIds = useMemo(() => {
    const ids = layers?.map((layer) => layer.id.toString()) || [];
    // For point layers with clustering enabled, include the cluster
    // sub-layer ids so MapLibre returns them in click events (needed for
    // cluster expand-on-click; layer-id convention from Layers.tsx).
    // Non-existent ids are silently ignored by MapLibre, so adding all
    // four covers both circle-cluster and marker-cluster modes.
    layers?.forEach((l) => {
      if (
        l.type === "feature" &&
        l.feature_layer_geometry_type === "point" &&
        (l.properties as { cluster?: { enabled?: boolean } } | undefined)?.cluster?.enabled
      ) {
        ids.push(
          `${l.id}-cluster-bubble`,
          `${l.id}-cluster-count`,
          `${l.id}-cluster-icon`,
          `${l.id}-cluster-badge`,
        );
      }
    });
    if (pendingFeaturesExist) {
      ids.push("pending-features-fill", "pending-features-line", "pending-features-circle", "pending-features-symbol");
    }
    return ids;
  }, [layers, pendingFeaturesExist]);

  const handlePopoverClose = () => {
    dispatch(setPopupInfo(undefined));
    dispatch(setHighlightedFeature(undefined));
    hoverPopupKeyRef.current = undefined;
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

    // Cluster click: zoom to the cluster's expansion zoom.
    // Layer-id convention from Layers.tsx: cluster layers contain `-cluster-`
    // (bubble / count / icon / badge).
    const clusterFeature = features?.find(
      (f) =>
        typeof f.layer.id === "string" &&
        f.layer.id.includes("-cluster-") &&
        f.properties?.cluster_id != null,
    );
    if (clusterFeature && mapRef?.current) {
      const map = mapRef.current.getMap();
      const sourceId = clusterFeature.layer.source;
      const source = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
      const clusterId = clusterFeature.properties?.cluster_id;
      if (source && clusterId != null && "getClusterExpansionZoom" in source) {
        source
          .getClusterExpansionZoom(clusterId)
          .then((zoom: number) => {
            const geom = clusterFeature.geometry;
            if (geom?.type === "Point") {
              map.easeTo({
                center: geom.coordinates as [number, number],
                zoom,
                duration: 500,
              });
            }
          })
          .catch(() => {
            // Cluster source may have been torn down between click and resolve; ignore.
          });
      }
      return;
    }

    // Track whether the popup block already highlighted a feature
    let didHighlight = false;

    if (features && features.length > 0 && isGetInfoActive) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let interactiveFeature = null as any;
      let interactiveLayer: Layer | ProjectLayer | undefined = undefined;

      // Find the first feature whose layer should fire a popup on click.
      // Accepts `click` or `click_and_hover` in the new schema, plus the
      // legacy `interaction.type === "click"`. Hover-only layers are
      // skipped here and handled in `handleMapOverImmediate`.
      const isClickable = (
        layer: Layer | ProjectLayer | undefined,
      ): boolean => {
        const t = getEffectivePopupTrigger(layer);
        return t === "click" || t === "click_and_hover";
      };
      // Once a popup is open for one layer, clicking on another layer's
      // feature should NOT replace it — the user must close the current
      // popup first. We still allow the same-layer case to update (e.g.
      // clicking a different feature in the same layer).
      const activeLayerId = popupInfo?.layerId;
      for (const feature of features) {
        const layer = layers?.find(
          (l) => l.id.toString() === feature.layer.id && isClickable(l),
        );
        if (!layer) continue;
        const layerDatasetId = (
          (layer as { layer_id?: string }).layer_id ?? layer.id
        )?.toString();
        if (activeLayerId && layerDatasetId !== activeLayerId) continue;
        interactiveFeature = feature;
        interactiveLayer = layer;
        break;
      }
      // A click always supersedes any hover-driven popup state.
      hoverPopupKeyRef.current = undefined;

      if (interactiveFeature && interactiveLayer) {
        dispatch(setHighlightedFeature(interactiveFeature));
        didHighlight = true;

        const layerName = interactiveLayer.name;
        let lngLat: [number, number] = [e.lngLat.lng, e.lngLat.lat];
        if (interactiveFeature.geometry.type === "Point" && interactiveFeature.geometry.coordinates) {
          lngLat = [interactiveFeature.geometry.coordinates[0], interactiveFeature.geometry.coordinates[1]];
        }

        // When a field list is configured, filter to the listed columns (raw values).
        // Otherwise, pass all feature properties.
        const fieldConfig = buildPopupFieldConfig(interactiveLayer);
        const rawProperties = selectPopupProperties(fieldConfig, interactiveFeature.properties);

        const { properties: primitiveProperties, jsonProperties } = splitPopupProperties(rawProperties);
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
            title: layerName ?? "",
            // ProjectLayer.id is the project-layer-link id, not the
            // underlying dataset id. queryables expects the dataset id,
            // which lives on `.layer_id` for ProjectLayers and on `.id`
            // for plain Layers. Prefer `layer_id` when present.
            layerId: (
              (interactiveLayer as { layer_id?: string }).layer_id ??
              interactiveLayer.id
            )?.toString(),
            projectLayerId: interactiveLayer.id?.toString(),
            ...popupFieldInfo(fieldConfig),
            onClose: handlePopoverClose,
          })
        );
      } else {
        // No interactive features were found in the click stack.
        dispatch(setHighlightedFeature(undefined));
        dispatch(setPopupInfo(undefined));
      }
    } else {
      // No features clicked or get info tool is not active.
      dispatch(setHighlightedFeature(undefined));
      dispatch(setPopupInfo(undefined));
    }

    // Click-to-filter: dispatch clicked feature independently of popup interaction settings.
    // This finds the topmost feature from ANY layer (regardless of interaction type).
    if (features && features.length > 0 && (mapMode === "builder" || mapMode === "public")) {
      for (const feature of features) {
        const matchedLayer = layers?.find((l) => l.id.toString() === feature.layer.id);
        if (matchedLayer) {
          // Only highlight if the popup block didn't already handle it — and
          // only when this layer's popup enables the active-feature highlight.
          // Otherwise click-to-filter would recolor the feature even for layers
          // whose popup (and thus "Highlight active feature") is off, leaving a
          // highlight with no popup. Filtering below still runs regardless.
          if (!didHighlight) {
            const props = matchedLayer.properties as
              | { popup?: PopupProperties; interaction?: { type?: string; content?: never[] } }
              | undefined;
            const cfg = props?.popup
              ? normalizePopup(props.popup)
              : normalizePopup(seedPopupFromInteraction(props?.interaction));
            if (layerHighlightsActiveFeature(cfg.enabled, cfg.highlight_active_feature)) {
              dispatch(setHighlightedFeature(feature));
            }
          }
          dispatch(
            setClickedFeatureForFilter({
              layerProjectId: matchedLayer.id as number,
              properties: feature.properties,
              timestamp: Date.now(),
            })
          );
          break;
        }
      }
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

    // Find the topmost feature whose layer is configured to show the
    // popup on hover. Accepts `hover` or `click_and_hover`. Once a popup
    // is open for one layer, hover triggers on OTHER layers are ignored
    // until that popup closes.
    const activeLayerId = popupInfo?.layerId;
    const isHoverable = (
      layer: Layer | ProjectLayer | undefined,
    ): boolean => {
      const t = getEffectivePopupTrigger(layer);
      return t === "hover" || t === "click_and_hover";
    };
    let hoverFeature: MapGeoJSONFeature | undefined;
    let hoverLayer: Layer | ProjectLayer | undefined;
    for (const feature of features ?? []) {
      const layer = layers?.find(
        (l) => l.id.toString() === feature.layer.id && isHoverable(l),
      );
      if (!layer) continue;
      const layerDatasetId = (
        (layer as { layer_id?: string }).layer_id ?? layer.id
      )?.toString();
      // Block cross-layer hover when another popup is active.
      if (activeLayerId && layerDatasetId !== activeLayerId) continue;
      hoverFeature = feature;
      hoverLayer = layer;
      break;
    }

    // Stable key so we only dispatch when the hovered feature changes.
    const hoverKey =
      hoverFeature && hoverLayer
        ? `${hoverLayer.id}:${hoverFeature.id ?? hoverFeature.properties?.id ?? ""}`
        : undefined;

    if (hoverKey === hoverPopupKeyRef.current) return;

    if (hoverFeature && hoverLayer && hoverKey) {
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
          layerId: (
            (hoverLayer as { layer_id?: string }).layer_id ?? hoverLayer.id
          )?.toString(),
          projectLayerId: hoverLayer.id?.toString(),
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
      // get all icon layers and add icons to map using addOrUpdateMarkerImages method

      layers?.forEach((layer) => {
        if (layer.type === "feature" && layer.feature_layer_geometry_type === "point") {
          const pointFeatureProperties = layer.properties as FeatureLayerPointProperties;
          addOrUpdateMarkerImages(layer.id, pointFeatureProperties, mapRef.current);
        }
      });

      // load pattern images
      addPatternImages(PATTERN_IMAGES ?? [], mapRef.current);

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
  }, [layers, mapRef, onLoad, dispatch, i18n.language, applyPendingMapStyle]);

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
          <Layers
            layers={layers}
            // "Highlight active feature" (popup.highlight_active_feature) must
            // govern ALL active-object highlighting, not just the pulsing dot:
            // when a popup is active but its highlight toggle is off, the
            // feature-recolor highlight is suppressed too. Non-popup highlights
            // (click-to-filter, hover-to-highlight, data table, geocoder) run
            // without an active popupInfo, so they are unaffected.
            highlightFeature={
              shouldHighlightActivePopupFeature(
                Boolean(popupInfo && activePopupConfig),
                activePopupConfig?.highlight_active_feature,
              )
                ? highlightedFeature
                : undefined
            }
          />
          <GeocoderLayer />
          <UserLocationLayer />
          <ToolboxLayers />
          <ExplorerMapLayers />
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
