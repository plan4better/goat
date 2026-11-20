// The bar a legend ramp draws: its colors and where each sits along it. Pure, so tests read the same gradient the
// legend shows.
import { Color } from "@maplibre/maplibre-gl-style-spec";

import type { LegendSection } from "@/lib/style/legend";

type Ramp = Extract<LegendSection, { kind: "ramp" }>;

/** A color of the ramp bar and its place along it, 0 (the domain's start) to 1 (its end). */
export interface RampStop {
  color: string;
  at: number;
}

/** The ramp's colors at their positions, else spread evenly from the start of the bar to its end. */
export function rampStops(section: Ramp): RampStop[] {
  const last = section.colors.length - 1;
  return section.colors.map((color, i) => ({
    color,
    at: section.positions?.[i] ?? (last > 0 ? i / last : 0),
  }));
}

/** The ramp bar's CSS background: its stops, blended from left to right; two stops at one place are a hard step. */
export function rampGradient(section: Ramp): string {
  const stops = rampStops(section).map((s) => `${s.color} ${Number((s.at * 100).toFixed(4))}%`);
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

const toHex = (color: Color): string => {
  // MapLibre's colors hold their channels multiplied by their alpha.
  const channel = (c: number) =>
    Math.round(Math.min(255, Math.max(0, color.a > 0 ? (c / color.a) * 255 : 0)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
};

/** The color the ramp bar shows at `value` of its domain, as `#rrggbb`: blended in RGB between the two stops around it,
 * as the gradient blends them; the end colors beyond the first and the last stop; the lower color on a hard step
 * itself. */
export function rampColorAt(section: Ramp, value: number): string {
  const [d0, d1] = section.domain;
  const t = Math.min(1, Math.max(0, (value - d0) / (d1 - d0 || 1)));
  const stops = rampStops(section);
  const parse = (color: string) => Color.parse(color) ?? Color.transparent;
  if (t <= stops[0].at) return toHex(parse(stops[0].color));
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, b] = [stops[i], stops[i + 1]];
    if (t > b.at) continue;
    const f = b.at > a.at ? (t - a.at) / (b.at - a.at) : 0;
    return toHex(Color.interpolate(parse(a.color), parse(b.color), f, "rgb"));
  }
  return toHex(parse(stops[stops.length - 1].color));
}
