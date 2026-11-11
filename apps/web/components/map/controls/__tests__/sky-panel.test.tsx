// The Sky and atmosphere panel (3D spec 8.3): automatic and read only by default; with Auto off its sections open the
// style editor's popovers, whose first edit writes the whole section from the values shown. Turning Auto off changes
// nothing on the map; the automatic fog is none, and the Fog popover turns one on.
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ViewControl } from "@/components/map/controls/ViewControl";

import { renderControl, seen } from "./english";

const camera = { zoom: 15, pitch: 75 };
const fakeMap = {
  getZoom: () => camera.zoom,
  getPitch: () => camera.pitch,
  getBearing: () => 0,
  getCenter: () => ({ lng: 13.4, lat: 52.52 }),
  getStyle: () => ({ version: 8, sources: {}, layers: [] }),
  on: vi.fn(),
  off: vi.fn(),
  easeTo: vi.fn(),
  jumpTo: vi.fn(),
};
vi.mock("react-map-gl/maplibre", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMap: () => ({ map: { getMap: () => fakeMap } }),
}));

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

async function openSky(opts: Parameters<typeof renderControl>[1] = {}, at = { zoom: 15, pitch: 75 }) {
  Object.assign(camera, at);
  fakeMap.easeTo.mockClear();
  const rendered = renderControl(<ViewControl showSky />, opts);
  await userEvent.click(screen.getByRole("button", { name: "View" }));
  await userEvent.click(screen.getByRole("button", { name: /Sky and atmosphere/ }));
  return Object.assign(screen.getByRole("dialog", { name: "Sky and atmosphere" }), { redux: rendered.store });
}

const autoSwitch = () => screen.getByRole("switch", { name: "Auto, colors follow the basemap" });

