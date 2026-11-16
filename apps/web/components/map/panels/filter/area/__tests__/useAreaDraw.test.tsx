/**
 * `useAreaDraw` borrows the map's one draw tool for a single shape. Measuring and feature editing live in the same
 * tool, so what is pinned here is that the hook only ever touches the shape it started and hands the tool back as it
 * found it.
 *
 * The draw tool is a stand-in that behaves like the real one where it matters: a mode that is left announces its
 * shape as created when the shape is valid and drops it when not, and only a mode's own way out (the last click,
 * Enter, Escape) tells the map about the mode change.
 */
import { configureStore } from "@reduxjs/toolkit";
import { act, renderHook } from "@testing-library/react";
import distance from "@turf/distance";
import React from "react";
import { Provider } from "react-redux";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SHOWN_MIDPOINTS_ID } from "@p4b/draw";

import type { PolygonCoords, Position } from "@/lib/filter/area";
import { featureEditorReducer, startEditing } from "@/lib/store/featureEditor/slice";
import { mapReducer, setActiveMeasureTool } from "@/lib/store/map/slice";

import type { AreaMap } from "@/components/map/panels/filter/area/host";
import { type DrawnShape, useAreaDraw } from "@/components/map/panels/filter/area/useAreaDraw";

type Listener = (event: unknown) => void;

const { tool, fakeMap, provided, maps } = vi.hoisted(() => {
  const listeners = new Map<string, Set<Listener>>();
  const fakeMap = {
    on: (event: string, listener: Listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(listener);
    },
    off: (event: string, listener: Listener) => void listeners.get(event)?.delete(listener),
    fire: (event: string, payload: unknown) => [...(listeners.get(event) ?? [])].forEach((l) => l(payload)),
    listening: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
    reset: () => listeners.clear(),
  };

  const features = new Map<string, GeoJSON.Feature>();
  const state = {
    mode: "simple_select",
    drawn: null as string | null,
    /** The feature direct_select edits. */
    selected: null as string | null,
    next: 0,
  };
  const isValid = (feature: GeoJSON.Feature) =>
    feature.geometry.type === "Polygon"
      ? (feature.geometry.coordinates[0]?.length ?? 0) >= 4
      : feature.geometry.type === "Point"
        ? feature.geometry.coordinates.length === 2
        : feature.geometry.type === "LineString" && feature.geometry.coordinates.length >= 2;

  /** Leaves the mode as the real tool does: the shape being drawn is announced when valid, dropped when not. */
  const leave = (mode: string, silent: boolean, options?: { featureId?: string }) => {
    const drawn = state.drawn ? features.get(state.drawn) : undefined;
    if (drawn && isValid(drawn)) fakeMap.fire("draw.create", { features: [drawn] });
    else if (drawn) features.delete(drawn.id as string);
    state.drawn = null;
    state.mode = mode;
    state.selected = mode === "direct_select" ? (options?.featureId ?? null) : null;
    if (mode === "draw_polygon" || mode === "draw_circle" || mode === "draw_point") {
      const id = `drawn-${++state.next}`;
      const geometry: GeoJSON.Geometry =
        mode === "draw_polygon"
          ? { type: "Polygon", coordinates: [[]] }
          : mode === "draw_point"
            ? { type: "Point", coordinates: [] }
            : { type: "LineString", coordinates: [] };
      features.set(id, { type: "Feature", id, properties: {}, geometry });
      state.drawn = id;
    }
    if (!silent) fakeMap.fire("draw.modechange", { mode });
  };

  const tool = {
    features,
    state,
    getAll: vi.fn(() => ({ type: "FeatureCollection", features: [...features.values()] })),
    get: vi.fn((id: string) => features.get(id)),
    getMode: vi.fn(() => state.mode),
    changeMode: vi.fn((mode: string, options?: { featureId?: string }) => leave(mode, true, options)),
    /** Without a mode change; the feature direct_select edits going takes the tool to select, silently. */
    delete: vi.fn((id: string) => {
      features.delete(id);
      if (state.mode === "direct_select" && state.selected === id) leave("simple_select", true);
    }),
    deleteAll: vi.fn(() => features.clear()),
    /** With the feature's own id, as the real tool keeps it; one of its own otherwise. */
    add: vi.fn((feature: GeoJSON.Feature) => {
      const id = feature.id === undefined ? `added-${++state.next}` : String(feature.id);
      features.set(id, { ...feature, id });
      return [id];
    }),
    /** direct_select's Delete: the selected corner goes (here the ring's second); a polygon left with fewer than
     * three corners goes with it, and the mode leaves for select by itself. */
    trash: vi.fn(() => {
      const edited = state.selected ? features.get(state.selected) : undefined;
      if (state.mode !== "direct_select" || edited?.geometry.type !== "Polygon") return;
      const [ring] = edited.geometry.coordinates;
      const rest = ring.filter((_, i) => i !== 1);
      edited.geometry = { type: "Polygon", coordinates: [rest] };
      if (rest.length < 4) {
        features.delete(state.selected as string);
        leave("simple_select", false);
      }
    }),
    /** Corners dragged in direct_select. */
    reshape: (geometry: GeoJSON.Geometry) => {
      (features.get(state.selected as string) as GeoJSON.Feature).geometry = geometry;
    },
    /** A click beside the edited shape: direct_select leaves for select by itself, the shape stays. */
    clickOutside: () => leave("simple_select", false),
    /** The user's clicks so far. */
    sketch: (geometry: GeoJSON.Geometry, properties: Record<string, unknown> = {}) => {
      const drawn = features.get(state.drawn as string) as GeoJSON.Feature;
      drawn.geometry = geometry;
      drawn.properties = properties;
    },
    /** The last click or Enter: the mode leaves for select by itself. */
    finish: () => leave("simple_select", false),
    /** Escape with the map in focus: the mode drops its shape and leaves. */
    escape: () => {
      features.delete(state.drawn as string);
      state.drawn = null;
      leave("simple_select", false);
    },
    reset: () => {
      features.clear();
      Object.assign(state, { mode: "simple_select", drawn: null, selected: null, next: 0 });
    },
  };
  // The maps by their ids, as a MapProvider holds them.
  const maps: Record<string, typeof fakeMap | undefined> = {};
  return { tool, fakeMap, provided: { drawControl: tool as typeof tool | null }, maps };
});

