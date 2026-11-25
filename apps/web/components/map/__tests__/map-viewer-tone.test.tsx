// MapViewer draws the project layers for the tone of the basemap it shows, which every map passes: not the active
// basemap's, which a preview with a basemap of its own does not draw.
import { ThemeProvider, createTheme } from "@mui/material";
import { configureStore } from "@reduxjs/toolkit";
import { render } from "@testing-library/react";
import { Children, type ReactNode, isValidElement } from "react";
import { Provider } from "react-redux";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { BASEMAPS } from "@/lib/constants/basemaps";
import { featureEditorReducer } from "@/lib/store/featureEditor/slice";
import { mapReducer, setActiveBasemap } from "@/lib/store/map/slice";

import MapViewer from "@/components/map/MapViewer";

const { recorded, StyledLayersMock } = vi.hoisted(() => {
  const recorded = { tone: undefined as string | undefined };
  const StyledLayersMock = (props: { tone: string }) => {
    recorded.tone = props.tone;
    return null;
  };
  return { recorded, StyledLayersMock };
});

vi.mock("@/components/map/StyledLayers", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  StyledLayers: StyledLayersMock,
}));
// The map renders only the project layers among its children: the others need a real map.
vi.mock("react-map-gl/maplibre", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Map: ({ children }: { children?: ReactNode }) => (
    <>{Children.toArray(children).filter((c) => isValidElement(c) && c.type === StyledLayersMock)}</>
  ),
}));
vi.mock("@/hooks/map/useScene", () => ({ useScene: () => null }));
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
  recorded.tone = undefined;
});

const viewer = (layerTone: "light" | "dark", active?: string) => {
  const store = configureStore({ reducer: { map: mapReducer, featureEditor: featureEditorReducer } });
  const basemap = BASEMAPS.find((b) => b.value === active);
  if (basemap) store.dispatch(setActiveBasemap({ basemap, projectId: "p1" }));
  return render(
    <ThemeProvider theme={createTheme({ palette: { mode: "dark" } })}>
      <Provider store={store}>
        <MapViewer
          mapRef={null}
          layers={[]}
          mapStyle="https://tiles.example/style.json"
          layerTone={layerTone}
          basemap={BASEMAPS.find((b) => b.value === "streets")}
        />
      </Provider>
    </ThemeProvider>
  );
};

describe("MapViewer and the basemap's tone", () => {
  it("draws the layers for the tone it is given, whatever the active basemap, the scene's basemap or the theme", () => {
    viewer("dark", "light");
    expect(recorded.tone).toBe("dark");
    viewer("light", "dark");
    expect(recorded.tone).toBe("light");
    viewer("dark");
    expect(recorded.tone).toBe("dark");
  });
});
