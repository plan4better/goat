// The automatic atmosphere's colours from the basemap (3D spec 5.2): the horizon and the fog take on the colour of the
// ground the basemap draws, so the sky meets the map without a seam. A vector basemap's ground is its `background`
// layer (else its lowest fill), a solid basemap's its colour; imagery gets one neutral haze. The sky colour itself,
// and every value where no ground colour is found, come from the auto table of the basemap's tone.
import { SCENE_AUTO, type SceneTone } from "@/lib/style/generated/scene";

export interface AtmosphereColors {
  /** The sky's colour at the horizon. */
  horizon: string;
  /** The fog's colour. */
  fog: string;
}

type Rgb = [number, number, number];

/** How far the horizon leans from the ground towards the tone's sky colour. */
const HORIZON_TOWARDS_SKY = 0.3;
/** How far the fog leans from the ground towards the tone's horizon colour. */
const FOG_TOWARDS_HORIZON = 0.35;
/** How much of the fog's saturation is taken out, so it reads as haze rather than a tint. */
const FOG_DESATURATE = 0.2;

/** Over imagery (satellite, raster, WMS): a neutral blue-grey haze that sits on photos in both themes. */
export const IMAGERY_ATMOSPHERE: AtmosphereColors = { horizon: "#c2cfdc", fog: "#a9b5c1" };

const NAMED: Record<string, string> = { white: "#ffffff", black: "#000000" };

/** A CSS colour (hex, rgb(a), hsl(a), white, black) as red, green and blue 0 to 255; null for anything else. */
export function cssColorRgb(text: unknown): Rgb | null {
  if (typeof text !== "string") return null;
  const s = (NAMED[text.trim().toLowerCase()] ?? text).trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) return [0, 1, 2].map((i) => parseInt(h[i] + h[i], 16)) as Rgb;
    if (h.length === 6 || h.length === 8) return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
    return null;
  }
  const fn = /^(rgb|hsl)a?\(([^)]*)\)$/.exec(s);
  if (!fn) return null;
  const parts = fn[2]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map((p) => parseFloat(p));
  if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
  if (fn[1] === "rgb") {
    const pct = fn[2].includes("%");
    return parts.slice(0, 3).map((n) => clamp255(pct ? n * 2.55 : n)) as Rgb;
  }
  return hslToRgb(parts[0], parts[1] / 100, parts[2] / 100);
}

const clamp255 = (n: number) => Math.max(0, Math.min(255, n));

function hslToRgb(h: number, s: number, l: number): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    hue < 60
      ? [c, x, 0]
      : hue < 120
        ? [x, c, 0]
        : hue < 180
          ? [0, c, x]
          : hue < 240
            ? [0, x, c]
            : hue < 300
              ? [x, 0, c]
              : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

const toHex = (rgb: Rgb) =>
  `#${rgb.map((c) => Math.round(clamp255(c)).toString(16).padStart(2, "0")).join("")}`;

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t) as Rgb;

/** A CSS colour moved `amount` of the way to white, as hex; null for a colour `cssColorRgb` cannot read. */
export function lightened(color: string, amount: number): string | null {
  const rgb = cssColorRgb(color);
  return rgb ? toHex(mix(rgb, [255, 255, 255], amount)) : null;
}

/** Moves a colour `amount` of the way to the grey of its own lightness. */
function desaturate(rgb: Rgb, amount: number): Rgb {
  const grey = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return mix(rgb, [grey, grey, grey], amount);
}

/** A colour paint value at a zoom: a colour, a legacy `stops` function, or a zoom `interpolate` or `step`
 * expression with literal colours (interpolated per channel); null for anything else. */
export function colorAtZoom(value: unknown, zoom: number): Rgb | null {
  const direct = cssColorRgb(value);
  if (direct) return direct;
  let stops: Array<[number, unknown]> | null = null;
  let stepped = false;
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray((value as { stops?: unknown }).stops)
  )
    stops = (value as { stops: Array<[number, unknown]> }).stops;
  else if (Array.isArray(value) && value[0] === "interpolate" && JSON.stringify(value[2]) === '["zoom"]') {
    stops = [];
    for (let i = 3; i + 1 < value.length; i += 2) stops.push([value[i], value[i + 1]]);
  } else if (Array.isArray(value) && value[0] === "step" && JSON.stringify(value[1]) === '["zoom"]') {
    stepped = true;
    stops = [[-Infinity, value[2]]];
    for (let i = 3; i + 1 < value.length; i += 2) stops.push([value[i], value[i + 1]]);
  }
  if (!stops?.length) return null;
  const rgbs = stops.map(([z, c]) => [Number(z), cssColorRgb(c)] as [number, Rgb | null]);
  if (rgbs.some(([, c]) => !c)) return null;
  // Linear between stops (an exponential curve's base is not followed: close enough for a colour).
  if (zoom <= rgbs[0][0]) return rgbs[0][1];
  for (let i = 1; i < rgbs.length; i++) {
    const [z0, c0] = rgbs[i - 1];
    const [z1, c1] = rgbs[i];
    if (zoom < z1) return stepped ? c0 : mix(c0!, c1!, (zoom - z0) / (z1 - z0));
  }
  return rgbs[rgbs.length - 1][1];
}

interface StyleLike {
  layers?: Array<{ type?: string; paint?: Record<string, unknown>; layout?: Record<string, unknown> }>;
}

/** The colour of the ground a vector style draws at a zoom: its `background` layer, else its lowest fill. */
export function groundColorOf(style: StyleLike | undefined | null, zoom: number): string | null {
  const layers = (style?.layers ?? []).filter((l) => l.layout?.visibility !== "none");
  const background = layers.find((l) => l.type === "background");
  const rgb =
    colorAtZoom(background?.paint?.["background-color"], zoom) ??
    colorAtZoom(layers.find((l) => l.type === "fill")?.paint?.["fill-color"], zoom);
  return rgb ? toHex(rgb) : null;
}

/** The automatic horizon and fog colours for a ground colour; null where there is none (the tone table applies). */
export function autoAtmosphereColors(ground: string | null, tone: SceneTone): AtmosphereColors | null {
  const base = cssColorRgb(ground);
  if (!base) return null;
  const sky = cssColorRgb(SCENE_AUTO[tone]["sky.color"])!;
  const horizon = cssColorRgb(SCENE_AUTO[tone]["sky.horizon_color"])!;
  return {
    horizon: toHex(mix(base, sky, HORIZON_TOWARDS_SKY)),
    fog: toHex(desaturate(mix(base, horizon, FOG_TOWARDS_HORIZON), FOG_DESATURATE)),
  };
}

/** What the automatic atmosphere reads of a basemap. */
export interface AtmosphereBasemap {
  type: string;
  /** A solid basemap's colour. */
  color?: string;
}

/** The automatic atmosphere colours for the basemap on the map: imagery's haze, a solid basemap's colour, or the
 * ground of the loaded vector style; null while none is known. */
export function sceneAtmosphere(
  basemap: AtmosphereBasemap,
  imagery: boolean,
  style: StyleLike | undefined | null,
  zoom: number,
  tone: SceneTone
): AtmosphereColors | null {
  if (imagery) return IMAGERY_ATMOSPHERE;
  if (basemap.type === "solid") return autoAtmosphereColors(basemap.color ?? null, tone);
  return autoAtmosphereColors(groundColorOf(style, zoom), tone);
}
