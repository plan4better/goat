import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const WEB = path.join(__dirname, "..", "..", "..", "..");
const SKIP = new Set(["node_modules", ".next", ".vitest", "public", "coverage"]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) return sources(file);
    return /\.tsx?$/.test(name) ? [file] : [];
  });
}

/** A react-map-gl map (`<Map`, or the component imported under another name) or a MapLibre map made in code. */
const MAKES_A_MAP =
  /<(Map|MapLibre|MapView)\s|new (maplibregl\.Map|MaplibreMap|MapLibreMap)\(|^import \{[^}]*\bMap as (\w+)[^}]*\} from "(react-map-gl\/maplibre|maplibre-gl)"/m;

describe("the shared map options", () => {
  it("route the own label fonts' glyph requests", async () => {
    const { MAPLIBRE_MAP_OPTIONS } = await import("@/lib/utils/map/maplibre");
    const { ownGlyphsRequest } = await import("@/lib/utils/map/glyphs");
    expect(MAPLIBRE_MAP_OPTIONS.transformRequest).toBe(ownGlyphsRequest);
  });
});

describe("every MapLibre map", () => {
  const files = sources(WEB).filter((file) => {
    const text = readFileSync(file, "utf8");
    return MAKES_A_MAP.test(text) && /from "(react-map-gl\/maplibre|maplibre-gl)"/.test(text);
  });

  it("is found", () => {
    // MapViewer, the print renderer, the report map, the catalog maps, the Add Layer preview, the style lab.
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it("passes the shared options, so it draws the own label fonts, and routes no request of its own", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const name = path.relative(WEB, file);
      expect(text, name).toContain("...MAPLIBRE_MAP_OPTIONS");
      expect(text, name).not.toMatch(/transformRequest/);
    }
  });
});
