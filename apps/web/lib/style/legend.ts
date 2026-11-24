// Legend data of a layer style (spec 7.2): sections of entries with swatches, ramps for palettes by attribute,
// size samples for ranges. Swatches hold fixed values at a zoom; the legend components draw them.
import { classTexts } from "@/lib/style/categoryTexts";
import { perLayer } from "@/lib/style/compile/cascade";
import { markersAsImages } from "@/lib/style/compile/points";
import { extrudes } from "@/lib/style/compile/polygons";
import { DEFAULT_CLUSTER_SYMBOL, h3Resolution, h3Scale, pointsSymbol } from "@/lib/style/compile/render";
import type { Geometry } from "@/lib/style/compile/types";
import { type Kind, darkerShade, fromForm, isZoomed, valueAt } from "@/lib/style/compile/values";
import { CAPABILITIES } from "@/lib/style/generated/capabilities";
import { PALETTES } from "@/lib/style/generated/catalog";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { PROPERTY_KINDS } from "@/lib/style/generated/properties";
import { type JsonObject, isObject } from "@/lib/style/json";
import { paletteSteps } from "@/lib/style/palettes";
import { classEnds, classReach, rasterColorSpec } from "@/lib/style/raster/color";

type Part = Record<string, unknown>;

export interface Swatch {
  geometry: Geometry;
  fill?: Part;
  outline?: Part;
  line?: Part;
  casing?: Part;
  marker?: Part;
  /** The icon a line's arrows draw where the style picks one (spec 3.2 `arrows.icon`), with its color, direction,
   * placement and whether it turns with the line; none for GOAT's own arrow. */
  arrows?: Part;
  /** A cluster's number on a badge at the marker's upper right (spec 8.2 `count: badge`): its fill, number and ring
   * colors. */
  badge?: { color: string; text: string; ring: string };
}

/** How an H3 cell's or a cluster's value is computed from its points (spec 8.2, 8.3). */
export type ValueOp = "count" | "sum" | "mean" | "min" | "max";

export interface LegendEntry {
  id: string;
  name?: string;
  values?: Array<string | number | boolean>;
  range?: { from?: number; to?: number };
  /** The classification's Other or No data record, the layer's clusters, its H3 cells in one color, the
   * features no rule matches (`rest`), or the base look of the single points below the clusters (`points`). */
  extra?: "other" | "no_data" | "cluster" | "h3" | "rest" | "points";
  /** The height in metres a class of the height gives its features. */
  height?: number;
  swatch: Swatch;
}

export type LegendSection =
  | {
      kind: "entries";
      id: string;
      title?: string;
      field?: string;
      entries: LegendEntry[];
      /** The data's minimum and maximum of numeric classes: the open first and last class read them. */
      domain?: [number, number];
      /** The i18n keys of the properties the classification sets, where the legend has more than one classification:
       * "Size · field" tells two blocks of one field apart. */
      properties?: string[];
      /** The classification's unit and number format: its ranges and category values read with them, as the class
       * list writes them. */
      unit?: string;
      format?: RangeFormat;
      /** H3 and clusters: how the cell's or the cluster's value is computed. */
      op?: ValueOp;
      /** The classification sets a size (a marker's size, a line's or an outline's width): its entries are drawn
       * at sizes in the ratio the classes have. Every other block keeps its swatches in one fixed box. */
      sized?: boolean;
      /** The classification sets the outline alone: its swatches are rings, so the outline reads. */
      hollow?: boolean;
      /** The classification sets the height alone: its entries draw a bar of their height, a swatch shows none. */
      bars?: boolean;
      /** Which of its classes the map draws is still being counted (`legend.classes`): this many placeholder rows
       * stand in for the entries, so the legend never shows every class first and then shrinks. */
      pending?: number;
    }
  | {
      kind: "ramp";
      id: string;
      title?: string;
      /** The field a value form reads. */
      field?: string;
      /** A cluster value by the field (spec 8.2 `value`): how it is computed. */
      op?: ValueOp;
      /** A density without numbers (a heatmap): the ends read low and high. */
      ends?: "low_high";
      colors: string[];
      /** Where each color sits along the ramp, 0 (the domain's start) to 1 (its end); without them the colors are
       * spread evenly. Two colors at one place are a hard step (a raster's stops at their values, spec 9.3). */
      positions?: number[];
      domain: [number, number];
      /** The value at the middle of the ramp, where the scale is not linear. */
      middle?: number;
      /** The features' own opacity the colors are drawn at (a fill's, the hexagons', a heatmap's), where it is below
       * 1; the layer's opacity is never in it. */
      opacity?: number;
      /** The unit after the end values, and words in place of them (raster legends, spec 9.2). */
      unit?: string;
      labels?: [string | undefined, string | undefined];
    }
  | {
      /** The height of raised polygons or H3 columns (3D spec 7.7): one line, worded by the legend component. */
      kind: "height";
      id: string;
      title?: string;
      mode: "fixed" | "zoom" | "field" | "storeys" | "classes" | "range" | "h3";
      field?: string;
      value?: number;
      max?: number;
      count?: number;
      from?: number;
      to?: number;
      /** H3: how the cell value is computed. */
      op?: "count" | "sum" | "mean";
    }
  | { kind: "image"; id: string; title?: string; url: string }
  /** The counts left none of the layer's classes (spec 7.2 `legend.classes`): a note in place of a swatch, which would
   * show a look no feature on the map has. */
  | { kind: "empty"; id: string; title?: string; classes: "filter" | "view" }
  | {
      kind: "sizes";
      id: string;
      title?: string;
      /** The field the sizes follow. */
      field?: string;
      /** A cluster value by the field (spec 8.2 `value`): how it is computed. */
      op?: ValueOp;
      samples: Array<{ value: number; swatch: Swatch }>;
    };

export interface Legend {
  title?: string;
  caption?: string;
  sections: LegendSection[];
}

/** What a count found of one classification's classes (spec 7.2 `legend.classes`): the classes that have features, by
 * their id or else their position, and whether values in no class and features without a value were among them. */
export interface ClassPresence {
  classes: ReadonlySet<string>;
  other: boolean;
  no_data: boolean;
}

/** The counts of a layer's classifications, by the classification's id or else its position in `classify`. */
export type Presence = Readonly<Record<string, ClassPresence>>;

/** Which classes a legend lists (spec 7.2): every class, those the layer's filter keeps, those in the map's view. */
export type LegendClasses = "all" | "filter" | "view";

const LEGEND_CLASSES = new Set<unknown>(["all", "filter", "view"]);

/** The layer's `legend.classes`, or the default; a raster's legend lists every class. */
export function legendClasses(style: JsonObject): LegendClasses {
  if (style.kind === "raster") return "all";
  const value = isObject(style.legend) ? style.legend.classes : undefined;
  return (LEGEND_CLASSES.has(value) ? value : DEFAULTS["legend.classes"]) as LegendClasses;
}

/** The key of a classification or a class in the counts and the legend's entries: its id, else its position. */
export const itemKey = (item: JsonObject, index: number): string =>
  typeof item.id === "string" ? item.id : String(index);

const PARTS: Record<Geometry, Array<keyof Omit<Swatch, "geometry" | "badge">>> = {
  point: ["marker", "outline"],
  // A marker on a line or a polygon draws in its middle (spec 3.3).
  line: ["casing", "line", "marker"],
  polygon: ["fill", "outline", "marker"],
};

const KEYS: Record<string, string[]> = {
  fill: ["color", "opacity", "pattern"],
  outline: ["color", "width", "opacity", "dash"],
  line: ["color", "width", "opacity", "dash"],
  casing: ["color", "width", "opacity"],
  marker: ["shape", "color", "size", "opacity", "icon_color"],
};

/** The properties whose classes are sizes. */
const SIZES = new Set(["marker.size", "line.width", "outline.width"]);

