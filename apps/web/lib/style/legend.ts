// Legend data of a layer style (spec 7.2): sections of entries with swatches, ramps for palettes by attribute,
// size samples for ranges. Swatches hold fixed values at a zoom; the legend components draw them.
import { perLayer } from "@/lib/style/compile/cascade";
import { extrudes } from "@/lib/style/compile/polygons";
import { DEFAULT_CLUSTER_SYMBOL, h3Resolution, h3Scale } from "@/lib/style/compile/render";
import type { Geometry } from "@/lib/style/compile/types";
import { fromForm, valueAt } from "@/lib/style/compile/values";
import { CAPABILITIES } from "@/lib/style/generated/capabilities";
import { PALETTES } from "@/lib/style/generated/catalog";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { PROPERTY_KINDS } from "@/lib/style/generated/properties";
import { type JsonObject, isObject } from "@/lib/style/json";
import { rasterColorSpec } from "@/lib/style/raster/color";

type Part = Record<string, unknown>;

export interface Swatch {
  geometry: Geometry;
  fill?: Part;
  outline?: Part;
  line?: Part;
  casing?: Part;
  marker?: Part;
}

export interface LegendEntry {
  id: string;
  name?: string;
  values?: Array<string | number | boolean>;
  range?: { from?: number; to?: number };
  /** The classification's Other or No data record, the layer's clusters, its H3 cells in one color, or the
   * features no rule matches (`rest`). */
  extra?: "other" | "no_data" | "cluster" | "h3" | "rest";
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
      /** H3: how the cell value is computed. */
      op?: "count" | "sum" | "mean";
      /** The classification sets a size (a marker's size, a line's or an outline's width): its entries are drawn
       * at sizes in the ratio the classes have. Every other block keeps its swatches in one fixed box. */
      sized?: boolean;
      /** The classification sets the outline alone: its swatches are rings, so the outline reads. */
      hollow?: boolean;
      /** The classification sets the height alone: its entries draw a bar of their height, a swatch shows none. */
      bars?: boolean;
    }
  | {
      kind: "ramp";
      id: string;
      title?: string;
      /** The field a value form reads. */
      field?: string;
      /** A density without numbers (a heatmap): the ends read low and high. */
      ends?: "low_high";
      colors: string[];
      domain: [number, number];
      /** The value at the middle of the ramp, where the scale is not linear. */
      middle?: number;
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
  | {
      kind: "sizes";
      id: string;
      title?: string;
      /** The field the sizes follow. */
      field?: string;
      samples: Array<{ value: number; swatch: Swatch }>;
    };

export interface Legend {
  title?: string;
  caption?: string;
  sections: LegendSection[];
}

const PARTS: Record<Geometry, Array<keyof Omit<Swatch, "geometry">>> = {
  point: ["marker", "outline"],
  line: ["casing", "line"],
  polygon: ["fill", "outline"],
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

/** Sizes and widths: read at one zoom whatever the map's. A legend whose symbols grow and shrink with the zoom
 * jumps; colors and every other value follow the map's zoom, so a swatch shows the color on screen. */
const STEADY = new Set(["marker.size", "line.width", "outline.width", "casing.width"]);

/** The zoom a size by zoom is read at: the middle of its stops. */
function steadyZoom(form: unknown, zoom: number): number {
  const stops = isObject(form) && Array.isArray(form.zoom) ? (form.zoom as unknown[][]) : [];
  const [first, last] = [stops[0]?.[0], stops[stops.length - 1]?.[0]];
  return typeof first === "number" && typeof last === "number" ? (first + last) / 2 : zoom;
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

/** The base merged with a record's overrides (spec 6.1): `false` switches a part off, an object switches it on.
 * `neutral`: the main part's color the record does not set itself is neutral grey (a classification that sets no
 * color). */
function swatch(
  style: JsonObject,
  geometry: Geometry,
  zoom: number,
  override?: JsonObject,
  neutral = false
): Swatch {
  const symbol = isObject(style.symbol) ? style.symbol : {};
  const out: Swatch = { geometry };
  for (const part of PARTS[geometry]) {
    const base = symbol[part];
    const over = override?.[part];
    const used = part === MAIN[geometry] || isObject(base) || isObject(over);
    if (!used || over === false || (base === false && !isObject(over))) continue;
    const merged: JsonObject = { ...(isObject(base) ? base : {}), ...(isObject(over) ? over : {}) };
    // A main color by attribute has no one color to show (its ramp stands beside the entries): neutral grey.
    if (part === MAIN[geometry] && isObject(merged.color) && typeof merged.color.field === "string")
      merged.color = LEGEND_NEUTRAL;
    if (neutral && part === MAIN[geometry]) {
      const own = isObject(over) ? over : {};
      if (own.color === undefined) merged.color = LEGEND_NEUTRAL;
      if (part === "marker" && own.icon_color === undefined && merged.icon_color !== undefined)
        merged.icon_color = LEGEND_NEUTRAL;
    }
    const resolved: Part = {};
    for (const key of KEYS[part]) resolved[key] = resolve(merged[key], `${part}.${key}`, zoom);
    if (part === "marker" && merged.icon !== undefined)
      resolved.icon = resolve(merged.icon, "marker.icon", zoom);
    // A hollow marker (spec 3.3): its outline and icon only, the icon in the marker color unless it has its own.
    if (part === "marker" && merged.fill === false && resolved.shape !== "icon") {
      resolved.fill = false;
      if (merged.icon_color === undefined) resolved.icon_color = resolved.color;
    }
    if (part === "fill" && resolved.pattern !== "none") {
      resolved.pattern_color = merged.pattern_color ?? resolved.color;
      for (const key of ["pattern_spacing", "pattern_width"])
        resolved[key] = resolve(merged[key], `fill.${key}`, zoom);
    }
    if (part === "outline" && resolved.color === "fill")
      resolved.color =
        geometry === "point"
          ? (out.marker?.color ?? DEFAULTS["marker.color"])
          : (out.fill?.color ?? DEFAULTS["fill.color"]);
    out[part] = resolved;
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

/** The output of a range form at `v`, by its scale (spec 5.8), rounded to 0.1. */
export function scaled(form: JsonObject, domain: [number, number], v: number): number {
  const [r0, r1] = form.range as number[];
  const t = scaleT(form, domain, v);
  const out = Number.isFinite(t) ? r0 + t * (r1 - r0) : r0;
  return Math.round(out * 10) / 10;
}

/** Sections for the base symbol's value forms by attribute: a ramp per palette, three samples per range. */
function valueFormSections(style: JsonObject, geometry: Geometry, zoom: number): LegendSection[] {
  const symbol = isObject(style.symbol) ? style.symbol : {};
  const sections: LegendSection[] = [];
  for (const part of PARTS[geometry]) {
    const node = symbol[part];
    if (!isObject(node)) continue;
    for (const [key, form] of Object.entries(node)) {
      if (!isObject(form) || typeof form.field !== "string") continue;
      const domain = domainOf(form);
      if (!domain) continue;
      const id = `${part}.${key}`;
      const title = typeof form.title === "string" ? form.title : undefined;
      if ("palette" in form) {
        const colors = Array.isArray(form.palette)
          ? [...(form.palette as string[])]
          : [...(PALETTES[form.palette as string]?.colors ?? [])];
        if (form.reverse === true) colors.reverse();
        const curved = form.scale === "sqrt" || form.scale === "log";
        sections.push({
          kind: "ramp",
          id,
          title,
          field: form.field,
          colors,
          domain,
          // Three significant digits: a guide to where the middle sits, not a value to read exactly.
          ...(curved ? { middle: Number(scaleValue(form, domain, 0.5).toPrecision(3)) } : {}),
        });
      } else if (Array.isArray(form.range)) {
        const samples = [0, 0.5, 1].map((t) => {
          const value = domain[0] + t * (domain[1] - domain[0]);
          return {
            value,
            swatch: swatch(style, geometry, zoom, { [part]: { [key]: scaled(form, domain, value) } }),
          };
        });
        sections.push({ kind: "sizes", id, title, field: form.field, samples });
      }
    }
  }
  return sections;
}

/** The legend of a raster file or map service (spec 9.2 to 9.5, 9.8): a ramp, the visible classes, or the service's
 * legend image; an image and shading without colors have none. */
function rasterSections(style: JsonObject, serviceLegendUrl?: string): LegendSection[] {
  if (serviceLegendUrl) return [{ kind: "image", id: "service", url: serviceLegendUrl }];
  const render: JsonObject = isObject(style.render) ? style.render : { type: "image" };
  const spec = rasterColorSpec(render);
  if (!spec) return [];
  const legend = isObject(style.legend) ? style.legend : {};
  const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const ends: [string | undefined, string | undefined] = [text(legend.min_label), text(legend.max_label)];
  const ramp = (colors: string[], domain: [number, number]): LegendSection => ({
    kind: "ramp",
    id: "raster",
    colors,
    domain,
    ...(text(legend.unit) ? { unit: text(legend.unit) } : {}),
    ...(ends.some(Boolean) ? { labels: ends } : {}),
  });
  const fill = (color: string): Swatch => ({ geometry: "polygon", fill: { color } });
  // A ramp without a domain shows none until the server computed the band's range (spec 12).
  if (spec.kind === "ramp") return spec.domain ? [ramp(spec.colors, spec.domain)] : [];
  if (spec.kind === "stops")
    return [
      ramp(
        spec.stops.map((s) => s.color),
        [spec.stops[0].value, spec.stops[spec.stops.length - 1].value]
      ),
    ];
  if (spec.kind === "classes") {
    const written = list(isObject(render.classify) ? render.classify.classes : undefined);
    const entries = spec.classes.flatMap((c, i): LegendEntry[] =>
      c.color === null || written[i]?.legend === false
        ? []
        : [
            {
              id: typeof written[i]?.id === "string" ? (written[i].id as string) : String(i),
              ...(typeof written[i]?.name === "string" ? { name: written[i].name as string } : {}),
              range: {
                ...(c.from !== undefined ? { from: c.from } : {}),
                ...(c.to !== undefined ? { to: c.to } : {}),
              },
              swatch: fill(c.color),
            },
          ]
    );
    return entries.length ? [{ kind: "entries", id: "raster", entries }] : [];
  }
  if (spec.kind === "categories") {
    const written = list(render.classes);
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
    return entries.length ? [{ kind: "entries", id: "raster", entries }] : [];
  }
  return [];
}

/** Whether a legend says more than the layer's base look, which a swatch beside the layer's name already shows. */
/** Two records of one class merged: the later one's parts over the earlier's, as the map applies them (spec 5.7). */
function mergeRecords(a: unknown, b: unknown): JsonObject | undefined {
  if (!isObject(a)) return isObject(b) ? b : undefined;
  if (!isObject(b)) return a;
  const out: JsonObject = { ...a };
  for (const [key, value] of Object.entries(b))
    out[key] = isObject(value) && isObject(out[key]) ? { ...(out[key] as JsonObject), ...value } : value;
  return out;
}

/** What a classification's classes hold: their values (categories) or their bounds (numeric classes). */
const classValues = (c: JsonObject) => JSON.stringify(list(c.classes).map((k) => [k.values, k.from, k.to]));

/** The shown classifications, those of one field with the same classes as one (the same categories, or the same
 * numeric bounds): a class shows everything the classifications set for it (a size and a color by the same field
 * are one list). */
function legendClassifications(
  style: JsonObject,
  geometry: Geometry
): Array<{ c: JsonObject; targets: string[] }> {
  const out: Array<{ c: JsonObject; targets: string[] }> = [];
  for (const c of list(style.classify)) {
    if (c.legend === false) continue;
    const same = out.find(
      ({ c: o }) =>
        (o.method === "categories") === (c.method === "categories") &&
        o.field === c.field &&
        classValues(o) === classValues(c)
    );
    if (!same) {
      out.push({ c, targets: [targetOf(c, geometry)] });
      continue;
    }
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
    const values = (form.zoom as unknown[][]).map((stop) => stop[1]).filter((v) => typeof v === "number");
    return { kind: "height", id: "height", mode: "zoom", max: Math.max(...(values as number[])) };
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

export const informative = (legend: Legend | null | undefined): boolean =>
  !!legend?.sections.some((section) => section.kind !== "entries" || section.id !== "base");

export function buildLegend(
  style: JsonObject,
  ctx: { geometry?: Geometry; zoom: number; serviceLegendUrl?: string }
): Legend | null {
  const legend = style.legend;
  if (legend === false || (isObject(legend) && legend.show === false)) return null;
  if (style.kind === "raster") {
    const sections = rasterSections(style, ctx.serviceLegendUrl);
    if (!sections.length) return null;
    return {
      ...(isObject(legend) && typeof legend.title === "string" ? { title: legend.title } : {}),
      ...(isObject(legend) && typeof legend.caption === "string" ? { caption: legend.caption } : {}),
      sections,
    };
  }
  const geometry = ctx.geometry ?? (style.geometry as Geometry | undefined) ?? "point";
  const sections: LegendSection[] = [];
  const blocks: Array<{ section: Extract<LegendSection, { kind: "entries" }>; targets: string[] }> = [];
  // A heatmap or H3 layer draws its points from a zoom on (`points_from_zoom`), or never: below that zoom the map
  // shows the density alone, from it the points alone. The legend lists what is on the map.
  const render = isObject(style.render) ? style.render : null;
  const density = render?.type === "heatmap" || render?.type === "h3";
  const points =
    !density || (typeof render?.points_from_zoom === "number" && ctx.zoom >= render.points_from_zoom);
  for (const { c, targets } of points ? legendClassifications(style, geometry) : []) {
    const entries: LegendEntry[] = [];
    const numeric = c.method !== "categories";
    const neutral = !targets.some((target) => CAPABILITIES[target]?.kind === "color");
    list(c.classes).forEach((k, i) => {
      // A class hidden with the eye draws nothing on the map, so the legend leaves it out too.
      if (k.legend === false || k.visible === false) return;
      // A class picked by hand before its values are: it draws nothing yet.
      if (!numeric && Array.isArray(k.values) && !k.values.length) return;
      // Its features are hidden with the eye in another classification of the field: nothing of it is on the map.
      if (hiddenElsewhere(style, c, k)) return;
      const entry: LegendEntry = {
        id: typeof k.id === "string" ? k.id : String(i),
        swatch: swatch(style, geometry, ctx.zoom, k, neutral),
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
      const own = c[extra];
      // The author hid these features with the eye, or left them out of the legend.
      if (isObject(own) && (own.legend === false || own.visible === false)) continue;
      // The data decides (spec 12): the server writes into `computed` whether the field has features without a
      // value, and values no class lists. They are listed when it has, with the look the style gives them or the
      // base look they keep, and not listed when it has none.
      const fact = isObject(c.computed) ? c.computed[extra] : undefined;
      // While the server has not looked: listed where the style sets something for them, and features without a
      // value also where another classification of the field lists them (they are the same features).
      const recorded =
        isObject(own) ||
        (extra === "no_data" &&
          list(style.classify).some(
            (o) =>
              o.field === c.field &&
              o.legend !== false &&
              isObject(o.no_data) &&
              o.no_data.legend !== false &&
              o.no_data.visible !== false
          ));
      if (!(typeof fact === "boolean" ? fact : recorded)) continue;
      const record: JsonObject = isObject(own) ? own : {};
      // Features without a value hidden with the eye in another classification of the field are not on the map.
      if (
        extra === "no_data" &&
        list(style.classify).some(
          (o) => o.field === c.field && isObject(o.no_data) && o.no_data.visible === false
        )
      )
        continue;
      entries.push({
        id: extra,
        extra,
        ...(typeof record.name === "string" ? { name: record.name } : {}),
        ...(raisedTo(record) !== undefined ? { height: raisedTo(record) } : {}),
        swatch: swatch(style, geometry, ctx.zoom, record, neutral),
      });
    }
    // A classification without entries leaves no block, nor a heading: its classes are all hidden with the eye,
    // or it has none (not computed yet, or its field has no values).
    if (!entries.length) continue;
    const domain = classDomain(c);
    blocks.push({
      targets,
      section: {
        kind: "entries",
        id: typeof c.id === "string" ? c.id : String(c.field),
        ...(typeof c.title === "string" ? { title: c.title } : {}),
        ...(typeof c.field === "string" ? { field: c.field } : {}),
        entries,
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
  // A rule that hides its features draws nothing, so it has no entry either.
  const rules = (points ? list(style.rules) : []).filter(
    (r) => typeof r.name === "string" && r.legend !== false && r.visible !== false
  );
  const forms = points ? valueFormSections(style, geometry, ctx.zoom) : [];
  if (rules.length) {
    const entries: LegendEntry[] = rules.map((r, i) => ({
      id: typeof r.id === "string" ? r.id : String(i),
      name: r.name as string,
      swatch: swatch(style, geometry, ctx.zoom, r),
    }));
    // Without classes or a value by attribute nothing else says what the features no rule matches look like.
    if (!blocks.length && !forms.length)
      entries.push({ id: "rest", extra: "rest", swatch: swatch(style, geometry, ctx.zoom) });
    sections.push({ kind: "entries", id: "rules", entries });
  }
  sections.push(...forms);
  if (isObject(style.render) && style.render.type === "heatmap" && !points) {
    const palette = style.render.palette ?? DEFAULTS["heatmap.palette"];
    const colors = Array.isArray(palette)
      ? [...(palette as string[])]
      : [...(PALETTES[palette as string]?.colors ?? [])];
    if (style.render.reverse === true) colors.reverse();
    sections.push({ kind: "ramp", id: "heatmap", colors, domain: [0, 1], ends: "low_high" });
  }
  if (isObject(style.render) && style.render.type === "h3" && !points)
    sections.push(...h3Sections(style.render, ctx.zoom));
  if (!sections.length) {
    sections.push({
      kind: "entries",
      id: "base",
      entries: [{ id: "base", swatch: swatch(style, geometry, ctx.zoom) }],
    });
  }
  // H3 columns stand only while the hexagons are drawn.
  const height = density && points ? null : heightSection(style, geometry);
  if (height) sections.push(height);
  // Clusters first, then the single points (spec 7.2).
  // (Only below `cluster_until_zoom`: from it on the map draws single points alone.)
  if (
    isObject(style.render) &&
    style.render.type === "cluster" &&
    ctx.zoom <
      (typeof style.render.cluster_until_zoom === "number"
        ? style.render.cluster_until_zoom
        : (DEFAULTS["cluster.cluster_until_zoom"] as number))
  )
    sections.unshift(clusterSection(style.render, ctx.zoom));
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

/** "Clusters" with a sample (spec 7.2): the cluster symbol, at the middle of its sizes where they follow the count. */
function clusterSection(render: JsonObject, zoom: number): LegendSection {
  const symbol = isObject(render.symbol) ? render.symbol : (DEFAULT_CLUSTER_SYMBOL as unknown as JsonObject);
  const marker = isObject(symbol.marker) ? symbol.marker : {};
  const range =
    isObject(marker.size) && Array.isArray(marker.size.range) ? (marker.size.range as number[]) : null;
  const sample = swatch(
    { symbol },
    "point",
    zoom,
    range ? { marker: { size: (range[0] + range[1]) / 2 } } : undefined
  );
  return { kind: "entries", id: "cluster", entries: [{ id: "cluster", extra: "cluster", swatch: sample }] };
}

/** H3 hexagons (spec 7.2): the cell value at the resolution the zoom draws, as classes or a ramp; nothing while the
 * values are not computed. A sum or mean names its field. */
function h3Sections(render: JsonObject, zoom: number): LegendSection[] {
  const scale = h3Scale(render, h3Resolution(render, zoom));
  const value = isObject(render.value) ? render.value : {};
  const field = value.op !== "count" && typeof value.field === "string" ? { field: value.field } : {};
  if (scale.kind === "ramp")
    return [
      {
        kind: "ramp",
        id: "h3",
        ...(field.field ? { title: field.field } : {}),
        colors: scale.colors,
        domain: [scale.min, scale.max],
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
          { id: "0", extra: "h3", swatch: { geometry: "polygon" as const, fill: { color: scale.color } } },
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
        swatch: { geometry: "polygon" as const, fill: { color } },
      })),
      ...(scale.domain ? { domain: scale.domain } : {}),
    },
  ];
}

/** A layer's base look as one swatch (the layer list's icon). */
export function baseSwatch(style: JsonObject, ctx: { geometry: Geometry; zoom: number }): Swatch {
  return swatch(style, ctx.geometry, ctx.zoom);
}

const isEmpty = (value: unknown) => value === null || value === undefined || value === "";

/** The record of the first classification a feature falls in: its class, else `other`, `no_data` for no value. */
function recordOf(c: JsonObject, value: unknown): JsonObject | undefined {
  if (isEmpty(value)) return isObject(c.no_data) ? c.no_data : undefined;
  const classes = list(c.classes);
  const found =
    c.method === "categories"
      ? classes.find((k) => Array.isArray(k.values) && k.values.some((v) => String(v) === String(value)))
      : typeof value === "number"
        ? classes.find(
            (k, i) =>
              (typeof k.from !== "number" || value >= k.from) &&
              (typeof k.to !== "number" || value < k.to || i === classes.length - 1)
          )
        : undefined;
  return found ?? (isObject(c.other) ? c.other : undefined);
}

/** The swatch of the class a feature falls in (the popup header's icon): the first classification's
 * class for the feature's value, its `other` or `no_data` record, else the layer's base look. */
export function classOf(
  style: JsonObject,
  properties: Record<string, unknown> | undefined,
  ctx: { geometry: Geometry; zoom: number }
): Swatch {
  const [first] = list(style.classify);
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
 * single class the data's range, or its one value. */
export function rangeText(range: { from?: number; to?: number }, opts: RangeOptions): string {
  const n = rangeNumber(opts);
  const { from, to } = labelRange(range, opts);
  const text =
    from !== undefined && to !== undefined
      ? from === to
        ? n(from)
        : `${n(from)} ${opts.words.to} ${n(to)}`
      : to !== undefined
        ? `${opts.words.under} ${n(to)}`
        : from !== undefined
          ? `${n(from)} ${opts.words.andMore}`
          : "";
  return opts.unit ? `${text} ${opts.unit}` : text;
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
