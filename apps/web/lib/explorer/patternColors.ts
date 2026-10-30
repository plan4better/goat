/**
 * The colours of a calendar's service patterns, by the weekdays they run:
 * Mon–Fri is the same green on every line and on each of its trips, Saturday
 * the same blue, and so on, so a colour learnt once reads the same
 * everywhere. A line with two patterns on the same weekdays (school terms
 * and holidays) gets shades of that colour, the largest the colour itself.
 */
import type { DayType } from "@/lib/explorer/derive/serviceCalendar";

type Hsl = [number, number, number];

/** The usual weeks, by their weekdays as a bit mask (bit 0 = Monday). */
const BY_WEEK: Record<number, Hsl> = {
  0b0011111: [122, 45, 34], // Mon–Fri
  0b0100000: [210, 70, 40], // Sat
  0b1000000: [28, 85, 46], // Sun
  0b1111111: [186, 100, 26], // daily
  0b0111111: [291, 55, 40], // Mon–Sat
  0b1100000: [231, 48, 48], // Sat–Sun
  0b0001111: [88, 50, 34], // Mon–Thu
  0b0010000: [330, 70, 38], // Fri
};
/** Patterns on individual dates only: a muted brown, apart from the weeks. */
const DATES: Hsl = [20, 30, 38];
/** How each further pattern on the same weekdays is shaded: lightness and hue steps. */
const SHADES: [number, number][] = [
  [0, 0],
  [14, 10],
  [-8, -10],
  [24, 20],
  [-14, -20],
];

function hsl([h, s, l]: Hsl, n: number): string {
  const [dl, dh] = SHADES[n % SHADES.length];
  const turn = Math.floor(n / SHADES.length) * 35;
  return `hsl(${Math.round((h + dh + turn + 360) % 360)}, ${s}%, ${Math.min(70, Math.max(22, l + dl))}%)`;
}

/** Each pattern's colour, in the order given (largest first). */
export function patternColors(types: DayType[]): string[] {
  const seen = new Map<number, number>();
  return types.map((ty) => {
    const mask = ty.weekdays.reduce((m, w) => m | (1 << (w - 1)), 0);
    const n = seen.get(mask) ?? 0;
    seen.set(mask, n + 1);
    // Other weeks: a hue of their own, a golden angle per mask apart.
    const base = !mask ? DATES : (BY_WEEK[mask] ?? [Math.round((mask * 137.508) % 360), 50, 40]);
    return hsl(base, n);
  });
}