/** What the legend draws (spec 7.2): the properties a swatch shows (`swatch`: the parts' KEYS, a marker's icon and
 * hollow fill, a pattern's color and spacing, the arrows' color) and the height a class of the height writes beside
 * its entry. A label's text, color and font, a marker's rotation and offset, a line's offset or blur draw nothing in a
 * swatch. */
const DRAWN = new Set([
  ...Object.entries(KEYS).flatMap(([part, keys]) => keys.map((key) => `${part}.${key}`)),
  "marker.icon",
  "marker.fill",
  "fill.pattern_color",
  "fill.pattern_spacing",
  "fill.pattern_width",
  "arrows.color",
  "extrude.height",
]);

/** Whether the legend shows a classification: it sets something the legend draws (its target; without one, the main
 * color). One that sets nothing it draws (a label's font) has no block of its own, joins none of its field's, and is
 * not counted for `legend.classes`; its classes hidden with the eye still hide their features, on the map and so in the
 * legend. */
export const legendDraws = (c: JsonObject): boolean => typeof c.target !== "string" || DRAWN.has(c.target);

const MAIN: Record<Geometry, string> = { point: "marker", line: "line", polygon: "fill" };

/** The color a classification that sets no color draws its legend symbols in: a size legend suggests no color. */
export const LEGEND_NEUTRAL = "#9aa3ad";

/** The keys a classification sets: its target, else the geometry's main color. */
const targetOf = (c: JsonObject, geometry: Geometry) =>
  typeof c.target === "string" ? c.target : `${MAIN[geometry]}.color`;

/** The panel's short words for the main part's properties ("Size"); other parts' properties by their full name
 * ("Outline width"). */
const SHORT = new Set(["color", "size", "opacity", "width", "pattern", "icon"]);
function propertyKey(target: string, geometry: Geometry): string {
  const [part, key] = target.split(".");
  return part === MAIN[geometry] && SHORT.has(key) && !target.slice(part.length + 1).includes(".")
    ? `style_editor.${key}`
    : `style_editor.prop_${target.replace(/\./g, "_")}`;
}

/** The i18n key of the property a classification sets ("Size"), which tells two classifications of one field
 * apart where the legend has more than one. */
export const classificationProperty = (c: JsonObject, geometry: Geometry): string =>
  propertyKey(targetOf(c, geometry), geometry);

const list = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isObject) : []);

/** A polygon's or a line's marker alone (spec 7.2): what a block of the marker's sizes shows, as for points; in neutral
 * grey where the block sets no color. */
function markerAlone(swatch: Swatch, neutral = false): Swatch {
  if (swatch.geometry === "point" || !swatch.marker) return swatch;
  return { geometry: "point", marker: neutral ? { ...swatch.marker, color: LEGEND_NEUTRAL } : swatch.marker };
}

/** Sizes and widths: read at one zoom whatever the map's. A legend whose symbols grow and shrink with the zoom
 * jumps; colors and every other value follow the map's zoom, so a swatch shows the color on screen. */
const STEADY = new Set(["marker.size", "line.width", "outline.width", "casing.width"]);

/** The zoom a size by zoom is read at: the middle of its stops. */
function steadyZoom(form: unknown, zoom: number): number {
  const stops = isObject(form) && Array.isArray(form.zoom) ? (form.zoom as unknown[][]) : [];
  const [first, last] = [stops[0]?.[0], stops[stops.length - 1]?.[0]];
  return typeof first === "number" && typeof last === "number" ? (first + last) / 2 : zoom;
}

/** The colors a layer draws inside images (compile/imageNames.ts): a pattern's, and where its markers are images, a
 * marker's fill and icon, and its stroke on points. MapLibre picks an image once per tile, at the tile's whole zoom
 * (the map's zoom rounded down), and the image's name holds its colors at every whole zoom between their stops
 * (`everyZoom`): such a color is read at that whole zoom, every other color at the zoom itself. */
function imageColors(style: JsonObject, geometry: Geometry): Set<string> {
  const markers = markersAsImages(style, geometry)
    ? ["marker.color", "marker.icon_color", ...(geometry === "point" ? ["outline.color"] : [])]
    : [];
  return new Set(["fill.pattern_color", ...markers]);
}

/** A part key's value at `zoom`: fixed, or taken from its zoom stops; a value by attribute shows the reference. */
function resolve(form: unknown, path: string, zoom: number): unknown {
  const kind = (PROPERTY_KINDS[path] as "color" | "number" | "choice" | undefined) ?? "choice";
  const at = valueAt(
    fromForm(form, kind, DEFAULTS[path], (v) => v),
    STEADY.has(path) ? steadyZoom(form, zoom) : zoom
  );
  return Array.isArray(at) || isObject(at) ? DEFAULTS[path] : at;
}

/** A value by attribute (spec 4.3): a field's value, mapped or used as it is. */
const byField = (value: unknown): value is JsonObject => isObject(value) && typeof value.field === "string";

/** The stops of a value by zoom whose stops hold values by attribute (spec 4.4); null for any other value. */
function fieldStops(form: unknown): Array<[number, unknown]> | null {
  if (!isObject(form) || !Array.isArray(form.zoom)) return null;
  const stops = (form.zoom as unknown[]).filter(
    (stop): stop is [number, unknown] => Array.isArray(stop) && typeof stop[0] === "number"
  );
  return stops.some(([, value]) => byField(value)) ? stops : null;
}

/** Whether a value follows a field, at every zoom (spec 4.3) or in its zoom stops (spec 4.4): no one value to show. */
const followsField = (form: unknown): boolean => byField(form) || fieldStops(form) !== null;

/** The stops a value by zoom reads at `zoom`, as the compiler's `valueAt` reads them: the first or the last beyond
 * them, the one the zoom is on or a step holds, else the two around the zoom. */
function stopsAround<T>(stops: Array<[number, T]>, zoom: number, step: boolean): Array<[number, T]> {
  const last = stops.length - 1;
  if (zoom <= stops[0][0]) return [stops[0]];
  if (zoom >= stops[last][0]) return [stops[last]];
  const i = stops.findIndex(([z], k) => z <= zoom && zoom < stops[k + 1][0]);
  return zoom === stops[i][0] || step ? [stops[i]] : [stops[i], stops[i + 1]];
}

/** A palette's colors, turned round where the form says so, or a fixed color alone; none for any other value. */
function colorsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!byField(value) || !("palette" in value)) return [];
  const colors = Array.isArray(value.palette)
    ? [...(value.palette as string[])]
    : [...(PALETTES[value.palette as string]?.colors ?? [])];
  if (value.reverse === true) colors.reverse();
  return colors;
}

/** A value by attribute as the map draws it at `zoom`, for its ramp or its size samples: the form whose field, title,
 * scale and domain they show and, for a range, its output at a value of the field. A value by zoom with values by
 * attribute in its stops (spec 4.4) is read as the compiler reads it: at or beyond a stop, or on a step, that stop's
 * form; between two stops both outputs, blended by the stops' own curve (a palette color by color, both spread over as
 * many colors as the longer one has; two palettes over different domains or scales are no one ramp, so the stop
 * nearer the zoom stands for them). Null where those stops follow more than one field or a domain is not computed
 * yet. */
