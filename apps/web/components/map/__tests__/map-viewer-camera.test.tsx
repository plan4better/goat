// MapViewer's camera per mode (3D spec 7.1): 2D cannot tilt or rotate, 3D tilts to 85; a saved tilt opens in 3D.
import { ThemeProvider, createTheme } from "@mui/material";
import { configureStore } from "@reduxjs/toolkit";
import { act, render } from "@testing-library/react";
import { Provider } from "react-redux";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { featureEditorReducer } from "@/lib/store/featureEditor/slice";
import { mapReducer } from "@/lib/store/map/slice";

import MapViewer from "@/components/map/MapViewer";

const { recorded } = vi.hoisted(() => ({
  recorded: { map: {} as Record<string, unknown>, scene: {} as Record<string, unknown> },
}));

vi.mock("react-map-gl/maplibre", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Map: (props: Record<string, unknown>) => {
    recorded.map = props;
    return null;
  },
}));
vi.mock("@/hooks/map/useScene", () => ({
  useScene: (_map: unknown, inputs: Record<string, unknown>) => {
    recorded.scene = inputs;
    return null;
  },
}));
vi.mock("@/hooks/map/useFeatureEditor", () => ({ useFeatureEditor: () => ({}) }));
vi.mock("@/hooks/map/useRenderLayers", () => ({ useRenderLayers: () => [] }));

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

beforeEach(() => {
  recorded.map = {};
  recorded.scene = {};
});

const viewer = (props: Partial<React.ComponentProps<typeof MapViewer>> = {}) => {
  const store = configureStore({ reducer: { map: mapReducer, featureEditor: featureEditorReducer } });
  return render(
    <ThemeProvider theme={createTheme()}>
      <Provider store={store}>
        <MapViewer mapRef={null} layers={[]} mapStyle="https://tiles.example/style.json" {...props} />
      </Provider>
    </ThemeProvider>
  );
};

describe("MapViewer camera", () => {
  it("2D: no tilt, no rotation", () => {
    viewer({ mode: "2d" });
    expect(recorded.map).toMatchObject({ maxPitch: 0, dragRotate: false, touchPitch: false });
    expect(recorded.scene).toMatchObject({ mode: "2d", projection: "mercator" });
  });

  it("3D: tilts to 85 and rotates", () => {
    viewer({ mode: "3d", projection: "globe" });
    expect(recorded.map).toMatchObject({
      maxPitch: 85,
      dragRotate: true,
      touchPitch: true,
      touchZoomRotate: true,
    });
    expect(recorded.scene).toMatchObject({ mode: "3d", projection: "globe" });
  });

  it("starts the map in the saved projection and mode, without an ease", () => {
    viewer({
      mode: "3d",
      projection: "globe",
      initialViewState: { pitch: 55, zoom: 3, latitude: 47.49, longitude: 11.09 },
    });
    expect(recorded.map).toMatchObject({ projection: { type: "globe" }, maxPitch: 85 });
    expect((recorded.map.initialViewState as { pitch: number }).pitch).toBe(55);
  });

  it("maxPitch follows the view", () => {
    viewer({ initialViewState: { pitch: 75, zoom: 14, latitude: 47.49, longitude: 11.09 } });
    expect(recorded.map).toMatchObject({ maxPitch: 85 });
    expect(recorded.scene).toMatchObject({ mode: "3d" });
  });

  it("an untilted view without a mode is 2D", () => {
    viewer({ initialViewState: { zoom: 14, latitude: 47.49, longitude: 11.09 } });
    expect(recorded.map).toMatchObject({ maxPitch: 0 });
  });

  it("says so when the map cannot start, and logs the map's own errors", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = viewer({ mode: "2d" });
    const onError = recorded.map.onError as (e: { target: unknown; error: Error }) => void;
    act(() => onError({ target: {}, error: new Error("tile 404") }));
    expect(view.queryByRole("alert")).toBeNull();
    act(() => onError({ target: null, error: new Error("Failed to initialize WebGL") }));
    expect(view.getByRole("alert").textContent).toBe("view3d.needs_webgl");
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it("does not log a basemap style's source layers its tiles lack as errors, but a project layer's", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    viewer({ mode: "2d" });
    const onError = recorded.map.onError as (e: { target: unknown; error: Error }) => void;
    const missing = (source: string, layer: string) =>
      new Error(
        `Source layer "aeroway" does not exist on source "${source}" as specified by style layer "${layer}".`
      );
    act(() => onError({ target: {}, error: missing("smarttiles_wld", "wrVerkehrsflaeche_Flugverkehr") }));
    act(() => onError({ target: {}, error: missing("smarttiles_wld", "wrVerkehrsflaeche_Flugverkehr") }));
    expect(error).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
    act(() => onError({ target: {}, error: missing("src-abc", "lyr-abc") }));
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
    debug.mockRestore();
  });
});
