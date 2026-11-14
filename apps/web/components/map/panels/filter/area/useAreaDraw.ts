// Drawing a shape for an area with a map's own draw tool, or editing one: a copy of the shape is loaded into the tool
// and read back once it is finished. On the project's map, measuring and feature editing draw with the same tool, so a
// shape is only started or edited there while neither is active, and only the one shape started or loaded here is ever
// read or deleted: their features stay where they are. A dialog's own map draws only its area.
import MapboxDraw from "@mapbox/mapbox-gl-draw";
import bearing from "@turf/bearing";
import distance from "@turf/distance";
import { useCallback, useEffect, useRef, useState } from "react";
import { type MapRef, useMap } from "react-map-gl/maplibre";
import { useStore } from "react-redux";

import { SHOWN_MIDPOINTS_ID, generateCirclePolygon } from "@p4b/draw";

import { type PolygonCoords, type Position, geometryPolygons, roundPolygons } from "@/lib/filter/area";
import { useDraw } from "@/lib/providers/DrawProvider";
import type { RootState } from "@/lib/store";
import { setIsMapGetInfoActive, setMapCursor } from "@/lib/store/map/slice";
import { drawEvents } from "@/lib/utils/map/drawEvents";

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { DrawModes } from "@/components/map/controls/Draw";
import { type AreaMap, MAIN_MAP } from "@/components/map/panels/filter/area/host";

export type AreaShape = "polygon" | "circle";
/** A shape, or a point: one click, a circle's centre. */
export type DrawShape = AreaShape | "point";

export type DrawnShape = { shape: AreaShape; polygons: PolygonCoords[] } | { shape: "point"; at: Position };

export interface AreaDraw {
  /** Whether a shape can be drawn now: there is a map with its draw tool and nothing else is using it. */
  available: boolean;
  /** The shape being drawn, null when none is. */
  drawing: DrawShape | null;
  /** Whether a shape is being edited. */
  editing: boolean;
  /** Starts drawing; `onDone` gets the finished shape once. */
  start: (shape: DrawShape, onDone: (drawn: DrawnShape) => void) => void;
  /** Loads polygons into the tool: their corners can be dragged, added at the midpoints and deleted. `onDone` gets them
   * once, as they are when the edit is finished (Enter, a click beside the shape, `finish`); Escape and `cancel` keep
   * the old shape, as does a shape left with fewer than three corners. */
  edit: (polygons: PolygonCoords[], onDone: (polygons: PolygonCoords[]) => void) => void;
  /** Finishes the shape being edited. */
  finish: () => void;
  /** Gives up the shape being drawn or edited. */
  cancel: () => void;
}

interface Session {
  control: MapboxDraw;
  mode: string;
  /** The feature the draw mode made for this shape, or the copy loaded to be edited. */
  featureId: string | number | undefined;
  stopListening: () => void;
  /** Ends an edit with its shape; a shape being drawn is finished on the map. */
  finish?: () => void;
}

type Listener = Parameters<ReturnType<typeof drawEvents>["on"]>[1];

const { SIMPLE_SELECT, DIRECT_SELECT, DRAW_POINT } = MapboxDraw.constants.modes;

const MODES: Record<DrawShape, string> = {
  polygon: DrawModes.POLYGON,
  circle: DrawModes.CIRCLE,
  point: DRAW_POINT,
};

/** The drawn feature as the shape it was started as, undefined when it is none. */
function drawnShape(shape: DrawShape, feature: GeoJSON.Feature): DrawnShape | undefined {
  if (shape !== "point") {
    const polygons = drawnPolygons(shape, feature);
    return polygons && { shape, polygons };
  }
  const { geometry } = feature;
  if (geometry.type !== "Point" || geometry.coordinates.length < 2) return undefined;
  // Rounded as a piece's coordinates are: the point as a ring of one position.
  const [[[at]]] = roundPolygons([[[geometry.coordinates]]]);
  return { shape, at };
}

/** The drawn feature as polygons, undefined when it is no shape. A circle comes as its radius: centre to edge. */
function drawnPolygons(shape: AreaShape, feature: GeoJSON.Feature): PolygonCoords[] | undefined {
  const { geometry, properties } = feature;
  if (shape === "polygon") {
    return geometry.type === "Polygon" ? roundPolygons([geometry.coordinates]) : undefined;
  }
  if (geometry.type !== "LineString" || geometry.coordinates.length < 2) return undefined;
  const [center, edge] = geometry.coordinates;
  // The second click writes radius and direction; a circle finished with Enter has only the line.
  const radius =
    typeof properties?.radiusInKm === "number"
      ? properties.radiusInKm
      : distance(center, edge, { units: "kilometers" });
  if (!(radius > 0)) return undefined;
  const start =
    typeof properties?.azimuthDegrees === "number" ? properties.azimuthDegrees : bearing(center, edge);
  const circle = generateCirclePolygon([center[0], center[1]], radius, start);
  return roundPolygons([circle.geometry.coordinates]);
}

