/**
 * The Explorer on the map, drawn by itself whatever GOAT's layers beneath
 * show: the bundle's whole network in its routes' colours (shape_lines
 * tiles, each shape styled from the snapshot), the selected route over it
 * with its stops, the others faded; the network's stops from street level;
 * playback's vehicles (a WebGL layer of their own, vehicleLayer.ts); the
 * stop and the trip the right panel shows.
 * Clicking a vehicle opens its trip, a stop its timetable, a line its route.
 *
 * Rendered inside <Map>, outside the Explorer's provider: it reads what the
 * panels put in the store, and the network and playback stores. Sources are
 * always mounted, in drawing order; layer ids start with `explorer-`, which
 * the layer restack keeps above the data (Layers.tsx).
 */
import { Box, GlobalStyles, ListItemButton, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import type { FeatureCollection, Point, Polygon } from "geojson";
import type { ExpressionSpecification, FilterSpecification, MapLayerMouseEvent } from "maplibre-gl";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Layer, Popup, Source, useMap } from "react-map-gl/maplibre";

import { GEOAPI_BASE_URL } from "@/lib/constants";
import { vehicleFrame } from "@/lib/explorer/derive/vehicles";
import { directionsOnShapes } from "@/lib/explorer/directionChoice";
import { routeMatches } from "@/lib/explorer/filters";
import { highlightStore } from "@/lib/explorer/highlightStore";
import { mapColor, mapPalette } from "@/lib/explorer/mapPalette";
import { tint } from "@/lib/explorer/modes";
import { networkStore, shapeColorExpression } from "@/lib/explorer/network";
import { playbackClock } from "@/lib/explorer/playback";
import {
  closeExplorerPanel,
  openExplorerPanel,
  panelItem,
  pickExplorerPattern,
  pickedStop,
  selectExplorerRoute,
  selectExplorerRouteAt,
} from "@/lib/store/explorer/slice";

import type { RouteRow } from "@/hooks/explorer/useExplorerData";
import { usePatternKey, usePickedTrips } from "@/hooks/explorer/usePickedTrips";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { EXPLORER_PANEL_WIDTH } from "@/components/explorer/ExplorerLeftPanel";
import { RouteBadge } from "@/components/explorer/RouteBadge";
import { directionLabel } from "@/components/explorer/directionWords";
import { EXPLORER_RIGHT_PANEL_WIDTH } from "@/components/explorer/right/panelSize";
import { bottomBarHeight } from "@/components/explorer/strip/stripLayout";
import { VEHICLE_LAYER_ID, VehicleLayer } from "@/components/explorer/vehicleLayer";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
const NO_VEHICLES = vehicleFrame();
const NETWORK = "explorer-network";
/** How close a picked stop is shown: near enough to tell its platforms and
 * the streets round it apart. A station is fitted whole, no closer. */
const STOP_ZOOM = 17;
/** How close a route or one of its patterns is fitted, at most: a short
 * route is shown among its streets, not filling the screen. */
const ROUTE_ZOOM = 15;
/** The arrow drawn along a highlighted pattern, pointing the way it runs:
 * a white chevron, its tip to the right (the line's forward direction). */
const ARROW = "explorer-arrow-2";
function arrowImage(): { image: ImageData; options: object } {
  // At twice the CSS size: a chevron 5 px tall and 2 px thick, inside the
  // highlighted line's 6 px, so it reads white on the line's colour.
  const size = 20;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  ctx.strokeStyle = "#FFFFFF";
  ctx.lineWidth = 3.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(8, 5.5);
  ctx.lineTo(12.5, 10);
  ctx.lineTo(8, 14.5);
  ctx.stroke();
  return { image: ctx.getImageData(0, 0, size, size), options: { pixelRatio: 2 } };
}

/** How close a run's vehicle is flown to: among the streets it runs on. */
const VEHICLE_ZOOM = 15;
/** Room (px) kept between what a fit shows and the panels round it. */
const FIT_ROOM = 32;
/** What the Explorer's panels and controls cover at the map's edges (px):
 * the left panel and the gap after it, the map controls' column at the right
 * (and the right panel, when open, beside it), and under the bottom bar its
 * offset from the map's foot and a gap above it. */
const COVER = {
  top: 10,
  left: EXPLORER_PANEL_WIDTH + 20,
  right: 60,
  rightPanel: EXPLORER_RIGHT_PANEL_WIDTH + 20,
  bar: 50,
};
/** However much the panels cover, a fit keeps this much of the map to fit
 * into: a share of each side, at least so many px. Covering more (a strip
 * dragged tall), the bar's side gives way first: the fit then runs under
 * it rather than zooming far out into a sliver above it. */
const KEEP = { share: 0.3, height: 180, width: 300 };

type Padding = { top: number; bottom: number; left: number; right: number };

/** The map's padding for a fit or a flight: clear of the panels, with `room`
 * more on every side, giving way where they leave too little (KEEP). */
