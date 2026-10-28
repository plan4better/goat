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
  "outline.width": { min: 0, max: 8, step: 1, unit: "px" },
  "line.opacity": PCT,
  "line.width": { min: 1, max: 14, step: 1, unit: "px" },
  "line.offset": { min: -10, max: 10, step: 1, unit: "px" },
  "casing.opacity": PCT,
  "casing.width": { min: 1, max: 6, step: 1, unit: "px" },
  "arrows.size": { min: 6, max: 24, step: 1, unit: "px" },
  "arrows.spacing": { min: 40, max: 240, step: 10, unit: "px" },
  "marker.opacity": PCT,
  "marker.size": { min: 2, max: 60, step: 1, unit: "px" },
  "marker.rotation": { min: 0, max: 359, step: 1, unit: "°" },
  "label.size": { min: 8, max: 28, step: 1, unit: "px" },
  "label.max_width": { min: 60, max: 240, step: 10, unit: "px" },
  "label.halo.width": { min: 0, max: 4, step: 1, unit: "px" },
  "label.offset": { min: -20, max: 20, step: 1, unit: "px" },
  "heatmap.radius": { min: 5, max: 60, step: 1, unit: "px" },
  "heatmap.intensity": { min: 0.2, max: 3, step: 0.05, pct: true },
  "heatmap.opacity": PCT,
  "h3.opacity": PCT,
  "cluster.radius": { min: 20, max: 120, step: 5, unit: "px" },
  "terrain.direction": { min: 0, max: 359, step: 1, unit: "°" },
  "terrain.altitude": { min: 5, max: 85, step: 1, unit: "°" },
  "terrain.exaggeration": { min: 0, max: 1, step: 0.05, pct: true },
};
