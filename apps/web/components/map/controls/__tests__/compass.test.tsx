// The compass (3D spec 7.1, 8.1): shown while the map is tilted or rotated; the first click faces north, the next
// returns to 2D.
import { ThemeProvider, createTheme } from "@mui/material";
import { configureStore } from "@reduxjs/toolkit";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";

import en from "@/i18n/locales/en/common.json";
import { initView, mapReducer } from "@/lib/store/map/slice";

import { Compass, TILT_PER_PX, TURN_PER_PX, needleTransform } from "@/components/map/controls/Compass";

const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  lng: "en",
  ns: ["common"],
  defaultNS: "common",
  resources: { en: { common: en } },
  initImmediate: false,
  react: { useSuspense: false },
});

const camera = { pitch: 0, bearing: 0 };
const handlers = new Map<string, Set<() => void>>();
const moved = () => handlers.get("move")?.forEach((h) => h());
const fakeMap = {
  getPitch: () => camera.pitch,
  getBearing: () => camera.bearing,
  resetNorthPitch: vi.fn(() => {
    camera.bearing = 0;
    camera.pitch = 0;
    moved();
  }),
  jumpTo: vi.fn((to: { bearing: number; pitch: number }) => {
    camera.bearing = to.bearing;
    camera.pitch = to.pitch;
    moved();
  }),
  on: (type: string, h: () => void) => handlers.set(type, (handlers.get(type) ?? new Set()).add(h)),
  off: (type: string, h: () => void) => handlers.get(type)?.delete(h),
};
vi.mock("react-map-gl/maplibre", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMap: () => ({ map: { getMap: () => fakeMap } }),
}));

function setup(pitch: number, bearing: number, mode: "2d" | "3d" = pitch > 0 ? "3d" : "2d") {
  camera.pitch = pitch;
  camera.bearing = bearing;
  fakeMap.resetNorthPitch.mockClear();
  fakeMap.jumpTo.mockClear();
  const store = configureStore({ reducer: { map: mapReducer } });
  store.dispatch(initView({ projectId: "p1", mode, projection: "mercator" }));
  render(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider theme={createTheme()}>
        <Provider store={store}>
          <Compass />
        </Provider>
      </ThemeProvider>
    </I18nextProvider>
  );
  return store;
}

const ACTION = "Drag to rotate map, click to reset north";

describe("Compass", () => {
  it("hides in 2D on a map facing north, shows in 3D even flat", () => {
    setup(0, 0, "2d");
    expect(screen.queryByRole("button", { name: /^Facing/ })).toBeNull();
    cleanup();
    setup(0, 0, "3d");
    expect(screen.getByRole("button", { name: `Facing north, tilted 0°. ${ACTION}` })).toBeTruthy();
  });

  it("a click faces north and lays the map flat, staying in 3D; no chip", async () => {
    const store = setup(55, -20);
    expect(screen.queryByText(/Tilt 55/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: `Facing 340° N, tilted 55°. ${ACTION}` }));
    expect(fakeMap.resetNorthPitch).toHaveBeenCalledTimes(1);
    expect(store.getState().map.view?.mode).toBe("3d");
  });

  it("shows the tilt and the heading on its needle, as MapLibre's compass", () => {
    setup(55, -20);
    expect(screen.getByTestId("compass-needle").style.transform).toBe(needleTransform(55, -20));
    expect(needleTransform(55, -20)).toMatch(/^scale\(1\.32\d*\) rotateX\(55deg\) rotateZ\(20deg\)$/);
  });

  it("a press that moves less than the threshold is a click; more turns and tilts the map", () => {
    setup(55, -20);
    const button = () => screen.getByRole("button", { name: /^Facing/ });
    fireEvent.pointerDown(button(), { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(button(), { clientX: 101, clientY: 101, pointerId: 1 });
    fireEvent.pointerUp(button(), { pointerId: 1 });
    fireEvent.click(button());
    expect(fakeMap.jumpTo).not.toHaveBeenCalled();
    expect(fakeMap.resetNorthPitch).toHaveBeenCalledTimes(1);

    act(() => {
      camera.pitch = 55;
      camera.bearing = -20;
      moved();
    });
    fireEvent.pointerDown(button(), { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(button(), { clientX: 150, clientY: 80, pointerId: 1 });
    expect(fakeMap.jumpTo).toHaveBeenLastCalledWith({
      bearing: -20 + 50 * TURN_PER_PX,
      pitch: 55 + 20 * TILT_PER_PX,
    });
    fireEvent.pointerUp(button(), { pointerId: 1 });
    fireEvent.click(button());
    expect(fakeMap.resetNorthPitch).toHaveBeenCalledTimes(1);
  });
});