function formAt(
  form: unknown,
  zoom: number
): { form: JsonObject; domain: [number, number]; output: (v: number) => number } | null {
  if (byField(form)) {
    const domain = domainOf(form);
    return domain ? { form, domain, output: (v) => rangeOutput(form, domain, v) } : null;
  }
  const stops = fieldStops(form);
  if (!stops) return null;
  const kind = stops.some(([, v]) => byField(v) && "palette" in v) ? "color" : "number";
  const value = fromForm(form, kind, null);
  if (!isZoomed(value)) return null;
  const around = stopsAround(stops, zoom, value.interpolate === "step");
  const blend = (outputs: unknown[], as: Kind = kind) =>
    valueAt(
      { interpolate: value.interpolate, stops: around.map(([z], i) => [z, outputs[i]]), kind: as },
      zoom
    );
  const forms = around.map(([, v]) => v).filter(byField);
  const domains = forms.map(domainOf);
  if (!forms.length || forms.some((f) => f.field !== forms[0].field) || domains.some((d) => !d)) return null;
  const [own, domain] = [forms[0], domains[0]!];
  if (kind === "color") {
    const lists = around.map(([, v]) => colorsOf(v));
    if (lists.some((colors) => !colors.length)) return null;
    const [a, b] = domains as Array<[number, number]>;
    if (
      b &&
      ((forms[0].scale ?? "linear") !== (forms[1].scale ?? "linear") || a[0] !== b[0] || a[1] !== b[1])
    )
      return formAt(forms[(blend([0, 1], "number") as number) < 0.5 ? 0 : 1], zoom);
    const n = Math.max(...lists.map((colors) => colors.length));
    const even = lists.map((colors) => (colors.length === n ? colors : paletteSteps(colors, n)));
    const palette = even[0].map((_, k) => String(blend(even.map((colors) => colors[k]))));
    return { form: { ...own, palette, reverse: false }, domain, output: () => NaN };
  }
  const outputs = (v: number) =>
    around.map(([, s]) =>
      typeof s === "number" ? s : byField(s) && Array.isArray(s.range) ? rangeOutput(s, domainOf(s)!, v) : NaN
    );
  if (!outputs(domain[0]).every(Number.isFinite)) return null;
  return { form: own, domain, output: (v) => blend(outputs(v)) as number };
}

/** The icon a line's arrows draw where the style picks one (spec 3.2 `arrows.icon`), in the arrows' color or the
 * line's; none for GOAT's own arrow, and none where the base or the record switches the arrows off. */
function arrowsSwatch(
  style: JsonObject,
  base: unknown,
  over: unknown,
  lineColor: unknown,
  zoom: number
): Part | undefined {
  if (base === false || over === false || !(isObject(base) || isObject(over))) return undefined;
  const icon = perLayer(style, "arrows.icon");
  if (typeof icon !== "string" || icon === DEFAULTS["arrows.icon"]) return undefined;
  const merged: JsonObject = { ...(isObject(base) ? base : {}), ...(isObject(over) ? over : {}) };
  return {
    icon,
    color:
      (merged.color !== undefined ? resolve(merged.color, "arrows.color", zoom) : undefined) ?? lineColor,
    direction: perLayer(style, "arrows.direction"),
    placement: perLayer(style, "arrows.placement"),
    turn_with_line: perLayer(style, "arrows.turn_with_line"),
  };
}

/** The base merged with a record's overrides (spec 6.1): `false` switches a part off, an object switches on a part the
 * base leaves out; a part the base switches off stays off. An outline in the fill color takes the color the main part
 * would have, drawn or not. `neutral`: the main part's color the record does not set itself is neutral grey (a
 * classification that sets no color). `images`: the style's `imageColors`, worked out once per legend. */
function swatch(
  style: JsonObject,
  geometry: Geometry,
  zoom: number,
  override?: JsonObject,
  neutral = false,
  images = imageColors(style, geometry)
): Swatch {
  const symbol = isObject(style.symbol) ? style.symbol : {};
  const out: Swatch = { geometry };
  const at = (path: string) => (images.has(path) ? Math.floor(zoom) : zoom);
  let mainColor: unknown;
  for (const part of PARTS[geometry]) {
    const base = symbol[part];
    const over = override?.[part];
    const used = part === MAIN[geometry] || isObject(base) || isObject(over);
    const merged: JsonObject = { ...(isObject(base) ? base : {}), ...(isObject(over) ? over : {}) };
    if (part === MAIN[geometry]) mainColor = resolve(merged.color, `${part}.color`, at(`${part}.color`));
    if (!used || over === false || base === false) continue;
    // A main color by attribute has no one color to show (its ramp stands beside the entries): neutral grey.
    if (part === MAIN[geometry] && followsField(merged.color)) merged.color = LEGEND_NEUTRAL;
    if (neutral && part === MAIN[geometry]) {
      const own = isObject(over) ? over : {};
      if (own.color === undefined) merged.color = LEGEND_NEUTRAL;
      if (part === "marker" && own.icon_color === undefined && merged.icon_color !== undefined)
        merged.icon_color = LEGEND_NEUTRAL;
    }
    const resolved: Part = {};
    for (const key of KEYS[part])
      resolved[key] = resolve(merged[key], `${part}.${key}`, at(`${part}.${key}`));
    if (part === "marker" && merged.icon !== undefined)
      resolved.icon = resolve(merged.icon, "marker.icon", zoom);
    // A hollow marker (spec 3.3): its outline and icon only, the icon in the marker color unless it has its own.
    if (part === "marker" && merged.fill === false && resolved.shape !== "icon") {
      resolved.fill = false;
      if (merged.icon_color === undefined) resolved.icon_color = resolved.color;
    }
    if (part === "fill" && resolved.pattern !== "none") {
      // In the fill color unless it has its own, drawn in an image.
      resolved.pattern_color = followsField(merged.pattern_color)
        ? merged.pattern_color
        : merged.pattern_color !== undefined
          ? resolve(merged.pattern_color, "fill.pattern_color", at("fill.pattern_color"))
          : resolve(merged.color, "fill.color", at("fill.pattern_color"));
      for (const key of ["pattern_spacing", "pattern_width"])
        resolved[key] = resolve(merged[key], `fill.${key}`, zoom);
    }
    if (part === "outline" && resolved.color === "fill")
      resolved.color =
        (geometry === "point" ? out.marker?.color : out.fill?.color) ??
        mainColor ??
        DEFAULTS[geometry === "point" ? "marker.color" : "fill.color"];
    out[part] = resolved;
  }
  // An outline's or a casing's "auto": the color the main part shows, darkened (the casing comes before the line).
  for (const part of ["outline", "casing"] as const) {
    const own = out[part];
    if (own?.color !== "auto") continue;
    const main = out[MAIN[geometry] as "fill" | "line" | "marker"]?.color ?? mainColor;
    own.color = darkerShade(String(main ?? DEFAULTS[`${MAIN[geometry]}.color`]));
  }
  if (geometry === "line") {
    const arrows = arrowsSwatch(style, symbol.arrows, override?.arrows, out.line?.color, zoom);
    if (arrows) out.arrows = arrows;
  }
  return out;
}

const domainOf = (form: JsonObject): [number, number] | null => {
  const d = Array.isArray(form.domain) ? form.domain : isObject(form.computed) ? form.computed.domain : null;
  return Array.isArray(d) && d.length === 2 ? [d[0] as number, d[1] as number] : null;
};

const scaleFn = (scale: unknown) =>
  scale === "sqrt" ? (x: number) => Math.sqrt(Math.max(x, 0)) : scale === "log" ? Math.log : (x: number) => x;

/** Where `v` sits along a value form's domain by its scale (spec 5.8): 0 to 1, clamped; NaN where it cannot. */
export function scaleT(form: JsonObject, [d0, d1]: [number, number], v: number): number {
  const f = scaleFn(form.scale);
  const t = (f(v) - f(d0)) / (f(d1) - f(d0));
  return Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : NaN;
}

/** The value at `t` (0 to 1) along a value form's domain by its scale: the inverse of scaleT. */
export function scaleValue(form: JsonObject, [d0, d1]: [number, number], t: number): number {
  if (form.scale === "sqrt") {
    const [a, b] = [Math.sqrt(Math.max(d0, 0)), Math.sqrt(Math.max(d1, 0))];
    return (a + t * (b - a)) ** 2;
  }
  if (form.scale === "log" && d0 > 0 && d1 > 0)
    return Math.exp(Math.log(d0) + t * (Math.log(d1) - Math.log(d0)));
  return d0 + t * (d1 - d0);
}