function clearOf(
  map: { getCanvas: () => HTMLCanvasElement },
  { rightPanel, bar }: { rightPanel: boolean; bar: number },
  room = 0
): Padding {
  const { clientWidth: w, clientHeight: h } = map.getCanvas();
  const p = {
    top: COVER.top + room,
    bottom: bar + COVER.bar + room,
    left: COVER.left + room,
    right: (rightPanel ? COVER.rightPanel : 0) + COVER.right + room,
  };
  const tallBy = p.top + p.bottom - (h - Math.max(KEEP.height, h * KEEP.share));
  if (tallBy > 0) p.bottom = Math.max(room, p.bottom - tallBy);
  const wideBy = p.left + p.right - (w - Math.max(KEEP.width, w * KEEP.share));
  if (wideBy > 0) {
    const cut = Math.min(wideBy, p.right - room);
    p.right -= cut;
    p.left = Math.max(room, p.left - (wideBy - cut));
  }
  return p;
}

/** Where a flight's target lands in the padded view, as an offset from the
 * map's centre. A flight given `padding` would keep it on the map, and
 * MapLibre takes the kept padding off every later fit as well as the fit's
 * own: lines and directions were then fitted far too small. */
function offsetFor(p: Padding): [number, number] {
  return [(p.left - p.right) / 2, (p.top - p.bottom) / 2];
}

/** A fit's padding, less what the map already keeps (set elsewhere): the
 * two are added up. */
function fitPadding(map: { getPadding: () => Partial<Padding> }, p: Padding): Padding {
  const kept = map.getPadding();
  return {
    top: Math.max(0, p.top - (kept.top ?? 0)),
    bottom: Math.max(0, p.bottom - (kept.bottom ?? 0)),
    left: Math.max(0, p.left - (kept.left ?? 0)),
    right: Math.max(0, p.right - (kept.right ?? 0)),
  };
}

/** Whether a place is in plain view: inside the padding. */
function inViewOf(
  map: { getCanvas: () => HTMLCanvasElement; project: (ll: [number, number]) => { x: number; y: number } },
  p: Padding,
  [lon, lat]: number[]
): boolean {
  const { x, y } = map.project([lon, lat]);
  const { clientWidth: w, clientHeight: h } = map.getCanvas();
  return x > p.left && x < w - p.right && y > p.top && y < h - p.bottom;
}
/** The Explorer's layers, bottom to top. */
const DRAW_ORDER = [
  "explorer-station-area",
  "explorer-station-edge",
  "explorer-picked-station-area",
  "explorer-network-line",
  "explorer-network-faded",
  "explorer-stop-dot",
  "explorer-route-casing",
  "explorer-route-line",
  "explorer-pattern-casing",
  "explorer-pattern-line",
  "explorer-pattern-section-casing",
  "explorer-pattern-section-line",
  "explorer-pattern-section-arrows",
  "explorer-route-stop",
  "explorer-picked-station-edge",
  VEHICLE_LAYER_ID,
  "explorer-picked-stop-halo",
  "explorer-picked-stop-dot",
  "explorer-route-ends",
];

/** The line chooser's class, and its look: the panels' card. */
const LINE_CHOICE = "explorer-line-choice";
const LINE_CHOICE_SX = {
  [`.${LINE_CHOICE} .maplibregl-popup-content`]: {
    padding: 0,
    borderRadius: "12px",
    boxShadow: "rgba(0, 0, 0, 0.2) 0px 0px 10px",
    overflow: "hidden",
  },
  [`.${LINE_CHOICE} .maplibregl-popup-tip`]: { display: "none" },
};

/** What a click opens, first found first: a vehicle, a stop, a line under
 * the pointer, the station it is in, a line near it. */
const STOP_LAYERS = ["explorer-route-stop", "explorer-stop-dot"];
const LINE_LAYERS = ["explorer-network-line", "explorer-network-faded"];
/** The selected line's own shapes: a click there picks one of its directions. */
const ROUTE_LINE_LAYERS = ["explorer-route-line"];
const STATION_LAYERS = ["explorer-station-area"];

/** How far (px) from the pointer a feature is looked for, nearest first. */
const HIT_RADII = [2, 5, 9];

/** The shape_lines tiles name their layer this. */
const TILE_LAYER = "default";

