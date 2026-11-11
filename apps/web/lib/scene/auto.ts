// The scene's automatic values (3D spec 5.2): the basemap's tone, the auto table per tone with the atmosphere colours
// the basemap gives, and the light the map shows for a scene (automatic, or from a direction).
import type { AtmosphereColors } from "@/lib/scene/atmosphere";
import { type Value, fromForm, valueAt } from "@/lib/style/compile/values";
import { SCENE_AUTO, type SceneTone } from "@/lib/style/generated/scene";
import type { Scene } from "@/lib/style/generated/types";

export type Tone = SceneTone;

/** What the tone and imagery rules read of a basemap. */
export interface BasemapLook {
  value?: string;
  source: string;
  type: string;
  /** A solid basemap's colour. */
  color?: string;
  /** A custom vector basemap's `background` layer colour. */
  backgroundColor?: string;
}

/** WCAG relative luminance of a hex colour, 0 (black) to 1 (white); null for anything else. */
function luminance(color: string | undefined): number | null {
  const m = /^#([0-9a-f]{6})/i.exec(color ?? "");
  if (!m) return null;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Below this relative luminance a basemap counts as dark. */
const DARK_BELOW = 0.35;

/** Whether the basemap is a picture of the ground (Satellite, raster, WMS, WMTS, XYZ): it carries its own shading. */
export function isImageryBasemap(basemap: BasemapLook): boolean {
  if (basemap.source === "builtin") return basemap.value === "satellite";
  return basemap.type !== "vector" && basemap.type !== "solid";
}

/** The basemap's tone (3D spec 5.2): dark for the dark basemap and dark solid or custom vector backgrounds; imagery
 * follows the app theme; everything else is light. */
export function toneOf(basemap: BasemapLook, appTheme: Tone): Tone {
  if (basemap.source === "builtin" && basemap.value === "dark") return "dark";
  if (isImageryBasemap(basemap)) return appTheme;
  const lum = luminance(basemap.type === "solid" ? basemap.color : basemap.backgroundColor);
  return lum !== null && lum < DARK_BELOW ? "dark" : "light";
}

/** What the automatic scene follows: the basemap's tone and the atmosphere colours its ground gives (none known:
 * the tone's). */
export interface AutoLook {
  tone: Tone;
  atmosphere?: AtmosphereColors | null;
}

/** A tone alone, or a tone with the basemap's atmosphere colours. */
export type AutoSource = Tone | AutoLook;

export const lookOf = (source: AutoSource): AutoLook =>
  typeof source === "string" ? { tone: source } : source;

/** A scene key's automatic value form: the basemap's atmosphere colour for the horizon and the fog, else the auto
 * table's for the tone. */
export function autoForm(source: AutoSource, key: string): unknown {
  const { tone, atmosphere } = lookOf(source);
  if (atmosphere && key === "sky.horizon_color") return atmosphere.horizon;
  if (atmosphere && key === "fog.color") return atmosphere.fog;
  return SCENE_AUTO[tone][key];
}

/** A scene key's value form (`sky.color`): the section's own, else the automatic one. */
export function sceneForm(scene: Scene | undefined, source: AutoSource, key: string): unknown {
  const [section, name] = key.split(".");
  const own = (scene?.[section as keyof Scene] as Record<string, unknown> | null | undefined)?.[name];
  return own ?? autoForm(source, key);
}

/** Whether a scene section is automatic (absent). */
export const isAuto = (scene: Scene | undefined, section: "sky" | "fog" | "glow" | "light"): boolean =>
  !scene?.[section];

/** A fixed number or colour of a value form, at `zoom` when it varies by zoom. */
function fixedAt(form: unknown, kind: "number" | "color", zoom: number): unknown {
  const value: Value = fromForm(form, kind, null);
  return valueAt(value, zoom);
}

/**
 * The automatic light (3D spec 7.4): it stands with the camera (MapLibre's viewport light) at `azimuth` of the view,
 * straight behind the planet up to the first zoom of `polar` and at MapLibre's default angle from straight above
 * from its last zoom, evenly in between.
 */
export const AUTO_LIGHT = {
  azimuth: 210,
  polar: [
    [5, 0],
    [10, 30],
  ],
} as const;

/** The automatic light's polar angle (from straight above) at a zoom. */
export function autoLightPolar(zoom: number): number {
  const [[z0, p0], [z1, p1]] = AUTO_LIGHT.polar;
  if (zoom <= z0) return p0;
  if (zoom >= z1) return p1;
  return p0 + ((zoom - z0) / (z1 - z0)) * (p1 - p0);
}

/** The automatic light as a light standing on the map, at a zoom and map bearing: where it comes from (compass
 * degrees) and its height above the horizon. */
export function autoLightAt(zoom: number, bearing: number): { direction: number; altitude: number } {
  return {
    direction: Number(((((AUTO_LIGHT.azimuth + bearing) % 360) + 360) % 360).toFixed(6)),
    altitude: Number((90 - autoLightPolar(zoom)).toFixed(6)),
  };
}

export interface EffectiveLight {
  mode: "auto" | "direction";
  /** The compass direction the light comes from and its altitude above the horizon, in degrees. */
  azimuth: number;
  altitude: number;
  intensity: number;
  color: string;
}

/**
 * The light the map shows (3D spec 7.4): the automatic one, or the scene's direction with the automatic light at
 * `zoom` and `bearing` for what it leaves out. Intensity and colour by zoom are read at `zoom`.
 */
export function effectiveLight(
  scene: Scene | undefined,
  source: AutoSource,
  opts: { zoom?: number; bearing?: number } = {}
): EffectiveLight {
  const light = scene?.light ?? null;
  const zoom = opts.zoom ?? 14;
  const auto = autoLightAt(zoom, opts.bearing ?? 0);
  return {
    mode: light ? "direction" : "auto",
    azimuth: light?.direction ?? auto.direction,
    altitude: light?.altitude ?? auto.altitude,
    intensity: Number(fixedAt(sceneForm(scene, source, "light.intensity"), "number", zoom)),
    color: String(fixedAt(sceneForm(scene, source, "light.color"), "color", zoom)),
  };
}