/** The output of a range form at `v`, by its scale (spec 5.8). */
function rangeOutput(form: JsonObject, domain: [number, number], v: number): number {
  const [r0, r1] = form.range as number[];
  const t = scaleT(form, domain, v);
  return Number.isFinite(t) ? r0 + t * (r1 - r0) : r0;
}

/** The output of a range form at `v`, by its scale (spec 5.8), rounded to 0.1. */
export function scaled(form: JsonObject, domain: [number, number], v: number): number {
  return Math.round(rangeOutput(form, domain, v) * 10) / 10;
}

/** A ramp's opacity (`opacity` in a ramp section): none at full strength. */
const rampOpacity = (opacity: number): { opacity?: number } => (opacity < 1 ? { opacity } : {});

/** A heatmap's or the hexagons' own opacity at `zoom`: fixed, or taken from its zoom stops; the default where it has
 * no one value. */
function renderOpacity(form: unknown, fallback: number, zoom: number): number {
  const at = valueAt(fromForm(form, "number", fallback), zoom);
  return typeof at === "number" ? at : fallback;
}

/** The opacity a part's color by attribute is drawn at, as the base swatch shows the part: a pattern draws at full
 * strength whatever the fill's opacity, and a hollow marker is not faded by its own. */
function partOpacity(base: Swatch, part: keyof Omit<Swatch, "geometry" | "badge">, key: string): number {
  const own = base[part];
  if (key === "pattern_color" || !own || (part === "marker" && own.fill === false)) return 1;
  return typeof own.opacity === "number" ? own.opacity : 1;
}

/** Sections for the base symbol's value forms by attribute, also those in zoom stops (spec 4.4): a ramp per palette,
 * at its part's opacity, three samples per range. Sizes by zoom are read at the middle of their stops, a color drawn
 * in an image at the whole zoom (imageColors), every other value at the zoom. */
function valueFormSections(
  style: JsonObject,
  geometry: Geometry,
  zoom: number,
  images = imageColors(style, geometry)
): LegendSection[] {
  const symbol = isObject(style.symbol) ? style.symbol : {};
  const sections: LegendSection[] = [];
  // The base look: the opacity of each part a ramp colors, at the zoom (an opacity by attribute shows the default).
  const base = swatch(style, geometry, zoom, undefined, false, images);
  for (const part of PARTS[geometry]) {
    const node = symbol[part];
    if (!isObject(node)) continue;
    for (const [key, value] of Object.entries(node)) {
      const id = `${part}.${key}`;
      const at = formAt(
        value,
        STEADY.has(id) ? steadyZoom(value, zoom) : images.has(id) ? Math.floor(zoom) : zoom
      );
      if (!at) continue;
      const { form, domain } = at;
      const title = typeof form.title === "string" ? form.title : undefined;
      if ("palette" in form) {
        const curved = form.scale === "sqrt" || form.scale === "log";
        sections.push({
          kind: "ramp",
          id,
          title,
          field: form.field as string,
          colors: colorsOf(form),
          domain,
          // Three significant digits: a guide to where the middle sits, not a value to read exactly.
          ...(curved ? { middle: Number(scaleValue(form, domain, 0.5).toPrecision(3)) } : {}),
          ...rampOpacity(partOpacity(base, part, key)),
        });
      } else if (Array.isArray(form.range)) {
        const samples = [0, 0.5, 1].map((t) => {
          const value = domain[0] + t * (domain[1] - domain[0]);
          const size = Math.round(at.output(value) * 10) / 10;
          const sample = swatch(style, geometry, zoom, { [part]: { [key]: size } }, false, images);
          return { value, swatch: part === "marker" ? markerAlone(sample) : sample };
        });
        sections.push({ kind: "sizes", id, title, field: form.field as string, samples });
      }
    }
  }
  return sections;
}

/** The legend of a raster file or map service (spec 9.2 to 9.5, 9.8): a ramp, the visible classes, or the service's
 * legend image; an image and shading without colors have none. */
function rasterSections(
  style: JsonObject,
  serviceLegendUrl?: string,
  valueRange?: [number, number] | null
): LegendSection[] {
  if (serviceLegendUrl) return [{ kind: "image", id: "service", url: serviceLegendUrl }];
  const render: JsonObject = isObject(style.render) ? style.render : { type: "image" };
  const spec = rasterColorSpec(render);
  if (!spec) return [];
  const legend = isObject(style.legend) ? style.legend : {};
  const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const ends: [string | undefined, string | undefined] = [text(legend.min_label), text(legend.max_label)];
  // The unit follows the ramp's end values and the numbers of classes and categories, as a classification's does.
  const unit = text(legend.unit);
  const ramp = (colors: string[], domain: [number, number], positions?: number[]): LegendSection => ({
    kind: "ramp",
    id: "raster",
    colors,
    ...(positions ? { positions } : {}),
    domain,
    ...(unit ? { unit } : {}),
    ...(ends.some(Boolean) ? { labels: ends } : {}),
  });
  const fill = (color: string): Swatch => ({ geometry: "polygon", fill: { color } });
  // A ramp without a domain shows none until the server computed the band's range (spec 12).
  if (spec.kind === "ramp") return spec.domain ? [ramp(spec.colors, spec.domain)] : [];
  if (spec.kind === "stops") {
    const { stops } = spec;
    const domain: [number, number] = [stops[0].value, stops[stops.length - 1].value];
    const span = domain[1] - domain[0];
    if (!(span > 0)) return [ramp([stops[0].color], domain)];
    const at = (value: number) => (value - domain[0]) / span;
    // Each stop's color at its value, blended between; nearest stops hold their color up to the midpoints to their
    // neighbours, a midpoint itself in the lower color (as the raster service paints them).
    const placed =
      spec.interpolate === "nearest"
        ? stops.flatMap((s, i) => [
            { color: s.color, at: i === 0 ? 0 : at((stops[i - 1].value + s.value) / 2) },
            { color: s.color, at: i === stops.length - 1 ? 1 : at((s.value + stops[i + 1].value) / 2) },
          ])
        : stops.map((s) => ({ color: s.color, at: at(s.value) }));
    return [
      ramp(
        placed.map((s) => s.color),
        domain,
        placed.map((s) => s.at)
      ),
    ];
  }
  if (spec.kind === "classes") {
    const written = list(isObject(render.classify) ? render.classify.classes : undefined);
    // Each class's values as the map draws them: with values outside left out, the first and last end where the
    // drawing stops (`classReach`).
    const reach = classReach(spec, valueRange);
    const entries = spec.classes.flatMap((c, i): LegendEntry[] =>
      c.color === null || written[i]?.legend === false
        ? []
        : [
            {
              id: typeof written[i]?.id === "string" ? (written[i].id as string) : String(i),
              ...(typeof written[i]?.name === "string" ? { name: written[i].name as string } : {}),
              range: {
                ...(reach[i].from !== undefined ? { from: reach[i].from } : {}),
                ...(reach[i].to !== undefined ? { to: reach[i].to } : {}),
              },
              swatch: fill(c.color),
            },
          ]
    );
    // The band's minimum and maximum close an open first or last class, as the data's do a classification's; with
    // values outside left out, where the drawing stops (`classEnds`).
    const domain = classEnds(render, { range: valueRange });
    return entries.length
      ? [{ kind: "entries", id: "raster", entries, ...(domain ? { domain } : {}), ...(unit ? { unit } : {}) }]
      : [];
  }
  if (spec.kind === "categories") {
    // The coloring's categories are the entries with a value: their names after the same filter.
    const written = list(render.classes).filter(
      (c) => typeof c.value === "number" && Number.isFinite(c.value)
    );
    const entries = spec.classes.flatMap((c, i): LegendEntry[] =>
      c.color === null || written[i]?.legend === false
        ? []
        : [
            {
              id: String(c.value),
              ...(typeof written[i]?.name === "string" ? { name: written[i].name as string } : {}),
              values: [c.value],
              swatch: fill(c.color),
            },
          ]
    );
    // Values no class names take the other color, as the vector legend's Other entry shows them.
    if (spec.other !== null) entries.push({ id: "other", extra: "other", swatch: fill(spec.other) });
    return entries.length ? [{ kind: "entries", id: "raster", entries, ...(unit ? { unit } : {}) }] : [];
  }
  return [];
}