vi.mock("react-map-gl/maplibre", () => ({ useMap: () => maps }));
vi.mock("@/lib/providers/DrawProvider", () => ({ useDraw: () => ({ drawControl: provided.drawControl }) }));
vi.mock("@/components/map/controls/Draw", () => ({
  DrawModes: { CIRCLE: "draw_circle", POLYGON: "draw_polygon" },
}));

/** A circle that came back as its centre and radius. */
type DrawnCircle = Extract<DrawnShape, { shape: "circle" }>;

const makeStore = () => configureStore({ reducer: { featureEditor: featureEditorReducer, map: mapReducer } });

const renderDraw = (store = makeStore(), target?: AreaMap) => {
  const rendered = renderHook(() => useAreaDraw(target), {
    wrapper: ({ children }: { children: React.ReactNode }) => <Provider store={store}>{children}</Provider>,
  });
  return { ...rendered, store };
};

const triangle: GeoJSON.Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [11.123456789, 48.1],
      [11.2, 48.123456712],
      [11.3, 48.1],
      [11.123456789, 48.1],
    ],
  ],
};

/** A measurement that was on the map before. */
const measurement: GeoJSON.Feature = {
  type: "Feature",
  id: "measurement-1",
  properties: {},
  geometry: {
    type: "LineString",
    coordinates: [
      [11, 48],
      [11.5, 48.5],
    ],
  },
};

