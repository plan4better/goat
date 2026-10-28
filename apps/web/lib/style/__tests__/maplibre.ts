// Runs compiled output through MapLibre's own style validator (style spec 26.4.4).
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";

const SOURCE = { type: "vector", tiles: ["https://tiles.example/{z}/{x}/{y}"] };

/** Validation messages for a style holding `layers` (and `sources`, default one vector source `s`). */
export function maplibreErrors(
  layers: unknown[],
  sources: Record<string, unknown> = { s: SOURCE },
  state: Record<string, unknown> = {}
): string[] {
  const style = {
    version: 8,
    glyphs: "https://glyphs.example/{fontstack}/{range}.pbf",
    sources,
    layers,
    ...(Object.keys(state).length ? { state } : {}),
  };
  // Through JSON first, as the style reaches MapLibre: NaN and Infinity become null there.
  return validateStyleMin(JSON.parse(JSON.stringify(style))).map((e: { message: string }) => e.message);
}

/** Errors of a circle layer whose `circle-radius` (or another paint key) holds `value`. */
export const paintErrors = (value: unknown, key = "circle-radius", type = "circle"): string[] =>
  maplibreErrors([{ id: "l", type, source: "s", "source-layer": "default", paint: { [key]: value } }]);
