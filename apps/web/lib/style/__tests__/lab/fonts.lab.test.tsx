// GOAT's own label fonts on a real map: a label in each own stack loads its glyph ranges from the app's files
// (public/glyphs, which the lab serves as the app does), through the request routing every map of the app passes
// (MAPLIBRE_MAP_OPTIONS), and draws in that font's weight and slant. The servers' stacks come from the lab's fixtures.
import { Map as MaplibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { GLYPHS_PATH, OWN_FONT_STACKS } from "@/lib/utils/map/glyphs";
import { MAPLIBRE_MAP_OPTIONS } from "@/lib/utils/map/maplibre";

import { LAB_GLYPHS } from "./scene";

const WIDTH = 600;
const HEIGHT = 160;

interface Drawn {
  map: MaplibreMap;
  errors: string[];
  warnings: string[];
}

const maps: MaplibreMap[] = [];
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  performance.clearResourceTimings();
  warn = vi.spyOn(console, "warn");
});

afterEach(() => {
  warn.mockRestore();
  while (maps.length) maps.pop()?.remove();
});

/** One label, black on white without a halo, in the middle of the map. */
async function drawLabel(text: string, stack: string): Promise<Drawn> {
  const screen = await render(<div style={{ width: WIDTH, height: HEIGHT }} />);
  const map = new MaplibreMap({
    ...MAPLIBRE_MAP_OPTIONS,
    container: screen.container.firstElementChild as HTMLElement,
    center: [0, 0],
    zoom: 2,
    attributionControl: false,
    fadeDuration: 0,
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
        { id: "ground", type: "background", paint: { "background-color": "#ffffff" } },
        {
          id: "label",
          type: "symbol",
          source: "point",
          layout: { "text-field": text, "text-font": [stack], "text-size": 40 },
          paint: { "text-color": "#000000" },
        },
      ],
    },
  });
  maps.push(map);
  const errors: string[] = [];
  map.on("error", (event) => errors.push(String(event.error?.message ?? event.error)));
  await map.once("idle");
  const warnings = warn.mock.calls.map((args) => args.map(String).join(" "));
  return { map, errors, warnings };
}

/** The canvas's ink, row by row from the top: true where a pixel is dark. */
function ink(map: MaplibreMap): boolean[][] {
  const canvas = map.getCanvas();
  const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext;
  const [w, h] = [gl.drawingBufferWidth, gl.drawingBufferHeight];
  const data = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
  const rows: boolean[][] = [];
  // readPixels counts rows from the bottom.
  for (let r = h - 1; r >= 0; r--) {
    const row: boolean[] = [];
    for (let c = 0; c < w; c++) {
      const i = (r * w + c) * 4;
      row.push(data[i] + data[i + 1] + data[i + 2] < 384);
    }
    rows.push(row);
  }
  return rows;
}

const inkCount = (rows: boolean[][]) => rows.reduce((sum, row) => sum + row.filter(Boolean).length, 0);

/** How far right the ink's top rows sit of its bottom rows, as the mean column of their dark pixels. */
function slant(rows: boolean[][]): number {
  const inked = rows.filter((row) => row.includes(true));
  const band = Math.max(2, Math.floor(inked.length / 4));
  const meanColumn = (band: boolean[][]) => {
    const columns = band.flatMap((row) => row.flatMap((dark, c) => (dark ? [c] : [])));
    return columns.reduce((a, b) => a + b, 0) / columns.length;
  };
  return meanColumn(inked.slice(0, band)) - meanColumn(inked.slice(-band));
}

/** The glyph requests the page made since the test began, with their status. */
const glyphRequests = () =>
  (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
    .filter((entry) => entry.name.endsWith(".pbf"))
    .map((entry) => ({
      path: decodeURIComponent(new URL(entry.name).pathname),
      status: entry.responseStatus,
    }));

const OWN = Object.keys(OWN_FONT_STACKS);

describe("own label fonts", () => {
  it.each(OWN)("%s loads Latin, Vietnamese, Greek and Cyrillic from the app's files", async (stack) => {
    const drawn = await drawLabel("Việt Ωμέγα Жук", stack);
    expect(drawn.errors).toEqual([]);
    // A range that fails to load is drawn from a local font with a warning, not a map error.
    expect(drawn.warnings.filter((text) => text.includes("glyph"))).toEqual([]);
    const dir = OWN_FONT_STACKS[stack].dir;
    expect(glyphRequests()).toEqual(
      expect.arrayContaining(
        ["0-255", "768-1023", "1024-1279", "7680-7935"].map((range) => ({
          path: `${GLYPHS_PATH}/${dir}/${range}.pbf`,
          status: 200,
        }))
      )
    );
    expect(glyphRequests().filter((request) => !request.path.startsWith(`${GLYPHS_PATH}/`))).toEqual([]);
    expect(inkCount(ink(drawn.map))).toBeGreaterThan(500);
  });

  it("draw each weight heavier than the one below it, upright and italic", async () => {
    const weight = async (stack: string) => inkCount(ink((await drawLabel("Hamburg", stack)).map));
    const [light, regular, medium, bold] = [
      await weight("Noto Sans Light"),
      await weight("Noto Sans Regular"),
      await weight("Noto Sans Medium"),
      await weight("Noto Sans Bold"),
    ];
    expect(light).toBeLessThan(regular);
    expect(regular).toBeLessThan(medium);
    expect(medium).toBeLessThan(bold);
    const [lightItalic, italic, mediumItalic, boldItalic] = [
      await weight("Noto Sans Light Italic"),
      await weight("Noto Sans Italic"),
      await weight("Noto Sans Medium Italic"),
      await weight("Noto Sans Bold Italic"),
    ];
    expect(lightItalic).toBeLessThan(italic);
    expect(italic).toBeLessThan(mediumItalic);
    expect(mediumItalic).toBeLessThan(boldItalic);
  });

  it("draw the italics slanted and the upright weights upright", async () => {
    const slantOf = async (stack: string) => slant(ink((await drawLabel("IIIII", stack)).map));
    for (const stack of ["Noto Sans Light", "Noto Sans Medium"]) {
      expect(Math.abs(await slantOf(stack)), stack).toBeLessThanOrEqual(1);
    }
    for (const stack of ["Noto Sans Light Italic", "Noto Sans Medium Italic", "Noto Sans Bold Italic"]) {
      expect(await slantOf(stack), stack).toBeGreaterThanOrEqual(3);
    }
  });
});