/** Two records of one class merged: the later one's parts over the earlier's, as the map applies them (spec 5.7). The
 * class keeps the earlier one's id (or none): the first classification's counts and the legend's entries read it. */
function mergeRecords(a: unknown, b: unknown): JsonObject | undefined {
  if (!isObject(a)) return isObject(b) ? b : undefined;
  if (!isObject(b)) return a;
  const out: JsonObject = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (key === "id") continue;
    out[key] = isObject(value) && isObject(out[key]) ? { ...(out[key] as JsonObject), ...value } : value;
  }
  return out;
}

/** What a classification's classes hold: their values (categories) or their bounds (numeric classes). */
const classValues = (c: JsonObject) => JSON.stringify(list(c.classes).map((k) => [k.values, k.from, k.to]));

/** The shown classifications (`legendDraws`), those of one field with the same classes as one (the same categories,
 * or the same numeric bounds): a class shows everything the classifications set for it (a size and a color by the
 * same field are one list). `key` is the first one's: its counts stand for the others, which hold the same features,
 * and its classes' ids are the entries' ids. */
function legendClassifications(
  style: JsonObject,
  geometry: Geometry
): Array<{ c: JsonObject; targets: string[]; key: string; indices: number[] }> {
  const out: Array<{ c: JsonObject; targets: string[]; key: string; indices: number[] }> = [];
  for (const [index, c] of list(style.classify).entries()) {
    if (c.legend === false || !legendDraws(c)) continue;
    const same = out.find(
      ({ c: o }) =>
        (o.method === "categories") === (c.method === "categories") &&
        o.field === c.field &&
        classValues(o) === classValues(c)
    );
    if (!same) {
      out.push({ c, targets: [targetOf(c, geometry)], key: itemKey(c, index), indices: [index] });
      continue;
    }
    same.indices.push(index);
    same.c = {
      ...same.c,
      classes: list(same.c.classes).map((k, i) => mergeRecords(k, list(c.classes)[i]) ?? k),
      other: mergeRecords(same.c.other, c.other),
      no_data: mergeRecords(same.c.no_data, c.no_data),
    };
    if (!same.targets.includes(targetOf(c, geometry))) same.targets.push(targetOf(c, geometry));
  }
  return out;
}

/** The legend's blocks of classes (spec 7.2): each one's section id and the properties it stands for, its own
 * classification's and those of the classifications of its field merged into it. */
export function legendBlocks(
  style: JsonObject,
  geometry: Geometry
): Array<{ id: string; targets: string[] }> {
  return legendClassifications(style, geometry).map(({ c, targets }) => ({
    id: typeof c.id === "string" ? c.id : String(c.field),
    targets,
  }));
}

/** The classifications (by index in `classify`) each block of the legend shows, in legend order: one of a field merges
 * the later classifications of that field with the same classes (`legendClassifications`). */
export const legendGroups = (style: JsonObject, geometry: Geometry): number[][] =>
  legendClassifications(style, geometry).map(({ indices }) => indices);

/** The rules the legend lists (spec 7.2): those with a name, not left out; a rule that hides its features draws
 * nothing, so it has no entry either. An entry's id is its rule's `itemKey` among these. */
export const listedRules = (style: JsonObject): JsonObject[] =>
  list(style.rules).filter((r) => typeof r.name === "string" && r.legend !== false && r.visible !== false);

/** The Height line of a layer that raises its features (3D spec 7.7): how the base height is set, or the classes a
 * classification of the height makes; H3 columns follow the cell value. */
function heightSection(style: JsonObject, geometry: Geometry): LegendSection | null {
  if (!extrudes(style)) return null;
  const render = isObject(style.render) ? style.render : null;
  if (render?.type === "h3") {
    const value = isObject(render.value) ? render.value : {};
    const op = value.op === "sum" || value.op === "mean" ? value.op : "count";
    return {
      kind: "height",
      id: "height",
      mode: "h3",
      op,
      ...(op !== "count" && typeof value.field === "string" ? { field: value.field } : {}),
    };
  }
  if (geometry !== "polygon") return null;
  const classified = list(style.classify).find(
    (c) => c.target === "extrude.height" && typeof c.field === "string" && list(c.classes).length > 0
  );
  if (classified)
    return {
      kind: "height",
      id: "height",
      mode: "classes",
      field: classified.field as string,
      count: list(classified.classes).length,
    };
  const symbol = isObject(style.symbol) ? style.symbol : {};
  const part = isObject(symbol.extrude) ? symbol.extrude : {};
  const form = part.height ?? DEFAULTS["extrude.height"];
  if (typeof form === "number") return { kind: "height", id: "height", mode: "fixed", value: form };
  if (isObject(form) && Array.isArray(form.zoom)) {
    // A stop by attribute (spec 4.4) reaches the larger end of its range.
    const values = (form.zoom as unknown[][]).flatMap(([, v]) =>
      typeof v === "number"
        ? [v]
        : byField(v) && Array.isArray(v.range)
          ? v.range.filter((r): r is number => typeof r === "number")
          : []
    );
    return values.length ? { kind: "height", id: "height", mode: "zoom", max: Math.max(...values) } : null;
  }
  if (isObject(form) && typeof form.field === "string") {
    const range = Array.isArray(form.range) ? form.range : null;
    if (range && typeof range[0] === "number" && typeof range[1] === "number")
      return { kind: "height", id: "height", mode: "range", field: form.field, from: range[0], to: range[1] };
    const storeys = perLayer(style, "extrude.unit") === "storeys";
    return { kind: "height", id: "height", mode: storeys ? "storeys" : "field", field: form.field };
  }
  return null;
}

/** Whether a legend says more than the layer's base look, which a swatch beside the layer's name already shows. */
export const informative = (legend: Legend | null | undefined): boolean =>
  !!legend?.sections.some((section) => section.kind !== "entries" || section.id !== "base");

/** Whether a legend of the layer's name only (spec 7.2 `display`) has a title of its own: where a row shows the layer's
 * name (the layer list, the layer widget, print), that title stands under it as the legend's heading, without entries. */
export const titleOnly = (legend: Legend | null | undefined): boolean =>
  !!legend?.title && legend.sections.length === 0;

/** Whether a class is listed (spec 7.2), whatever a count finds: not when it draws nothing on the map. */
export function classListed(style: JsonObject, c: JsonObject, k: JsonObject): boolean {
  // A class hidden with the eye draws nothing on the map, so the legend leaves it out too.
  if (k.legend === false || k.visible === false) return false;
  // A class picked by hand before its values are: it draws nothing yet.
  if (c.method === "categories" && Array.isArray(k.values) && !k.values.length) return false;
  // Its features are hidden with the eye in another classification of the field: nothing of it is on the map.
  return !hiddenElsewhere(style, c, k);
}

/** Whether a classification's Other or No data is listed (spec 7.2), whatever a count finds: the data decides. The
 * server writes into `computed` whether the field has features without a value, and values no class lists; while it
 * has not looked, they are listed where the style sets something for them, and features without a value also where
 * another classification of the field lists them (they are the same features). Never when hidden with the eye or left
 * out, here or, for features without a value, in another classification of the field. */
export function extraListed(style: JsonObject, c: JsonObject, extra: "other" | "no_data"): boolean {
  const own = c[extra];
  if (isObject(own) && (own.legend === false || own.visible === false)) return false;
  const others = list(style.classify).filter((o) => o.field === c.field);
  if (extra === "no_data" && others.some((o) => isObject(o.no_data) && o.no_data.visible === false))
    return false;
  const fact = isObject(c.computed) ? c.computed[extra] : undefined;
  if (typeof fact === "boolean") return fact;
  return (
    isObject(own) ||
    (extra === "no_data" &&
      others.some(
        (o) =>
          o.legend !== false &&
          isObject(o.no_data) &&
          o.no_data.legend !== false &&
          o.no_data.visible !== false
      ))
  );
}

