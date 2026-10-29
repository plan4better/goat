/**
 * The Explorer's map colours, for the basemap beneath them. Lines, stops and
 * labels stand off the map: on a light basemap on white casings and halos,
 * on the dark one on casings of its own ground, with light labels, and with
 * route colours too dark to see there lifted towards white. The feed's own
 * colour is kept everywhere else (the panels, the badges).
 */
import { luminance, tint } from "@/lib/explorer/modes";

export interface MapPalette {
  dark: boolean;
  /** The basemap's ground: the casing under a highlighted line, a label's
   * halo, and what a faded route colour fades into. */
  ground: string;
  /** The network's lines while a route is selected. */
  faded: string;
  /** A line the Explorer tab's filter leaves out: faded and see-through, as
   * the faded layer draws it (0.35 opacity under the layer's 0.9). */
  filtered: string;
  /** A stop's dot and the ring round it; a station's area. */
  stop: string;
  stopRing: string;
  /** The selected route's end names: GOAT's text colour for that ground. */
  label: string;
}

export const LIGHT_MAP: MapPalette = {
  dark: false,
  ground: "#FFFFFF",
  faded: "#9E9E9E",
  filtered: "rgba(158, 158, 158, 0.4)",
  stop: "#717171",
  stopRing: "#FFFFFF",
  label: "rgba(58, 53, 65, 0.87)",
};

export const DARK_MAP: MapPalette = {
  dark: true,
  // The background of GOAT's Dark basemap (OpenFreeMap's "dark" style).
  ground: "#0C0C0C",
  faded: "#9E9E9E",
  filtered: "rgba(158, 158, 158, 0.4)",
  stop: "#8A8A8A",
  stopRing: "#0C0C0C",
  label: "rgba(231, 227, 252, 0.87)",
};

/** The palette for the basemap shown, by its value in GOAT's basemaps. */
export function mapPalette(basemap: string | undefined): MapPalette {
  return basemap === "dark" ? DARK_MAP : LIGHT_MAP;
}

/** The least luminance a line needs on `ground` to show: a contrast of 3:1,
 * WCAG's minimum for graphics. */
function leastOn(ground: string): number {
  return 3 * (luminance(ground) + 0.05) - 0.05;
}

const lifted = new Map<string, string>();

/** A route's colour as the map draws it on `palette`'s ground: as the feed
 * gives it, or on the dark basemap, where a black or navy line would vanish,
 * mixed with white just enough to stand off the ground. */
export function mapColor(color: string, palette: MapPalette): string {
  if (!palette.dark || !/^#[0-9A-Fa-f]{6}$/.test(color)) return color;
  const least = leastOn(palette.ground);
  if (luminance(color) >= least) return color;
  const key = `${color}|${palette.ground}`;
  let out = lifted.get(key);
  if (!out) {
    // The most of the colour kept that still reaches the contrast.
    let [lo, hi] = [0, 1];
    for (let i = 0; i < 12; i++) {
      const share = (lo + hi) / 2;
      if (luminance(tint(color, share)) >= least) lo = share;
      else hi = share;
    }
    out = tint(color, lo);
    lifted.set(key, out);
  }
  return out;
}
