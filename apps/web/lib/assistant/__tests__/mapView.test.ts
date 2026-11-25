import { afterEach, describe, expect, it, vi } from "vitest";

import { fakeMap } from "@/lib/assistant/__tests__/fakeMap";
import { applyMapView, applyViewTarget, mapViewport, projectMapContext } from "@/lib/assistant/mapView";

describe("map view helpers", () => {
  it("rounds and clamps the viewport to what the server accepts", () => {
    expect(
      mapViewport(
        fakeMap({
          lng: 13.4049871234,
          lat: 52.5200061234,
          zoom: 26.3,
          pitch: 95,
          bounds: [-200, -91, 200, 91],
        })
      )
    ).toEqual({
      center: [13.40499, 52.52001],
      zoom: 24,
      bearing: 0,
      pitch: 90,
      bbox: [-180, -90, 180, 90],
    });
  });

  it("wraps a center panned across world copies to its real longitude", () => {
    expect(mapViewport(fakeMap({ lng: 370, lat: 52, zoom: 3 })).center).toEqual([10, 52]);
    expect(mapViewport(fakeMap({ lng: -350, lat: 52, zoom: 3 })).center).toEqual([10, 52]);
  });

  it("drops the bbox of a view across the antimeridian and keeps the context valid", () => {
    const map = fakeMap({ lng: 180, lat: 0, zoom: 4, bounds: [170, -10, -170, 10] });
    const viewport = mapViewport(map);
    expect(viewport.bbox).toBeUndefined();
    expect(projectMapContext({ projectId: "p1", map, activeLayerId: null })).toEqual({
      surface: "project.map",
      project_id: "p1",
      viewport: { center: [-180, 0], zoom: 4, bearing: 0, pitch: 0 },
    });
  });

  it("names the selected layer only when one is selected", () => {
    const map = fakeMap({ lng: 13, lat: 52, zoom: 10 });
    expect(projectMapContext({ projectId: "p1", map, activeLayerId: 4 })).toMatchObject({
      surface: "project.map",
      project_id: "p1",
      selected_layer_project_id: 4,
    });
    expect(projectMapContext({ projectId: "p1", map: null, activeLayerId: -1 })).toEqual({
      surface: "project.map",
      project_id: "p1",
    });
  });

  it("puts basemap, basemaps, view_mode and projection into the map context", () => {
    const dark = { id: "dark", name: "Dark", tone: "dark", imagery: false } as const;
    const satellite = { id: "satellite", name: "Satellite", tone: "dark", imagery: true } as const;
    expect(
      projectMapContext({
        projectId: "p1",
        map: null,
        activeLayerId: null,
        basemap: dark,
        basemaps: [dark, satellite],
        viewMode: "3d",
        projection: "globe",
      })
    ).toEqual({
      surface: "project.map",
      project_id: "p1",
      basemap: dark,
      basemaps: [dark, satellite],
      view_mode: "3d",
      projection: "globe",
    });
  });

  it("leaves the keys out when the page does not know them", () => {
    const expected = { surface: "project.map", project_id: "p1" };
    expect(projectMapContext({ projectId: "p1", map: null, activeLayerId: null })).toEqual(expected);
    expect(
      projectMapContext({ projectId: "p1", map: null, activeLayerId: null, basemap: undefined, basemaps: [] })
    ).toEqual(expected);
    // An active basemap the server would refuse is left out rather than sent.
    expect(
      projectMapContext({
        projectId: "p1",
        map: null,
        activeLayerId: null,
        basemap: { id: "x".repeat(65), name: "Too long", tone: "light", imagery: false },
      })
    ).toEqual(expected);
    expect(
      projectMapContext({
        projectId: "p1",
        map: null,
        activeLayerId: null,
        basemap: { id: "unnamed", name: "", tone: "light", imagery: false },
      })
    ).toEqual(expected);
  });

  it("flies to a camera or fits a bbox, and flies back on undo", () => {
    const map = fakeMap({ lng: 11.5, lat: 48.1, zoom: 9, bearing: 10, pitch: 20 });
    const undo = applyMapView(map, {
      project_id: "p1",
      camera: { center: [13.4, 52.5], zoom: 12, bearing: 0, pitch: 0 },
      bbox: null,
      layer_project_id: null,
    });
    expect(map.flyTo).toHaveBeenCalledWith({ center: [13.4, 52.5], zoom: 12, bearing: 0, pitch: 0 });
    undo();
    expect(map.flyTo).toHaveBeenLastCalledWith({ center: [11.5, 48.1], zoom: 9, bearing: 10, pitch: 20 });

    applyMapView(map, {
      project_id: "p1",
      camera: null,
      bbox: [13.1, 52.3, 13.8, 52.7],
      layer_project_id: 3,
    });
    expect(map.fitBounds).toHaveBeenCalledWith(
      [
        [13.1, 52.3],
        [13.8, 52.7],
      ],
      { padding: 48, duration: 800 }
    );
  });
});

