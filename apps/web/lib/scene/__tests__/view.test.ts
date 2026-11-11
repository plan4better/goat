import { describe, expect, it } from "vitest";

import {
  ENTER_3D,
  cameraFor,
  maxPitchAtZoom,
  openingMode,
  openingPitch,
  openingTilt,
  storableView,
  viewModeOf,
} from "@/lib/scene/view";

describe("view modes", () => {
  it("a saved pitch without a mode is 3D; a mode wins", () => {
    expect(viewModeOf({})).toBe("2d");
    expect(viewModeOf({ pitch: 0 })).toBe("2d");
    expect(viewModeOf({ pitch: 30 })).toBe("3d");
    expect(viewModeOf({ pitch: 30, mode: "2d" })).toBe("2d");
    expect(viewModeOf({ mode: "3d" })).toBe("3d");
  });

  it("2D cannot tilt or rotate; 3D tilts to 85 and rotates", () => {
    expect(cameraFor("2d")).toEqual({
      maxPitch: 0,
      dragRotate: false,
      touchPitch: false,
      pitchWithRotate: true,
    });
    expect(cameraFor("3d")).toEqual({
      maxPitch: 85,
      dragRotate: true,
      touchPitch: true,
      pitchWithRotate: true,
    });
    expect(ENTER_3D).toEqual({ pitch: 55 });
  });

  it("a page opens a tilted URL view in 3D, else in the saved mode", () => {
    expect(openingMode({ mode: "2d", pitch: 0 }, 40)).toBe("3d");
    expect(openingMode({ mode: "3d", pitch: 55 }, 0)).toBe("3d");
    expect(openingMode({ pitch: 30 })).toBe("3d");
    expect(openingMode(undefined)).toBe("2d");
    expect(openingMode({ mode: "2d" }, 0)).toBe("2d");
  });

  it("keeps a saved camera inside what core stores", () => {
    const base = { longitude: 13.4, latitude: 52.5, zoom: 12, pitch: 0, bearing: -20 };
    expect(storableView({ ...base, longitude: 200 }).longitude).toBeCloseTo(-160);
    expect(storableView({ ...base, longitude: -190 }).longitude).toBeCloseTo(170);
    expect(storableView({ ...base, longitude: 180 }).longitude).toBeCloseTo(-180);
    expect(storableView({ ...base, zoom: 25 }).zoom).toBe(24);
    expect(storableView({ ...base, zoom: -3.5 }).zoom).toBe(0);
    expect(storableView({ ...base, latitude: 90 }).latitude).toBeCloseTo(85.051129);
    expect(storableView({ ...base, pitch: 90 }).pitch).toBe(85);
    expect(storableView({ ...base, min_zoom: -1, max_zoom: 24 })).toMatchObject({
      min_zoom: 0,
      max_zoom: 20,
    });
    expect(storableView({ ...base, min_zoom: 4.6, max_zoom: 2 })).toMatchObject({ min_zoom: 5, max_zoom: 5 });
    expect(storableView(base)).toEqual({ ...base, min_zoom: 0, max_zoom: 20 });
  });

  it("lets a zoomed-out globe tilt less: flat to zoom 3, the full 85 from zoom 7", () => {
    expect(maxPitchAtZoom(0)).toBe(0);
    expect(maxPitchAtZoom(3)).toBe(0);
    expect(maxPitchAtZoom(5)).toBeCloseTo(42.5);
    expect(maxPitchAtZoom(7)).toBe(85);
    expect(maxPitchAtZoom(15)).toBe(85);
  });

  it("opens a saved 3D view tilted: the URL's tilt, else the saved one, else the 3D entry tilt", () => {
    expect(openingPitch({ mode: "3d", pitch: 62 }, 0)).toBe(62);
    expect(openingPitch({ mode: "3d", pitch: 0 }, undefined)).toBe(ENTER_3D.pitch);
    expect(openingPitch({ mode: "3d", pitch: 62 }, 40)).toBe(40);
    expect(openingPitch({ mode: "2d", pitch: 0 }, 0)).toBe(0);
    expect(openingPitch(undefined, undefined)).toBe(0);
    expect(openingPitch({ pitch: 30 }, undefined)).toBe(30);
  });

  it("opens a zoomed-out 3D globe no steeper than its zoom allows, mercator at the saved tilt", () => {
    const saved = { mode: "3d" as const, pitch: 55 };
    expect(openingTilt(saved, undefined, 1, "globe")).toBe(0);
    expect(openingTilt(saved, undefined, 5, "globe")).toBeCloseTo(42.5);
    expect(openingTilt(saved, undefined, 1, "mercator")).toBe(55);
    expect(openingTilt(saved, undefined, 14, "globe")).toBe(55);
  });
});
