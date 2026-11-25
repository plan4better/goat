import type { StyleSpecification } from "maplibre-gl";
import { describe, expect, it } from "vitest";

import { BASEMAPS } from "@/lib/constants/basemaps";
import { toneOf } from "@/lib/scene/auto";
import { DARK_BELOW, basemapTone, lookOfMapStyle } from "@/lib/style/tone";

const builtIn = (value: string) => ({ source: "builtin", type: "vector", value });

describe("basemapTone", () => {
  it("counts the built-in dark and satellite basemaps dark, every other built-in light", () => {
    expect(basemapTone(builtIn("dark"))).toBe("dark");
    expect(basemapTone(builtIn("satellite"))).toBe("dark");
    for (const value of ["streets", "light", "basemap_wld_col", "basemap_de_gry", "basemap_de_top"])
      expect(basemapTone(builtIn(value))).toBe("light");
    for (const basemap of BASEMAPS)
      expect(basemapTone(basemap)).toBe(["dark", "satellite"].includes(basemap.value) ? "dark" : "light");
  });

  it("reads a solid basemap by the luminance of its color, with the scene's threshold", () => {
    expect(basemapTone({ source: "custom", type: "solid", color: "#202020" })).toBe("dark");
    expect(basemapTone({ source: "custom", type: "solid", color: "#f0f0f0" })).toBe("light");
    // #9f9f9f and #a0a0a0 lie either side of the threshold.
    expect(DARK_BELOW).toBe(0.35);
    expect(basemapTone({ source: "custom", type: "solid", color: "#9f9f9f" })).toBe("dark");
    expect(basemapTone({ source: "custom", type: "solid", color: "#a0a0a0" })).toBe("light");
    // Eight digits: the alpha is ignored, as the scene ignores it.
    expect(basemapTone({ source: "custom", type: "solid", color: "#20202000" })).toBe("dark");
  });

  it("reads a custom vector basemap by its background color where it is known, else light", () => {
    expect(basemapTone({ source: "custom", type: "vector", backgroundColor: "#111111" })).toBe("dark");
    expect(basemapTone({ source: "custom", type: "vector", backgroundColor: "#fafafa" })).toBe("light");
    expect(basemapTone({ source: "custom", type: "vector" })).toBe("light");
  });

  it("counts a custom image basemap and anything unknown light", () => {
    expect(basemapTone({ source: "custom", type: "raster" })).toBe("light");
    expect(basemapTone({ source: "custom", type: "raster", backgroundColor: "#000000" })).toBe("light");
    expect(basemapTone({ source: "custom", type: "solid" })).toBe("light");
    expect(basemapTone({ source: "custom", type: "solid", color: "black" })).toBe("light");
    expect(basemapTone(null)).toBe("light");
    expect(basemapTone(undefined)).toBe("light");
  });

  it("does not read a built-in basemap's background color", () => {
    expect(basemapTone({ ...builtIn("light"), backgroundColor: "#000000" })).toBe("light");
    expect(basemapTone({ ...builtIn("dark"), backgroundColor: "#ffffff" })).toBe("dark");
  });

  it("differs from the scene's tone only for imagery, which the scene takes from the app theme", () => {
    const looks = [
      builtIn("dark"),
      builtIn("light"),
      builtIn("streets"),
      { source: "custom", type: "solid", color: "#202020" },
      { source: "custom", type: "solid", color: "#f0f0f0" },
      { source: "custom", type: "vector", backgroundColor: "#111111" },
      { source: "custom", type: "vector" },
    ];
    for (const look of looks)
      for (const theme of ["light", "dark"] as const) expect(basemapTone(look)).toBe(toneOf(look, theme));
    expect(toneOf(builtIn("satellite"), "light")).toBe("light");
    expect(basemapTone(builtIn("satellite"))).toBe("dark");
    expect(toneOf({ source: "custom", type: "raster" }, "dark")).toBe("dark");
    expect(basemapTone({ source: "custom", type: "raster" })).toBe("light");
  });
});

describe("lookOfMapStyle", () => {
  const dark = BASEMAPS.find((b) => b.value === "dark")!;
  const light = BASEMAPS.find((b) => b.value === "light")!;

  it("finds a built-in basemap by its style URL", () => {
    expect(basemapTone(lookOfMapStyle(dark.url))).toBe("dark");
    expect(basemapTone(lookOfMapStyle(light.url))).toBe("light");
    expect(lookOfMapStyle(dark.url)).toMatchObject({ source: "builtin", value: "dark" });
  });

  it("takes another style URL for a custom vector basemap", () => {
    expect(lookOfMapStyle("https://tiles.example.org/style.json")).toEqual({
      source: "custom",
      type: "vector",
    });
  });

  it("reads a solid basemap's style by its background color", () => {
    const solid = (color: string) =>
      ({
        version: 8,
        sources: {},
        layers: [{ id: "background", type: "background", paint: { "background-color": color } }],
      }) as StyleSpecification;
    expect(basemapTone(lookOfMapStyle(solid("#101010")))).toBe("dark");
    expect(basemapTone(lookOfMapStyle(solid("#f5f5f5")))).toBe("light");
  });

  it("counts an image basemap's style and nothing at all light", () => {
    const raster = {
      version: 8,
      sources: { "raster-source": { type: "raster", tiles: ["https://tiles.example.org/{z}/{x}/{y}.png"] } },
      layers: [{ id: "raster-layer", type: "raster", source: "raster-source" }],
    } as StyleSpecification;
    expect(lookOfMapStyle(raster)).toEqual({ source: "custom", type: "raster" });
    expect(basemapTone(lookOfMapStyle(raster))).toBe("light");
    expect(lookOfMapStyle(undefined)).toBeNull();
  });
});