describe("Sky and atmosphere", () => {
  it("shows the automatic values read only, with Fog only while terrain is on", async () => {
    const panel = await openSky();
    expect(autoSwitch()).toHaveProperty("checked", true);
    for (const text of ["Blend 60%", "Off", "100%", "Auto · from the camera"])
      expect(within(panel).getByText(text)).toBeTruthy();
    expect(within(panel).getByText("Turn off Auto to set your own colors, glow and light.")).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: /^Sky/ })).toBeNull();
  });

  it("leaves out Fog without terrain", async () => {
    const panel = await openSky({ scene: { terrain: false } });
    expect(within(panel).queryByText("Fog")).toBeNull();
    expect(within(panel).getByText("Globe glow")).toBeTruthy();
  });

  it("writes nothing when Auto goes off, so the map keeps its look, and resets all four sections", async () => {
    const panel = await openSky();
    await userEvent.click(autoSwitch());
    expect(seen.scene?.sky ?? seen.scene?.fog ?? seen.scene?.glow ?? seen.scene?.light).toBeUndefined();
    expect(autoSwitch()).toHaveProperty("checked", false);
    expect(within(panel).getByRole("button", { name: /^Sky/ })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: /^Light, Auto · from the camera/ })).toBeTruthy();
    await userEvent.click(within(panel).getByRole("button", { name: /^Globe glow/ }));
    const mode = () => screen.getByRole("button", { name: /^Strength: .*Change how the value is set\.$/ });
    await userEvent.click(mode());
    await userEvent.click(within(screen.getByRole("menu")).getByText("By zoom"));
    expect(seen.scene?.glow?.strength).toHaveProperty("zoom");
    await userEvent.click(within(panel).getByRole("button", { name: "Reset to auto" }));
    expect(seen.scene).toEqual({});
    expect(autoSwitch()).toHaveProperty("checked", true);
  });

  it("writes the whole sky on its first edit, and its popover resets the sky only", async () => {
    const panel = await openSky();
    await userEvent.click(autoSwitch());
    await userEvent.click(within(panel).getByRole("button", { name: /^Sky/ }));
    const popover = screen.getByText("Sky to horizon").closest("[data-popover-frame]") as HTMLElement;
    fireEvent.change(within(popover).getByRole("slider", { name: "Sky to horizon" }), {
      target: { value: 0.5 },
    });
    expect(seen.scene?.sky).toEqual({ color: "#79B8EC", horizon_color: "#DFEEFA", horizon_blend: 0.5 });
    await userEvent.click(within(popover).getByRole("button", { name: "Reset to auto" }));
    expect(seen.scene?.sky).toBeUndefined();
    expect(seen.scene?.light).toBeUndefined();
  });

  it("draws no fog on Auto, and its popover turns a fog on from the values shown", async () => {
    const panel = await openSky();
    await userEvent.click(autoSwitch());
    expect(within(panel).getByRole("button", { name: "Fog, Off" })).toBeTruthy();
    await userEvent.click(within(panel).getByRole("button", { name: /^Fog/ }));
    expect(screen.queryByRole("slider", { name: "Fog to ground" })).toBeNull();
    // The switch sits in the popover's header, beside its close button, not in its body.
    const turnOn = screen.getByRole("checkbox", { name: "Turn Fog on" });
    expect(turnOn.closest("[data-popover-frame]")).toBeTruthy();
    expect(turnOn.closest("[data-popover-body]")).toBeNull();
    await userEvent.click(turnOn);
    expect(seen.scene?.fog).toEqual({ color: "#E9F1F7", horizon_blend: 0.5, ground_blend: 0.6 });
    expect(screen.getByRole("slider", { name: "Fog to ground" })).toBeTruthy();
    await userEvent.click(screen.getByRole("checkbox", { name: "Turn Fog off" }));
    expect(seen.scene?.fog).toBeUndefined();
    expect(screen.queryByRole("slider", { name: "Fog to ground" })).toBeNull();
  });

  it("opens the zoom editor one level further for a glow by zoom", async () => {
    const panel = await openSky();
    await userEvent.click(autoSwitch());
    await userEvent.click(within(panel).getByRole("button", { name: /^Globe glow/ }));
    const mode = () => screen.getByRole("button", { name: /^Strength: .*Change how the value is set\.$/ });
    await userEvent.click(mode());
    await userEvent.click(within(screen.getByRole("menu")).getByText("By zoom"));
    const strength = seen.scene?.glow?.strength as { zoom: [number, number][] };
    expect(strength.zoom.map(([z]) => z)).toEqual([13, 17]);
    // From the automatic strength, a fixed 1.
    expect(strength.zoom.map(([, v]) => v)).toEqual([1, 1]);
    const level2 = document.querySelector("[data-popover-level='2']") as HTMLElement;
    expect(within(level2).getByText("Strength by zoom")).toBeTruthy();
  });

  it("mutes a section the camera does not show and says when it shows, without moving the camera", async () => {
    const panel = await openSky({}, { zoom: 15, pitch: 50 });
    // Tilted 50: no sky (from 69); the glow needs the globe; the automatic fog is none, so nothing is hidden.
    expect(within(panel).getByLabelText(/^Shows above the horizon/)).toBeTruthy();
    expect(within(panel).queryByLabelText(/^Shows on terrain/)).toBeNull();
    expect(within(panel).getByLabelText(/^Shows around the globe/)).toBeTruthy();
    await userEvent.click(autoSwitch());
    await userEvent.click(within(panel).getByRole("button", { name: /^Globe glow/ }));
    const popover = document.querySelector("[data-popover-level='1']") as HTMLElement;
    expect(within(popover).getByText("Shows around the globe when zoomed out.")).toBeTruthy();
    expect(within(popover).queryByRole("button", { name: "Show me" })).toBeNull();
    expect(fakeMap.easeTo).not.toHaveBeenCalled();
  });

  it("sets the globe glow's color, fixed or by zoom, and says nothing of the sun", async () => {
    const panel = await openSky();
    await userEvent.click(autoSwitch());
    await userEvent.click(within(panel).getByRole("button", { name: /^Globe glow/ }));
    const popover = document.querySelector("[data-popover-level='1']") as HTMLElement;
    expect(within(popover).queryByText(/follows the sun/)).toBeNull();
    const mode = () => screen.getByRole("button", { name: /^Glow color: .*Change how the value is set\.$/ });
    await userEvent.click(mode());
    await userEvent.click(within(screen.getByRole("menu")).getByText("By zoom"));
    // The section is written whole from the values shown: the automatic strength (full, as drawn) and the halo's
    // colour by zoom.
    expect(seen.scene?.glow?.strength).toBe(1);
    const color = seen.scene?.glow?.color as { zoom: [number, string][] };
    expect(color.zoom.map(([, c]) => c.toUpperCase())).toEqual(["#6EA5F5", "#6EA5F5"]);
    await userEvent.click(mode());
    await userEvent.click(within(screen.getByRole("menu")).getByText("Fixed"));
    expect(String(seen.scene?.glow?.color).toUpperCase()).toBe("#6EA5F5");
  });

  it("shows sky and fog unmuted when tilted steeply", async () => {
    const panel = await openSky({}, { zoom: 15, pitch: 75 });
    expect(within(panel).queryByLabelText(/^Shows above the horizon/)).toBeNull();
    expect(within(panel).queryByLabelText(/^Shows on terrain/)).toBeNull();
  });
});