export function ExplorerMapLayers() {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const active = useAppSelector((s) => s.explorer.active);
  const drawing = useAppSelector((s) => (s.explorer.active ? s.explorer.drawing : null));
  const picked = useAppSelector((s) => (s.explorer.active ? pickedStop(s.explorer) : null));
  const openTrip = useAppSelector((s) => {
    const item = s.explorer.active ? panelItem(s.explorer) : null;
    return item?.kind === "trip" ? item : null;
  });
  const panelOpen = useAppSelector((s) => s.explorer.active && s.explorer.panel.stack.length > 0);
  const selectedRouteId = useAppSelector((s) => (s.explorer.active ? s.explorer.selectedRouteId : null));
  const filters = useAppSelector((s) => s.explorer.filters);
  const playing = useAppSelector((s) => s.explorer.playing);
  // Room the bottom bar takes: the trip strip's under a selected route, and
  // the map's own margin below it.
  const bar = useAppSelector((s) => bottomBarHeight(s.explorer.strip, s.explorer.selectedRouteId !== null));
  // The patterns highlighted over the rest of the route: the Stops tab's
  // line, else what the direction picker chose (highlightedPatterns). As a
  // string from the store, so it changes only when they do.
  const patternKey = usePatternKey();
  const patternIdxs = useMemo(() => (patternKey ? patternKey.split(",").map(Number) : null), [patternKey]);
  // The line's trips shown in full: its vehicles on other patterns fade.
  const pickedTrips = usePickedTrips();
  // The stretch those patterns run, cut from their shapes; until it is in,
  // the shapes themselves stand in.
  const highlight = useSyncExternalStore(highlightStore.subscribe, highlightStore.getSnapshot, () => null);
  const sections = highlight && highlight.key === patternKey ? highlight.sections : null;
  const network = useSyncExternalStore(
    networkStore.subscribe,
    networkStore.getSnapshot,
    networkStore.getSnapshot
  );
  const { current: map } = useMap();
  // A stop or station just picked on the map itself: the map stays where it
  // is for it, as it is in view where it was clicked (02-panel-behaviour-spec
  // › Automatic behaviour). A line is fitted whole however it is picked.
  const onMap = useRef<{ stop?: number }>({});
  const theme = useTheme();
  // Drawn for the basemap under it, light or dark (lib/explorer/mapPalette).
  // In the Explorer the store always holds this project's basemap: the one
  // saved with it, or the theme's (useExplorerBasemap).
  const basemap = useAppSelector((s) => s.map.activeBasemap?.value);
  const palette = mapPalette(basemap);
  // One array for as long as the layer is the same: a new one makes the map
  // replace the source, and with it every shape's styling.
  const networkTiles = useMemo(
    () => [`${GEOAPI_BASE_URL}/collections/${network.shapeLinesLayerId}/tiles/WebMercatorQuad/{z}/{x}/{y}`],
    [network.shapeLinesLayerId]
  );
  // What a click offers to choose from: the lines under it, or the selected
  // line's directions where they share the track.
  const [choice, setChoice] = useState<
    | { lon: number; lat: number; routeIds: string[]; shapeIds?: string[]; directions?: undefined }
    | { lon: number; lat: number; directions: number[]; routeIds?: undefined; shapeIds?: undefined }
    | null
  >(null);
  const pattern = useAppSelector((s) => s.explorer.pattern);
  // The drawing as it is when a click lands, without registering the
  // handlers again for every change of it.
  const drawingNow = useRef(drawing);
  drawingNow.current = drawing;
  // What a click on nothing lets go of, as it is when the click lands.
  const panelShown = useAppSelector((s) => s.explorer.active && s.explorer.panel.stack.length > 0);
  const open = useRef({ choice: false, panel: false, route: false });
  open.current = { choice: choice !== null, panel: panelShown, route: selectedRouteId !== null };

  // Playback's vehicles, drawn by a layer of their own (vehicleLayer.ts).
  // Frames reach it directly, not through React: many a second, and nothing
  // else on the map changes with them. Paused, the map shows the network,
  // not vehicles standing still on it.
  const vehicles = useMemo(() => new VehicleLayer(), []);
  const pushVehicles = () => {
    const frame = playbackClock.getSnapshot();
    vehicles.setFrame(playing ? frame.vehicles : NO_VEHICLES, frame.styles);
  };
  useEffect(() => playbackClock.subscribe(pushVehicles));
  useEffect(pushVehicles);
  useEffect(() => {
    vehicles.setLook({
      selectedRouteId,
      openTrip: openTrip ? { trip_idx: openTrip.trip_idx, run_dep_s: openTrip.run_dep_s } : null,
      ring: theme.palette.primary.main,
      faded: palette.faded,
      pickedTrips,
    });
  }, [vehicles, selectedRouteId, openTrip, theme.palette.primary.main, palette.faded, pickedTrips]);

  // The Explorer's layers in drawing order, bottom to top. Sources mount as
  // their data arrives — the network after the route's stops — and a layer
  // added later lands on top; this puts each back in its place. The
  // vehicles' layer is added here, and again whenever a new basemap style
  // drops it.
  useEffect(() => {
    if (!map || !active) return;
    const raw = map.getMap();
    const order = () => {
      if (!raw.getLayer(VEHICLE_LAYER_ID)) {
        try {
          raw.addLayer(vehicles);
        } catch {
          return; // the style is still loading: the next styledata adds it
        }
      }
      const ids = raw.getLayersOrder().filter((id) => DRAW_ORDER.includes(id));
      const want = DRAW_ORDER.filter((id) => ids.includes(id));
      if (ids.every((id, i) => id === want[i])) return;
      for (const id of want) raw.moveLayer(id);
    };
    order();
    raw.on("styledata", order);
    return () => {
      raw.off("styledata", order);
      if (raw.getLayer(VEHICLE_LAYER_ID)) raw.removeLayer(VEHICLE_LAYER_ID);
    };
  }, [map, active, vehicles]);

  // Shapes faded by the Explorer tab's filter (a mode or an agency left
  // out), as feature-state, which the map keeps for shapes whose tiles are
  // not loaded yet. Only those: their colour is a style expression
  // (shapeColorExpression), and a selected route fades the rest by a layer
  // of its own (explorer-network-faded), so selecting one sets no state at
  // all. With no filter there is none, and a tile loading has none to apply.
  // Only what changed is set again: the shapes faded now.
  const fadedNow = useRef(new Set<string>());
  useEffect(() => {
    if (!map || !active) return;
    const narrowing = filters.modes.length > 0 || filters.agencies.length > 0;
    const apply = () => {
      const was = fadedNow.current;
      // No source, no state: whatever was set went with it.
      if (!map.getSource(NETWORK)) return void was.clear();
      const next = new Set<string>();
      if (narrowing)
        for (const [id, shape] of network.shapes) {
          const shown = shape.route_ids.some((r) => {
            const route = network.routes.get(r);
            return route ? routeMatches(route, filters) : false;
          });
          if (!shown) next.add(id);
        }
      for (const id of was)
        if (!next.has(id)) map.removeFeatureState({ source: NETWORK, sourceLayer: TILE_LAYER, id }, "faded");
      for (const id of next)
        if (!was.has(id))
          map.setFeatureState({ source: NETWORK, sourceLayer: TILE_LAYER, id }, { faded: true });
      fadedNow.current = next;
    };
    apply();
    // Whenever the source is (re)added — after this first runs, or when the
    // style reloads — its features start without state: set it all again.
    const onData = (e: { sourceId?: string; sourceDataType?: string }) => {
      if (e.sourceId === NETWORK && e.sourceDataType === "metadata") {
        fadedNow.current.clear();
        apply();
      }
    };
    map.on("sourcedata", onData);
    return () => {
      map.off("sourcedata", onData);
    };
  }, [map, active, network, filters]);
  const shapeColor = useMemo(
    () => shapeColorExpression(network.shapes, palette.faded, (c) => mapColor(c, palette)),
    [network.shapes, palette]
  );

  // A click opens what it lands on: a vehicle its trip, a stop its
  // timetable, a line its route — where several routes share the shapes
  // under the pointer, they are offered to choose from. Lines, dots and
  // vehicles are a few pixels across, so the pointer need only come near
  // one: the nearest are taken, looking further out only while none is
  // found, so a click in a dense part of the network still finds one thing,
  // not all around it.
  useEffect(() => {
    if (!map || !active) return;
    const near = (point: { x: number; y: number }, layers: string[], radii = HIT_RADII) => {
      const present = layers.filter((l) => map.getLayer(l));
      if (!present.length) return [];
      for (const r of radii) {
        const found = map.queryRenderedFeatures(
          [
            [point.x - r, point.y - r],
            [point.x + r, point.y + r],
          ],
          { layers: present }
        );
        if (found.length) return found;
      }
      return [];
    };
    const vehicleAt = (point: { x: number; y: number }) => {
      for (const r of HIT_RADII) {
        const found = vehicles.hit(point, r);
        if (found) return found;
      }
      return null;
    };
    const onClick = (e: MapLayerMouseEvent) => {
      onMap.current = {};
      const vehicle = vehicleAt(e.point);
      if (vehicle) {
        dispatch(
          openExplorerPanel({
            item: { kind: "trip", trip_idx: vehicle.trip_idx, run_dep_s: vehicle.run_dep_s },
          })
        );
        return;
      }
      const [stop] = near(e.point, STOP_LAYERS);
      if (stop) {
        const [lon, lat] = (stop.geometry as Point).coordinates;
        const p = stop.properties ?? {};
        onMap.current = { stop: Number(p.stop_idx) };
        dispatch(
          openExplorerPanel({
            item: {
              kind: "stop",
              stop: { stop_idx: Number(p.stop_idx), name: String(p.name ?? ""), lon, lat },
            },
            // A stop of the selected route goes when the route does.
            fromRoute: stop.layer.id === "explorer-route-stop" ? selectedRouteId : null,
          })
        );
        return;
      }
      // The selected line itself: one of its directions to pick. Where only
      // one runs under the pointer it is taken; where several share the
      // track they are offered, as overlapping lines are.
      const d = drawingNow.current;
      if (d) {
        const shapes = near(e.point, ROUTE_LINE_LAYERS, HIT_RADII.slice(0, 2)).map((f) =>
          String(f.properties?.shape_id ?? f.id)
        );
        const keys = directionsOnShapes(shapes, d.directions, d.patternShapes);
        if (keys.length === 1) {
          dispatch(pickExplorerPattern({ direction: keys[0], pattern_idx: null }));
          return;
        }
        if (keys.length > 1) {
          setChoice({ lon: e.lngLat.lng, lat: e.lngLat.lat, directions: keys });
          return;
        }
      }
      // A station's area covers the lines through it: a line right under
      // the pointer wins, the station takes the rest of its area.
      // The shapes under the pointer, kept: a route picked by them opens in
      // their direction (selectExplorerRouteAt).
      let clicked: string[] = [];
      const routesOf = (radii: number[]) => {
        clicked = near(e.point, LINE_LAYERS, radii).map((f) => String(f.properties?.shape_id ?? f.id));
        return [...new Set(clicked.flatMap((id) => network.shapes.get(id)?.route_ids ?? []))];
      };
      let routeIds = routesOf(HIT_RADII.slice(0, 1));
      if (!routeIds.length) {
        const [station] = near(e.point, STATION_LAYERS, [0]);
        if (station) {
          const p = station.properties ?? {};
          const ring = (station.geometry as Polygon).coordinates[0] ?? [];
          const mid = (k: 0 | 1) => ring.reduce((sum, c) => sum + c[k], 0) / Math.max(ring.length, 1);
          onMap.current = { stop: Number(p.stop_idx) };
          dispatch(
            openExplorerPanel({
              item: {
                kind: "stop",
                stop: { stop_idx: Number(p.stop_idx), name: String(p.name ?? ""), lon: mid(0), lat: mid(1) },
              },
            })
          );
          return;
        }
        routeIds = routesOf(HIT_RADII);
      }
      if (routeIds.length === 1) {
        dispatch(selectExplorerRouteAt({ routeId: routeIds[0], shapeIds: clicked }));
      } else if (routeIds.length > 1)
        setChoice({ lon: e.lngLat.lng, lat: e.lngLat.lat, routeIds, shapeIds: clicked });
      else dismiss();
    };
    // A click on nothing lets go of what is open, the latest first: the line
    // chooser, then the right panel's stop or trip, then the selected route.
    // A tool holding the cursor (measuring) owns its clicks.
    const dismiss = () => {
      const cursor = map.getCanvas().style.cursor;
      if (cursor !== "" && cursor !== "pointer") return;
      if (open.current.choice) return; // the popup closes itself
      if (open.current.panel) dispatch(closeExplorerPanel());
      else if (open.current.route) dispatch(selectExplorerRoute(null));
    };
    // Registered after the map viewer's own handler, which sets the cursor
    // for GOAT's layers on every move: over anything that opens, this one
    // has the last word, unless a tool (measuring) holds the cursor.
    const all = [...STOP_LAYERS, ...STATION_LAYERS, ...LINE_LAYERS, ...ROUTE_LINE_LAYERS];
    const onMove = (e: MapLayerMouseEvent) => {
      const canvas = map.getCanvas();
      if (canvas.style.cursor === "" && (vehicleAt(e.point) || near(e.point, all).length))
        canvas.style.cursor = "pointer";
    };
    map.on("click", onClick);
    map.on("mousemove", onMove);
    return () => {
      map.off("click", onClick);
      map.off("mousemove", onMove);
    };
  }, [map, active, network, selectedRouteId, dispatch, vehicles]);

  // A picked station is its whole area, as drawn round its stops, not a
  // point in it; a stop or platform is its point.
  // A run picked in the trip strip: its vehicle, if out on the map, flown
  // to, clear of the panels — the trip opens in the right panel with it. In
  // plain view already, it is left where it is; a run not running now has
  // no vehicle to go to.
  const focus = useAppSelector((s) => (s.explorer.active ? s.explorer.focus : null));
  useEffect(() => {
    if (!map || !focus) return;
    const at = vehicles.find(focus.trip_idx, focus.run_dep_s);
    if (!at) return;
    const padding = clearOf(map, { rightPanel: true, bar });
    if (
      inViewOf(map, clearOf(map, { rightPanel: true, bar }, FIT_ROOM), [at.lon, at.lat]) &&
      map.getZoom() >= VEHICLE_ZOOM
    )
      return;
    map.flyTo({
      center: [at.lon, at.lat],
      zoom: Math.max(map.getZoom(), VEHICLE_ZOOM),
      offset: offsetFor(padding),
      duration: 1000,
    });
    // Playing, the vehicle runs on while the map flies: landed, the map
    // catches up with where it is now.
    const settle = () => {
      const now = vehicles.find(focus.trip_idx, focus.run_dep_s);
      if (now) map.easeTo({ center: [now.lon, now.lat], offset: offsetFor(padding), duration: 300 });
    };
    map.once("moveend", settle);
    return () => {
      map.off("moveend", settle);
    };
    // Only when asked again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, focus]);

  const pickedArea = useMemo(
    () =>
      picked
        ? (network.stations.features.find((f) => f.properties.stop_idx === picked.stop_idx) ?? null)
        : null,
    [picked, network.stations]
  );
  const pickedAreaData = useMemo<FeatureCollection>(
    () => (pickedArea ? { type: "FeatureCollection", features: [pickedArea] } : EMPTY),
    [pickedArea]
  );
  const pickedPoint = useMemo<FeatureCollection>(
    () =>
      !pickedArea && picked && picked.lon !== null && picked.lat !== null
        ? {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: { type: "Point", coordinates: [picked.lon, picked.lat] },
                properties: { name: picked.name },
              },
            ],
          }
        : EMPTY,
    [picked, pickedArea]
  );

  // Fly to a picked stop, clear of the panels, close enough to see it
  // (STOP_ZOOM), never out from a closer look; a station is fitted whole.
  // One already in plain view at street level (clicked on the map) is left
  // where it is.
  useEffect(() => {
    if (!map || !picked) return;
    if (onMap.current.stop === picked.stop_idx) {
      onMap.current = {};
      return;
    }
    const cover = { rightPanel: panelOpen, bar };
    const padding = clearOf(map, cover);
    const roomy = clearOf(map, cover, FIT_ROOM);
    const inView = (c: number[]) => inViewOf(map, roomy, c);
    if (pickedArea) {
      const ring = pickedArea.geometry.coordinates[0] ?? [];
      if (!ring.length) return;
      if (ring.every(inView) && map.getZoom() >= 16) return;
      const lons = ring.map((c) => c[0]);
      const lats = ring.map((c) => c[1]);
      map.fitBounds(
        [
          [Math.min(...lons), Math.min(...lats)],
          [Math.max(...lons), Math.max(...lats)],
        ],
        { maxZoom: STOP_ZOOM, padding: fitPadding(map, roomy) }
      );
      return;
    }
    if (picked.lon === null || picked.lat === null) return;
    if (inView([picked.lon, picked.lat]) && map.getZoom() >= 16) return;
    map.flyTo({
      center: [picked.lon, picked.lat],
      zoom: Math.max(map.getZoom(), STOP_ZOOM),
      offset: offsetFor(padding),
    });
    // Only when another stop is picked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, picked, pickedArea]);

  // The arrows along a highlighted pattern, drawn when the map asks for
  // them, so a new style that drops them draws them again.
  useEffect(() => {
    if (!map) return;
    const raw = map.getMap();
    const onMissing = (e: { id: string }) => {
      if (raw.hasImage(e.id)) return;
      if (e.id !== ARROW) return;
      const { image, options } = arrowImage();
      raw.addImage(e.id, image, options);
    };
    raw.on("styleimagemissing", onMissing);
    return () => {
      raw.off("styleimagemissing", onMissing);
    };
  }, [map]);

  // The selected line's ends, named on the map: where its directions start
  // and end, or, with patterns highlighted, where those start and end. A
  // name shared by two ends (both directions' termini) is named once.
  const ends = useMemo<FeatureCollection>(() => {
    if (!drawing) return EMPTY;
    const ids = new Set<number>();
    for (const p of patternIdxs ?? drawing.directions.map((d) => d.key)) {
      const e = drawing.patternEnds?.[p];
      if (e) e.forEach((i) => ids.add(i));
    }
    const named = new Set<string>();
    const features: FeatureCollection["features"] = [];
    for (const s of drawing.stops) {
      if (!ids.has(s.stop_idx) || !s.name || named.has(s.name)) continue;
      named.add(s.name);
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        properties: { name: s.name },
      });
    }
    return { type: "FeatureCollection", features };
  }, [drawing, patternIdxs]);

  const stops = useMemo<FeatureCollection>(
    () => ({
      type: "FeatureCollection",
      features: (drawing?.stops ?? []).map((s) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        properties: { stop_idx: s.stop_idx, name: s.name },
      })),
    }),
    [drawing?.stops]
  );
  // Fit the view to the network on opening, clear of the left panel and the
  // bottom bar.
  const bounds = useAppSelector((s) => (s.explorer.active ? s.explorer.bounds : null));
  useEffect(() => {
    if (!map || !bounds) return;
    map.fitBounds(
      [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ],
      { padding: fitPadding(map, clearOf(map, { rightPanel: false, bar }, FIT_ROOM)), maxZoom: 14 }
    );
    // Once, on opening: not again when the bottom bar changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, bounds]);

  // Fit the view to the highlighted patterns when they change, clear of the
  // panels and the bottom bar.
  useEffect(() => {
    const boxes = (patternIdxs ?? []).map((i) => drawing?.patternBounds?.[i]).filter((x) => !!x);
    if (!map || !boxes.length) return;
    const b = [
      Math.min(...boxes.map((x) => x[0])),
      Math.min(...boxes.map((x) => x[1])),
      Math.max(...boxes.map((x) => x[2])),
      Math.max(...boxes.map((x) => x[3])),
    ];
    map.fitBounds(
      [
        [b[0], b[1]],
        [b[2], b[3]],
      ],
      {
        padding: fitPadding(map, clearOf(map, { rightPanel: panelOpen, bar }, FIT_ROOM)),
        maxZoom: ROUTE_ZOOM,
      }
    );
    // Only when other patterns are chosen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, patternIdxs, drawing?.routeId]);

  // A map pick that moved nothing (the stop already open) is not kept for a
  // later pick of the same from a panel.
  useEffect(() => {
    if (!picked && onMap.current.stop !== undefined) onMap.current = {};
  }, [picked]);

  // Fit the view to a route when it is selected, clear of the panels.
  useEffect(() => {
    if (!map || !drawing?.stops.length) return;
    const lons = drawing.stops.map((s) => s.lon);
    const lats = drawing.stops.map((s) => s.lat);
    map.fitBounds(
      [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ],
      {
        padding: fitPadding(map, clearOf(map, { rightPanel: panelOpen, bar }, FIT_ROOM)),
        maxZoom: ROUTE_ZOOM,
      }
    );
    // Only when another route is chosen, not on every update of the same one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, drawing?.routeId]);

  if (!active) return null;
  const color = mapColor(drawing?.color ?? theme.palette.primary.main, palette);
  const selectedShapes: FilterSpecification = [
    "in",
    ["get", "shape_id"],
    ["literal", drawing?.shapeIds ?? []],
  ];
  // With patterns picked, the rest of the route steps back for them.
  const highlighting = patternIdxs !== null && !!drawing;
  // All of them in one direction: their arrows say which way it runs.
  const oneWay =
    highlighting &&
    !!drawing?.directions.some((d) => (patternIdxs ?? []).every((p) => d.patterns.includes(p)));
  const patternShapes: FilterSpecification = [
    "in",
    ["get", "shape_id"],
    ["literal", [...new Set((patternIdxs ?? []).flatMap((i) => drawing?.patternShapes[i] ?? []))]],
  ];
  const none: FilterSpecification = ["boolean", false];
  const all: FilterSpecification = ["boolean", true];
  const faded: ExpressionSpecification = ["boolean", ["feature-state", "faded"], false];
  // Every line faded: a route selected, or only stops listed.
  const allFaded = !!selectedRouteId || (filters.types.length === 1 && filters.types[0] === "stops");

  return (
    <>
      <GlobalStyles styles={LINE_CHOICE_SX} />
      {network.shapeLinesLayerId && (
        <Source
          key={NETWORK}
          id={NETWORK}
          type="vector"
          tiles={networkTiles}
          promoteId="shape_id"
          maxzoom={14}>
          {/* Every line in its route's colour; faded ones grey and thin.
              With patterns highlighted, the selected route's own lines are
              left to the route's layers above, faded there for them. */}
          <Layer
            id="explorer-network-line"
            type="line"
            source-layer={TILE_LAYER}
            filter={highlighting ? ["!", selectedShapes] : all}
            // Light to draw: a network's many shapes overlap on every street,
            // and the map keeps vertices for each in every tile. Plain joins
            // and caps (round ones add a fan of triangles at every vertex),
            // and only the colour per shape (each per-shape paint property
            // keeps an array per vertex): a shape faded by the filter is a
            // pale colour, at the same width. Round, data-driven lines had
            // Berlin's heap past 900 MB zoomed in and out (23 Oct 2026).
            layout={{ visibility: allFaded ? "none" : "visible" }}
            paint={{
              "line-color": ["case", faded, palette.filtered, shapeColor] as ExpressionSpecification,
              "line-opacity": 0.9,
              "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.2, 14, 3.5],
            }}
          />
          {/* The whole network faded, in place of the layer above while a
              route is selected or only stops are listed: one switch of
              which layer shows, not a state for every shape. */}
          <Layer
            id="explorer-network-faded"
            type="line"
            source-layer={TILE_LAYER}
            filter={highlighting ? ["!", selectedShapes] : all}
            layout={{ visibility: allFaded ? "visible" : "none" }}
            paint={{
              "line-color": palette.faded,
              "line-opacity": 0.35,
              "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.6, 14, 1.5],
            }}
          />
          {/* The selected route over the rest, on a casing of the map's
              ground: white on a light basemap, near-black on the dark. */}
          <Layer
            id="explorer-route-casing"
            type="line"
            source-layer={TILE_LAYER}
            filter={selectedShapes}
            layout={{ "line-cap": "round", "line-join": "round" }}
            paint={{ "line-color": palette.ground, "line-width": 8 }}
          />
          <Layer
            id="explorer-route-line"
            type="line"
            source-layer={TILE_LAYER}
            filter={selectedShapes}
            layout={{ "line-cap": "round", "line-join": "round" }}
            // Faded for highlighted patterns by a paler colour, not by
            // transparency: a route's many shapes lie over each other, and
            // see-through lines would add up to solid again.
            paint={{
              "line-color": highlighting ? tint(color, 0.3, palette.ground) : color,
              "line-width": highlighting ? 3.5 : 4.5,
            }}
          />
          <Layer
            id="explorer-pattern-casing"
            type="line"
            source-layer={TILE_LAYER}
            filter={highlighting && !sections ? patternShapes : none}
            layout={{ "line-cap": "round", "line-join": "round" }}
            paint={{ "line-color": palette.ground, "line-width": 10 }}
          />
          <Layer
            id="explorer-pattern-line"
            type="line"
            source-layer={TILE_LAYER}
            filter={highlighting && !sections ? patternShapes : none}
            layout={{ "line-cap": "round", "line-join": "round" }}
            paint={{ "line-color": color, "line-width": 6 }}
          />
        </Source>
      )}
      {/* The highlighted patterns' own stretch of line, over the faded route. */}
      <Source
        key="explorer-pattern-sections"
        id="explorer-pattern-sections"
        type="geojson"
        data={highlighting && sections ? sections : EMPTY}>
        <Layer
          id="explorer-pattern-section-casing"
          type="line"
          layout={{ "line-cap": "round", "line-join": "round" }}
          paint={{ "line-color": palette.ground, "line-width": 10 }}
        />
        <Layer
          id="explorer-pattern-section-line"
          type="line"
          layout={{ "line-cap": "round", "line-join": "round" }}
          paint={{ "line-color": color, "line-width": 6 }}
        />
        {/* Which way it runs: each section is cut in the direction its
            trips travel, so arrows along it point that way. Only for one
            direction's patterns: with both, the arrows would point both
            ways along the same street and say nothing. */}
        <Layer
          id="explorer-pattern-section-arrows"
          type="symbol"
          filter={oneWay ? all : none}
          layout={{
            "symbol-placement": "line",
            "symbol-spacing": 70,
            "icon-image": ARROW,
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
            "icon-rotation-alignment": "map",
          }}
        />
      </Source>
      {/* Each station as a faint area round its stops, under the lines:
          clicked, the timetable of all its stops. */}
      <Source key="explorer-stations" id="explorer-stations" type="geojson" data={network.stations}>
        <Layer
          id="explorer-station-area"
          type="fill"
          minzoom={14}
          paint={{
            "fill-color": palette.stop,
            "fill-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0, 15, selectedRouteId ? 0.1 : 0.16],
          }}
        />
        <Layer
          id="explorer-station-edge"
          type="line"
          minzoom={14}
          paint={{
            "line-color": palette.stop,
            "line-width": 1,
            "line-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0, 15, selectedRouteId ? 0.3 : 0.55],
          }}
        />
      </Source>
      {/* The network's stops from street level, to click for a timetable:
          a grey dot in a ring of the map's ground (StopMarker's, on white). */}
      <Source key="explorer-stops" id="explorer-stops" type="geojson" data={network.stops}>
        <Layer
          id="explorer-stop-dot"
          type="circle"
          minzoom={13}
          paint={{
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 2, 16, 4],
            "circle-color": palette.stop,
            "circle-stroke-color": palette.stopRing,
            "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 13, 1, 16, 2],
            "circle-opacity": selectedRouteId ? 0.6 : 1,
            "circle-stroke-opacity": selectedRouteId ? 0.6 : 1,
          }}
        />
      </Source>
      <Source key="explorer-route-stops" id="explorer-route-stops" type="geojson" data={stops}>
        <Layer
          id="explorer-route-stop"
          type="circle"
          paint={{
            "circle-radius": 5,
            "circle-color": "#FFFFFF",
            "circle-stroke-color": color,
            "circle-stroke-width": 2.5,
          }}
        />
      </Source>
      {/* A picked station: its area tinted, under the lines, and edged in
          the theme's colour above them. */}
      <Source key="explorer-picked-station" id="explorer-picked-station" type="geojson" data={pickedAreaData}>
        <Layer
          id="explorer-picked-station-area"
          type="fill"
          paint={{ "fill-color": theme.palette.primary.main, "fill-opacity": 0.16 }}
        />
        <Layer
          id="explorer-picked-station-edge"
          type="line"
          paint={{ "line-color": theme.palette.primary.main, "line-width": 2.5 }}
        />
      </Source>
      <Source key="explorer-picked-stop" id="explorer-picked-stop" type="geojson" data={pickedPoint}>
        <Layer
          id="explorer-picked-stop-halo"
          type="circle"
          paint={{ "circle-radius": 14, "circle-color": theme.palette.primary.main, "circle-opacity": 0.2 }}
        />
        <Layer
          id="explorer-picked-stop-dot"
          type="circle"
          paint={{
            "circle-radius": 6,
            "circle-color": "#FFFFFF",
            "circle-stroke-color": theme.palette.primary.main,
            "circle-stroke-width": 3,
          }}
        />
      </Source>
      <Source key="explorer-route-ends" id="explorer-route-ends" type="geojson" data={ends}>
        <Layer
          id="explorer-route-ends"
          type="symbol"
          layout={{
            "text-field": ["get", "name"],
            "text-font": ["Roboto Bold"],
            "text-size": 11.5,
            // Beside the stop, wherever there is room; always shown: the
            // ends say which way the line runs.
            "text-variable-anchor": ["top", "bottom", "left", "right"],
            "text-radial-offset": 1,
            "text-justify": "auto",
            "text-allow-overlap": true,
            "text-max-width": 12,
          }}
          paint={{
            "text-color": palette.label,
            "text-halo-color": palette.ground,
            "text-halo-width": 2,
          }}
        />
      </Source>
      {choice?.directions && drawing && (
        // The selected line's directions under the click, as the lines are
        // offered below: the one shown marked.
        <Popup
          longitude={choice.lon}
          latitude={choice.lat}
          closeOnClick
          closeButton={false}
          offset={10}
          className={LINE_CHOICE}
          onClose={() => setChoice(null)}
          maxWidth="280px">
          <Box sx={{ py: 1, minWidth: 220 }}>
            <Typography
              variant="caption"
              color="text.secondary"
              fontWeight={600}
              display="block"
              sx={{ px: 1.5, pb: 0.5 }}>
              {t("explorer_directions_here", { count: choice.directions.length })}
            </Typography>
            {choice.directions.map((key) => {
              const dir = drawing.directions.find((x) => x.key === key);
              const r = network.routes.get(drawing.routeId);
              if (!dir || !r) return null;
              const shown = (pattern?.direction ?? drawing.directions[0]?.key) === key;
              return (
                <ListItemButton
                  key={key}
                  dense
                  selected={shown}
                  onClick={() => {
                    dispatch(pickExplorerPattern({ direction: key, pattern_idx: null }));
                    setChoice(null);
                  }}
                  sx={{ px: 1.5, gap: 1.25, minHeight: 34 }}>
                  <RouteBadge route={r as unknown as RouteRow} small />
                  <Typography variant="body2" fontWeight={shown ? 700 : 400} noWrap>
                    {directionLabel(dir.name, t)}
                  </Typography>
                </ListItemButton>
              );
            })}
          </Box>
        </Popup>
      )}
      {choice?.routeIds && (
        // The panels' card, not MapLibre's bubble (styles in LINE_CHOICE_SX).
        <Popup
          longitude={choice.lon}
          latitude={choice.lat}
          closeOnClick
          closeButton={false}
          offset={10}
          className={LINE_CHOICE}
          onClose={() => setChoice(null)}
          maxWidth="280px">
          <Box sx={{ py: 1, minWidth: 220 }}>
            <Typography
              variant="caption"
              color="text.secondary"
              fontWeight={600}
              display="block"
              sx={{ px: 1.5, pb: 0.5 }}>
              {t("explorer_lines_here", { count: choice.routeIds.length })}
            </Typography>
            {choice.routeIds.map((id) => {
              const r = network.routes.get(id);
              if (!r) return null;
              return (
                <ListItemButton
                  key={id}
                  dense
                  onClick={() => {
                    dispatch(selectExplorerRouteAt({ routeId: id, shapeIds: choice.shapeIds ?? [] }));
                    setChoice(null);
                  }}
                  sx={{ px: 1.5, gap: 1.25, minHeight: 34 }}>
                  <RouteBadge route={r as unknown as RouteRow} small />
                  <Typography variant="body2" noWrap>
                    {r.long_name || r.short_name || r.route_id}
                  </Typography>
                </ListItemButton>
              );
            })}
          </Box>
        </Popup>
      )}
    </>
  );
}
