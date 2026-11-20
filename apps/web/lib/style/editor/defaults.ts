// Slider ranges of the panel's number rows (prototype 4.1). They are panel choices: the values a style starts from
// are the reference defaults (DEFAULTS), not these.
export interface SliderRange {
  min: number;
  max: number;
  step: number;
  unit?: string;
  pct?: boolean;
}

const PCT: SliderRange = { min: 0, max: 1, step: 0.05, pct: true };

export const SLIDERS: Readonly<Record<string, SliderRange>> = {
  opacity: PCT,
  "fill.opacity": PCT,
  "fill.pattern_spacing": { min: 2, max: 40, step: 1, unit: "px" },
  "fill.pattern_width": { min: 1, max: 10, step: 1, unit: "px" },
  "outline.opacity": PCT,
  // Widths of strokes step by half a pixel, which draws finely; a pattern's line width stays whole (its image).
  "outline.width": { min: 0, max: 8, step: 0.5, unit: "px" },
  "line.opacity": PCT,
  "line.width": { min: 1, max: 14, step: 0.5, unit: "px" },
  "line.offset": { min: -10, max: 10, step: 1, unit: "px" },
  "line.blur": { min: 0, max: 10, step: 1, unit: "px" },
  "casing.opacity": PCT,
  "casing.width": { min: 1, max: 6, step: 0.5, unit: "px" },
  "arrows.size": { min: 6, max: 24, step: 1, unit: "px" },
  "arrows.spacing": { min: 40, max: 240, step: 10, unit: "px" },
  "marker.opacity": PCT,
  "marker.size": { min: 2, max: 60, step: 1, unit: "px" },
  "marker.rotation": { min: 0, max: 359, step: 1, unit: "°" },
  "marker.offset": { min: -20, max: 20, step: 1, unit: "px" },
  "label.size": { min: 8, max: 28, step: 1, unit: "px" },
  "label.max_width": { min: 60, max: 240, step: 10, unit: "px" },
  // Ems of the label size, shown as percent of it.
  "label.letter_spacing": { min: -0.1, max: 0.5, step: 0.01, pct: true },
  "label.line_height": { min: 0.8, max: 2, step: 0.05, pct: true },
  "label.halo.width": { min: 0, max: 4, step: 0.5, unit: "px" },
  "label.offset": { min: -20, max: 20, step: 1, unit: "px" },
  "label.spacing": { min: 50, max: 1000, step: 10, unit: "px" },
  "label.padding": { min: 0, max: 30, step: 1, unit: "px" },
  "heatmap.radius": { min: 5, max: 60, step: 1, unit: "px" },
  "heatmap.intensity": { min: 0.2, max: 3, step: 0.05, pct: true },
  "heatmap.opacity": PCT,
  "h3.opacity": PCT,
  // Heights of polygons (goatlib allows 5000 m; the number field takes any).
  "extrude.height": { min: 0, max: 200, step: 1, unit: "m" },
  "extrude.base": { min: 0, max: 200, step: 1, unit: "m" },
  // Columns chart a value over hexagons up to ~20 km wide, so they go far above a building (goatlib allows 200 km).
  "h3.extrude.tallest": { min: 0, max: 60000, step: 100, unit: "m" },
  "h3.extrude.base": { min: 0, max: 60000, step: 100, unit: "m" },
  "cluster.radius": { min: 20, max: 120, step: 5, unit: "px" },
  "scene.sky.horizon_blend": PCT,
  "scene.fog.horizon_blend": PCT,
  "scene.fog.ground_blend": PCT,
  "scene.glow.strength": PCT,
  "scene.light.intensity": PCT,
  "scene.light.direction": { min: 0, max: 355, step: 5, unit: "°" },
  "scene.light.altitude": { min: 0, max: 90, step: 5, unit: "°" },
  "hillshade.direction": { min: 0, max: 359, step: 1, unit: "°" },
  "hillshade.altitude": { min: 5, max: 85, step: 1, unit: "°" },
  "hillshade.exaggeration": { min: 0, max: 1, step: 0.05, pct: true },
};

/** The numbers a panel menu offers, with a stored number it lacks in its place among them, so the menu shows the
 * stored number as picked and an edit elsewhere keeps it. */
export function withStored(values: readonly number[], stored: unknown): number[] {
  if (typeof stored !== "number" || !Number.isFinite(stored) || values.includes(stored)) return [...values];
  return [...values, stored].sort((a, b) => a - b);
}
