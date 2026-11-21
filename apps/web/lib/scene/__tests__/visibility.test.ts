import { describe, expect, it } from "vitest";

import { GLOBE_UNTIL_ZOOM, sectionVisibility } from "@/lib/scene/visibility";

const look = { mode: "3d" as const, projection: "mercator" as const, zoom: 15, pitch: 75, terrain: true };

describe("scene section visibility", () => {
  it("shows sky and fog tilted steeply on terrain, the glow only on the globe", () => {
    expect(sectionVisibility(look)).toEqual({ sky: true, fog: true, glow: false, light: true });
  });

  it("hides fog below a tilt of 60 and the sky below 69", () => {
    expect(sectionVisibility({ ...look, pitch: 65 })).toMatchObject({ sky: false, fog: true });
    expect(sectionVisibility({ ...look, pitch: 55 })).toMatchObject({ sky: false, fog: false });
  });

  it("hides fog without terrain and both in 2D", () => {
    expect(sectionVisibility({ ...look, terrain: false })).toMatchObject({ sky: true, fog: false });
    expect(sectionVisibility({ ...look, mode: "2d", pitch: 0 })).toMatchObject({ sky: false, fog: false });
  });

  it("draws neither while the globe renders (below its handover's end), and the glow then", () => {
    expect(sectionVisibility({ ...look, projection: "globe", zoom: 4 })).toEqual({
      sky: false,
      fog: false,
      glow: true,
      light: true,
    });
    expect(sectionVisibility({ ...look, projection: "globe", zoom: GLOBE_UNTIL_ZOOM - 0.1 })).toMatchObject({
      fog: false,
      glow: true,
    });
    expect(sectionVisibility({ ...look, projection: "globe", zoom: GLOBE_UNTIL_ZOOM })).toMatchObject({
      fog: true,
      glow: false,
    });
  });
});
