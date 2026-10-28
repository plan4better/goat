// The coloring of a raster file (spec 9): a style's render resolved into what the raster service colors cells with
// (goatlib.raster.token, same keys). Palettes become colors and class colors come from the palette here, so the
// service needs no palette catalog; class names and legend texts never travel.
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { type JsonObject, isObject } from "@/lib/style/json";
import { paletteColors, paletteSteps } from "@/lib/style/palettes";

type Outside = "clamp" | "hide";
/** A band number, or a band formula's expression. */
type Band = number | string;

/** How the cells are colored. A color of null draws nothing (a hidden class). */
export type RasterColorSpec =
  | {
      kind: "ramp";
      band: Band;
      noData: number[];
      colors: string[];
      /** null: the band's minimum and maximum, until the style's domain is computed. */
      domain: [number, number] | null;
      outside: Outside;
    }
  | {
      kind: "stops";
      band: Band;
      noData: number[];
      stops: Array<{ value: number; color: string }>;
      interpolate: "linear" | "nearest";
      outside: Outside;
    }
  | {
      kind: "classes";
      band: Band;
      noData: number[];
      classes: Array<{ from?: number; to?: number; color: string | null }>;
    }
  | {
      kind: "categories";
      band: Band;
      noData: number[];
      classes: Array<{ value: number; color: string | null }>;
      other: string | null;
    }
  /** bands null: the file as it is (its color table, bands 1 to 3, or one band in grey from its minimum to maximum). */
  | { kind: "rgb"; bands: [number, number, number] | null; noData: number[] };

/** A class without a color of its own (the panel's color for a new category). */
const CLASS_GRAY = "#9aa3ad";

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The band a render colors: a number, or a formula's expression; null when it is neither. */
function bandOf(render: JsonObject): Band | null {
  const band = render.band ?? 1;
  if (num(band)) return band;
  if (isObject(band) && typeof band.expression === "string" && band.expression.trim()) return band.expression;
  return null;
}

/** The domain a ramp colors over: the author's, else the computed one (spec 12), else null. */
function domainOf(render: JsonObject): [number, number] | null {
  const given = Array.isArray(render.domain) ? render.domain : null;
  const computed =
    isObject(render.computed) && Array.isArray(render.computed.domain) ? render.computed.domain : null;
  const domain = given ?? computed;
  return domain && domain.length === 2 && domain.every(num) ? (domain as [number, number]) : null;
}

/** The coloring of a raster render; null for shading without colors (terrain without a palette). */
export function rasterColorSpec(render: JsonObject): RasterColorSpec | null {
  const noData =
    isObject(render.no_data) && Array.isArray(render.no_data.values) ? render.no_data.values.filter(num) : [];
  if (render.type === "image" || render.type === undefined) {
    const given = Array.isArray(render.bands) ? render.bands.filter(num) : [];
    return { kind: "rgb", bands: given.length === 3 ? (given as [number, number, number]) : null, noData };
  }
  const band = bandOf(render);
  if (band === null) return null;
  if (render.type === "categorical") {
    const classes = (Array.isArray(render.classes) ? render.classes : [])
      .filter(isObject)
      .filter((c) => num(c.value));
    // Without classes the file draws as stored (its color table).
    if (!classes.length) return { kind: "rgb", bands: null, noData };
    return {
      kind: "categories",
      band,
      noData,
      classes: classes.map((c) => ({
        value: c.value as number,
        color: c.visible === false ? null : typeof c.color === "string" ? c.color : CLASS_GRAY,
      })),
      other: typeof render.other_color === "string" ? render.other_color : null,
    };
  }
  if (render.type !== "continuous" && render.type !== "terrain") return null;
  const outside: Outside = render.outside === "hide" ? "hide" : "clamp";
  if (render.type === "continuous" && Array.isArray(render.stops)) {
    const stops = render.stops
      .filter(isObject)
      .filter((s) => num(s.value) && typeof s.color === "string")
      .map((s) => ({ value: s.value as number, color: s.color as string }))
      .sort((a, b) => a.value - b.value);
    if (!stops.length) return null;
    return {
      kind: "stops",
      band,
      noData,
      stops,
      interpolate: render.interpolate === "nearest" ? "nearest" : "linear",
      outside,
    };
  }
  // Terrain is colored only with a palette; continuous defaults to the reference palette.
  const fallback = render.type === "continuous" ? (DEFAULTS["continuous.palette"] as string) : undefined;
  const palette = (render.palette ?? fallback) as string | string[] | undefined;
  if (palette === undefined) return null;
  const domain = domainOf(render);
  const classify = isObject(render.classify) ? render.classify : null;
  const written = (classify && Array.isArray(classify.classes) ? classify.classes : []).filter(isObject);
  const manual = (classify?.method ?? "manual") === "manual";
  // Computed classes draw once the server filled their bounds; until then the color range stands in.
  const bounded = written.length > 0 && (manual || written.some((c) => num(c.from) || num(c.to)));
  if (classify && bounded) {
    // Class colors from the classification's own palette, else the render's (goatlib compute does the same).
    const own = classify.palette !== undefined;
    const steps = paletteSteps((own ? classify.palette : palette) as string | string[], written.length);
    const reverse = (own ? classify.reverse : render.reverse) === true;
    const colors = reverse ? [...steps].reverse() : steps;
    return {
      kind: "classes",
      band,
      noData,
      classes: written.map((c, i) => ({
        ...(num(c.from) ? { from: c.from } : {}),
        ...(num(c.to) ? { to: c.to } : {}),
        color: c.visible === false ? null : typeof c.color === "string" ? c.color : (colors[i] ?? CLASS_GRAY),
      })),
    };
  }
  const colors = paletteColors(palette);
  if (!colors.length) return null;
  return {
    kind: "ramp",
    band,
    noData,
    colors: render.reverse === true ? [...colors].reverse() : colors,
    domain,
    outside,
  };
}
