// Palette ids and lists as colors (spec 1): the catalogue's colors, its variant for a class count, or sampled as goatlib
// samples them.
import { alphaOf } from "@/lib/style/colors";
import { type CataloguePalette, PALETTES } from "@/lib/style/generated/catalog";

/** The colors of a palette id or list, in `steps` classes when the palette has that variant. */
export function paletteColors(value: string | string[], steps?: number): string[] {
  if (Array.isArray(value)) return value;
  const palette = PALETTES[value];
  if (!palette) return [];
  return [...((steps && palette.variants?.[steps]) || palette.colors)];
}

// sRGB (D65) to CIE XYZ and back, and the D65 white point: goatlib's `colors.py`, step for step, so a blend rounds to
// the same color there and here.
const TO_XYZ = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
];
const FROM_XYZ = [
  [3.2404542, -1.5371385, -0.4985314],
  [-0.969266, 1.8760108, 0.041556],
  [0.0556434, -0.2040259, 1.0572252],
];
const WHITE = [0.95047, 1.0, 1.08883];
const DELTA = 6 / 29;

const dot = (row: number[], v: number[]) => row.reduce((sum, m, i) => sum + m * v[i], 0);

function toLab(hex: string): number[] {
  const linear = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const [fx, fy, fz] = TO_XYZ.map((row, i) => dot(row, linear) / WHITE[i]).map((t) =>
    t > DELTA ** 3 ? t ** (1 / 3) : t / (3 * DELTA ** 2) + 4 / 29
  );
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function fromLab([lightness, a, b]: number[]): string {
  const fy = (lightness + 16) / 116;
  const xyz = [fy + a / 500, fy, fy - b / 200].map(
    (t, i) => WHITE[i] * (t > DELTA ? t ** 3 : 3 * DELTA ** 2 * (t - 4 / 29))
  );
  return `#${FROM_XYZ.map((row) => {
    const c = dot(row, xyz);
    const s = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.floor(Math.min(1, Math.max(0, s)) * 255 + 0.5)
      .toString(16)
      .padStart(2, "0");
  }).join("")}`;
}

/**
 * Exactly `count` colors of a palette, as goatlib's `sample_colors` picks them (it writes the class colors the server
 * computes): the palette's variant for that count; a qualitative palette's colors repeated in order; else the
 * colors spread evenly from 0 to 1, a class between two of them blended in Lab and their alphas linearly (eight digits
 * where the blend's alpha is below 255), one class at the middle. `reverse` turns the palette round before it is
 * sampled; `kind` stands for a list's kind (an id has its own).
 */
export function paletteSteps(
  value: string | string[],
  count: number,
  { reverse = false, kind }: { reverse?: boolean; kind?: CataloguePalette["kind"] } = {}
): string[] {
  if (count <= 0) return [];
  const stops = Array.isArray(value)
    ? value.map((c) => String(c).toLowerCase())
    : paletteColors(value, count);
  if (!stops.length) return [];
  if (reverse) stops.reverse();
  if (stops.length === count) return stops;
  if ((kind ?? (Array.isArray(value) ? undefined : PALETTES[value]?.kind)) === "qualitative")
    return Array.from({ length: count }, (_, i) => stops[i % stops.length]);
  if (stops.length === 1) return Array.from({ length: count }, () => stops[0]);
  // Class i's place among the stops as an exact fraction, so a class on a stop takes its color unchanged.
  const positions = count === 1 ? [[1, 2]] : Array.from({ length: count }, (_, i) => [i, count - 1]);
  return positions.map(([num, den]) => {
    const at = num * (stops.length - 1);
    const [j, rem] = [Math.floor(at / den), at % den];
    if (rem === 0) return stops[j];
    const [start, end] = [toLab(stops[j]), toLab(stops[j + 1])];
    const blend = fromLab(start.map((s, k) => s + (end[k] - s) * (rem / den)));
    return blend + blendAlpha(stops[j], stops[j + 1], rem, den);
  });
}

/** The alpha `rem / den` of the way from `start`'s to `end`'s, rounded half up in whole numbers, as the two digits a
 * hex color ends with; nothing where it is opaque. */
function blendAlpha(start: string, end: string, rem: number, den: number): string {
  const [a, b] = [alphaOf(start) ?? 255, alphaOf(end) ?? 255];
  // (a + (b - a) x rem / den) rounded half up, in integers.
  const value = Math.floor((2 * (a * den + (b - a) * rem) + den) / (2 * den));
  return value === 255 ? "" : value.toString(16).padStart(2, "0");
}