/** The tool and the map as they are when nobody draws, once the click that ended the shape has passed. */
const expectHandedBack = (store: ReturnType<typeof makeStore>) => {
  act(() => vi.runOnlyPendingTimers());
  expect(tool.state.mode).toBe("simple_select");
  expect(store.getState().map.mapCursor).toBeUndefined();
  expect(store.getState().map.isMapGetInfoActive).toBe(true);
  expect(fakeMap.listening()).toBe(0);
  expect(tool.deleteAll).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.useFakeTimers();
  tool.reset();
  fakeMap.reset();
  for (const id of Object.keys(maps)) delete maps[id];
  maps.map = fakeMap;
  provided.drawControl = tool;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useAreaDraw", () => {
  it("is available with a map and its draw tool", () => {
    expect(renderDraw().result.current).toMatchObject({ available: true, drawing: null });
  });

  it("is not available without the draw tool, and starts nothing", () => {
    provided.drawControl = null;
    const onDone = vi.fn();
    const { result } = renderDraw();
    expect(result.current.available).toBe(false);
    act(() => result.current.start("polygon", onDone));
    expect(result.current.drawing).toBeNull();
    expect(tool.changeMode).not.toHaveBeenCalled();
  });

  it("is not available while measuring, and starts nothing", () => {
    const { result, store } = renderDraw();
    act(() => void store.dispatch(setActiveMeasureTool("area")));
    expect(result.current.available).toBe(false);
    act(() => result.current.start("polygon", vi.fn()));
    expect(result.current.drawing).toBeNull();
    expect(tool.changeMode).not.toHaveBeenCalled();
  });

  it("is not available while a layer's features are edited", () => {
    const { result, store } = renderDraw();
    act(() => void store.dispatch(startEditing({ layerId: "layer-1", geometryType: "polygon" })));
    expect(result.current.available).toBe(false);
    act(() => result.current.start("circle", vi.fn()));
    expect(tool.changeMode).not.toHaveBeenCalled();
  });

  it("draws a polygon: the tool is armed, and the finished shape comes back once, rounded", () => {
    const onDone = vi.fn<(drawn: DrawnShape) => void>();
    const { result, store } = renderDraw();

    act(() => result.current.start("polygon", onDone));
    expect(tool.changeMode).toHaveBeenCalledExactlyOnceWith("draw_polygon");
    expect(result.current.drawing).toBe("polygon");
    expect(result.current.available).toBe(true);
    expect(store.getState().map.mapCursor).toBe("crosshair");
    expect(store.getState().map.isMapGetInfoActive).toBe(false);

    act(() => {
      tool.sketch(triangle);
      tool.finish();
    });

    expect(onDone).toHaveBeenCalledExactlyOnceWith({
      shape: "polygon",
      polygons: [
        [
          [
            [11.123457, 48.1],
            [11.2, 48.123457],
            [11.3, 48.1],
            [11.123457, 48.1],
          ],
        ],
      ],
    });
    expect(result.current.drawing).toBeNull();
    expect(tool.features.size).toBe(0);
    // The tool was already on its way to select: it is not sent there a second time from inside its own event.
    expect(tool.changeMode).toHaveBeenCalledTimes(1);
    expectHandedBack(store);
  });

  it("gives the map's info clicks back only after the click that finished the shape", () => {
    const { result, store } = renderDraw();
    act(() => result.current.start("polygon", vi.fn()));
    act(() => {
      tool.sketch(triangle);
      tool.finish();
    });
    // The tool finishes on the mouse button's release: the map's click for the same press comes after it.
    expect(store.getState().map.isMapGetInfoActive).toBe(false);
    act(() => vi.runOnlyPendingTimers());
    expect(store.getState().map.isMapGetInfoActive).toBe(true);
  });

  it("keeps the map's info clicks off when a new shape starts before they came back", () => {
    const { result, store } = renderDraw();
    act(() => result.current.start("polygon", vi.fn()));
    act(() => {
      tool.sketch(triangle);
      tool.finish();
    });
    act(() => result.current.start("circle", vi.fn()));
    act(() => vi.runOnlyPendingTimers());
    expect(store.getState().map.isMapGetInfoActive).toBe(false);
  });

  it("draws a circle: the radius line comes back as the circle's centre and radius", () => {
    const onDone = vi.fn<(drawn: DrawnShape) => void>();
    const { result, store } = renderDraw();
    act(() => result.current.start("circle", onDone));
    expect(tool.changeMode).toHaveBeenCalledExactlyOnceWith("draw_circle");
    expect(result.current.drawing).toBe("circle");

    const radiusLine: GeoJSON.LineString = {
      type: "LineString",
      coordinates: [
        [11.5, 48.1],
        [11.5, 48.2],
      ],
    };
    act(() => {
      tool.sketch(radiusLine, { isCircle: true, radiusInKm: 5, azimuthDegrees: 0 });
      tool.finish();
    });

    expect(onDone).toHaveBeenCalledExactlyOnceWith({ shape: "circle", center: [11.5, 48.1], km: 5 });
    expect(tool.features.size).toBe(0);
    expectHandedBack(store);
  });

  it("keeps a drawn circle's centre to six decimals and its radius to the meter", () => {
    const onDone = vi.fn<(drawn: DrawnShape) => void>();
    const { result } = renderDraw();
    act(() => result.current.start("circle", onDone));
    act(() => {
      tool.sketch(
        {
          type: "LineString",
          coordinates: [
            [11.123456789, 48.987654321],
            [11.2, 48.9],
          ],
        },
        { radiusInKm: 1.23456789 }
      );
      tool.finish();
    });
    expect(onDone).toHaveBeenCalledExactlyOnceWith({
      shape: "circle",
      center: [11.123457, 48.987654],
      km: 1.235,
    });
  });

  it("measures the radius itself when the circle was finished without its second click", () => {
    const onDone = vi.fn<(drawn: DrawnShape) => void>();
    const { result } = renderDraw();
    act(() => result.current.start("circle", onDone));
    act(() => {
      // Enter: the line is there, the properties the second click writes are not.
      tool.sketch({
        type: "LineString",
        coordinates: [
          [11.5, 48.1],
          [11.5, 48.2],
        ],
      });
      tool.finish();
    });
    const drawn = onDone.mock.calls[0][0] as DrawnCircle;
    expect(drawn.center).toEqual([11.5, 48.1]);
    // The edge is about 11.1 km north of the centre.
    expect(drawn.km).toBeCloseTo(11.12, 2);
  });

  it("takes a circle without a radius for no shape", () => {
    const onDone = vi.fn();
    const { result, store } = renderDraw();
    act(() => result.current.start("circle", onDone));
    act(() => {
      tool.sketch({
        type: "LineString",
        coordinates: [
          [11.5, 48.1],
          [11.5, 48.1],
        ],
      });
      tool.finish();
    });
    expect(onDone).not.toHaveBeenCalled();
    expect(result.current.drawing).toBeNull();
    expect(tool.features.size).toBe(0);
    expectHandedBack(store);
  });

  it("deletes only its own shape", () => {
    tool.features.set("measurement-1", measurement);
    const onDone = vi.fn();
    const { result } = renderDraw();
    act(() => result.current.start("polygon", onDone));
    act(() => {
      tool.sketch(triangle);
      tool.finish();
    });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(tool.delete).toHaveBeenCalledExactlyOnceWith("drawn-1");
    expect(tool.deleteAll).not.toHaveBeenCalled();
    expect([...tool.features.keys()]).toEqual(["measurement-1"]);
  });

  it("leaves a shape alone that somebody else created meanwhile", () => {
    const onDone = vi.fn();
    const { result } = renderDraw();
    act(() => result.current.start("polygon", onDone));
    act(() => fakeMap.fire("draw.create", { features: [measurement] }));
    expect(onDone).not.toHaveBeenCalled();
    expect(tool.delete).not.toHaveBeenCalled();
    expect(result.current.drawing).toBe("polygon");
  });

  it("cancels: the half-drawn shape is gone and nothing is handed over", () => {
    tool.features.set("measurement-1", measurement);
    const onDone = vi.fn();
    const created = vi.fn();
    fakeMap.on("draw.create", created);
    const { result, store } = renderDraw();
    act(() => result.current.start("polygon", onDone));
    // Far enough to count as a shape: leaving the mode with it would announce it to whoever listens.
    act(() => tool.sketch(triangle));

    act(() => result.current.cancel());

    expect(onDone).not.toHaveBeenCalled();
    expect(created).not.toHaveBeenCalled();
    expect(result.current.drawing).toBeNull();
    expect(tool.delete).toHaveBeenCalledExactlyOnceWith("drawn-1");
    expect([...tool.features.keys()]).toEqual(["measurement-1"]);
    fakeMap.off("draw.create", created);
    expectHandedBack(store);

    // A shape finished later is not this one's business any more.
    act(() => fakeMap.fire("draw.create", { features: [{ ...measurement, id: "drawn-1" }] }));
    expect(onDone).not.toHaveBeenCalled();
  });

  it("cancels when it is unmounted while drawing", () => {
    const onDone = vi.fn();
    const { result, store, unmount } = renderDraw();
    act(() => result.current.start("circle", onDone));
    act(() =>
      tool.sketch({
        type: "LineString",
        coordinates: [
          [11.5, 48.1],
          [11.6, 48.1],
        ],
      })
    );

    unmount();

    expect(onDone).not.toHaveBeenCalled();
    expect(tool.features.size).toBe(0);
    expectHandedBack(store);
  });

  it("does nothing on cancel or unmount when it is not drawing", () => {
    tool.features.set("measurement-1", measurement);
    const { result, store, unmount } = renderDraw();
    act(() => result.current.cancel());
    unmount();
    expect(tool.changeMode).not.toHaveBeenCalled();
    expect(tool.delete).not.toHaveBeenCalled();
    expect(tool.features.size).toBe(1);
    expectHandedBack(store);
  });

  it("ends when the tool leaves the mode without a shape (Escape on the map)", () => {
    const onDone = vi.fn();
    const { result, store } = renderDraw();
    act(() => result.current.start("polygon", onDone));

    act(() => tool.escape());

    expect(onDone).not.toHaveBeenCalled();
    expect(result.current.drawing).toBeNull();
    // Only the one call that armed the tool.
    expect(tool.changeMode).toHaveBeenCalledTimes(1);
    expectHandedBack(store);
  });

  it("ends when the shape was not one (two corners)", () => {
    const onDone = vi.fn();
    const { result, store } = renderDraw();
    act(() => result.current.start("polygon", onDone));
    act(() => {
      tool.sketch({
        type: "Polygon",
        coordinates: [
          [
            [11, 48],
            [11.1, 48],
          ],
        ],
      });
      tool.finish();
    });
    expect(onDone).not.toHaveBeenCalled();
    expect(result.current.drawing).toBeNull();
    expect(tool.features.size).toBe(0);
    expectHandedBack(store);
  });

  it("cancels on Escape wherever the focus is", () => {
    const onDone = vi.fn();
    const { result, store } = renderDraw();
    act(() => result.current.start("polygon", onDone));
    act(() => tool.sketch(triangle));

    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));

    expect(onDone).not.toHaveBeenCalled();
    expect(result.current.drawing).toBeNull();
    expect(tool.features.size).toBe(0);
    expectHandedBack(store);

    // The key is let go of with the session.
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(tool.changeMode).toHaveBeenCalledTimes(2);
  });

  it("keeps Escape from going further while drawing: a dialog around the map stays open", () => {
    const beyond = vi.fn();
    document.addEventListener("keydown", beyond);
    const { result } = renderDraw();
    act(() => result.current.start("polygon", vi.fn()));
    const escape = () => new KeyboardEvent("keydown", { key: "Escape", bubbles: true });

    act(() => void document.body.dispatchEvent(escape()));
    expect(result.current.drawing).toBeNull();
    expect(beyond).not.toHaveBeenCalled();
    // Without a shape under way the key goes where it always went.
    act(() => void document.body.dispatchEvent(escape()));
    expect(beyond).toHaveBeenCalledTimes(1);
    document.removeEventListener("keydown", beyond);
  });

  it("places a point: the clicked position comes back, rounded", () => {
    const onDone = vi.fn<(drawn: DrawnShape) => void>();
    const { result, store } = renderDraw();
    act(() => result.current.start("point", onDone));
    expect(tool.changeMode).toHaveBeenCalledExactlyOnceWith("draw_point");
    expect(result.current.drawing).toBe("point");

    act(() => {
      tool.sketch({ type: "Point", coordinates: [11.123456789, 48.987654321] });
      tool.finish();
    });

    expect(onDone).toHaveBeenCalledExactlyOnceWith({ shape: "point", at: [11.123457, 48.987654] });
    expect(tool.features.size).toBe(0);
    expectHandedBack(store);
  });

  describe("on a map of its own (a dialog's preview)", () => {
    const PREVIEW: AreaMap = { id: "preview", main: false };
    beforeEach(() => {
      delete maps.map;
      maps.preview = fakeMap;
    });

    it("draws on the map it is given, and leaves the project map's cursor and popups alone", () => {
      const onDone = vi.fn<(drawn: DrawnShape) => void>();
      const { result, store } = renderDraw(makeStore(), PREVIEW);
      const before = store.getState().map;
      act(() => result.current.start("polygon", onDone));
      expect(result.current.drawing).toBe("polygon");
      expect(store.getState().map).toBe(before);

      act(() => {
        tool.sketch(triangle);
        tool.finish();
      });
      act(() => vi.runOnlyPendingTimers());
      expect(onDone).toHaveBeenCalledTimes(1);
      expect(store.getState().map).toBe(before);
      expect(fakeMap.listening()).toBe(0);
    });

    it("is available while the project map measures or edits: they have a draw tool of their own", () => {
      const store = makeStore();
      store.dispatch(setActiveMeasureTool("area"));
      store.dispatch(startEditing({ layerId: "layer-1", geometryType: "polygon" }));
      const { result } = renderDraw(store, PREVIEW);
      expect(result.current.available).toBe(true);
      act(() => result.current.start("polygon", vi.fn()));
      expect(result.current.drawing).toBe("polygon");
    });

    it("is not available without its map", () => {
      delete maps.preview;
      maps.map = fakeMap;
      expect(renderDraw(makeStore(), PREVIEW).result.current.available).toBe(false);
    });
  });

  it("starts the new shape in place of one being drawn", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result } = renderDraw();
    act(() => result.current.start("polygon", first));
    act(() => tool.sketch(triangle));
    act(() => result.current.start("circle", second));

    expect(result.current.drawing).toBe("circle");
    expect(first).not.toHaveBeenCalled();
    expect([...tool.features.keys()]).toEqual(["drawn-2"]);
    expect(tool.state.mode).toBe("draw_circle");
  });

  describe("when measuring takes the tool over", () => {
    /** What starting a measure tool does, in its order: the mode first, then the cursor, the popups and the tool. */
    const startMeasuring = (store: ReturnType<typeof makeStore>) => {
      tool.changeMode("draw_polygon");
      store.dispatch({ type: "map/setMapCursor", payload: "crosshair" });
      store.dispatch({ type: "map/setIsMapGetInfoActive", payload: false });
      store.dispatch(setActiveMeasureTool("area"));
    };

    it("lets go without touching the mode, the cursor or the measurement being drawn", () => {
      const onDone = vi.fn();
      const { result, store } = renderDraw();
      act(() => result.current.start("polygon", onDone));
      tool.changeMode.mockClear();

      act(() => startMeasuring(store));

      expect(result.current).toMatchObject({ available: false, drawing: null });
      expect(onDone).not.toHaveBeenCalled();
      // The measure tool's own call and nothing after it.
      expect(tool.changeMode).toHaveBeenCalledExactlyOnceWith("draw_polygon");
      expect(tool.state.mode).toBe("draw_polygon");
      expect([...tool.features.keys()]).toEqual(["drawn-2"]);
      expect(tool.delete).not.toHaveBeenCalled();
      expect(store.getState().map.mapCursor).toBe("crosshair");
      expect(store.getState().map.isMapGetInfoActive).toBe(false);
      expect(fakeMap.listening()).toBe(0);
    });

    it("drops a shape that was cut short, though the tool announces it as created", () => {
      const onDone = vi.fn();
      const { result, store } = renderDraw();
      act(() => result.current.start("polygon", onDone));
      act(() => tool.sketch(triangle));

      act(() => startMeasuring(store));

      expect(onDone).not.toHaveBeenCalled();
      expect(result.current.drawing).toBeNull();
      expect([...tool.features.keys()]).toEqual(["drawn-2"]);
      expect(store.getState().map.mapCursor).toBe("crosshair");
      expect(store.getState().map.isMapGetInfoActive).toBe(false);
      expect(fakeMap.listening()).toBe(0);
    });
  });

  describe("when the tool is sent to select behind its back (the measure menu closes)", () => {
    it("ends without the shape that was cut short", () => {
      const onDone = vi.fn();
      const { result, store } = renderDraw();
      act(() => result.current.start("circle", onDone));
      act(() =>
        tool.sketch({
          type: "LineString",
          coordinates: [
            [11.5, 48.1],
            [11.9, 48.3],
          ],
        })
      );

      act(() => {
        tool.changeMode("simple_select");
        fakeMap.fire("draw.render", {});
      });

      expect(onDone).not.toHaveBeenCalled();
      expect(result.current.drawing).toBeNull();
      expect(tool.features.size).toBe(0);
      expectHandedBack(store);
    });

    it("ends when its half-drawn shape was cleared away with the measurements", () => {
      tool.features.set("measurement-1", measurement);
      const onDone = vi.fn();
      const { result, store } = renderDraw();
      act(() => result.current.start("polygon", onDone));
      tool.changeMode.mockClear();

      act(() => {
        tool.deleteAll();
        tool.changeMode("simple_select");
        fakeMap.fire("draw.render", {});
      });

      expect(onDone).not.toHaveBeenCalled();
      expect(result.current.drawing).toBeNull();
      expect(tool.changeMode).toHaveBeenCalledTimes(1);
      expect(tool.delete).not.toHaveBeenCalled();
      expect(store.getState().map.mapCursor).toBeUndefined();
      expect(store.getState().map.isMapGetInfoActive).toBe(true);
      expect(fakeMap.listening()).toBe(0);
    });

    it("goes on while the tool is still in its mode with its shape", () => {
      const { result } = renderDraw();
      act(() => result.current.start("polygon", vi.fn()));
      act(() => fakeMap.fire("draw.render", {}));
      expect(result.current.drawing).toBe("polygon");
      expect(tool.features.size).toBe(1);
    });
  });

  it("lets go when feature editing starts, leaving the popups off for the editor", () => {
    const onDone = vi.fn();
    const { result, store } = renderDraw();
    act(() => result.current.start("polygon", onDone));
    tool.changeMode.mockClear();

    act(() => void store.dispatch(startEditing({ layerId: "layer-1", geometryType: "polygon" })));

    expect(result.current).toMatchObject({ available: false, drawing: null });
    expect(onDone).not.toHaveBeenCalled();
    // The half-drawn shape is taken away, the mode is the editor's to set.
    expect(tool.features.size).toBe(0);
    expect(tool.changeMode).not.toHaveBeenCalled();
    expect(store.getState().map.isMapGetInfoActive).toBe(false);
    expect(fakeMap.listening()).toBe(0);
  });

  describe("editing a shape", () => {
    /** A drawn polygon as a piece keeps it. */
    const square: PolygonCoords[] = [
      [
        [
          [11, 48],
          [11.1, 48],
          [11.1, 48.1],
          [11, 48.1],
          [11, 48],
        ],
      ],
    ];
    /** The square with two corners dragged, off the six decimals a piece keeps. */
    const moved: GeoJSON.Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [11, 48],
          [11.2000004, 48],
          [11.1, 48.1],
          [10.9, 48.1499996],
          [11, 48],
        ],
      ],
    };
    const movedRounded: PolygonCoords[] = [
      [
        [
          [11, 48],
          [11.2, 48],
          [11.1, 48.1],
          [10.9, 48.15],
          [11, 48],
        ],
      ],
    ];
    const keydown = (key: string, target: EventTarget = document.body) =>
      act(() => void target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));

    it("loads the shape into the tool for its corners, with the popups off and the cursor left alone", () => {
      const { result, store } = renderDraw();
      act(() => result.current.edit(square, vi.fn()));

      // Under the id whose midpoints the draw styles show: a click on one adds a corner there.
      expect(tool.add).toHaveBeenCalledExactlyOnceWith({
        type: "Feature",
        id: SHOWN_MIDPOINTS_ID,
        properties: {},
        geometry: { type: "Polygon", coordinates: square[0] },
      });
      expect(tool.changeMode).toHaveBeenCalledExactlyOnceWith("direct_select", {
        featureId: SHOWN_MIDPOINTS_ID,
      });
      expect(result.current).toMatchObject({ editing: true, drawing: null, available: true });
      expect(store.getState().map.isMapGetInfoActive).toBe(false);
      expect(store.getState().map.mapCursor).toBeUndefined();
    });

    it("a click beside the shape finishes: the moved corners come back once, rounded", () => {
      const onDone = vi.fn<(polygons: PolygonCoords[]) => void>();
      const { result, store } = renderDraw();
      act(() => result.current.edit(square, onDone));

      act(() => {
        tool.reshape(moved);
        tool.clickOutside();
      });

      expect(onDone).toHaveBeenCalledExactlyOnceWith(movedRounded);
      expect(result.current.editing).toBe(false);
      expect(tool.features.size).toBe(0);
      // The tool had left for select by itself: it is not sent there again.
      expect(tool.changeMode).toHaveBeenCalledTimes(1);
      // The click that finished it is still on its way to the map: the popups come back after it.
      expect(store.getState().map.isMapGetInfoActive).toBe(false);
      expectHandedBack(store);
    });

    it("finish() (Done) hands back the shape as it is and the tool as it was", () => {
      tool.features.set("measurement-1", measurement);
      const onDone = vi.fn<(polygons: PolygonCoords[]) => void>();
      const { result, store } = renderDraw();
      act(() => result.current.edit(square, onDone));
      act(() => tool.reshape(moved));

      act(() => result.current.finish());

      expect(onDone).toHaveBeenCalledExactlyOnceWith(movedRounded);
      expect(result.current.editing).toBe(false);
      expect(tool.delete).toHaveBeenCalledExactlyOnceWith(SHOWN_MIDPOINTS_ID);
      expect([...tool.features.keys()]).toEqual(["measurement-1"]);
      // No click on the map follows a button's: the popups are back at once.
      expect(store.getState().map.isMapGetInfoActive).toBe(true);
      expectHandedBack(store);
    });

    it("Enter finishes, wherever the focus is but in a text field", () => {
      const onDone = vi.fn<(polygons: PolygonCoords[]) => void>();
      const { result } = renderDraw();
      act(() => result.current.edit(square, onDone));
      act(() => tool.reshape(moved));

      const input = document.createElement("input");
      document.body.appendChild(input);
      keydown("Enter", input);
      expect(result.current.editing).toBe(true);
      input.remove();

      keydown("Enter");
      expect(onDone).toHaveBeenCalledExactlyOnceWith(movedRounded);
      expect(result.current.editing).toBe(false);
    });

    it("Escape cancels: nothing comes back, the edited copy is gone, the key goes no further", () => {
      const beyond = vi.fn();
      document.addEventListener("keydown", beyond);
      const onDone = vi.fn();
      const { result, store } = renderDraw();
      act(() => result.current.edit(square, onDone));
      act(() => tool.reshape(moved));

      keydown("Escape");

      expect(onDone).not.toHaveBeenCalled();
      expect(beyond).not.toHaveBeenCalled();
      expect(result.current.editing).toBe(false);
      expect(tool.features.size).toBe(0);
      expectHandedBack(store);
      document.removeEventListener("keydown", beyond);
    });

    it("cancel() keeps the old shape: nothing comes back", () => {
      const onDone = vi.fn();
      const { result, store } = renderDraw();
      act(() => result.current.edit(square, onDone));
      act(() => tool.reshape(moved));

      act(() => result.current.cancel());

      expect(onDone).not.toHaveBeenCalled();
      expect(result.current.editing).toBe(false);
      expect(tool.features.size).toBe(0);
      expectHandedBack(store);
    });

    it("Delete removes the selected corner with the tool, but not while a text field has the focus", () => {
      const { result } = renderDraw();
      act(() => result.current.edit(square, vi.fn()));

      const input = document.createElement("input");
      document.body.appendChild(input);
      keydown("Delete", input);
      keydown("Backspace", input);
      expect(tool.trash).not.toHaveBeenCalled();
      input.remove();

      keydown("Backspace");
      expect(tool.trash).toHaveBeenCalledTimes(1);
      expect(result.current.editing).toBe(true);
    });

    it("gives up a shape left with fewer than three corners: the old one stays", () => {
      const onDone = vi.fn();
      const { result, store } = renderDraw();
      act(() =>
        result.current.edit(
          [
            [
              [
                [11, 48],
                [11.1, 48],
                [11.1, 48.1],
                [11, 48],
              ],
            ],
          ],
          onDone
        )
      );

      keydown("Delete");

      expect(onDone).not.toHaveBeenCalled();
      expect(result.current.editing).toBe(false);
      expect(tool.features.size).toBe(0);
      expectHandedBack(store);
    });

    it("cancels when it is unmounted while editing", () => {
      const onDone = vi.fn();
      const { result, store, unmount } = renderDraw();
      act(() => result.current.edit(square, onDone));

      unmount();

      expect(onDone).not.toHaveBeenCalled();
      expect(tool.features.size).toBe(0);
      expectHandedBack(store);
    });

    it("lets go when measuring takes the tool, keeping the old shape", () => {
      const onDone = vi.fn();
      const { result, store } = renderDraw();
      act(() => result.current.edit(square, onDone));

      act(() => void store.dispatch(setActiveMeasureTool("area")));

      expect(result.current).toMatchObject({ available: false, editing: false });
      expect(onDone).not.toHaveBeenCalled();
      expect(tool.features.size).toBe(0);
      expect(fakeMap.listening()).toBe(0);
    });

    it("drawing a new shape gives up the edit", () => {
      const onDone = vi.fn();
      const { result } = renderDraw();
      act(() => result.current.edit(square, onDone));

      act(() => result.current.start("polygon", vi.fn()));

      expect(onDone).not.toHaveBeenCalled();
      expect(result.current).toMatchObject({ editing: false, drawing: "polygon" });
      expect(tool.features.has(SHOWN_MIDPOINTS_ID)).toBe(false);
    });

    it("edits on a dialog's own map without touching the project map's popups", () => {
      delete maps.map;
      maps.preview = fakeMap;
      const onDone = vi.fn();
      const { result, store } = renderDraw(makeStore(), { id: "preview", main: false });
      const before = store.getState().map;
      act(() => result.current.edit(square, onDone));
      expect(result.current.editing).toBe(true);
      expect(store.getState().map).toBe(before);

      act(() => {
        tool.reshape(moved);
        tool.clickOutside();
      });
      act(() => vi.runOnlyPendingTimers());
      expect(onDone).toHaveBeenCalledExactlyOnceWith(movedRounded);
      expect(store.getState().map).toBe(before);
    });
  });

  describe("editing a circle", () => {
    const circle = { center: [11, 48] as Position, km: 3 };
    /** The radius line the tool edits. */
    const line = () => tool.features.get(tool.state.selected as string)?.geometry as GeoJSON.LineString;
    const kmOf = ({ coordinates: [center, edge] }: GeoJSON.LineString) =>
      distance(center, edge, { units: "kilometers" });
    /** The tool drew what was dragged. */
    const drawn = () => act(() => fakeMap.fire("draw.render", {}));
    const keydown = (key: string) =>
      act(() => void document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));

    it("loads it as the radius line the select mode draws a circle around, under an id that shows no midpoints", () => {
      const { result, store } = renderDraw();
      act(() => result.current.editCircle(circle, vi.fn()));

      expect(tool.add).toHaveBeenCalledTimes(1);
      const added = tool.add.mock.calls[0][0];
      expect(added.id).toBeUndefined();
      expect(added.properties).toEqual({ isCircle: true, isRadiusLine: true });
      const loaded = added.geometry as GeoJSON.LineString;
      expect(loaded.coordinates[0]).toEqual([11, 48]);
      // To a tenth of a meter: the tool and turf take the earth a few meters apart in size.
      expect(kmOf(loaded)).toBeCloseTo(3, 4);
      expect(tool.changeMode).toHaveBeenCalledExactlyOnceWith("direct_select", { featureId: "added-1" });
      expect(result.current).toMatchObject({ editing: true, drawing: null });
      expect(store.getState().map.isMapGetInfoActive).toBe(false);
    });

    it("takes the edge dragged elsewhere for a new radius around the same centre", () => {
      const onDone = vi.fn();
      const { result, store } = renderDraw();
      act(() => result.current.editCircle(circle, onDone));
      act(() =>
        tool.reshape({
          type: "LineString",
          coordinates: [
            [11, 48],
            [11, 48.05],
          ],
        })
      );
      drawn();
      expect(line().coordinates[1]).toEqual([11, 48.05]);

      act(() => result.current.finish());

      // 0.05 degrees of latitude, to the meter.
      expect(onDone).toHaveBeenCalledExactlyOnceWith({ center: [11, 48], km: 5.56 });
      expect(tool.features.size).toBe(0);
      expectHandedBack(store);
    });

    it("takes the ring along with the centre dragged: the radius stays as it was", () => {
      const onDone = vi.fn();
      const { result } = renderDraw();
      act(() => result.current.editCircle(circle, onDone));
      const [, edge] = line().coordinates;
      act(() => tool.reshape({ type: "LineString", coordinates: [[11.2, 48.3], edge] }));
      drawn();

      expect(line().coordinates[0]).toEqual([11.2, 48.3]);
      expect(kmOf(line())).toBeCloseTo(3, 4);
      // Drawn again, it stays where it is.
      drawn();
      expect(line().coordinates[0]).toEqual([11.2, 48.3]);

      act(() => result.current.finish());
      expect(onDone).toHaveBeenCalledExactlyOnceWith({ center: [11.2, 48.3], km: 3 });
    });

    it("hands back a centre dragged just before the edit ended, before the tool drew it", () => {
      const onDone = vi.fn();
      const { result } = renderDraw();
      act(() => result.current.editCircle(circle, onDone));
      const [, edge] = line().coordinates;
      act(() => tool.reshape({ type: "LineString", coordinates: [[11.1234567, 48.2], edge] }));

      act(() => tool.clickOutside());

      expect(onDone).toHaveBeenCalledExactlyOnceWith({ center: [11.123457, 48.2], km: 3 });
    });

    it("keeps the line's two ends when a point was added between them", () => {
      const { result } = renderDraw();
      act(() => result.current.editCircle(circle, vi.fn()));
      const [center, edge] = line().coordinates;
      act(() => tool.reshape({ type: "LineString", coordinates: [center, [11.01, 48.01], [11.05, 48]] }));
      drawn();
      expect(line().coordinates).toEqual([center, [11.05, 48]]);
      expect(edge).not.toEqual([11.05, 48]);
    });

    it("leaves Delete and Backspace alone: the circle has no corner to remove", () => {
      const { result } = renderDraw();
      act(() => result.current.editCircle(circle, vi.fn()));
      keydown("Delete");
      keydown("Backspace");
      expect(tool.trash).not.toHaveBeenCalled();
      expect(result.current.editing).toBe(true);
    });

    it("Escape gives up: nothing comes back and the line is gone", () => {
      const onDone = vi.fn();
      const { result, store } = renderDraw();
      act(() => result.current.editCircle(circle, onDone));
      keydown("Escape");
      expect(onDone).not.toHaveBeenCalled();
      expect(result.current.editing).toBe(false);
      expect(tool.features.size).toBe(0);
      expectHandedBack(store);
    });

    it("keeps the old circle when the edge was dragged onto the centre", () => {
      const onDone = vi.fn();
      const { result } = renderDraw();
      act(() => result.current.editCircle(circle, onDone));
      act(() =>
        tool.reshape({
          type: "LineString",
          coordinates: [
            [11, 48],
            [11, 48],
          ],
        })
      );
      act(() => result.current.finish());
      expect(onDone).not.toHaveBeenCalled();
      expect(result.current.editing).toBe(false);
      expect(tool.features.size).toBe(0);
    });
  });
});