/** `present` while the classes a layer's legend lists are still being counted. */
export const PRESENCE_PENDING = "pending";
/** The most placeholder rows a classification shows while its classes are counted. */
const PENDING_ROWS = 3;

export function buildLegend(
  style: JsonObject,
  ctx: {
    geometry?: Geometry;
    zoom: number;
    serviceLegendUrl?: string;
    /** A raster file's minimum and maximum of what it colors (its value tiles' description): the open first and last
     * class read them (`classEnds`). */
    valueRange?: [number, number] | null;
    /** The classes that have features (spec 7.2 `legend.classes`); without it, or with `all`, every class; while
     * they are counted, placeholder rows. */
    present?: Presence | typeof PRESENCE_PENDING;
  }
): Legend | null {
  const legend = style.legend;
  if (legend === false || (isObject(legend) && legend.show === false)) return null;
  // The layer's name alone (spec 7.2 `display`): its title and caption, no entries.
  if (isObject(legend) && legend.display === "name_only")
    return {
      ...(typeof legend.title === "string" ? { title: legend.title } : {}),
      ...(typeof legend.caption === "string" ? { caption: legend.caption } : {}),
      sections: [],
    };
  if (style.kind === "raster") {
    const sections = rasterSections(style, ctx.serviceLegendUrl, ctx.valueRange);
    if (!sections.length) return null;
    return {
      ...(isObject(legend) && typeof legend.title === "string" ? { title: legend.title } : {}),
      ...(isObject(legend) && typeof legend.caption === "string" ? { caption: legend.caption } : {}),
      sections,
    };
  }
  const geometry = ctx.geometry ?? (style.geometry as Geometry | undefined) ?? "point";
  const images = imageColors(style, geometry);
  const sections: LegendSection[] = [];
  const blocks: Array<{ section: Extract<LegendSection, { kind: "entries" }>; targets: string[] }> = [];
  // A heatmap or H3 layer draws its points from a zoom on (`points_from_zoom`), or never: below that zoom the map
  // shows the density alone, from it the points alone. The legend lists what is on the map.
  const render = isObject(style.render) ? style.render : null;
  const density = render?.type === "heatmap" || render?.type === "h3";
  const points =
    !density || (typeof render?.points_from_zoom === "number" && ctx.zoom >= render.points_from_zoom);
  const counts = legendClasses(style) === "all" ? undefined : ctx.present;
  const pending = counts === PRESENCE_PENDING;
  // A class or Other or No data the count left out: when nothing else is left, the legend says so.
  let countedOut = false;
  // Clusters, only below `cluster_until_zoom`: from it on the map draws single points alone.
  const clustering =
    render?.type === "cluster" &&
    ctx.zoom <
      (typeof render.cluster_until_zoom === "number"
        ? render.cluster_until_zoom
        : (DEFAULTS["cluster.cluster_until_zoom"] as number));
  for (const { c, targets, key } of points ? legendClassifications(style, geometry) : []) {
    const entries: LegendEntry[] = [];
    const numeric = c.method !== "categories";
    const neutral = !targets.some((target) => CAPABILITIES[target]?.kind === "color");
    // Its features under the layer's filter or in the map's view, once counted.
    const counted = counts === PRESENCE_PENDING ? undefined : counts?.[key];
    list(c.classes).forEach((k, i) => {
      if (!classListed(style, c, k)) return;
      // No feature of it is kept by the filter, or in the view: the map draws none, as for a class hidden with the eye.
      if (counted && !counted.classes.has(itemKey(k, i))) {
        countedOut = true;
        return;
      }
      const entry: LegendEntry = {
        id: itemKey(k, i),
        swatch: swatch(style, geometry, ctx.zoom, k, neutral, images),
      };
      if (typeof k.name === "string") entry.name = k.name;
      const raised = heightOf(k);
      if (raised !== undefined) entry.height = raised;
      if (numeric)
        entry.range = {
          ...(typeof k.from === "number" ? { from: k.from } : {}),
          ...(typeof k.to === "number" ? { to: k.to } : {}),
        };
      else if (Array.isArray(k.values)) entry.values = k.values as LegendEntry["values"];
      entries.push(entry);
    });
    // The height of features a class of the height does not raise itself: the layer's own, where it is one value.
    const raisedTo = (record: JsonObject): number | undefined =>
      heightOf(record) ?? (targets.includes("extrude.height") ? baseHeight(style) : undefined);
    for (const extra of ["other", "no_data"] as const) {
      // Listed with the look the style gives them or the base look they keep, when the data holds such features and
      // the count, where there is one, found some.
      if (!extraListed(style, c, extra)) continue;
      if (counted && !counted[extra]) {
        countedOut = true;
        continue;
      }
      const own = c[extra];
      const record: JsonObject = isObject(own) ? own : {};
      entries.push({
        id: extra,
        extra,
        ...(typeof record.name === "string" ? { name: record.name } : {}),
        ...(raisedTo(record) !== undefined ? { height: raisedTo(record) } : {}),
        swatch: swatch(style, geometry, ctx.zoom, record, neutral, images),
      });
    }
    // A classification without entries leaves no block, nor a heading: its classes are all hidden with the eye,
    // or it has none (not computed yet, or its field has no values).
    if (!entries.length) continue;
    // Sizes of a polygon's or a line's marker: the markers alone, as for points.
    if (targets.includes("marker.size") && targets.every((target) => target.startsWith("marker.")))
      for (const entry of entries) entry.swatch = markerAlone(entry.swatch, neutral);
    const domain = classDomain(c);
    blocks.push({
      targets,
      section: {
        kind: "entries",
        id: typeof c.id === "string" ? c.id : String(c.field),
        ...(typeof c.title === "string" ? { title: c.title } : {}),
        ...(typeof c.field === "string" ? { field: c.field } : {}),
        ...(pending ? { entries: [], pending: Math.min(entries.length, PENDING_ROWS) } : { entries }),
        ...(domain ? { domain } : {}),
        ...(typeof c.unit === "string" && c.unit ? { unit: c.unit } : {}),
        ...(isObject(c.format) ? { format: c.format as RangeFormat } : {}),
        ...(targets.every((target) => target === "extrude.height") ? { bars: true } : {}),
        ...(targets.some((target) => SIZES.has(target)) ? { sized: true } : {}),
        ...(geometry !== "line" &&
        targets.every((target) => target.startsWith("outline.") && !SIZES.has(target))
          ? { hollow: true }
          : {}),
      },
    });
  }
  for (const { section, targets } of blocks)
    sections.push(
      blocks.length > 1
        ? { ...section, properties: targets.map((target) => propertyKey(target, geometry)) }
        : section
    );
  const rules = points ? listedRules(style) : [];
  const forms = points ? valueFormSections(style, geometry, ctx.zoom, images) : [];
  if (rules.length) {
    const entries: LegendEntry[] = rules.map((r, i) => ({
      id: itemKey(r, i),
      name: r.name as string,
      swatch: swatch(style, geometry, ctx.zoom, r, false, images),
    }));
    // Without classes or a value by attribute nothing else says what the features no rule matches look like.
    if (!blocks.length && !forms.length)
      entries.push({
        id: "rest",
        extra: "rest",
        swatch: swatch(style, geometry, ctx.zoom, undefined, false, images),
      });
    sections.push({ kind: "entries", id: "rules", entries });
  }
  sections.push(...forms);
  if (isObject(style.render) && style.render.type === "heatmap" && !points) {
    const palette = style.render.palette ?? DEFAULTS["heatmap.palette"];
    const colors = Array.isArray(palette)
      ? [...(palette as string[])]
      : [...(PALETTES[palette as string]?.colors ?? [])];
    if (style.render.reverse === true) colors.reverse();
    const opacity = renderOpacity(style.render.opacity, DEFAULTS["heatmap.opacity"] as number, ctx.zoom);
    sections.push({
      kind: "ramp",
      id: "heatmap",
      colors,
      domain: [0, 1],
      ends: "low_high",
      ...rampOpacity(opacity),
    });
  }
  if (isObject(style.render) && style.render.type === "h3" && !points)
    sections.push(...h3Sections(style.render, ctx.zoom));
  if (!sections.length && countedOut)
    sections.push({
      kind: "empty",
      id: "empty",
      classes: legendClasses(style) === "view" ? "view" : "filter",
    });
  else if (!sections.length) {
    // The layer's name says what the one swatch is; below the Clusters row it reads as the single points.
    sections.push({
      kind: "entries",
      id: "base",
      entries: [
        {
          id: "base",
          ...(clustering ? { extra: "points" as const } : {}),
          swatch: swatch(style, geometry, ctx.zoom, undefined, false, images),
        },
      ],
    });
  }
  // H3 columns stand only while the hexagons are drawn.
  const height = density && points ? null : heightSection(style, geometry);
  if (height) sections.push(height);
  // Clusters first, then the single points (spec 7.2).
  if (clustering && render) sections.unshift(...clusterSections(style, render, ctx.zoom));
  return {
    ...(isObject(legend) && typeof legend.title === "string" ? { title: legend.title } : {}),
    ...(isObject(legend) && typeof legend.caption === "string" ? { caption: legend.caption } : {}),
    sections,
  };
}

