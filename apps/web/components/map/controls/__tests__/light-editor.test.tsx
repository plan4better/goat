// The Light popover (3D spec 8.3): the light's direction and height on a sky chart and two sliders, then its
// intensity and colour. The automatic light stands with the camera: the first edit writes it as the light on the map it
// is for the camera then.
import { fireEvent, screen } from "@testing-library/react";
import type { Map as MaplibreMap } from "maplibre-gl";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { SceneLight } from "@/lib/style/generated/types";

import { useSceneStoreContext } from "@/hooks/map/useSceneStore";

import { LightEditor, lightSummary } from "@/components/map/controls/view/LightEditor";
import { EMPTY_DATA, StyleEditorProvider } from "@/components/map/panels/styleEditor/context";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";

import { english, renderControl, seen } from "./english";

const camera = { zoom: 14, bearing: 0 };
const map = { getZoom: () => camera.zoom, getBearing: () => camera.bearing } as unknown as MaplibreMap;

function Editor() {
  const store = useSceneStoreContext();
  if (!store) return null;
  return (
    <StyleEditorProvider store={store} data={EMPTY_DATA} mapZoom={camera.zoom} map={map}>
      <PopoverProvider>
        <div data-style-panel>
          <LightEditor look={{ tone: "light" }} />
        </div>
      </PopoverProvider>
    </StyleEditorProvider>
  );
}

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

describe("LightEditor", () => {
  it("sets the light by direction and height only", () => {
    renderControl(<Editor />, { scene: { light: { direction: 225, altitude: 30 } } });
    expect(screen.queryByRole("radio", { name: "Sun position" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Now" })).toBeNull();
    const height = screen.getByRole("slider", { name: "Height" });
    expect([height.getAttribute("min"), height.getAttribute("max")]).toEqual(["0", "90"]);
    const direction = screen.getByRole("slider", { name: "Direction" });
    expect([direction.getAttribute("min"), direction.getAttribute("max")]).toEqual(["0", "355"]);
    fireEvent.change(direction, { target: { value: 90 } });
    expect(seen.scene?.light).toMatchObject({ direction: 90, altitude: 30 });
  });

  it("moves the light with the arrow keys on the chart, writing the automatic light whole as it stands", () => {
    Object.assign(camera, { zoom: 14, bearing: 0 });
    renderControl(<Editor />, { scene: {} });
    // The automatic light: from 210 degrees of the view, 30 degrees from straight above at city zoom.
    const chart = screen.getByRole("img", { name: /^Light 60 degrees above the horizon, from 210 degrees/ });
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    expect(seen.scene?.light).toEqual({
      direction: 215,
      altitude: 60,
      intensity: 0.45,
      color: "#FFFFFF",
    });
    fireEvent.keyDown(chart, { key: "ArrowUp" });
    expect(seen.scene?.light).toMatchObject({ direction: 215, altitude: 65 });
  });

  it("seeds the first edit from the automatic light turned with the map and raised for the zoom", () => {
    Object.assign(camera, { zoom: 7.5, bearing: 200 });
    renderControl(<Editor />, { scene: {} });
    // Viewport azimuth 210 on a map turned 200: from 50 on the map; polar 15 at zoom 7.5: 75 above the horizon.
    const chart = screen.getByRole("img", { name: /^Light 75 degrees above the horizon, from 50 degrees/ });
    fireEvent.keyDown(chart, { key: "ArrowUp" });
    expect(seen.scene?.light).toEqual({ direction: 50, altitude: 80, intensity: 0.45, color: "#FFFFFF" });
  });

  it("summarizes the light by its direction, the automatic one as standing with the camera", () => {
    const t = english.getFixedT("en", "common");
    expect(lightSummary({ direction: 225, altitude: 30 } as SceneLight, t)).toBe("Direction 225°, 30°");
    expect(lightSummary(null, t)).toBe("Auto · from the camera");
  });
});
