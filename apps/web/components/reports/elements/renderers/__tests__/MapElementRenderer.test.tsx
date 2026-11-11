// A report map element in 3D (3D spec 10): a tilted view prints tilted with the project's scene, an atlas page flat.
import { ThemeProvider, createTheme } from "@mui/material";
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AtlasPage } from "@/lib/print/atlas-utils";
import type { ReportElement } from "@/lib/validations/reportLayout";

import MapElementRenderer from "@/components/reports/elements/renderers/MapElementRenderer";

const { recorded } = vi.hoisted(() => ({
  recorded: {
    map: {} as Record<string, unknown>,
    scene: {} as Record<string, unknown>,
    compiled: null as object | null,
  },
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
    return recorded.compiled;
  },
}));

beforeEach(() => {
  recorded.map = {};
  recorded.scene = {};
  recorded.compiled = null;
});

const element = (viewState: Record<string, unknown>, config: Record<string, unknown> = {}) =>
  ({
    id: "map-1",
    type: "map",
    position: { x: 0, y: 0, width: 200, height: 150, z_index: 0 },
    config: { viewState, ...config },
  }) as unknown as ReportElement;

const TILTED = { latitude: 47.49, longitude: 11.09, zoom: 13, bearing: 30, pitch: 75 };
const SCENE = { terrain: { exaggeration: 2 } };

const renderMap = (props: Partial<React.ComponentProps<typeof MapElementRenderer>>) =>
  render(
    <ThemeProvider theme={createTheme()}>
      <MapElementRenderer element={element(TILTED)} viewOnly {...props} />
    </ThemeProvider>
  );

describe("MapElementRenderer in 3D", () => {
  it("maxPitch follows the view: a tilted map prints at its pitch, in 3D, with the project's scene", () => {
    renderMap({ scene: SCENE });
    expect(recorded.map).toMatchObject({ pitch: 75, bearing: 30, maxPitch: 85 });
    expect(recorded.scene).toMatchObject({ mode: "3d", scene: SCENE, tone: "light" });
  });

  it("a flat map stays 2D and cannot be tilted", () => {
    renderMap({ element: element({ ...TILTED, pitch: 0 }) });
    expect(recorded.map).toMatchObject({ pitch: 0, maxPitch: 0 });
    expect(recorded.scene).toMatchObject({ mode: "2d" });
  });

  it("an atlas page stays flat even when the view is tilted, with the bearing the element gives", () => {
    const page = {
      index: 0,
      pageNumber: 1,
      totalPages: 1,
      label: "1",
      bounds: [11.0, 47.4, 11.2, 47.6],
      center: [11.1, 47.5],
    } as AtlasPage;
    renderMap({ element: element(TILTED, { atlas: { enabled: true, mode: "best_fit" } }), atlasPage: page });
    expect(recorded.map).toMatchObject({ pitch: 0, bearing: 30, maxPitch: 0 });
    expect(recorded.scene).toMatchObject({ mode: "2d" });
  });

  it("a tilted print is ready only once the scene is on the map", () => {
    const ready = vi.fn();
    const { rerender } = renderMap({ scene: SCENE, onMapLoaded: ready });
    const fire = (name: "onLoad" | "onIdle") => act(() => (recorded.map[name] as () => void)());
    fire("onLoad");
    fire("onIdle");
    expect(ready).not.toHaveBeenCalled();
    recorded.compiled = {};
    rerender(
      <ThemeProvider theme={createTheme()}>
        <MapElementRenderer element={element(TILTED)} viewOnly scene={SCENE} onMapLoaded={ready} />
      </ThemeProvider>
    );
    fire("onIdle");
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("a flat print is ready on the first idle", () => {
    const ready = vi.fn();
    renderMap({ element: element({ ...TILTED, pitch: 0 }), onMapLoaded: ready });
    act(() => (recorded.map.onLoad as () => void)());
    act(() => (recorded.map.onIdle as () => void)());
    expect(ready).toHaveBeenCalledTimes(1);
  });
});
