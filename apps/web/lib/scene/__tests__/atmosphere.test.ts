import { describe, expect, it } from "vitest";

import {
  IMAGERY_ATMOSPHERE,
  autoAtmosphereColors,
  colorAtZoom,
  cssColorRgb,
  groundColorOf,
  sceneAtmosphere,
} from "@/lib/scene/atmosphere";

describe("css colours", () => {
  it("reads hex, rgb(a), hsl(a) and two names", () => {
    expect(cssColorRgb("#fff")).toEqual([255, 255, 255]);
    expect(cssColorRgb("#0c0c0c")).toEqual([12, 12, 12]);
    expect(cssColorRgb("#0c0c0c80")).toEqual([12, 12, 12]);
    expect(cssColorRgb("rgb(242,243,240)")).toEqual([242, 243, 240]);
    expect(cssColorRgb("rgba(242, 243, 240, 0.5)")).toEqual([242, 243, 240]);
    expect(cssColorRgb("hsl(0, 0%, 50%)")!.map(Math.round)).toEqual([128, 128, 128]);
    expect(cssColorRgb("hsla(30, 50%, 90%, 1)")!.map(Math.round)).toEqual([242, 230, 217]);
    expect(cssColorRgb("white")).toEqual([255, 255, 255]);
    expect(cssColorRgb("tomato")).toBeNull();
    expect(cssColorRgb(undefined)).toBeNull();
  });

  it("reads a colour by zoom at a zoom", () => {
    const stops = {
      stops: [
        [5, "#000000"],
        [15, "#ffffff"],
      ],
    };
    expect(colorAtZoom(stops, 10)!.map(Math.round)).toEqual([128, 128, 128]);
    expect(colorAtZoom(stops, 2)).toEqual([0, 0, 0]);
    expect(colorAtZoom(["interpolate", ["linear"], ["zoom"], 5, "#000000", 15, "#ffffff"], 20)).toEqual([
      255, 255, 255,
    ]);
    expect(colorAtZoom(["step", ["zoom"], "#000000", 10, "#ffffff"], 9)).toEqual([0, 0, 0]);
    expect(colorAtZoom(["step", ["zoom"], "#000000", 10, "#ffffff"], 10)).toEqual([255, 255, 255]);
    expect(colorAtZoom(["get", "color"], 10)).toBeNull();
  });
});

describe("the ground of a style", () => {
  it("is its background, else its lowest fill, skipping hidden layers", () => {
    expect(
      groundColorOf(
        { layers: [{ type: "background", paint: { "background-color": "rgb(242,243,240)" } }] },
        10
      )
    ).toBe("#f2f3f0");
    expect(
      groundColorOf(
        {
          layers: [
            { type: "background", paint: { "background-color": "#000000" }, layout: { visibility: "none" } },
            { type: "fill", paint: { "fill-color": "#e0d8c8" } },
            { type: "fill", paint: { "fill-color": "#ff0000" } },
          ],
        },
        10
      )
    ).toBe("#e0d8c8");
    expect(groundColorOf({ layers: [] }, 10)).toBeNull();
    expect(groundColorOf(undefined, 10)).toBeNull();
  });
});

describe("automatic atmosphere colours", () => {
  const lum = (hex: string) => {
    const [r, g, b] = cssColorRgb(hex)!;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };

  it("light grey ground: a light horizon leaning to the sky, a light grey fog", () => {
    const c = autoAtmosphereColors("#f2f3f0", "light")!;
    expect(lum(c.horizon)).toBeGreaterThan(150);
    expect(lum(c.fog)).toBeGreaterThan(200);
    const [r, , b] = cssColorRgb(c.horizon)!;
    expect(b).toBeGreaterThan(r);
  });

  it("dark ground: a dark horizon and fog, lighter than the ground", () => {
    const c = autoAtmosphereColors("#0c0c0c", "dark")!;
    expect(lum(c.horizon)).toBeLessThan(80);
    expect(lum(c.fog)).toBeLessThan(80);
    expect(lum(c.fog)).toBeGreaterThan(lum("#0c0c0c"));
  });

  it("beige ground: the fog keeps a little of its warmth, toned down", () => {
    const c = autoAtmosphereColors("#f1eee8", "light")!;
    const [r, g, b] = cssColorRgb(c.fog)!;
    expect(r).toBeGreaterThanOrEqual(b - 12);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(20);
  });

  it("no ground: none (the tone's table applies)", () => {
    expect(autoAtmosphereColors(null, "light")).toBeNull();
    expect(autoAtmosphereColors("not a colour", "dark")).toBeNull();
  });

  it("per basemap: imagery's haze, a solid colour, a vector style's ground", () => {
    const style = { layers: [{ type: "background", paint: { "background-color": "#0c0c0c" } }] };
    expect(sceneAtmosphere({ type: "raster" }, true, style, 10, "dark")).toEqual(IMAGERY_ATMOSPHERE);
    expect(sceneAtmosphere({ type: "solid", color: "#f1eee8" }, false, style, 10, "light")).toEqual(
      autoAtmosphereColors("#f1eee8", "light")
    );
    expect(sceneAtmosphere({ type: "vector" }, false, style, 10, "dark")).toEqual(
      autoAtmosphereColors("#0c0c0c", "dark")
    );
    expect(sceneAtmosphere({ type: "vector" }, false, undefined, 10, "dark")).toBeNull();
  });
});
