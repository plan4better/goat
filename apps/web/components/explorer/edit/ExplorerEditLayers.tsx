/**
 * What editing draws on the map and takes from it, beside the Explorer's own
 * layers (ExplorerMapLayers):
 *
 * - the Stop tool's clicks, under a crosshair, and the stop being placed,
 *   which can be dragged until it is created (board 18);
 * - with Select, the picked stop dragged to move it (board 23): where it
 *   goes, a dashed line from where it was and how far, and the paths through
 *   it as they would run, dotted in their line's colour, until Apply or Cancel;
 * - "Edit stops" and "Edit path" (EditModeLayers): stops added to the line,
 *   or a path dragged off it to reroute it (1.2);
 * - a reroute's handles: one at each point it runs through, and one halfway
 *   between each two on the path as drawn, to drag out another; a point
 *   double-clicked goes. Handles are diamonds, never taken for stops.
 */
import { useTheme } from "@mui/material/styles";
import type { FeatureCollection } from "geojson";
import type { MapGeoJSONFeature, MapLayerMouseEvent } from "maplibre-gl";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Layer, Source, useMap } from "react-map-gl/maplibre";

import { draftPathsStore, previewedStore } from "@/lib/explorer/edit/draftStore";
import { metres } from "@/lib/explorer/edit/ops/geo";
import { mapColor, mapPalette } from "@/lib/explorer/mapPalette";
import { networkStore } from "@/lib/explorer/network";
import { pickedStop, placeStop, setEditDraft } from "@/lib/store/explorer/slice";
import { setMapCursor } from "@/lib/store/map/slice";

import { useDragPoint } from "@/hooks/explorer/useDragPoint";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { EditModeLayers } from "@/components/explorer/edit/EditModeLayers";

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

/** The editing layers, bottom to top: placed above the Explorer's own. */
export const EDIT_DRAW_ORDER = [
  "explorer-draft-paths-old",
  "explorer-draft-paths",
  "explorer-draft-move",
  "explorer-draft-from",
  "explorer-draft-stop-halo",
  "explorer-draft-stop-dot",
  "explorer-draft-move-label",
  "explorer-reroute-band",
  "explorer-reroute-band-point",
  "explorer-reroute-handle",
  "explorer-mode-stop-ring",
  "explorer-mode-band",
  "explorer-mode-band-point",
  "explorer-mode-ghost",
  "explorer-mode-ghost-handle",
];

type LonLat = [number, number];

/** The point halfway along `line`, by its length. */
function halfway(line: LonLat[]): LonLat {
  const legs = line.slice(1).map((q, k) => metres(line[k], q));
  let rest = legs.reduce((a, b) => a + b, 0) / 2;
  for (let k = 0; k < legs.length; k++) {
    if (rest <= legs[k] && legs[k] > 0) {
      const f = rest / legs[k];
      const [p, q] = [line[k], line[k + 1]];
      return [p[0] + f * (q[0] - p[0]), p[1] + f * (q[1] - p[1])];
    }
    rest -= legs[k];
  }
  return line[line.length - 1];
}
/** The vertex of `line` nearest `p`, from `from` on. */
function nearestVertex(line: LonLat[], p: LonLat, from: number): number {
  let best = from;
  for (let k = from; k < line.length; k++) if (metres(line[k], p) < metres(line[best], p)) best = k;
  return best;
}

const pointAt = (coordinates: LonLat, properties: Record<string, unknown>) => ({
  type: "Feature" as const,
  geometry: { type: "Point" as const, coordinates },
  properties,
});

/** The dot a new path is drawn with, one every DOT_SPACING px along it: a
 * signed distance field, so each path tints it with its line's colour. A row
 * of icons, not a dash pattern: the map rescales a pattern between zoom
 * levels, and its dots came out uneven. */
const DOT = "explorer-draft-dot";
const DOT_SPACING = 9;
/** A path's handle (1.2): a diamond, a shape no stop or stop marker has, so
 * a point to drag is not taken for a stop. A distance field as the dot, so
 * it is tinted with the theme's grey (the green is the selection's) and
 * haloed white. */
