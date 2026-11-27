/**
 * The line modes on the map (decided 26 Nov 2026: two, so a click and a drag
 * never mean two things), for the line the resolver hands over (modeStore).
 * With nothing else being edited, the pointer on the line shows the path it
 * is on, between two stops, and a point on the line under it.
 *
 * "Edit stops":
 * - a click there offers a stop added to the line between the two (3.1,
 *   LineContextMenu): one there is, picked next, nearest first, or a new one
 *   at the point, named and created first, then added (two edits, each
 *   applied on its own);
 * - the stop under the pointer is ringed, and a click on it offers what can
 *   be done to it on the line: off the line, the line ended or started
 *   there, and at either end, the line run on from it (1.3, 1.4, 3.2).
 *
 * "Edit path": the point is a reroute's handle (a diamond), and a drag from
 * there reroutes the path (1.2), the reroute's own handles taking over once
 * let go. Stops are passed over: only the line is edited.
 *
 * The Explorer's own clicks stand down meanwhile (ExplorerMapLayers).
 */
import { useTheme } from "@mui/material/styles";
import type { FeatureCollection } from "geojson";
import type { MapGeoJSONFeature, MapLayerMouseEvent } from "maplibre-gl";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Layer, Source, useMap } from "react-map-gl/maplibre";

import { type PatternPath, stretchAt } from "@/lib/explorer/derive/path";
import { modeStore } from "@/lib/explorer/edit/modeStore";
import { selectionStore } from "@/lib/explorer/selectionStore";
import { openExplorerLineMenu, setEditDraft, setExplorerPath } from "@/lib/store/explorer/slice";

import { useDragPoint } from "@/hooks/explorer/useDragPoint";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { HANDLE } from "@/components/explorer/edit/ExplorerEditLayers";

type LonLat = [number, number];
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

/** How near the line the pointer is on it, in pixels. */
const ON_LINE_PX = 10;
/** How near a stop of the line's centre the pointer is on it, in pixels:
 * its marker (radius 5, a 2.5 ring) and room to hit it without aiming. The
 * stop under the pointer is ringed, so what a click takes is seen. */
const ON_STOP_PX = 11;

