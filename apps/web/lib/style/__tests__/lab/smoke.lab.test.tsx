import { Map as MaplibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

// The app's map setup: the worker URL the lab config serves, and the options
// every map of the app passes.
import { MAPLIBRE_MAP_OPTIONS } from "@/lib/utils/map/maplibre";

// The lab's map style: glyphs come from the local fixtures the lab config
// serves, so a map never reaches the network.
const LAB_GLYPHS = "/lab-glyphs/{fontstack}/{range}.pbf";

const maps: MaplibreMap[] = [];

afterEach(() => {
  while (maps.length) maps.pop()?.remove();
});

describe("style lab setup", () => {
  it("a circle on a GeoJSON source is drawn", async () => {
    const screen = await render(<div style={{ width: 400, height: 300 }} />);
    const container = screen.container.firstElementChild as HTMLElement;

    const map = new MaplibreMap({
      ...MAPLIBRE_MAP_OPTIONS,
      container,
      center: [0, 0],
      zoom: 2,
      attributionControl: false,
      fadeDuration: 0,
      // Keeps the frame in the drawing buffer after compositing, so its
      // pixels can be read back.
      canvasContextAttributes: { preserveDrawingBuffer: true },
      style: {
        version: 8,
        glyphs: LAB_GLYPHS,
        sources: {
          point: {
            type: "geojson",
            data: { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } },
          },
        },
        layers: [
          {
            id: "circle",
            type: "circle",
            source: "point",
            paint: { "circle-color": "#ff0000", "circle-radius": 20 },
          },
        ],
      },
    });
    maps.push(map);
    await map.once("idle");

    const canvas = map.getCanvas();
    const gl = canvas.getContext("webgl2");
    expect(gl).not.toBeNull();

    const ratio = map.getPixelRatio();
    const pixel = new Uint8Array(4);
    // readPixels counts rows from the bottom of the drawing buffer.
    gl!.readPixels(
      Math.round(200 * ratio),
      Math.round(gl!.drawingBufferHeight - 150 * ratio),
      1,
      1,
      gl!.RGBA,
      gl!.UNSIGNED_BYTE,
      pixel
    );
    const [r, g, b] = pixel;
    const tolerance = 4;
    expect(Math.abs(r - 255)).toBeLessThanOrEqual(tolerance);
    expect(g).toBeLessThanOrEqual(tolerance);
    expect(b).toBeLessThanOrEqual(tolerance);
  });

  it("serves the glyph fixtures at the lab's glyph URL", async () => {
    for (const fontstack of ["Noto Sans Regular", "Noto Sans Bold"]) {
      const url = LAB_GLYPHS.replace("{fontstack}", encodeURIComponent(fontstack)).replace(
        "{range}",
        "0-255"
      );
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }
  });

  it("cannot reach any other host", async () => {
    // no-cors: a reachable host answers with an opaque response instead of a
    // CORS error, so only a request that never leaves the machine rejects.
    await expect(fetch("https://example.com/", { mode: "no-cors" })).rejects.toThrow();
  });
});