export const HANDLE = "explorer-reroute-handle-icon";
function handleImage(): { image: ImageData; options: object } {
  // At twice the CSS size: 12 px corner to corner, room round it for the halo.
  const size = 40;
  const r = 12;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const out = (Math.abs(x + 0.5 - size / 2) + Math.abs(y + 0.5 - size / 2) - r) / Math.SQRT2;
      const k = (y * size + x) * 4;
      data[k] = data[k + 1] = data[k + 2] = 255;
      data[k + 3] = Math.max(0, Math.min(255, Math.round((0.75 - out / 8) * 255)));
    }
  return { image: new ImageData(data, size, size), options: { pixelRatio: 2, sdf: true } };
}

function dotImage(): { image: ImageData; options: object } {
  // At twice the CSS size: a dot 5 px across. The edge at 0.75, falling by
  // 1/8 a pixel outward, as the map reads a distance field.
  const size = 24;
  const r = 5;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const out = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) - r;
      const k = (y * size + x) * 4;
      data[k] = data[k + 1] = data[k + 2] = 255;
      data[k + 3] = Math.max(0, Math.min(255, Math.round((0.75 - out / 8) * 255)));
    }
  return { image: new ImageData(data, size, size), options: { pixelRatio: 2, sdf: true } };
}

export function ExplorerEditLayers() {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const theme = useTheme();
  const { current: map } = useMap();
  const editor = useAppSelector((s) => s.explorer.edit.enabled);
  const tool = useAppSelector((s) => s.explorer.edit.tool);
  const lineMode = useAppSelector((s) => !!s.explorer.edit.mode);
  const draft = useAppSelector((s) => s.explorer.edit.draft);
  const picked = useAppSelector((s) => (s.explorer.active ? pickedStop(s.explorer) : null));
  const network = useSyncExternalStore(
    networkStore.subscribe,
    networkStore.getSnapshot,
    networkStore.getSnapshot
  );
  const paths = useSyncExternalStore(
    draftPathsStore.subscribe,
    draftPathsStore.getSnapshot,
    draftPathsStore.getSnapshot
  );
  const placing = draft?.kind === "stop-new" ? draft : null;
  const moving = draft?.kind === "stop-move" ? draft : null;
  // Where the point being dragged is, before it is let go.
  const [dragAt, setDragAt] = useState<LonLat | null>(null);

  // The path being rerouted (begun in "Edit path", EditModeLayers), and the
  // points the reroute runs through.
  const rerouting = draft?.kind === "line-reroute" ? draft : null;
  const ends = rerouting?.ends ?? null;
  const via = useMemo(() => rerouting?.via ?? [], [rerouting]);
  const way = useMemo(() => (ends ? [ends[0], ...via, ends[1]] : []), [ends, via]);
  // A reroute starts from "Edit path" (EditModeLayers); its
  // handles are the reroute's.
  const bendable = editor && tool === "select" && !!ends && !!rerouting;
  // A handle being dragged: where it is, and which (a point `k`, or a new
  // one between points `ins` and `ins + 1` of the way).
  const [bend, setBend] = useState<{ at: LonLat; k?: number; ins?: number } | null>(null);
  // The rerouted path as drawn (the preview's new stretch running from the
  // first stop to the second), and where each point lies on it.
  const guide = useMemo(() => {
    if (!rerouting || !ends) return null;
    let best: LonLat[] | null = null;
    let score = Infinity;
    for (const f of paths?.features ?? []) {
      if (f.properties.kind !== "new" || f.geometry.type !== "LineString") continue;
      const line = f.geometry.coordinates as LonLat[];
      const s = metres(line[0], ends[0]) + metres(line[line.length - 1], ends[1]);
      if (line.length > 1 && s < score) [best, score] = [line, s];
    }
    return best;
  }, [rerouting, ends, paths]);
  const cuts = useMemo(() => {
    if (!guide) return [];
    const at = [0];
    for (const p of via) at.push(nearestVertex(guide, p, at[at.length - 1]));
    return [...at, guide.length - 1];
  }, [guide, via]);
  const handles = useMemo<FeatureCollection>(() => {
    if (!bendable) return EMPTY;
    return {
      type: "FeatureCollection",
      features: [
        ...way.slice(1).map((q, k) => {
          // Halfway along the path as drawn between the two points (along
          // the streets, with Snap); straight while it is being drawn.
          const piece = guide ? guide.slice(cuts[k], cuts[k + 1] + 1) : [];
          return pointAt(halfway(piece.length > 1 ? piece : [way[k], q]), { ins: k, ghost: true });
        }),
        ...via.map((p, k) => pointAt(p, { k, ghost: false })),
      ],
    };
  }, [bendable, way, via, guide, cuts]);
  const band = useMemo<FeatureCollection>(() => {
    if (!bend || !way.length) return EMPTY;
    const [before, after] =
      bend.k !== undefined ? [way[bend.k], way[bend.k + 2]] : [way[bend.ins ?? 0], way[(bend.ins ?? 0) + 1]];
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: [before, bend.at, after] },
          properties: {},
        },
        pointAt(bend.at, {}),
      ],
    };
  }, [bend, way]);
  const grabbedOf = (f?: MapGeoJSONFeature) => {
    const p = (f?.properties ?? {}) as { k?: number; ins?: number; ghost?: boolean };
    return p.ghost ? { ins: Number(p.ins) } : { k: Number(p.k) };
  };
  useDragPoint(
    map?.getMap(),
    ["explorer-reroute-handle"],
    bendable,
    (at, f) => setBend(at && { at, ...grabbedOf(f) }),
    (at, f) => {
      const g = grabbedOf(f);
      if (!rerouting) return;
      const next =
        g.k !== undefined
          ? via.map((p, k) => (k === g.k ? at : p))
          : [...via.slice(0, g.ins), at, ...via.slice(g.ins)];
      dispatch(setEditDraft({ ...rerouting, via: next }));
    }
  );
  // A point double-clicked goes; the last one, and the reroute with it.
  useEffect(() => {
    const raw = map?.getMap();
    if (!raw || !rerouting) return;
    const onDouble = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f || f.properties?.ghost) return;
      e.preventDefault();
      const k = Number(f.properties?.k);
      const next = via.filter((_, j) => j !== k);
      dispatch(setEditDraft(next.length ? { ...rerouting, via: next } : null));
    };
    raw.on("dblclick", "explorer-reroute-handle", onDouble);
    return () => {
      raw.off("dblclick", "explorer-reroute-handle", onDouble);
    };
  }, [map, rerouting, via, dispatch]);

  // The picked stop where the network has it: a stop of its own (not a
  // station), which an editor can drag with Select.
  const pickedAt = useMemo<LonLat | null>(() => {
    if (!picked) return null;
    const f = network.stops.features.find((x) => x.properties.stop_idx === picked.stop_idx);
    return f ? (f.geometry.coordinates as LonLat) : null;
  }, [picked, network.stops]);

  // The Stop tool: a crosshair, and a click places the stop there. The
  // map's cursor is the measure tool's way too: given back on leaving.
  useEffect(() => {
    if (!map || tool !== "stop") return;
    dispatch(setMapCursor("crosshair"));
    const onClick = (e: MapLayerMouseEvent) => dispatch(placeStop({ lon: e.lngLat.lng, lat: e.lngLat.lat }));
    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
      dispatch(setMapCursor(undefined));
    };
  }, [map, tool, dispatch]);

  // The dot of the new paths, there before a path is: asked for only when
  // the map first draws one, the dots came a moment after the path's old
  // parts. Drawn again when the map asks, for a new style that drops it.
  useEffect(() => {
    if (!map) return;
    const raw = map.getMap();
    const add = () => {
      for (const [id, make] of [
        [DOT, dotImage],
        [HANDLE, handleImage],
      ] as const) {
        if (raw.hasImage(id)) continue;
        const { image, options } = make();
        raw.addImage(id, image, options);
      }
    };
    const onMissing = (e: { id: string }) => {
      if (e.id === DOT || e.id === HANDLE) add();
    };
    add();
    raw.on("styleimagemissing", onMissing);
    return () => {
      raw.off("styleimagemissing", onMissing);
    };
  }, [map]);

  // With Select, the picked stop is dragged to move it; not in a line mode,
  // where a press on the map is the mode's (a click and a drag never mean
  // two things).
  useDragPoint(
    map?.getMap(),
    ["explorer-picked-stop-dot", "explorer-picked-stop-halo"],
    editor && tool === "select" && !!picked && !!pickedAt && !moving && !lineMode,
    setDragAt,
    ([lon, lat]) =>
      picked && dispatch(setEditDraft({ kind: "stop-move", stop_idx: picked.stop_idx, lon, lat }))
  );
  // A stop being placed or moved is dragged again where it now is.
  useDragPoint(
    map?.getMap(),
    ["explorer-draft-stop-dot", "explorer-draft-stop-halo"],
    !!placing || !!moving,
    setDragAt,
    ([lon, lat]) => {
      if (placing) dispatch(placeStop({ lon, lat }));
      else if (moving) dispatch(setEditDraft({ ...moving, lon, lat }));
    }
  );

  const at = useMemo<LonLat | null>(
    () => dragAt ?? (placing ? [placing.lon, placing.lat] : moving ? [moving.lon, moving.lat] : null),
    [dragAt, placing, moving]
  );
  // Moving: from where it was, while it is dragged or waits for Apply.
  const from = moving || (dragAt && !placing) ? pickedAt : null;
  const point = useMemo<FeatureCollection>(
    () =>
      at
        ? {
            type: "FeatureCollection",
            features: [{ type: "Feature", geometry: { type: "Point", coordinates: at }, properties: {} }],
          }
        : EMPTY,
    [at]
  );
  const move = useMemo<FeatureCollection>(
    () =>
      at && from
        ? {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: { type: "LineString", coordinates: [from, at] },
                properties: {},
              },
              {
                type: "Feature",
                geometry: { type: "Point", coordinates: at },
                properties: { label: t("explorer_moved_m", { metres: Math.round(metres(from, at)) }) },
              },
            ],
          }
        : EMPTY,
    [at, from, t]
  );
  // Moving, the stop is where it goes: where it was is a hollow ring, the
  // picked stop's own marker set aside meanwhile (board 23).
  useEffect(() => {
    const raw = map?.getMap();
    if (!raw) return;
    const visibility = from ? "none" : "visible";
    for (const id of ["explorer-picked-stop-halo", "explorer-picked-stop-dot"])
      if (raw.getLayer(id)) raw.setLayoutProperty(id, "visibility", visibility);
  }, [map, from]);
  const fromPoint = useMemo<FeatureCollection>(
    () =>
      from
        ? {
            type: "FeatureCollection",
            features: [{ type: "Feature", geometry: { type: "Point", coordinates: from }, properties: {} }],
          }
        : EMPTY,
    [from]
  );

  // The paths as they would run, once the drop is built (not while
  // dragging): dotted in their line's colour, over the path each replaces,
  // drawn here in the network's stead and faint where it is drawn anew.
  // A stop being added to a line shows its paths as a moved one does.
  const shown =
    (!!moving ||
      draft?.kind === "line-stop-add" ||
      draft?.kind === "line-extend" ||
      draft?.kind === "line-new" ||
      draft?.kind === "line-cut" ||
      !!rerouting) &&
    !dragAt &&
    !bend;
  // In the colours the network is drawn in for the basemap under it: a dark
  // line lifted on a dark one, as ExplorerMapLayers draws it.
  const basemap = useAppSelector((s) => s.map.activeBasemap?.value);
  const painted = useMemo(() => {
    const palette = mapPalette(basemap);
    return {
      ...paths,
      features: paths.features.map((f) => ({
        ...f,
        properties: { ...f.properties, color: mapColor(f.properties.color, palette) },
      })),
    };
  }, [paths, basemap]);
  const preview = shown ? painted : EMPTY;
  useEffect(() => {
    previewedStore.set(shown && paths.features.length ? draftPathsStore.replaces() : null);
  }, [shown, paths]);
  useEffect(() => () => previewedStore.set(null), []);

  return (
    <>
      <EditModeLayers />
      <Source key="explorer-draft-paths" id="explorer-draft-paths" type="geojson" data={preview}>
        {/* The old path as the network draws it, faint where it is replaced. */}
        <Layer
          id="explorer-draft-paths-old"
          type="line"
          filter={["!=", ["get", "kind"], "new"]}
          paint={{
            "line-color": ["get", "color"],
            "line-opacity": ["case", ["==", ["get", "kind"], "replaced"], 0.25, 0.9],
            "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.2, 14, 3.5],
          }}
        />
        <Layer
          id="explorer-draft-paths"
          type="symbol"
          filter={["==", ["get", "kind"], "new"]}
          layout={{
            "symbol-placement": "line",
            "symbol-spacing": DOT_SPACING,
            "icon-image": DOT,
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
            "icon-padding": 0,
            "icon-rotation-alignment": "map",
          }}
          paint={{ "icon-color": ["get", "color"] }}
        />
      </Source>
      <Source key="explorer-draft-move" id="explorer-draft-move" type="geojson" data={move}>
        <Layer
          id="explorer-draft-move"
          type="line"
          filter={["==", ["geometry-type"], "LineString"]}
          paint={{
            "line-color": theme.palette.text.secondary,
            "line-width": 1.5,
            "line-dasharray": [2, 2],
          }}
        />
        <Layer
          id="explorer-draft-move-label"
          type="symbol"
          filter={["==", ["geometry-type"], "Point"]}
          layout={{
            "text-field": ["get", "label"],
            "text-font": ["Roboto Bold"],
            "text-size": 11.5,
            "text-offset": [0, 1.6],
            "text-anchor": "top",
            "text-allow-overlap": true,
          }}
          paint={{
            "text-color": theme.palette.text.primary,
            "text-halo-color": theme.palette.background.paper,
            "text-halo-width": 1.5,
          }}
        />
      </Source>
      <Source key="explorer-draft-from" id="explorer-draft-from" type="geojson" data={fromPoint}>
        <Layer
          id="explorer-draft-from"
          type="circle"
          paint={{
            "circle-radius": 5,
            "circle-color": theme.palette.background.paper,
            "circle-opacity": 0.6,
            "circle-stroke-color": theme.palette.text.secondary,
            "circle-stroke-width": 1.5,
          }}
        />
      </Source>
      {/* A path's handle being dragged: straight from the points either side. */}
      <Source key="explorer-reroute-band" id="explorer-reroute-band" type="geojson" data={band}>
        <Layer
          id="explorer-reroute-band"
          type="line"
          filter={["==", ["geometry-type"], "LineString"]}
          paint={{
            "line-color": theme.palette.primary.main,
            "line-width": 2,
            "line-dasharray": [2, 2],
          }}
        />
        <Layer
          id="explorer-reroute-band-point"
          type="symbol"
          filter={["==", ["geometry-type"], "Point"]}
          layout={{ "icon-image": HANDLE, "icon-allow-overlap": true, "icon-ignore-placement": true }}
          paint={{
            "icon-color": theme.palette.secondary.dark,
            "icon-halo-color": "#FFFFFF",
            "icon-halo-width": 3,
          }}
        />
      </Source>
      {/* The path's handles, all alike: each point it runs through, and one
          halfway between each two to drag out another. */}
      <Source
        key="explorer-reroute-handle"
        id="explorer-reroute-handle"
        type="geojson"
        data={bend ? EMPTY : handles}>
        <Layer
          id="explorer-reroute-handle"
          type="symbol"
          layout={{
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
      <Source key="explorer-draft-stop" id="explorer-draft-stop" type="geojson" data={point}>
        {/* As a picked stop, its halo ringed: not in the network yet. */}
        <Layer
          id="explorer-draft-stop-halo"
          type="circle"
          paint={{
            "circle-radius": 16,
            "circle-color": theme.palette.primary.main,
            "circle-opacity": 0.14,
            "circle-stroke-color": theme.palette.primary.main,
            "circle-stroke-width": 1.5,
            "circle-stroke-opacity": 0.6,
          }}
        />
        <Layer
          id="explorer-draft-stop-dot"
          type="circle"
          paint={{
            "circle-radius": 6,
            "circle-color": "#FFFFFF",
            "circle-stroke-color": theme.palette.primary.main,
            "circle-stroke-width": 3,
          }}
        />
      </Source>
    </>
  );
}
