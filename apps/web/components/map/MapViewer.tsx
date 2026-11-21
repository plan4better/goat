import MapboxDraw from "@mapbox/mapbox-gl-draw";
import { Box, Typography, useTheme } from "@mui/material";
import centroid from "@turf/centroid";
import type { MapGeoJSONFeature, Map as MaplibreMap, PaddingOptions, StyleSpecification } from "maplibre-gl";
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
import { type InfoRecord, infoSourceOf } from "@/lib/style/popup/infoSources";
import { opensOn, rasterPopupLayers, rasterPopupOf } from "@/lib/style/raster/popup";
import { BUILDINGS_TILES_URL, TERRAIN_TILES_URL } from "@/lib/constants";
import { BASEMAPS, DEFAULT_BASEMAP } from "@/lib/constants/basemaps";
import { type Tone, isImageryBasemap, toneOf } from "@/lib/scene/auto";
import { buildingsAnchor } from "@/lib/scene/compile";
import { keepGlobeDepth } from "@/lib/scene/depth";
import { SPACE_STYLE, followGlobe, haloOf } from "@/lib/scene/space";
import { ENTER_3D, MAX_PITCH_3D, type ViewMode, cameraFor, maxPitchAtZoom, viewModeOf } from "@/lib/scene/view";
import { GLOBE_UNTIL_ZOOM } from "@/lib/scene/visibility";
import { extrudes } from "@/lib/style/compile/polygons";
import type { Scene } from "@/lib/style/generated/types";
import type { JsonObject } from "@/lib/style/json";
import { carryProjectLayers, mapLayerIdsOf, projectLayerOf } from "@/lib/style/render/mapLayers";
import {
  INTERACTIVE_PARTS,
  type ViewLayer,
  clusterFeatureOf,
  featureProperties,
  topFeature,
  zoomToCluster,
} from "@/lib/style/render/viewLayers";
import { getFeature } from "@/lib/api/layers";
import { MAP_SCOPE } from "@/lib/style/render/viewPresence";
import { applyMapLanguage } from "@/hooks/map/MapHooks";
import { MAPLIBRE_MAP_OPTIONS } from "@/lib/utils/map/maplibre";
import type { Basemap } from "@/types/map/common";
import createPulsingDot from "@/lib/utils/map/pulsing-dot-image";
import { type PopupTrigger, splitPopupProperties } from "@/lib/utils/map/popupProperties";

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { useFeatureEditor } from "@/hooks/map/useFeatureEditor";
import { useScene } from "@/hooks/map/useScene";
import { useRenderLayers } from "@/hooks/map/useRenderLayers";
import { ExplorerMapLayers } from "@/components/explorer/ExplorerMapLayers";
import FilterAreaLayer from "@/components/map/FilterAreaLayer";
import GeocoderLayer from "@/components/map/GeocoderLayer";
import { type EditedLayer, StyledLayers, liveLayer, useLiveLayer } from "@/components/map/StyledLayers";
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
  popupFields,
  popupFieldsLayerId,
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
  /** Pinch to zoom (and, in 3D, to rotate). */
  touchZoomRotate?: boolean | undefined;
  /** 2D or 3D (3D spec 7.1); missing: 3D when the initial view is tilted. */
  mode?: ViewMode;
  /** Globe when zoomed out, or mercator (the default). */
  projection?: "mercator" | "globe";
  /** The map document's scene: terrain, buildings, sky, fog, glow and light; missing parts are automatic. */
  scene?: Scene | null;
  /** The basemap's tone for the automatic scene; by default from the basemap and the app theme. */
  tone?: Tone;
  /** The basemap the scene adds buildings to; the active basemap by default. */
  basemap?: Basemap;
  children?: React.ReactNode;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  containerSx?: any;
  isEditor?: boolean;
  /** Whether the active popup feature gets the pulse (click) or dot (hover)
   * marker on top of its highlight. Off for maps that only need the
   * highlight, such as the dataset preview. */
  activeFeatureMarker?: boolean;
  /** The layout shows the popup in its own drawer (the published map on a phone): the map marks the feature only.
   * Otherwise the map shows the popup itself, in a window of any width. */
  popupInDrawer?: boolean;
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

