import { describe, expect, it } from "vitest";

import { autoForm, autoLightAt, effectiveLight, isImageryBasemap, sceneForm, toneOf } from "@/lib/scene/auto";

describe("tone", () => {
  it("dark basemaps, dark solid colours and raster basemaps in the dark app theme are dark", () => {
    expect(toneOf({ source: "builtin", type: "vector", value: "dark" }, "light")).toBe("dark");
    expect(toneOf({ source: "builtin", type: "vector", value: "light" }, "dark")).toBe("light");
    expect(toneOf({ source: "custom", type: "solid", color: "#202020" }, "light")).toBe("dark");
    expect(toneOf({ source: "custom", type: "solid", color: "#f0f0f0" }, "dark")).toBe("light");
    expect(toneOf({ source: "custom", type: "raster" }, "dark")).toBe("dark");
    expect(toneOf({ source: "custom", type: "raster" }, "light")).toBe("light");
    expect(toneOf({ source: "custom", type: "vector", backgroundColor: "#111111" }, "light")).toBe("dark");
    expect(toneOf({ source: "custom", type: "vector" }, "dark")).toBe("light");
  });

  it("imagery basemaps", () => {
    expect(isImageryBasemap({ source: "builtin", type: "vector", value: "satellite" })).toBe(true);
    expect(isImageryBasemap({ source: "custom", type: "raster" })).toBe(true);
    expect(isImageryBasemap({ source: "builtin", type: "vector", value: "light" })).toBe(false);
    expect(isImageryBasemap({ source: "custom", type: "solid", color: "#ffffff" })).toBe(false);
  });
});

describe("effective light", () => {
  it("automatic: with the camera, the tone's intensity and colour", () => {
    expect(effectiveLight(undefined, "light")).toEqual({
      mode: "auto",
      azimuth: 210,
      altitude: 60,
      intensity: 0.45,
      color: "#FFFFFF",
    });
  });

  it("direction: its own values, the automatic light for what it leaves out", () => {
    const light = effectiveLight({ light: { direction: 225 } }, "dark");
    expect(light).toEqual({
      mode: "direction",
      azimuth: 225,
      altitude: 60,
      intensity: 0.35,
      color: "#FFFFFF",
    });
  });

  it("the automatic light on the map: turned with the bearing, straight above zoomed out, 30 degrees off from zoom 10", () => {
    expect(autoLightAt(14, 0)).toEqual({ direction: 210, altitude: 60 });
    expect(autoLightAt(10, 0)).toEqual({ direction: 210, altitude: 60 });
    expect(autoLightAt(7.5, 200)).toEqual({ direction: 50, altitude: 75 });
    expect(autoLightAt(3, -30)).toEqual({ direction: 180, altitude: 90 });
  });

  it("intensity and colour by zoom are read at the zoom asked for", () => {
    const stops: [number, number][] = [
      [10, 0.2],
      [16, 0.8],
    ];
    const scene = { light: { direction: 90, intensity: { zoom: stops } } };
    expect(effectiveLight(scene, "light", { zoom: 10 }).intensity).toBe(0.2);
    expect(effectiveLight(scene, "light", { zoom: 16 }).intensity).toBe(0.8);
  });
});

describe("automatic forms", () => {
  const atmosphere = { horizon: "#aabbcc", fog: "#112233" };

  it("take the horizon and fog colours from the basemap's atmosphere, the rest from the tone", () => {
    expect(autoForm({ tone: "light", atmosphere }, "sky.horizon_color")).toBe("#aabbcc");
    expect(autoForm({ tone: "light", atmosphere }, "fog.color")).toBe("#112233");
    expect(autoForm({ tone: "light", atmosphere }, "sky.color")).toBe("#79B8EC");
    expect(autoForm("dark", "sky.horizon_color")).toBe("#3B6A99");
    expect(autoForm({ tone: "dark", atmosphere: null }, "fog.color")).toBe("#1B2633");
  });

  it("a section's own value wins", () => {
    expect(sceneForm({ fog: { color: "#ff0000" } }, { tone: "light", atmosphere }, "fog.color")).toBe(
      "#ff0000"
    );
  });
});
