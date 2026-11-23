// The shapes the scene writes (spec 7.4), each through MapLibre's own validator: a set light and every hillshade read
// `sunAzimuth`, `sunAltitude` and `lightPosition` from global state; the automatic light's position goes by zoom.
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";

const validate = (part: Record<string, unknown>): string[] =>
  validateStyleMin({
    version: 8,
    sources: {
      dem: { type: "raster-dem", tiles: ["https://dem.example/{z}/{x}/{y}.webp"], encoding: "terrarium" },
    },
    layers: [],
    state: {
      sunAzimuth: { default: null },
      sunAltitude: { default: null },
      lightPosition: { default: [1.15, 210, 30] },
    },
    ...part,
  } as never).map((e: { message: string }) => e.message);

const shapes: Record<string, Record<string, unknown>> = {
  lightPosition: { light: { anchor: "map", position: ["global-state", "lightPosition"] } },
  autoLightByZoom: {
    light: {
      anchor: "viewport",
      position: [
        "interpolate",
        ["linear"],
        ["zoom"],
        5,
        ["literal", [1.15, 210, 0]],
        10,
        ["literal", [1.15, 210, 30]],
      ],
    },
  },
  hillshadeDirection: {
    layers: [
      {
        id: "h",
        type: "hillshade",
        source: "dem",
        paint: {
          "hillshade-illumination-direction": ["coalesce", ["global-state", "sunAzimuth"], 315],
          "hillshade-illumination-altitude": ["coalesce", ["global-state", "sunAltitude"], 45],
          "hillshade-illumination-anchor": "map",
        },
      },
    ],
  },
};

describe("global-state shapes MapLibre accepts", () => {
  it.each(Object.entries(shapes))("%s validates", (_, part) => {
    expect(validate(part)).toEqual([]);
  });
});
