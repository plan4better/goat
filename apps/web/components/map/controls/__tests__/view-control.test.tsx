// The View button and its popover (3D spec 8.2): 2D | 3D and Globe always, Terrain, Exaggeration and 3D buildings in
// 3D where the map has them, the Sky and atmosphere row for editors.
import { configureStore } from "@reduxjs/toolkit";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";

import { initView, mapReducer } from "@/lib/store/map/slice";
import type { ViewMode } from "@/lib/scene/view";

import { SceneStoreProvider, useSceneDocument, useSceneStoreContext } from "@/hooks/map/useSceneStore";

import { ViewControl } from "@/components/map/controls/ViewControl";
import { ViewPanel, type ViewPanelProps } from "@/components/map/controls/view/ViewPanel";
import { renderWithProviders } from "@/components/map/panels/styleEditor/__tests__/renderPanel";

const fakeMap = {
  getZoom: () => 12,
  getPitch: () => 0,
  getBearing: () => 0,
  getStyle: () => ({ version: 8, sources: {}, layers: [] }),
  on: vi.fn(),
  off: vi.fn(),
};
const support = vi.hoisted(() => ({ value: "hardware" as "hardware" | "software" | "none" }));
vi.mock("@/lib/scene/support", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  graphicsSupport: () => support.value,
  shownMode: (mode: "2d" | "3d") => (support.value === "software" ? "2d" : mode),
}));

vi.mock("react-map-gl/maplibre", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMap: () => ({ map: { getMap: () => fakeMap } }),
}));

let sceneSeen: unknown;
function SceneSpy() {
  sceneSeen = useSceneDocument(useSceneStoreContext());
  return null;
}

function setup(ui: ReactNode, mode: ViewMode = "2d") {
  const store = configureStore({ reducer: { map: mapReducer } });
  store.dispatch(initView({ projectId: "p1", mode, projection: "mercator" }));
  const result = renderWithProviders(
    <Provider store={store}>
      <SceneStoreProvider projectId="p1" initial={undefined} editable={false}>
        {ui}
        <SceneSpy />
      </SceneStoreProvider>
    </Provider>
  );
  return { ...result, store };
}

const panel = (props: Partial<ViewPanelProps> = {}) => (
  <ViewPanel
    terrainUrl="https://dem.example/{z}/{x}/{y}.webp"
    hasBuildings
    projectExtrudes={false}
    showSky
    onClose={() => undefined}
    onOpenSky={() => undefined}
    {...props}
  />
);

describe("ViewPanel", () => {
  it("shows 2D | 3D and Globe in 2D, nothing of 3D", () => {
    setup(panel());
    expect(screen.getByRole("radiogroup", { name: "view3d.map_view" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "view3d.globe" })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "view3d.terrain" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "view3d.buildings" })).toBeNull();
    expect(screen.queryByText("view3d.hint")).toBeNull();
    // Sky and atmosphere shows in 2D only with Globe on.
    expect(screen.queryByText("view3d.sky")).toBeNull();
  });

  it("switches to 3D in the map slice", async () => {
    const { store } = setup(panel());
    await userEvent.click(screen.getByRole("radio", { name: "view3d.mode_3d" }));
    expect(store.getState().map.view?.mode).toBe("3d");
  });

  it("shows Terrain, Exaggeration, 3D buildings, Sky and atmosphere and the hint in 3D", () => {
    setup(panel(), "3d");
    expect(screen.getByRole("switch", { name: "view3d.terrain" })).toHaveProperty("checked", true);
    expect(screen.getByRole("slider", { name: "view3d.exaggeration" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "view3d.buildings" })).toHaveProperty("checked", true);
    expect(screen.getByText("view3d.sky")).toBeTruthy();
    expect(screen.getByText("view3d.auto")).toBeTruthy();
    expect(screen.getByText("view3d.hint")).toBeTruthy();
  });

  it("hides the rows the map has no source for, and their divider", () => {
    setup(panel({ terrainUrl: undefined, hasBuildings: false }), "3d");
    expect(screen.queryByRole("switch", { name: "view3d.terrain" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "view3d.buildings" })).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("turns terrain off and sets its exaggeration", async () => {
    setup(panel(), "3d");
    const slider = screen.getByRole("slider", { name: "view3d.exaggeration" });
    fireEvent.change(slider, { target: { value: 2 } });
    expect(sceneSeen).toEqual({ terrain: { exaggeration: 2 } });
    expect(screen.getByText("2x")).toBeTruthy();
    await userEvent.click(screen.getByRole("switch", { name: "view3d.terrain" }));
    expect(sceneSeen).toEqual({ terrain: false });
    expect(screen.queryByRole("slider", { name: "view3d.exaggeration" })).toBeNull();
  });

  it("starts 3D buildings off when a project layer extrudes, and remembers a choice", async () => {
    setup(panel({ projectExtrudes: true }), "3d");
    const buildings = screen.getByRole("switch", { name: "view3d.buildings" });
    expect(buildings).toHaveProperty("checked", false);
    await userEvent.click(buildings);
    expect(sceneSeen).toEqual({ buildings: true });
  });

  it("sets the buildings' opacity under their switch and keeps it when they go off", async () => {
    setup(panel(), "3d");
    const slider = screen.getByRole("slider", { name: "view3d.buildings_opacity" });
    expect(slider.getAttribute("aria-valuetext")).toBe("60%");
    fireEvent.change(slider, { target: { value: 35 } });
    expect(sceneSeen).toEqual({ buildings: { opacity: 0.35 } });
    expect(screen.getByText("35%")).toBeTruthy();
    await userEvent.click(screen.getByRole("switch", { name: "view3d.buildings" }));
    expect(sceneSeen).toEqual({ buildings: { on: false, opacity: 0.35 } });
    expect(screen.queryByRole("slider", { name: "view3d.buildings_opacity" })).toBeNull();
  });

  it("shows a saved 3D view in 2D and turns 3D off where 3D is drawn in software", () => {
    support.value = "software";
    const { store } = setup(panel(), "3d");
    expect(screen.getByRole("radio", { name: "view3d.mode_2d" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "view3d.mode_3d" })).toHaveProperty("disabled", true);
    expect(screen.getByText("view3d.needs_acceleration")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "view3d.globe" })).toHaveProperty("disabled", false);
    // The saved mode stays.
    expect(store.getState().map.view?.mode).toBe("3d");
    support.value = "hardware";
  });

  it("leaves out Sky and atmosphere for viewers", () => {
    setup(panel({ showSky: false }), "3d");
    expect(screen.queryByText("view3d.sky")).toBeNull();
  });
});

describe("ViewControl", () => {
  it("opens the View popover from its round button", async () => {
    setup(<ViewControl showSky />);
    const button = screen.getByRole("button", { name: "view3d.title" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const popover = screen.getByRole("dialog", { name: "view3d.title" });
    expect(within(popover).getByRole("radiogroup", { name: "view3d.map_view" })).toBeTruthy();
    await userEvent.click(within(popover).getByRole("button", { name: "style_editor.close" }));
    expect(screen.queryByRole("dialog", { name: "view3d.title" })).toBeNull();
  });
});