/** Whether every feature of class `k` falls in a class another classification of the same field hides with the eye:
 * a category whose values are all hidden there, a numeric class inside a hidden range. */
function hiddenElsewhere(style: JsonObject, c: JsonObject, k: JsonObject): boolean {
  const hidden = list(style.classify)
    .filter((o) => o.field === c.field)
    .flatMap((o) => list(o.classes).filter((h) => h.visible === false));
  if (!hidden.length) return false;
  if (Array.isArray(k.values)) {
    const gone = new Set(hidden.flatMap((h) => (Array.isArray(h.values) ? h.values.map(String) : [])));
    return k.values.length > 0 && k.values.every((v) => gone.has(String(v)));
  }
  const low = (r: JsonObject) => (typeof r.from === "number" ? r.from : -Infinity);
  const high = (r: JsonObject) => (typeof r.to === "number" ? r.to : Infinity);
  return hidden.some((h) => !Array.isArray(h.values) && low(h) <= low(k) && high(h) >= high(k));
}

/** The layer's own height in metres, where it is one value (not by zoom or by attribute). */
function baseHeight(style: JsonObject): number | undefined {
  const symbol = isObject(style.symbol) ? style.symbol : {};
  const own = isObject(symbol.extrude) ? symbol.extrude.height : undefined;
  const height = own ?? DEFAULTS["extrude.height"];
  return typeof height === "number" ? height : undefined;
}

/** The height a class record gives its features, where it sets one. */
const heightOf = (record: unknown): number | undefined =>
  isObject(record) && isObject(record.extrude) && typeof record.extrude.height === "number"
    ? record.extrude.height
    : undefined;

/** "Clusters" with a sample (spec 7.2): the cluster symbol, at the middle of its sizes where they follow the count, or
 * the points' marker as clusters drawn like them show it (spec 8.2 `look: points`, `pointsSymbol`); with the badge where the number is
 * on one, in the cluster symbol's marker, label and outline colors as on the map (white without an outline). With a
 * value by a field, the entry names it, and a size or color by the value shows its range. */
function clusterSections(style: JsonObject, render: JsonObject, zoom: number): LegendSection[] {
  const symbol = isObject(render.symbol) ? render.symbol : (DEFAULT_CLUSTER_SYMBOL as unknown as JsonObject);
  const marker = isObject(symbol.marker) ? symbol.marker : {};
  const range =
    isObject(marker.size) && Array.isArray(marker.size.range) ? (marker.size.range as number[]) : null;
  const own = swatch(
    { symbol },
    "point",
    zoom,
    range ? { marker: { size: (range[0] + range[1]) / 2 } } : undefined
  );
  const points = (render.look ?? DEFAULTS["cluster.look"]) === "points";
  const sample = points ? swatch({ symbol: pointsSymbol(style) }, "point", zoom) : own;
  if ((render.count ?? DEFAULTS["cluster.count"]) === "badge") {
    const label = isObject(symbol.label) ? symbol.label : {};
    const outline = isObject(symbol.outline) ? symbol.outline : null;
    sample.badge = {
      color: typeof own.marker?.color === "string" ? own.marker.color : (DEFAULTS["marker.color"] as string),
      text: typeof label.color === "string" ? label.color : DEFAULT_CLUSTER_SYMBOL.label.color,
      ring: outline
        ? typeof outline.color === "string"
          ? outline.color
          : (DEFAULTS["outline.color"] as string)
        : "#ffffff",
    };
  }
  const value = isObject(render.value) ? render.value : {};
  const named =
    typeof value.op === "string" && value.op !== "count" && typeof value.field === "string"
      ? { op: value.op as ValueOp, field: value.field }
      : null;
  const entries: LegendSection = {
    kind: "entries",
    id: "cluster",
    ...(named ?? {}),
    entries: [{ id: "cluster", extra: "cluster", swatch: sample }],
  };
  if (!named) return [entries];
  // The cluster symbol's forms over the value, as the base symbol's forms show theirs: its samples have the cluster
  // symbol's color and outline, as on the map; a form over the count has no sample of the value.
  const ofValue = (part: unknown) =>
    isObject(part)
      ? Object.fromEntries(
          Object.entries(part).filter(
            ([, form]) => !isObject(form) || typeof form.field !== "string" || form.field === "value"
          )
        )
      : part;
  const byValue = valueFormSections(
    { symbol: { marker: ofValue(symbol.marker), outline: ofValue(symbol.outline) } },
    "point",
    zoom
  ).map((section) => ({ ...section, id: `cluster.${section.id}`, ...named }) as LegendSection);
  return [entries, ...byValue];
}

/** H3 hexagons (spec 7.2): the cell value at the resolution the zoom draws, as classes or a ramp, at the hexagons'
 * opacity; nothing while the values are not computed. A sum or mean names its field. */
function h3Sections(render: JsonObject, zoom: number): LegendSection[] {
  const scale = h3Scale(render, h3Resolution(render, zoom));
  const value = isObject(render.value) ? render.value : {};
  const field = value.op !== "count" && typeof value.field === "string" ? { field: value.field } : {};
  const opacity = renderOpacity(render.opacity, DEFAULTS["h3.opacity"] as number, zoom);
  if (scale.kind === "ramp")
    return [
      {
        kind: "ramp",
        id: "h3",
        ...(field.field ? { title: field.field } : {}),
        colors: scale.colors,
        domain: [scale.min, scale.max],
        ...rampOpacity(opacity),
      },
    ];
  // Not computed yet, or one value in every cell: the map draws every hexagon in one color.
  if (scale.kind === "color")
    return [
      {
        kind: "entries",
        id: "h3",
        ...field,
        op: value.op === "sum" || value.op === "mean" ? value.op : "count",
        entries: [
          {
            id: "0",
            extra: "h3",
            swatch: { geometry: "polygon" as const, fill: { color: scale.color, opacity } },
          },
        ],
      },
    ];
  if (scale.kind !== "classes") return [];
  const n = scale.colors.length;
  return [
    {
      kind: "entries",
      id: "h3",
      ...field,
      entries: scale.colors.map((color, i) => ({
        id: String(i),
        range: {
          ...(i > 0 ? { from: scale.breaks[i - 1] } : {}),
          ...(i < n - 1 ? { to: scale.breaks[i] } : {}),
        },
        swatch: { geometry: "polygon" as const, fill: { color, opacity } },
      })),
      ...(scale.domain ? { domain: scale.domain } : {}),
    },
  ];
}

