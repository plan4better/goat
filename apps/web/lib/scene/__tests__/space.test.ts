import type { Map as MaplibreMap } from "maplibre-gl";
import { describe, expect, it, vi } from "vitest";

import { SPACE_STYLE, followGlobe, globeDisc, haloOf, starfieldTile } from "@/lib/scene/space";

const view = { width: 1100, height: 847, zoom: 1.8, lat: 50, pitch: 0, fov: 36.87 };

describe("the globe's outline on screen", () => {
  it("matches what MapLibre draws: zoom 1.8 over Europe is a circle about 340 px across the half", () => {
    const disc = globeDisc(view);
    expect(disc.x).toBe(550);
    expect(disc.y).toBeCloseTo(423.5, 5);
    expect(Math.abs(disc.rx - 339)).toBeLessThan(2);
    expect(disc.ry).toBeCloseTo(disc.rx, 5);
  });

  it("tilted, the horizon is where MapLibre draws it: zoom 3 at 47.3° N and pitch 55, about 125 px above the centre", () => {
    const disc = globeDisc({ ...view, zoom: 3, lat: 47.3, pitch: 55 });
    expect(Math.abs(disc.y - disc.ry - (423.5 - 124.6))).toBeLessThan(2);
    expect(disc.ry).toBeGreaterThan(disc.rx);
  });

  it("grows with the zoom", () => {
    expect(globeDisc({ ...view, zoom: 2.8 }).rx).toBeGreaterThan(globeDisc(view).rx * 1.5);
  });

  it("keeps the padding's centre", () => {
    const disc = globeDisc({ ...view, padding: { left: 300, right: 0, top: 0, bottom: 0 } });
    expect(disc.x).toBe(700);
  });
});

describe("the starfield", () => {
  it("is the same every time (seeded) and a few hundred small dots", () => {
    const tile = starfieldTile(7, 600, 180);
    expect(starfieldTile(7, 600, 180)).toBe(tile);
    expect(starfieldTile(8, 600, 180)).not.toBe(tile);
    const dots = tile.match(/<circle /g) ?? [];
    expect(dots).toHaveLength(180);
    const radii = [...tile.matchAll(/r="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(Math.max(...radii)).toBeLessThanOrEqual(1.4);
  });

  it("the space behind the globe: halo, stars and a dark backdrop, no animation", () => {
    const image = String(SPACE_STYLE.backgroundImage);
    expect(
      image.startsWith("radial-gradient(ellipse calc(var(--globe-rx) * 1.25) calc(var(--globe-ry) * 1.25)")
    ).toBe(true);
    expect(image).toContain("data:image/svg+xml,");
    expect(SPACE_STYLE.animation).toBeUndefined();
    expect(SPACE_STYLE.pointerEvents).toBe("none");
  });
});

describe("the halo is the globe glow", () => {
  const strength = (scene: unknown, zoom = 3) => haloOf(scene as never, "light", zoom).strength;

  it("is full in the automatic colour on the automatic glow, at every zoom", () => {
    expect(haloOf(undefined, "light", 2)).toEqual({ strength: 1, color: [110, 165, 245] });
    expect(haloOf({}, "dark", 8.5)).toEqual({ strength: 1, color: [110, 165, 245] });
  });

  it("follows a fixed strength, none at 0", () => {
    expect(strength({ glow: { strength: 0.5 } })).toBe(0.5);
    expect(strength({ glow: { strength: 0 } })).toBe(0);
  });

  it("follows a strength by zoom at the current zoom", () => {
    const scene = { glow: { strength: { zoom: [[2, 1], [6, 0.2]] } } };
    expect(strength(scene, 2)).toBe(1);
    expect(strength(scene, 4)).toBeCloseTo(0.6, 6);
    expect(strength(scene, 7)).toBeCloseTo(0.2, 6);
  });

  it("stays between none and full", () => {
    expect(strength({ glow: { strength: 1.4 } })).toBe(1);
    expect(strength({ glow: { strength: -0.2 } })).toBe(0);
  });

  it("takes its colour fixed or by zoom; a colour's alpha weakens it", () => {
    expect(haloOf({ glow: { color: "#ff8000" } }, "light", 3).color).toEqual([255, 128, 0]);
    const byZoom = { glow: { color: { zoom: [[2, "#000000"], [4, "#ffffff"]] } } } as never;
    expect(haloOf(byZoom, "light", 3).color).toEqual([128, 128, 128]);
    // A glow section with only a colour keeps the automatic strength (full).
    const half = haloOf({ glow: { color: "#ff800080" } }, "light", 3);
    expect(half.color).toEqual([255, 128, 0]);
    expect(half.strength).toBeCloseTo(128 / 255, 6);
  });

  it("draws every halo stop in the glow's colours at its strength, today's halo until they are set", () => {
    const image = String(SPACE_STYLE.backgroundImage);
    expect(image).toContain("rgba(var(--globe-glow-edge, 170, 210, 255), calc(0.6 * var(--globe-glow, 1))) 80%");
    expect(image).toContain(
      "rgba(var(--globe-glow-color, 110, 165, 245), calc(0.26 * var(--globe-glow, 1))) 82.4%"
    );
    expect(image).toContain("rgba(var(--globe-glow-outer, 80, 135, 230), calc(0.1 * var(--globe-glow, 1))) 88%");
  });

  const fakeMap = (camera: { zoom: number }, handlers: Record<string, () => void> = {}) =>
    ({
      getCanvas: () => ({ clientWidth: 1100, clientHeight: 847 }),
      getZoom: () => camera.zoom,
      getCenter: () => ({ lat: 50, lng: 10 }),
      getPitch: () => 0,
      getVerticalFieldOfView: () => 36.87,
      getPadding: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
      on: vi.fn((event: string, fn: () => void) => (handlers[event] = fn)),
      off: vi.fn(),
    }) as unknown as MaplibreMap;

  it("sets the halo's strength and colours from the glow at the map's zoom, again on every move", () => {
    const handlers: Record<string, () => void> = {};
    const camera = { zoom: 2 };
    const map = fakeMap(camera, handlers);
    const element = document.createElement("div");
    const scene = { glow: { strength: { zoom: [[2, 1], [6, 0.2]] }, color: "#ff8000" } } as never;
    const stop = followGlobe(map, element, (zoom) => haloOf(scene, "light", zoom));
    const style = (name: string) => element.style.getPropertyValue(name);
    expect(style("--globe-glow")).toBe("1.000");
    expect(style("--globe-glow-color")).toBe("255, 128, 0");
    expect(style("--globe-glow-edge")).toBe("255, 185, 115");
    expect(style("--globe-glow-outer")).toBe("217, 109, 0");
    camera.zoom = 4;
    handlers.move();
    expect(style("--globe-glow")).toBe("0.600");
    stop();
    expect(map.off).toHaveBeenCalledWith("move", handlers.move);
  });

  it("draws the automatic halo without a glow", () => {
    const element = document.createElement("div");
    followGlobe(fakeMap({ zoom: 3 }), element)();
    expect(element.style.getPropertyValue("--globe-glow")).toBe("1.000");
    expect(element.style.getPropertyValue("--globe-glow-color")).toBe("110, 165, 245");
  });
});