/** Metres a pixel spans at `lat` and the map's zoom (512 px tiles). */
function metresPerPixel(lat: number, zoom: number): number {
  return (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / 2 ** (zoom + 9);
}

type Hover = PatternPath & { at: LonLat };

export function EditModeLayers() {
  const theme = useTheme();
  const dispatch = useAppDispatch();
  const { current: map } = useMap();
  const on = useAppSelector((s) => s.explorer.active && !!s.explorer.edit.mode);
  const kind = useAppSelector((s) => s.explorer.edit.mode?.kind ?? null);
  const busy = useAppSelector((s) => !!s.explorer.edit.draft || !!s.explorer.lineMenu);
  const mode = useSyncExternalStore(modeStore.subscribe, modeStore.getSnapshot, () => null);
  const [hover, setHover] = useState<Hover | null>(null);
  // The line's stop under the pointer (Edit stops), ringed.
  const [stopAt, setStopAt] = useState<LonLat | null>(null);
  const [dragAt, setDragAt] = useState<LonLat | null>(null);
  const live = on && !!mode && !busy;
  // The latest, for the map's handlers.
  const now = useRef({ mode, hover, live, kind, dragging: false });
  now.current = { ...now.current, mode, hover, live, kind };

  // The path under the pointer, and the point on it; on one of the line's
  // stops, the stop is what is pointed at (a click opens its menu).
  useEffect(() => {
    const raw = map?.getMap();
    if (!raw || !live) {
      setHover(null);
      setStopAt(null);
      setDragAt(null);
      now.current.dragging = false;
      return;
    }
    const lineStop = (e: MapLayerMouseEvent, px: number) => {
      const m = now.current.mode;
      if (!m || !raw.getLayer("explorer-route-stop")) return null;
      const box: [[number, number], [number, number]] = [
        [e.point.x - px, e.point.y - px],
        [e.point.x + px, e.point.y + px],
      ];
      const ids = new Set(m.line.stops.map((s) => s.stop_idx));
      // On the marker itself: within `px` of its centre, the nearest.
      let best: { f: MapGeoJSONFeature; d: number } | null = null;
      for (const f of raw.queryRenderedFeatures(box, { layers: ["explorer-route-stop"] })) {
        if (!ids.has(Number(f.properties?.stop_idx)) || f.geometry.type !== "Point") continue;
        const at = raw.project(f.geometry.coordinates as LonLat);
        const d = Math.hypot(at.x - e.point.x, at.y - e.point.y);
        if (d <= px && (!best || d < best.d)) best = { f, d };
      }
      return best?.f ?? null;
    };
    const onMove = (e: MapLayerMouseEvent) => {
      const m = now.current.mode;
      // Held while a button is down: a press on the line keeps the path it
      // was on until it is let go, however the pointer wanders first.
      if (!m || now.current.dragging || e.originalEvent.buttons & 1) return;
      const canvas = raw.getCanvas();
      const stops = now.current.kind === "stops";
      const stop = stops ? lineStop(e, ON_STOP_PX) : null;
      setStopAt(stop && stop.geometry.type === "Point" ? (stop.geometry.coordinates as LonLat) : null);
      if (stop) {
        setHover(null);
        canvas.style.cursor = "pointer";
        return;
      }
      const found = stretchAt(m.line, e.lngLat.lng, e.lngLat.lat);
      if (found.off > ON_LINE_PX * metresPerPixel(e.lngLat.lat, raw.getZoom())) {
        setHover(null);
        if (canvas.style.cursor === "copy" || canvas.style.cursor === "grab") canvas.style.cursor = "";
        return;
      }
      const { off: _off, ...path } = found;
      setHover(path);
      canvas.style.cursor = stops ? "copy" : "grab";
    };
    const onClick = (e: MapLayerMouseEvent) => {
      const m = now.current.mode;
      // A click edits stops only; the path is dragged.
      if (!m || now.current.kind !== "stops") return;
      const stop = lineStop(e, ON_STOP_PX);
      if (stop) {
        dispatch(
          openExplorerLineMenu({
            x: e.originalEvent.clientX,
            y: e.originalEvent.clientY,
            lon: e.lngLat.lng,
            lat: e.lngLat.lat,
            stop_idx: Number(stop.properties?.stop_idx),
          })
        );
        return;
      }
      // On the line: a stop there is, or a new one (LineContextMenu), at
      // the point on the line under the pointer.
      const h = now.current.hover;
      if (!h) return;
      dispatch(
        openExplorerLineMenu({
          x: e.originalEvent.clientX,
          y: e.originalEvent.clientY,
          lon: h.at[0],
          lat: h.at[1],
          stop_idx: null,
        })
      );
      setHover(null);
    };
    const onLeave = () => {
      setStopAt(null);
      if (!now.current.dragging) setHover(null);
    };
    raw.on("mousemove", onMove);
    raw.on("click", onClick);
    raw.on("mouseout", onLeave);
    return () => {
      raw.off("mousemove", onMove);
      raw.off("click", onClick);
      raw.off("mouseout", onLeave);
      // The mode's cursors go with it.
      const canvas = raw.getCanvas();
      if (canvas.style.cursor === "copy" || canvas.style.cursor === "grab") canvas.style.cursor = "";
    };
  }, [map, live, dispatch]);

  // The path pointed at, drawn as a selected one is.
  useEffect(() => {
    selectionStore.set(hover ? [{ type: "LineString", coordinates: hover.line }] : null);
  }, [hover]);
  useEffect(() => () => selectionStore.set(null), []);

  // Dragged off the line: the path rerouted through where it is let go.
  useDragPoint(
    map?.getMap(),
    ["explorer-mode-ghost-handle"],
    // On for the whole mode: switched off mid-press, a drag never landed.
    live && kind === "path",
    (at) => {
      now.current.dragging = !!at;
      setDragAt(at);
    },
    (at) => {
      now.current.dragging = false;
      setDragAt(null);
      const h = now.current.hover;
      const m = now.current.mode;
      if (!h || !m || h.line.length < 2) return;
      const { at: _at, line: _line, ...path } = h;
      // Named in the reroute's panel.
      dispatch(setExplorerPath(path));
      dispatch(
        setEditDraft({
          kind: "line-reroute",
          a: h.from_stop,
          b: h.to_stop,
          ends: [h.line[0], h.line[h.line.length - 1]],
          via: [at],
          scope: { ...m.scope, pattern_idx: h.pattern_idx },
        })
      );
      setHover(null);
    }
  );

  const ghost = useMemo<FeatureCollection>(
    () =>
      hover && !dragAt
        ? {
            type: "FeatureCollection",
            features: [
              { type: "Feature", geometry: { type: "Point", coordinates: hover.at }, properties: {} },
            ],
          }
        : EMPTY,
    [hover, dragAt]
  );
  const band = useMemo<FeatureCollection>(
    () =>
      hover && dragAt && hover.line.length > 1
        ? {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: {
                  type: "LineString",
                  coordinates: [hover.line[0], dragAt, hover.line[hover.line.length - 1]],
                },
                properties: {},
              },
              { type: "Feature", geometry: { type: "Point", coordinates: dragAt }, properties: {} },
            ],
          }
        : EMPTY,
    [hover, dragAt]
  );

  const ring = useMemo<FeatureCollection>(
    () =>
      stopAt
        ? {
            type: "FeatureCollection",
            features: [{ type: "Feature", geometry: { type: "Point", coordinates: stopAt }, properties: {} }],
          }
        : EMPTY,
    [stopAt]
  );

  return (
    <>
      {/* The stop a click takes: ringed in the theme's green. */}
      <Source key="explorer-mode-stop-ring" id="explorer-mode-stop-ring" type="geojson" data={ring}>
        <Layer
          id="explorer-mode-stop-ring"
          type="circle"
          paint={{
            "circle-radius": 10,
            "circle-color": "transparent",
            "circle-stroke-color": theme.palette.primary.main,
            "circle-stroke-width": 2,
          }}
        />
      </Source>
      {/* Dragged off the line: straight from the stops either side. */}
      <Source key="explorer-mode-band" id="explorer-mode-band" type="geojson" data={band}>
        <Layer
          id="explorer-mode-band"
          type="line"
          filter={["==", ["geometry-type"], "LineString"]}
          paint={{ "line-color": theme.palette.primary.main, "line-width": 2, "line-dasharray": [2, 2] }}
        />
        <Layer
          id="explorer-mode-band-point"
          type="circle"
          filter={["==", ["geometry-type"], "Point"]}
          paint={{
            "circle-radius": 5,
            "circle-color": theme.palette.background.paper,
            "circle-stroke-color": theme.palette.primary.main,
            "circle-stroke-width": 2,
          }}
        />
      </Source>
      {/* The point on the line under the pointer: where a click adds a stop
          (a stop's ring), or the handle a drag reroutes by (the reroute's
          diamond). */}
      <Source key="explorer-mode-ghost" id="explorer-mode-ghost" type="geojson" data={ghost}>
        <Layer
          id="explorer-mode-ghost"
          type="circle"
          layout={{ visibility: kind === "stops" ? "visible" : "none" }}
          paint={{
            "circle-radius": 6,
            "circle-color": theme.palette.background.paper,
            "circle-stroke-color": theme.palette.primary.main,
            "circle-stroke-width": 2,
          }}
        />
        <Layer
          id="explorer-mode-ghost-handle"
          type="symbol"
          layout={{
            visibility: kind === "path" ? "visible" : "none",
            "icon-image": HANDLE,
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
          }}
          paint={{
            "icon-color": theme.palette.secondary.dark,
            "icon-halo-color": "#FFFFFF",
            "icon-halo-width": 3,
          }}
        />
      </Source>
    </>
  );
}