/** The page's view mode and projection, with spies on its two switches. */
function fakeView(mode: "2d" | "3d" = "2d", projection: "mercator" | "globe" = "mercator") {
  const state = { mode, projection };
  return {
    state,
    get: () => ({ ...state }),
    setMode: vi.fn((next: "2d" | "3d") => {
      state.mode = next;
    }),
    setProjection: vi.fn((next: "mercator" | "globe") => {
      state.projection = next;
    }),
  };
}

describe("applyViewTarget", () => {
  afterEach(() => vi.useRealTimers());

  it("flies to a camera, fits a box, sets mode and projection", () => {
    vi.useFakeTimers();
    const map = fakeMap({ lng: 11.5, lat: 48.1, zoom: 9, bearing: 10, pitch: 20 });
    const view = fakeView("3d");
    applyViewTarget(() => map, { camera: { center: [13.4, 52.5], zoom: 12 } }, view);
    expect(map.flyTo).toHaveBeenCalledWith({ center: [13.4, 52.5], zoom: 12 });
    // A camera without a centre keeps the map's.
    applyViewTarget(() => map, { camera: { pitch: 60, bearing: -30 } }, view);
    expect(map.flyTo).toHaveBeenLastCalledWith({ center: [11.5, 48.1], pitch: 60, bearing: -30 });
    applyViewTarget(() => map, { bbox: [13.1, 52.3, 13.8, 52.7] }, view);
    expect(map.fitBounds).toHaveBeenCalledWith(
      [
        [13.1, 52.3],
        [13.8, 52.7],
      ],
      { padding: 48, duration: 800 }
    );
    expect(view.setMode).not.toHaveBeenCalled();
    expect(view.setProjection).not.toHaveBeenCalled();

    map.flyTo.mockClear();
    applyViewTarget(() => map, { mode: "3d", projection: "globe" }, view);
    // The mode the page shows already is not set again; nothing moves the camera.
    expect(view.setMode).not.toHaveBeenCalled();
    expect(view.setProjection).toHaveBeenCalledWith("globe");
    applyViewTarget(() => map, { mode: "2d", projection: "globe" }, view);
    expect(view.setMode).toHaveBeenCalledWith("2d");
    expect(view.setProjection).toHaveBeenCalledTimes(1);
    vi.runAllTimers();
    expect(map.flyTo).not.toHaveBeenCalled();
  });

  it("moves the camera after the page's own switch of the mode, to the tilt that switch gives", () => {
    vi.useFakeTimers();
    const map = fakeMap({ lng: 11.5, lat: 48.1, zoom: 9 });
    const view = fakeView("2d");
    applyViewTarget(() => map, { mode: "3d", camera: { center: [13.4, 52.5], zoom: 12 } }, view);
    expect(view.setMode).toHaveBeenCalledWith("3d");
    // The page eases the camera when it draws the new mode: a move started before would be stopped by it.
    expect(map.flyTo).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(map.flyTo).toHaveBeenCalledTimes(1);
    expect(map.flyTo).toHaveBeenCalledWith({ center: [13.4, 52.5], zoom: 12, pitch: 55 });

    applyViewTarget(() => map, { mode: "2d", bbox: [13.1, 52.3, 13.8, 52.7] }, view);
    expect(map.fitBounds).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(map.fitBounds).toHaveBeenCalledWith(
      [
        [13.1, 52.3],
        [13.8, 52.7],
      ],
      { padding: 48, duration: 800, pitch: 0, bearing: 0 }
    );

    // A tilt the target names is kept.
    applyViewTarget(() => map, { mode: "3d", camera: { zoom: 14, pitch: 30 } }, view);
    vi.runAllTimers();
    expect(map.flyTo).toHaveBeenLastCalledWith({ center: [11.5, 48.1], zoom: 14, pitch: 30 });
  });

  it("moves at once when the page did not take the mode", () => {
    const map = fakeMap({ lng: 11.5, lat: 48.1, zoom: 9 });
    const view = { ...fakeView("2d"), setMode: vi.fn() };
    applyViewTarget(() => map, { mode: "3d", camera: { zoom: 12 } }, view);
    expect(view.setMode).toHaveBeenCalledWith("3d");
    expect(map.flyTo).toHaveBeenCalledWith({ center: [11.5, 48.1], zoom: 12 });
  });

  it("its undo puts camera, mode and projection back", () => {
    vi.useFakeTimers();
    const map = fakeMap({ lng: 11.5, lat: 48.1, zoom: 9, bearing: 10, pitch: 20 });
    const view = fakeView("3d", "globe");
    const undo = applyViewTarget(
      () => map,
      { camera: { center: [13.4, 52.5] }, projection: "mercator" },
      view
    );
    undo();
    expect(view.setProjection).toHaveBeenLastCalledWith("globe");
    expect(view.setMode).not.toHaveBeenCalled();
    expect(map.flyTo).toHaveBeenLastCalledWith({ center: [11.5, 48.1], zoom: 9, bearing: 10, pitch: 20 });

    // Back across a mode switch: the camera follows the page's own easing, a move still waiting is dropped.
    const flat = fakeMap({ lng: 11.5, lat: 48.1, zoom: 9 });
    const page = fakeView("2d");
    const back = applyViewTarget(() => flat, { mode: "3d", camera: { zoom: 12 } }, page);
    back();
    expect(page.setMode).toHaveBeenLastCalledWith("2d");
    expect(page.state).toEqual({ mode: "2d", projection: "mercator" });
    vi.runAllTimers();
    expect(flat.flyTo).toHaveBeenCalledTimes(1);
    expect(flat.flyTo).toHaveBeenCalledWith({ center: [11.5, 48.1], zoom: 9, bearing: 0, pitch: 0 });
  });

  it("its undo moves the map drawn now, and no camera while none is drawn", () => {
    vi.useFakeTimers();
    const first = fakeMap({ lng: 11.5, lat: 48.1, zoom: 9 });
    let drawn: ReturnType<typeof fakeMap> | null = first;
    const view = fakeView("2d");
    const undo = applyViewTarget(() => drawn, { camera: { center: [13.4, 52.5], zoom: 12 } }, view);
    expect(first.flyTo).toHaveBeenCalledTimes(1);
    // The page drew its map again (a switch to Workflows and back).
    const again = fakeMap({ lng: 13.4, lat: 52.5, zoom: 12 });
    drawn = again;
    undo();
    expect(first.flyTo).toHaveBeenCalledTimes(1);
    expect(again.flyTo).toHaveBeenCalledWith({ center: [11.5, 48.1], zoom: 9, bearing: 0, pitch: 0 });

    // A move that waits for a mode switch reads the map when it starts.
    const back = applyViewTarget(() => drawn, { mode: "3d", camera: { zoom: 14 } }, view);
    drawn = null;
    vi.runAllTimers();
    expect(again.flyTo).toHaveBeenCalledTimes(1);
    // Without a map the mode and projection still go back.
    expect(() => back()).not.toThrow();
    expect(view.state.mode).toBe("2d");
  });
});