/** Whether a style's legend and base swatch can change with the zoom: it has a value by zoom anywhere, or draws its
 * points as clusters, a heatmap or hexagons (each changes what it shows at a zoom). Any other legend is the same at
 * every zoom. */
export function legendDependsOnZoom(style: JsonObject): boolean {
  if (isObject(style.render) && style.render.type !== undefined) return true;
  const byZoom = (node: unknown): boolean =>
    Array.isArray(node)
      ? node.some(byZoom)
      : isObject(node) &&
        Object.entries(node).some(([key, v]) => (key === "zoom" && Array.isArray(v)) || byZoom(v));
  return byZoom(style);
}

/** A layer's base look as one swatch (the layer list's icon). */
export function baseSwatch(style: JsonObject, ctx: { geometry: Geometry; zoom: number }): Swatch {
  return swatch(style, ctx.geometry, ctx.zoom);
}

/** The class of a classification a feature's value falls in: its position in `classes`, `other` for a value no class
 * lists or holds, `no_data` for a feature without a value (spec 5.1, 5.2). */
export type ClassIndex = number | "other" | "no_data";

/**
 * Which class a value is in, as the map draws it: categories compare values as text with the texts each class matches
 * on the map (`classTexts`: a class value that writes a number also in the number's own spelling), a numeric class
 * holds its `from` and the values below its `to` (a value at the last class's `to` keeps the base look on the map, so
 * it is in no class). Built once per classification: categories look the value up in a table of their texts, so
 * reading many features costs one lookup each. The popup header and the legend's counts (spec 7.2 `legend.classes`)
 * read classes with it.
 */
export function classifier(c: JsonObject): (value: unknown) => ClassIndex {
  const classes = list(c.classes);
  if (c.method === "categories") {
    const byText = new Map<string, number>();
    classTexts(classes).forEach((texts, i) => texts.forEach((text) => byText.set(text, i)));
    return (value) =>
      value === null || value === undefined ? "no_data" : (byText.get(String(value)) ?? "other");
  }
  return (value) => {
    if (value === null || value === undefined) return "no_data";
    if (typeof value !== "number") return "other";
    for (let i = 0; i < classes.length; i++) {
      const { from, to } = classes[i];
      if ((typeof from !== "number" || value >= from) && (typeof to !== "number" || value < to)) return i;
    }
    return "other";
  };
}

/** The class a feature's value falls in, for one value (`classifier` reads many). */
export const classIndexOf = (c: JsonObject, value: unknown): ClassIndex => classifier(c)(value);

/** The record of the class a feature falls in: its class, else `other`, `no_data` for no value. */
function recordOf(c: JsonObject, value: unknown): JsonObject | undefined {
  const index = classIndexOf(c, value);
  const record = typeof index === "number" ? list(c.classes)[index] : c[index];
  return isObject(record) ? record : undefined;
}

/** The swatch of the class a feature falls in (the popup header's icon): the class of the first classification the
 * legend draws (`legendDraws`) for the feature's value, its `other` or `no_data` record, else the layer's base look. */
export function classOf(
  style: JsonObject,
  properties: Record<string, unknown> | undefined,
  ctx: { geometry: Geometry; zoom: number }
): Swatch {
  const first = list(style.classify).find(legendDraws);
  const record =
    first && typeof first.field === "string" ? recordOf(first, properties?.[first.field]) : undefined;
  return swatch(style, ctx.geometry, ctx.zoom, record);
}

/** The data's minimum and maximum a numeric classification's classes span (`computed.domain`, written by the server
 * with the classes); none for categories or while not computed. */
export function classDomain(c: JsonObject): [number, number] | undefined {
  if (c.method === "categories" || !isObject(c.computed)) return undefined;
  const d = c.computed.domain;
  return Array.isArray(d) &&
    d.length === 2 &&
    d.every((v) => typeof v === "number" && Number.isFinite(v)) &&
    (d[0] as number) <= (d[1] as number)
    ? (d as [number, number])
    : undefined;
}

export interface RangeFormat {
  decimals?: number | "auto";
  thousands_separator?: boolean;
  prefix?: string;
  suffix?: string;
}

interface RangeOptions {
  locale: string;
  words: { under: string; to: string; andMore: string };
  unit?: string;
  format?: RangeFormat;
  /** The data's minimum and maximum: an open first or last class reads them in place of "under" and "and more". */
  domain?: [number, number];
}

/** A number as range labels write it: the format's decimals, grouping, prefix and suffix. */
function rangeNumber(opts: { locale: string; format?: RangeFormat }): (v: number) => string {
  const decimals = opts.format?.decimals;
  const formatter = new Intl.NumberFormat(opts.locale, {
    useGrouping: opts.format?.thousands_separator !== false,
    ...(typeof decimals === "number"
      ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals }
      : {}),
  });
  return (v: number) => `${opts.format?.prefix ?? ""}${formatter.format(v)}${opts.format?.suffix ?? ""}`;
}

/** A class's range with its open ends closed by the data's minimum and maximum (`opts.domain`) where that reads
 * as a range: an end that reads the same as the class's bound once formatted, or lies past it, stays open. */
export function labelRange(
  range: { from?: number; to?: number },
  opts: RangeOptions
): { from?: number; to?: number } {
  if (!opts.domain) return range;
  const [min, max] = opts.domain;
  const n = rangeNumber(opts);
  const { from, to } = range;
  if (from === undefined && to === undefined)
    return n(min) === n(max) ? { from: min, to: min } : { from: min, to: max };
  return {
    ...(from !== undefined
      ? { from }
      : to !== undefined && min < to && n(min) !== n(to)
        ? { from: min }
        : {}),
    ...(to !== undefined
      ? { to }
      : from !== undefined && max > from && n(max) !== n(from)
        ? { to: max }
        : {}),
  };
}

/** A class's range as legend text (spec 7.2): "2,800 to 3,600"; an open first or last class "800 to 2,800" and
 * "6,300 to 9,000" with the data's minimum and maximum (`labelRange`), else "under 2,800" and "6,300 and more"; a
 * single class the data's range, or its one value. The unit goes with the last number: "under 49.4 m",
 * "101.6 m and more". */
export function rangeText(range: { from?: number; to?: number }, opts: RangeOptions): string {
  const n = rangeNumber(opts);
  const { from, to } = labelRange(range, opts);
  const unit = opts.unit ? ` ${opts.unit}` : "";
  if (from !== undefined && to !== undefined)
    return from === to ? `${n(from)}${unit}` : `${n(from)} ${opts.words.to} ${n(to)}${unit}`;
  if (to !== undefined) return `${opts.words.under} ${n(to)}${unit}`;
  if (from !== undefined) return `${n(from)}${unit} ${opts.words.andMore}`;
  return "";
}

/** A category's values as legend text: "100, 50 pixels", numbers with the classification's unit after them as
 * after a range, and with the number format where the classification sets one, else as they are (a year or a code
 * stays ungrouped). Names take no unit; yes and no read as the words in `flags` where given. */
export function valuesText(
  values: ReadonlyArray<string | number | boolean>,
  opts: { locale: string; unit?: string; format?: RangeFormat; flags?: { yes: string; no: string } }
): string {
  const n = opts.format ? rangeNumber(opts) : String;
  // The values of a yes/no field read as words (the server writes them as the texts "true" and "false").
  const words = opts.flags;
  const flags =
    !!words &&
    values.length > 0 &&
    values.every((v) => typeof v === "boolean" || v === "true" || v === "false");
  const text = values
    .map((v) =>
      flags ? (v === true || v === "true" ? words.yes : words.no) : typeof v === "number" ? n(v) : String(v)
    )
    .join(", ");
  // A unit suits numbers, not names.
  const numbers = values.length > 0 && values.every((v) => typeof v === "number");
  return opts.unit && numbers ? `${text} ${opts.unit}` : text;
}