/** How long a hover popup may stay at the pointer's last place while the read of its new place is on its way, in ms. */
const STALE_HOVER_MS = 100;

/** The map's zoom as the store holds it: rounded down to a tenth. MapLibre draws a tile's images and switches layers
 * and clusters at the whole zoom at or below the map's, so at 12.96 every reader of the store sees zoom 12, as drawn. */
const storedZoom = (zoom: number): number => Math.floor(zoom * 10) / 10;

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
  touchZoomRotate = false,
  mode,
  projection,
  scene,
  tone,
  basemap,
  maxExtent,
  minZoom,
  maxZoom,
  children,
  containerSx,
  isEditor,
  activeFeatureMarker = true,
  popupInDrawer = false,
}) => {
  const { t, i18n } = useTranslation("common");
  const theme = useTheme();
  const dispatch = useAppDispatch();
  // The MapLibre map once loaded: the scene applies to it.
  const [loadedMap, setLoadedMap] = useState<MaplibreMap | null>(null);
  // The map could not start (no WebGL 2): a message instead of a blank map.
  const [cannotStart, setCannotStart] = useState(false);
  // An error before the map exists is its start failing; the rest are the map's own (tiles, styles), logged as before.
  // A basemap style can name source layers its tiles do not carry (BKG's world style does), which draws nothing and
  // is not ours to fix: that goes to the debug log once per message. A project layer's (`src-*` source) stays an error.
  const loggedBasemapNotices = useRef(new Set<string>());
  const handleMapError = useCallback((event: { target: unknown; error: Error }) => {
    if (event.target === null) setCannotStart(true);
    const message = event.error?.message ?? "";
    const missingSourceLayer = /^Source layer ".*" does not exist on source "(.*)" as specified by style layer/.exec(
      message
    );
    if (missingSourceLayer && !missingSourceLayer[1].startsWith("src-")) {
      if (!loggedBasemapNotices.current.has(message)) {
        loggedBasemapNotices.current.add(message);
        console.debug(message);
      }
      return;
    }
    console.error(event.error);
  }, []);
  useEffect(() => {
    if (!loadedMap) return;
    // MapLibre restores a lost context itself when the browser gives it back; a lost one is worth a line in the log.
    const onLost = () => console.warn("The map's WebGL context was lost; it redraws when the browser restores it.");
    loadedMap.on("webglcontextlost", onLost);
    return () => {
      loadedMap.off("webglcontextlost", onLost);
    };
  }, [loadedMap]);
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

  // The popup is the style's (spec 7.4) in today's popup configuration; a raster file's labels in the map's language.
  const activePopupConfig = useMemo(
    () => popupInfo?.popup ?? layerPopup(clickedPopupLayer, popupInfo?.featureProperties, { t }),
    [clickedPopupLayer, popupInfo?.popup, popupInfo?.featureProperties, t],
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

  // A raster file's popup (spec 9.7): the cell under the pointer. Hovering reads the value tiles the map has loaded,
  // so it sends no request; a click shows that value at once, then the raster service's exact values. A pointer move
  // wins over the reads of earlier moves (`rasterReadRef`); a click wins over earlier clicks, and closing the popup
  // drops the answer of the click still on its way (`clickReadRef`), whatever the pointer does meanwhile.
  const rasterReadRef = useRef(0);
  const clickReadRef = useRef(0);
  /** The map moves (pans, zooms, rotates, tilts): a file's hover popup hides until the next pointer move after it. */
  const mapMovingRef = useRef(false);
  /** The clicks so far: a hover read started before a click shows nothing over the click's popup. */
  const clicksRef = useRef(0);
  /** The pointer move whose read the hover popup shows (its `rasterReadRef`). */
  const hoverShownRef = useRef(0);
  /** A click's read is on its way: hovering opens no popup over the one it is about to open. */
  const clickPendingRef = useRef(false);
  /** The files as drawn (an open style panel's document); while a popup is open, only its layer. */
  const rasterLayers = (): ViewLayer[] => {
    const activeLayerId = popupInfo?.layerId;
    return (layers ?? [])
      .filter((layer) => !activeLayerId || datasetOf(layer) === activeLayerId)
      .map((layer) => liveLayer(layer, editing));
  };
  /** The first of a list of files with a value at `lngLat`; each file's cell is read once, so the pointer and the hover
   * popup of one move share the read. `onFirst` hears a click's value from the map's tiles. Never rejects: a read
   * that fails has no value. */
  const rasterCells = (
    map: MaplibreMap,
    lngLat: { lng: number; lat: number },
    trigger: "click" | "hover",
    onFirst?: (layer: ViewLayer, record: InfoRecord) => void,
  ) => {
    // By layer id (`Map` here is the map component).
    const reads: Record<string, Promise<InfoRecord | null>> = {};
    const paints: Record<string, Promise<boolean>> = {};
    const ctx = (layer: ViewLayer) => ({
      map,
      trigger,
      t,
      locale: locale || i18n.language,
      onFirst: onFirst && ((first: InfoRecord) => onFirst(layer, first)),
    });
    const readOf = (layer: ViewLayer) =>
      (reads[String(layer.id)] ??=
        infoSourceOf(layer)?.at(layer, lngLat, ctx(layer)).catch(() => null) ?? Promise.resolve(null));
    const paintsOf = (layer: ViewLayer) =>
      (paints[String(layer.id)] ??=
        infoSourceOf(layer)?.paints(layer, lngLat, ctx(layer)).catch(() => false) ?? Promise.resolve(false));
    return {
      /** The first file with a value there, and its record. */
      first: async (candidates: ViewLayer[]): Promise<{ layer: ViewLayer; record: InfoRecord } | null> => {
        for (const layer of candidates) {
          const record = await readOf(layer);
          if (record) return { layer, record };
        }
        return null;
      },
      /** Whether one of the files draws something there that its popup shows: a cell with a value on its value
       * tiles, else, for a popup a click opens, a painted pixel of its colored tiles (a hover reads nothing there). */
      shown: async (candidates: ViewLayer[]): Promise<boolean> => {
        for (const layer of candidates) {
          if (await readOf(layer)) return true;
          if (opensOn(rasterPopupOf(layer)?.trigger, "click") && (await paintsOf(layer))) return true;
        }
        return false;
      },
    };
  };
  const showRasterPopup = (
    layer: ViewLayer,
    record: InfoRecord,
    lngLat: { lng: number; lat: number },
    trigger: "click" | "hover",
  ) =>
    dispatch(
      setPopupInfo({
        lngLat: [lngLat.lng, lngLat.lat],
        properties: record.values as unknown as Record<string, string>,
        featureProperties: record.values,
        triggeredBy: trigger,
        title: layer.name ?? "",
        layerId: datasetOf(layer),
        projectLayerId: layer.id.toString(),
        onClose: handlePopoverClose,
      }),
    );
  /** A click on the files: false when none opens a popup on click. Where none has a value, the popup closes. */
  const openRasterPopup = (lngLat: { lng: number; lat: number }): boolean => {
    const map = mapRef?.current?.getMap();
    const candidates = map ? rasterPopupLayers(rasterLayers(), "click") : [];
    if (!map || !candidates.length) return false;
    const read = ++clickReadRef.current;
    clickPendingRef.current = true;
    // A click supersedes the hover popup, as a feature's click does: a move before the map draws the click's popup
    // does not close it as a hover popup the pointer left.
    hoverPopupKeyRef.current = undefined;
    const show = (layer: ViewLayer, record: InfoRecord) => {
      if (read === clickReadRef.current) showRasterPopup(layer, record, lngLat, "click");
    };
    void rasterCells(map, lngLat, "click", show)
      .first(candidates)
      .then((found) => {
        if (read !== clickReadRef.current) return;
        clickPendingRef.current = false;
        if (found) show(found.layer, found.record);
        else dispatch(setPopupInfo(undefined));
      });
    return true;
  };

  // However the popup closes (its button, the feature editor, the data table, a dataset preview), the answer of a raster
  // click still on its way opens nothing.
  useEffect(() => {
    if (popupInfo) return;
    clickReadRef.current += 1;
    clickPendingRef.current = false;
  }, [popupInfo]);

  /** The map's cursor for what is under the pointer (`features`, and the cells of `rasters`): a drawing or measuring
   * tool's own; none while the map moves, so MapLibre's grabbing cursor shows while it is dragged; the pointer over a
   * feature, and over what a file's popup shows, as a feature does: a cell with a value, a painted pixel of an image,
   * read from the tiles the map has loaded, never from a request. A file's popup counts whatever opens it. */
  const updateCursor = (
    map: MaplibreMap,
    features: MapGeoJSONFeature[] | undefined,
    rasters: ViewLayer[],
    read: number,
    cells: ReturnType<typeof rasterCells> | undefined,
  ) => {
    // This is a hack to change the cursor to a pointer when hovering over a feature
    // It's not recommended to change the state of a component through internal methods
    // However, this is the only way to do it with the current version of react-map-gl
    // See https://github.com/visgl/react-map-gl/issues/579#issuecomment-1275163348
    const canvas = map.getCanvas();
    if (mapCursor) {
      canvas.style.cursor = mapCursor;
      return;
    }
    if (mapMovingRef.current) {
      canvas.style.cursor = "";
      return;
    }
    const pointable = features?.length
      ? []
      : rasters.filter((layer) => layer.visible !== false && rasterPopupOf(layer));
    if (cells && pointable.length) {
      void cells.shown(pointable).then((shown) => {
        if (read === rasterReadRef.current) canvas.style.cursor = shown ? "pointer" : "";
      });
    } else {
      canvas.style.cursor = features?.length ? "pointer" : "";
    }
  };

  // While the map moves a file's hover popup would read the place the pointer passes on the moving map: it hides at
  // once, and the next pointer move after the move reads afresh at the new zoom. A click's popup stays at its place.
  // The pointer gives way to MapLibre's grabbing cursor while the map is dragged, rotated or tilted.
  const handleMoveStart = () => {
    mapMovingRef.current = true;
    rasterReadRef.current += 1;
    const map = mapRef?.current?.getMap();
    if (map && !mapCursor) map.getCanvas().style.cursor = "";
    if (!hoverPopupKeyRef.current?.startsWith("raster:")) return;
    hoverPopupKeyRef.current = undefined;
    dispatch(setPopupInfo(undefined));
  };
  /** After a move the pointer's cursor is the one for what is under it now, without waiting for a pointer move. */
  const handleMoveEnd = (e: ViewStateChangeEvent) => {
    mapMovingRef.current = false;
    onMoveEnd?.(e);
    const map = mapRef?.current?.getMap();
    const pointer = e.originalEvent as { clientX?: number; clientY?: number } | undefined;
    if (!map || typeof pointer?.clientX !== "number" || typeof pointer.clientY !== "number") return;
    const box = map.getCanvas().getBoundingClientRect();
    const point: [number, number] = [pointer.clientX - box.left, pointer.clientY - box.top];
    const features = map.queryRenderedFeatures(point, {
      layers: interactiveLayerIds.filter((id) => map.getLayer(id)),
    }) as MapGeoJSONFeature[];
    const read = ++rasterReadRef.current;
    const rasters = isGetInfoActive && !popupInteractionsBlocked ? rasterLayers() : [];
    updateCursor(map, features, rasters, read, rasterCells(map, map.unproject(point), "hover"));
  };
  // The pointer left the map (onto a panel or a control over it): a hover popup closes, a click's stays. A feature's
  // hover popup takes the pointer (its buttons and links): moving into it is no leaving.
  const handleMouseOut = (e?: { originalEvent?: { relatedTarget?: unknown } }) => {
    rasterReadRef.current += 1;
    if (hoverPopupKeyRef.current === undefined || popupInfo?.triggeredBy !== "hover") return;
    const to = e?.originalEvent?.relatedTarget;
    if (to instanceof Element && to.closest(".goat-feature-popup") && !to.closest(".goat-popup-passive")) return;
    hoverPopupKeyRef.current = undefined;
    dispatch(setPopupInfo(undefined));
    dispatch(setHighlightedFeature(undefined));
  };

  const handlePopoverClose = () => {
    // A click's answer still on its way opens nothing any more.
    clickReadRef.current += 1;
    clickPendingRef.current = false;
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
  // The latest click: a clustered layer's feature properties arrive from geoapi after it, and only the latest click's
  // open the popup.
  const clickSeqRef = useRef(0);

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
    // A click wins over the raster reads of earlier clicks and moves.
    clickReadRef.current += 1;
    clicksRef.current += 1;
    clickPendingRef.current = false;
    rasterReadRef.current += 1;
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

    const click = ++clickSeqRef.current;

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

        void featureProperties(interactiveLayer, interactiveFeature, getFeature).then((full) => {
          if (click !== clickSeqRef.current) return;
          const { properties: primitiveProperties, jsonProperties } = splitPopupProperties(full);
          dispatch(
            setPopupInfo({
              lngLat,
              properties: primitiveProperties,
              jsonProperties: jsonProperties,
              // Full unfiltered feature properties — snapshotted here so the
              // new MapFeaturePopover doesn't read live from highlightedFeature
              // (which mutates on unrelated UI events like changing the
              // selected layer in the Layers panel).
              featureProperties: full,
              triggeredBy: "click",
              title: interactiveLayer.name ?? "",
              // queryables expects the dataset id, not the project layer id.
              layerId: datasetOf(interactiveLayer),
              projectLayerId: interactiveLayer.id.toString(),
              onClose: handlePopoverClose,
            })
          );
        });
      } else {
        // No interactive features were found in the click stack.
        dispatch(setHighlightedFeature(undefined));
        if (!openRasterPopup(e.lngLat)) dispatch(setPopupInfo(undefined));
      }
    } else {
      // No features clicked or get info tool is not active.
      dispatch(setHighlightedFeature(undefined));
      if (!(map && isGetInfoActive && openRasterPopup(e.lngLat))) dispatch(setPopupInfo(undefined));
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
      void featureProperties(filterHit.layer, filterHit.feature, getFeature).then((properties) => {
        if (click !== clickSeqRef.current) return;
        dispatch(
          setClickedFeatureForFilter({
            layerProjectId: filterHit.layer.id as number,
            properties,
            timestamp: Date.now(),
          })
        );
      });
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
    // The latest move wins over raster reads still on their way; a click after it, over its hover popup.
    const read = ++rasterReadRef.current;
    const clicked = clicksRef.current;
    const pointerMap = mapRef?.current?.getMap();
    const rasters =
      pointerMap && isGetInfoActive && !popupInteractionsBlocked && !mapMovingRef.current ? rasterLayers() : [];
    // One read of each file's cell serves the pointer and the hover popup.
    const cells = pointerMap ? rasterCells(pointerMap, e.lngLat, "hover") : undefined;
    if (pointerMap) updateCursor(pointerMap, features, rasters, read, cells);

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

    // Without a feature under the pointer, a file's cell value while hovering, from the value tiles the map has
    // loaded.
    const hoverable = !hoverKey && !clickPendingRef.current ? rasterPopupLayers(rasters, "hover") : [];
    if (cells && hoverable.length) {
      const lngLat = e.lngLat;
      // A read that takes long (a tile's first read, the browser cache disabled): the popup leaves the old place
      // rather than show its value there, and shows again when a read answers.
      setTimeout(() => {
        if (hoverShownRef.current >= read || !hoverPopupKeyRef.current?.startsWith("raster:")) return;
        hoverPopupKeyRef.current = undefined;
        dispatch(setPopupInfo(undefined));
      }, STALE_HOVER_MS);
      void cells.first(hoverable).then((found) => {
        if (read !== rasterReadRef.current || clicked !== clicksRef.current) return;
        hoverShownRef.current = read;
        if (!found) {
          if (hoverPopupKeyRef.current === undefined) return;
          hoverPopupKeyRef.current = undefined;
          dispatch(setPopupInfo(undefined));
          dispatch(setHighlightedFeature(undefined));
          return;
        }
        // The popup follows the pointer on every move with a value, the same value over a wide area too.
        hoverPopupKeyRef.current = `raster:${found.layer.id}`;
        showRasterPopup(found.layer, found.record, lngLat, "hover");
      });
      return;
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
      void featureProperties(hoverLayer, hoverFeature, getFeature).then((full) => {
        // The pointer moved on while a clustered layer's properties were on their way.
        if (hoverPopupKeyRef.current !== hoverKey) return;
        dispatch(
          setPopupInfo({
            lngLat: featureLngLat,
            title: hoverLayer.name ?? "",
            layerId: datasetOf(hoverLayer),
            projectLayerId: hoverLayer.id.toString(),
            // MapFeaturePopover uses featureProperties for token
            // substitution; `properties` carries the same payload for the
            // readers that still take it (the fixed popup slot's fallback).
            featureProperties: full,
            properties: full as Record<string, string>,
            triggeredBy: "hover",
            onClose: handlePopoverClose,
          }),
        );
      });
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

      // set current zoom (to a tenth, as storedZoom keeps it)
      const map = mapRef.current.getMap();
      const zoom = map.getZoom();
      const roundedZoom = storedZoom(zoom);
      lastDispatchedZoomRef.current = roundedZoom;
      dispatch(setCurrentZoom(roundedZoom));

      // Apply label language based on current locale
      applyMapLanguage(map, i18n.language);
      setLoadedMap(map);
      keepGlobeDepth(map);

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
        // To a tenth (storedZoom) to avoid excessive Redux updates during smooth zoom/pan
        // This prevents re-renders of components subscribed to currentZoom (like LayerTree)
        const roundedZoom = storedZoom(zoom);
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

  // --- 2D and 3D (3D spec 7.1) and the scene (7.2) ---------------------------
  const viewMode = mode ?? viewModeOf({ pitch: initialViewState?.pitch });
  const camera = cameraFor(viewMode);
  // react-map-gl applies maxPitch at once: leaving 3D keeps it until the map has eased flat.
  const [maxPitch, setMaxPitch] = useState(camera.maxPitch);
  const shownMode = useRef(viewMode);
  useEffect(() => {
    const map = loadedMap;
    if (!map) return;
    const three = viewMode === "3d";
    for (const handler of [map.touchZoomRotate, map.keyboard]) {
      if (three) handler.enableRotation();
      else handler.disableRotation();
    }
    if (shownMode.current === viewMode) return;
    shownMode.current = viewMode;
    if (three) {
      map.setMaxPitch(MAX_PITCH_3D);
      setMaxPitch(MAX_PITCH_3D);
      map.easeTo({ pitch: ENTER_3D.pitch });
      return;
    }
    const flat = () => {
      if (shownMode.current === "2d") setMaxPitch(0);
    };
    if (map.getPitch() === 0 && map.getBearing() === 0) return flat();
    map.once("moveend", flat);
    map.easeTo({ pitch: 0, bearing: 0 });
  }, [loadedMap, viewMode]);

  const activeBasemap = useAppSelector((state) => state.map.activeBasemap);
  const sceneBasemap: Basemap =
    basemap ?? activeBasemap ?? BASEMAPS.find((b) => b.value === DEFAULT_BASEMAP) ?? BASEMAPS[0];
  const projectExtrudes = useMemo(
    () => layers.some((l) => l.visible && l.style && extrudes(l.style.document as unknown as JsonObject)),
    [layers],
  );
  // A 3D globe tilts back as it zooms out (flat at zoom 3, the full 85 from zoom 7), so it stays in the middle of the
  // view; the limit only lowers the tilt, and moves with the zoom without stopping a gesture.
  useEffect(() => {
    const map = loadedMap;
    if (!map || viewMode !== "3d") return;
    const limit = () => {
      const max = projection === "globe" ? maxPitchAtZoom(map.getZoom()) : MAX_PITCH_3D;
      if (map.getMaxPitch() !== max) map.setMaxPitch(max);
    };
    limit();
    map.on("zoom", limit);
    return () => {
      map.off("zoom", limit);
      if (map.getMaxPitch() !== MAX_PITCH_3D && shownMode.current === "3d") map.setMaxPitch(MAX_PITCH_3D);
    };
  }, [loadedMap, viewMode, projection]);

  // While the globe is drawn (zoomed out), it sits in the middle of the whole map: padding a zoom to a layer left for
  // the panels is set aside, and given back once the map zooms in past the globe or leaves it.
  const asidePadding = useRef<PaddingOptions | null>(null);
  useEffect(() => {
    const map = loadedMap;
    if (!map) return;
    const centre = () => {
      const globe = projection === "globe" && map.getZoom() < GLOBE_UNTIL_ZOOM;
      const padding = map.getPadding();
      const padded = padding.top || padding.bottom || padding.left || padding.right;
      if (globe && padded) {
        asidePadding.current = { ...padding };
        map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
      } else if (!globe && asidePadding.current) {
        map.setPadding(asidePadding.current);
        asidePadding.current = null;
      }
    };
    centre();
    map.on("zoomend", centre);
    return () => {
      map.off("zoomend", centre);
    };
  }, [loadedMap, projection]);

  const sceneTone = tone ?? toneOf(sceneBasemap, theme.palette.mode);
  const appliedScene = useScene(loadedMap, {
    scene: scene ?? undefined,
    mode: viewMode,
    projection: projection ?? "mercator",
    tone: sceneTone,
    terrainUrl: TERRAIN_TILES_URL,
    buildingsUrl: BUILDINGS_TILES_URL,
    projectExtrudes,
    imagery: isImageryBasemap(sceneBasemap),
    basemap: sceneBasemap,
  });
  // Space around the globe: stars and a halo behind the canvas, which is transparent there. The halo is the globe
  // glow, as strong and in the colour the scene's Globe glow gives at the map's zoom.
  const spaceRef = useRef<HTMLDivElement>(null);
  const globe = projection === "globe";
  const glow = scene?.glow;
  useEffect(() => {
    if (!loadedMap || !globe || !spaceRef.current) return;
    return followGlobe(loadedMap, spaceRef.current, (zoom) =>
      haloOf(glow ? { glow } : undefined, sceneTone, zoom)
    );
  }, [loadedMap, globe, glow, sceneTone]);

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
          // A hover popup lets the pointer through to the map, content and all, so it never catches the pointer it
          // follows.
          ".goat-popup-passive, .goat-popup-passive *": {
            pointerEvents: "none",
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
        {globe && <div ref={spaceRef} aria-hidden style={SPACE_STYLE} />}
        <Map
          {...MAPLIBRE_MAP_OPTIONS}
          id="map"
          ref={mapRef}
          style={{ width: "100%", height: "100%" }}
          initialViewState={initialViewState}
          mapStyle={initialMapStyleRef.current}
          interactiveLayerIds={interactiveLayerIds}
          maxPitch={maxPitch}
          // On the first style load, so the first frame is already a globe (the scene applies it again later).
          projection={{ type: projection ?? "mercator" }}
          dragRotate={camera.dragRotate}
          touchPitch={camera.touchPitch}
          pitchWithRotate={camera.pitchWithRotate}
          touchZoomRotate={touchZoomRotate || viewMode === "3d"}
          attributionControl={false}
          // MapLibre's own UI strings; the canvas is announced by this title.
          locale={{ "Map.Title": t("map") }}
          onMoveStart={handleMoveStart}
          onMoveEnd={handleMoveEnd}
          onMouseOut={handleMouseOut}
          onClick={handleMapClick}
          onTouchStart={handleMapTouchStart}
          onTouchEnd={handleMapTouchEnd}
          onMouseMove={handleMapOverImmediate}
          onMove={_onMove}
          maxBounds={maxExtent}
          minZoom={minZoom}
          maxZoom={maxZoom}
          onLoad={handleMapLoad}
          onError={handleMapError}>
          <DrawControl
            position="top-right"
            displayControlsDefault={false}
            defaultMode={MapboxDraw.constants.modes.SIMPLE_SELECT}
          />
          <StyledLayers
            layers={renderLayers}
            editing={editing}
            locale={locale || i18n.language}
            ground={buildingsAnchor(appliedScene)}
            onLayersChange={setDrawnLayerIds}
            presenceScope={MAP_SCOPE}
          />
          <GeocoderLayer />
          <UserLocationLayer />
          <ToolboxLayers />
          <ExplorerMapLayers />
          <FilterAreaLayer />
          <MeasureLabels />
          {popupInfo && activePopupConfig && (
            <>
              {/* Fixed-anchor popups are rendered by the active layout
                  via <MapFixedPopupSlot>, so they pick up the layout's
                  toolbar / panel positioning the same way Geocoder /
                  ToolboxCtrl / MeasureButton do. Only the in-place
                  variant lives inside <Map>, where it needs useMap to
                  anchor to feature coordinates. A layout that shows the
                  popup in its own drawer (`popupInDrawer`, the published
                  map on a phone) gets none here, but the active-feature
                  pulse below still marks the feature on the map. */}
              {!popupInDrawer && activePopupConfig.layout !== "pinned" && (
                <MapFeaturePopover
                  // A new feature or place puts the popup in place anew; new values for the same place (a raster
                  // click's exact answer) update it, so a press on its close button is not lost between renders. A
                  // hover popup without a feature (a raster's cell, a hexagon) moves with the pointer as one popup.
                  key={
                    highlightedFeature?.id ??
                    (popupInfo.triggeredBy === "hover"
                      ? `hover:${popupInfo.projectLayerId ?? popupInfo.layerId}`
                      : `${popupInfo.projectLayerId ?? popupInfo.layerId}:${popupInfo.lngLat.join(",")}`)
                  }
                  layerId={popupFieldsLayerId(popupInfo.layerId, clickedPopupLayer)}
                  // A file's cell values: numbers in the reader's language, as a feature's are by its fields.
                  fields={popupFields(clickedPopupLayer, clickedFeatureProperties)}
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
                  // A file's hover popup follows the pointer and lets it through to the map; a feature's takes
                  // it, so its buttons and links can be pressed.
                  passive={popupInfo.triggeredBy === "hover" && clickedPopupLayer?.type === "raster"}
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
          {!popupInDrawer &&
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
          {!popupInDrawer && popupEditor && isEditor && (
            <MapPopoverEditor
              key={popupEditor.feature?.id || popupEditor.feature?.properties?.id || v4()}
              {...popupEditor}
            />
          )}
        </Map>
        {cannotStart && (
          <Box
            role="alert"
            sx={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              p: 4,
              bgcolor: "background.default",
            }}>
            <Typography variant="body1" color="text.secondary" textAlign="center">
              {t("view3d.needs_webgl")}
            </Typography>
          </Box>
        )}
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