/** Whether a key goes to a field being typed in. */
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** Hears the tool's events and the keys until the returned function is called. The keys are heard first, on the way
 * down: the draw tool only hears them while the map has the focus. */
function listen(
  map: MapRef,
  listeners: Record<string, Listener>,
  onKeyDown: (event: KeyboardEvent) => void
): () => void {
  const events = drawEvents(map);
  const entries = Object.entries(listeners);
  for (const [name, listener] of entries) events.on(name, listener);
  document.addEventListener("keydown", onKeyDown, true);
  return () => {
    for (const [name, listener] of entries) events.off(name, listener);
    document.removeEventListener("keydown", onKeyDown, true);
  };
}

/** `target`: the map to draw on, the project's map by default. */
export function useAreaDraw(target: AreaMap = MAIN_MAP): AreaDraw {
  const dispatch = useAppDispatch();
  const store = useStore<RootState>();
  const map = useMap()[target.id];
  const { drawControl } = useDraw();
  const { main } = target;
  const measuring = useAppSelector((state) => main && !!state.map.activeMeasureTool);
  const editing = useAppSelector((state) => main && !!state.featureEditor.activeLayerId);
  const available = !!map && !!drawControl && !measuring && !editing;
  // What the tool is doing for the area: drawing a shape, editing one, or nothing.
  const [active, setActive] = useState<DrawShape | "edit" | null>(null);
  const session = useRef<Session | null>(null);

  /** Whether measuring or editing has the tool, as of now: they take it before this hook renders again. */
  const taken = useCallback(() => {
    if (!main) return false;
    const state = store.getState();
    return !!state.map.activeMeasureTool || !!state.featureEditor.activeLayerId;
  }, [store, main]);

  /** Ends the session on this side: no more events, and the map as it was unless the tool went to somebody else.
   * `afterClick`: the tool ended it on a mouse button's release, and the map's click for the same press is still to
   * come; the popups come back once it has passed, so it opens none. */
  const end = useCallback(
    (afterClick = false) => {
      const ended = session.current;
      if (!ended) return null;
      session.current = null;
      ended.stopListening();
      // Whoever took the tool has set the cursor and the popups for itself. Another map has neither.
      if (main && !taken()) {
        dispatch(setMapCursor(undefined));
        const popups = () => {
          if (!session.current && !taken()) dispatch(setIsMapGetInfoActive(true));
        };
        if (afterClick) setTimeout(popups, 0);
        else popups();
      }
      setActive(null);
      return ended;
    },
    [dispatch, taken, main]
  );

  /** Ends the session and gives up the half-drawn shape; `afterClick` as for `end`. */
  const stop = useCallback(
    (afterClick = false) => {
      const ended = end(afterClick);
      if (!ended) return;
      const { control, featureId, mode } = ended;
      try {
        // The half-drawn shape goes before the mode does: a mode that is left with a valid shape announces it as created.
        if (featureId !== undefined && control.get(String(featureId))) control.delete(String(featureId));
        if (!taken() && control.getMode() === mode) control.changeMode(SIMPLE_SELECT);
      } catch {
        /* the control went with its map */
      }
    },
    [end, taken]
  );
  const cancel = useCallback(() => stop(), [stop]);
  const finish = useCallback(() => session.current?.finish?.(), []);

  /** Ends the session once somebody else sent the tool to another mode or cleared away its shape: that says nothing,
   * and a shape that was far enough is announced as created then, but it was cut short, not finished. */
  const cutShort = useCallback(
    (control: MapboxDraw, mode: string, featureId: string | number | undefined) => () => {
      const left = control.getMode() !== mode;
      const gone = featureId !== undefined && !control.get(String(featureId));
      if (left || gone) cancel();
    },
    [cancel]
  );

  /** Takes the session on: the map's popups go off (and its cursor is `cursor`) until it ends. */
  const begin = useCallback(
    (next: Session, doing: DrawShape | "edit", cursor?: string) => {
      session.current = next;
      if (main) {
        if (cursor) dispatch(setMapCursor(cursor));
        dispatch(setIsMapGetInfoActive(false));
      }
      setActive(doing);
    },
    [dispatch, main]
  );

  const start = useCallback(
    (shape: DrawShape, onDone: (drawn: DrawnShape) => void) => {
      if (!map || !drawControl || taken()) return;
      cancel();

      const mode = MODES[shape];
      const before = new Set(drawControl.getAll().features.map((feature) => feature.id));
      drawControl.changeMode(mode);
      // The mode makes its feature right away: the one that was not there before is this shape.
      const featureId = drawControl.getAll().features.find((feature) => !before.has(feature.id))?.id;

      // What the create event brought: null for a feature that is no shape, undefined before the event.
      let created: DrawnShape | null | undefined;
      const onCreate = (event: { features: GeoJSON.Feature[] }) => {
        const feature = event.features[0];
        if (!feature || created !== undefined) return;
        if (featureId !== undefined && feature.id !== featureId) return;
        created = drawnShape(shape, feature) ?? null;
        // No mode change here: the event comes from the tool leaving the mode.
        try {
          if (feature.id !== undefined) drawControl.delete(String(feature.id));
        } catch {
          /* the control went with its map */
        }
      };
      // A mode tells of its end only when it ends itself. After a shape, the user finished it: it is handed over.
      // Without one it was Escape on the map, or too few points.
      const onModeChange = () => {
        stop(true);
        if (created) onDone(created);
      };
      // Escape is kept here: it ends the shape and nothing else, not the dialog the map is in.
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        cancel();
      };

      const stopListening = listen(
        map,
        {
          [MapboxDraw.constants.events.CREATE]: onCreate,
          [MapboxDraw.constants.events.MODE_CHANGE]: onModeChange,
          [MapboxDraw.constants.events.RENDER]: cutShort(drawControl, mode, featureId),
        },
        onKeyDown
      );
      begin({ control: drawControl, mode, featureId, stopListening }, shape, "crosshair");
    },
    [map, drawControl, cancel, stop, taken, cutShort, begin]
  );

  const edit = useCallback(
    (polygons: PolygonCoords[], onDone: (polygons: PolygonCoords[]) => void) => {
      if (!map || !drawControl || taken() || !polygons.length) return;
      cancel();

      const geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon =
        polygons.length === 1
          ? { type: "Polygon", coordinates: polygons[0] }
          : { type: "MultiPolygon", coordinates: polygons };
      // Under the one id whose midpoints are shown: a click on one adds a corner.
      const [featureId] = drawControl.add({
        type: "Feature",
        id: SHOWN_MIDPOINTS_ID,
        properties: {},
        geometry,
      });
      drawControl.changeMode(DIRECT_SELECT, { featureId });

      /** Ends the edit with the shape as the tool has it now; with none once the tool dropped it. `afterClick` as for
       * `end`. */
      const done = (afterClick = false) => {
        let edited: PolygonCoords[] | null = null;
        try {
          const feature = drawControl.get(String(featureId));
          edited = feature ? geometryPolygons(feature.geometry) : null;
        } catch {
          /* the control went with its map */
        }
        stop(afterClick);
        if (edited) onDone(roundPolygons(edited));
      };
      // The edit mode ends itself on a click beside the shape, and once a deleted corner left fewer than three, when
      // it has dropped the shape first.
      const onModeChange = () => done(true);
      // Nothing of the edit mode's own goes by keys: Escape gives up (and goes no further, as while drawing), Enter
      // finishes, Delete and Backspace take the selected corners away. A field being typed in keeps the last two.
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          cancel();
          return;
        }
        if (typing(event.target)) return;
        if (event.key === "Enter") {
          // Not the button the focus is on, which would start the edit again.
          event.preventDefault();
          event.stopPropagation();
          done();
        } else if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          drawControl.trash();
        }
      };

      const stopListening = listen(
        map,
        {
          [MapboxDraw.constants.events.MODE_CHANGE]: onModeChange,
          [MapboxDraw.constants.events.RENDER]: cutShort(drawControl, DIRECT_SELECT, featureId),
        },
        onKeyDown
      );
      // The tool's own cursors say what a corner or the shape can do.
      begin(
        { control: drawControl, mode: DIRECT_SELECT, featureId, stopListening, finish: () => done() },
        "edit"
      );
    },
    [map, drawControl, cancel, stop, taken, cutShort, begin]
  );

  // Measuring or editing started, or the map went: the shape is given up.
  useEffect(() => {
    if (!available) cancel();
  }, [available, cancel]);
  useEffect(() => cancel, [cancel]);

  return {
    available,
    drawing: active === "edit" ? null : active,
    editing: active === "edit",
    start,
    edit,
    finish,
    cancel,
  };
}
