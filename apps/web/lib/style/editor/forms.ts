// How a property's value is set (spec 4): fixed, by zoom, by attribute, a field's values as they are, or by the
// classes of a classification. The panel's value mode button reads the mode, offers the modes the property takes
// (spec 4.5, from CAPABILITIES) and switches between them.
import type { Geometry } from "@/lib/style/compile/types";
import { fromForm, valueAt } from "@/lib/style/compile/values";
import { type Path, dropKey, getIn, setIn } from "@/lib/style/editor/paths";
import { CAPABILITIES, defaultRange } from "@/lib/style/generated/capabilities";
import { PALETTES } from "@/lib/style/generated/catalog";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type JsonObject, isObject } from "@/lib/style/json";
import { scaleT, scaled } from "@/lib/style/legend";

export type Mode = "fixed" | "zoom" | "attribute" | "raw" | "classes";

/** The property a classification without `target` sets (spec 18.4). */
export const MAIN_COLOR: Record<Geometry, string> = {
  point: "marker.color",
  line: "line.color",
  polygon: "fill.color",
};

const ZOOM_MIN = 0;
const ZOOM_MAX = 24;

const list = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isObject) : []);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The property key of a path: "symbol.line.width", "classify.0.classes.2.line.width" and a stop's value
 * "symbol.line.width.zoom.1.1" are "line.width". */
export function keyOf(full: Path): string {
  const path = full.replace(/\.zoom\.\d+\.1$/, "");
  if (path.startsWith("symbol.")) return path.slice("symbol.".length);
  const record = /^classify\.\d+\.(?:classes\.\d+|other|no_data)\.(.+)$/.exec(path);
  if (record) return record[1];
  const rule = /^rules\.\d+\.(.+)$/.exec(path);
  if (rule) return rule[1];
  if (path.startsWith("render.")) return `heatmap.${path.slice("render.".length)}`;
  return path;
}

/** The keys a classification sets through `target` (a classification without one sets the geometry's main color). */
export function targetsOf(c: JsonObject, geometry?: Geometry): string[] {
  if (typeof c.target === "string") return [c.target];
  return geometry ? [MAIN_COLOR[geometry]] : Object.values(MAIN_COLOR);
}

const classRecords = (c: JsonObject): JsonObject[] =>
  [...list(c.classes), c.other, c.no_data].filter(isObject);

/** The classification that sets `key` for the whole layer: its target, else one whose class records set it. */
export function classificationFor(doc: LayerStyle, key: string, geometry?: Geometry): JsonObject | undefined {
  const classify = list(getIn(doc, "classify"));
  return (
    classify.find((c) => targetsOf(c, geometry).includes(key)) ??
    classify.find((c) => classRecords(c).some((r) => getIn(r, key) !== undefined))
  );
}

export function modeOf(doc: LayerStyle, path: Path, geometry?: Geometry): Mode {
  if (path.startsWith("symbol.") && classificationFor(doc, keyOf(path), geometry)) return "classes";
  const value = getIn(doc, path);
  if (isObject(value)) {
    if (Array.isArray(value.zoom)) return "zoom";
    if (typeof value.field === "string") return "palette" in value || "range" in value ? "attribute" : "raw";
  }
  return "fixed";
}

export function modesFor(
  key: string,
  ctx: { scoped: boolean; hasNumberField: boolean; hasColorField?: boolean }
): Mode[] {
  const cap = CAPABILITIES[key];
  if (!cap) return ["fixed"];
  const modes: Mode[] = ["fixed"];
  if (cap.zoom) modes.push("zoom");
  if (!ctx.scoped && cap.perFeature) {
    if (cap.attribute && ctx.hasNumberField) modes.push("attribute");
    // Field values as they are: a bearing for rotation, a hex text for colors.
    if (key === "marker.rotation" ? ctx.hasNumberField : cap.kind === "color" && ctx.hasColorField)
      modes.push("raw");
    modes.push("classes");
  }
  return modes;
}

/** The text fields whose value in the sample feature is a color: the fields a color can be read from as it is. */
export function colorFields(
  fields: ReadonlyArray<{ name: string; type: string }>,
  sample: Record<string, unknown> | undefined
): string[] {
  return fields
    .filter(
      (f) => f.type === "string" && typeof sample?.[f.name] === "string" && HEX.test(sample[f.name] as string)
    )
    .map((f) => f.name);
}

interface SwitchContext {
  mapZoom: number;
  sample?: Record<string, unknown>;
  field?: string;
  geometry?: Geometry;
}

/** The value of `path` as one fixed value: at the map zoom, for the sample feature, or the reference default. */
export function fixedValue(doc: LayerStyle, path: Path, ctx: SwitchContext): unknown {
  const key = keyOf(path);
  const kind = CAPABILITIES[key]?.kind ?? "choice";
  const fallback = DEFAULTS[key];
  const value = getIn(doc, path);
  if (value === undefined) return fallback;
  if (!isObject(value)) return value;
  if (Array.isArray(value.zoom)) {
    const at = valueAt(
      fromForm(value, kind, fallback, (v) => v),
      ctx.mapZoom
    );
    return typeof at === "number"
      ? round2(at)
      : typeof at === "string" || typeof at === "boolean"
        ? at
        : fallback;
  }
  if (typeof value.field !== "string") return fallback;
  const raw = ctx.sample?.[value.field];
  const n = Number(raw);
  const computed = isObject(value.computed) ? value.computed.domain : undefined;
  const domain = (Array.isArray(value.domain) ? value.domain : computed) as [number, number] | undefined;
  if (Array.isArray(value.range)) {
    const [r0, r1] = value.range as [number, number];
    return raw !== undefined && Array.isArray(domain) && Number.isFinite(n)
      ? round2(scaled(value, domain, n))
      : round2((r0 + r1) / 2);
  }
  if ("palette" in value) {
    const colors = [
      ...(Array.isArray(value.palette)
        ? (value.palette as string[])
        : (PALETTES[value.palette as string]?.colors ?? [])),
    ];
    if (value.reverse === true) colors.reverse();
    if (!colors.length) return fallback;
    const along = Array.isArray(domain) && Number.isFinite(n) ? scaleT(value, domain, n) : NaN;
    const t = Number.isFinite(along) ? along : 0.5;
    return colors[Math.round(Math.min(1, Math.max(0, t)) * (colors.length - 1))];
  }
  // A field read as the value itself holds any text: only a value the property takes becomes the fixed one.
  if (kind === "color") return typeof raw === "string" && HEX.test(raw) ? raw : fallback;
  if (kind === "number")
    return raw !== undefined && raw !== null && raw !== "" && Number.isFinite(n) ? n : fallback;
  return typeof raw === "string" && raw ? raw : fallback;
}

/** A color as the language writes it. */
const HEX = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i;

/** The document without the classifications that set `key`, and without `key` in other classifications' records. */
function leaveClasses(doc: LayerStyle, key: string, geometry?: Geometry): LayerStyle {
  const kept = list(getIn(doc, "classify"))
    .filter((c) => !targetsOf(c, geometry).includes(key))
    .map((c) => {
      let next = c;
      list(c.classes).forEach((_, i) => {
        next = dropKey(next, `classes.${i}`, key);
      });
      for (const record of ["other", "no_data"])
        if (isObject(next[record])) next = dropKey(next, record, key);
      return next;
    });
  return setIn(doc, "classify", kept.length ? kept : undefined);
}

const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/** A value by zoom that starts flat at `value`, three zooms either side of the map's (on the half zoom nearest it, the
 * steps the stop chart moves in). */
function zoomForm(key: string, value: unknown, mapZoom: number): JsonObject {
  const at = Math.round(mapZoom * 2) / 2;
  const stops = [
    [clampZoom(at - 3), value],
    [clampZoom(at + 3), value],
  ];
  return CAPABILITIES[key]?.zoom === "step" ? { zoom: stops, interpolate: "step" } : { zoom: stops };
}

/** In class scope (spec 5.5): the class's own value at `writePath` set the way `to` says, starting from what the class
 * shows (`view`, the class merged over the base), so Fixed over a base by zoom keeps the value at the map zoom. Class
 * records take fixed values and values by zoom. */
export function switchScopedMode(
  doc: LayerStyle,
  view: LayerStyle,
  path: Path,
  writePath: Path,
  to: Mode,
  ctx: SwitchContext
): LayerStyle {
  // The mode the class already has, its own or inherited, changes nothing.
  const own = getIn(doc, writePath) !== undefined;
  if (modeOf(own ? doc : view, own ? writePath : path, ctx.geometry) === to) return doc;
  const value = fixedValue(view, path, ctx);
  if (to === "fixed") return setIn(doc, writePath, value);
  if (to === "zoom") return setIn(doc, writePath, zoomForm(keyOf(path), value, ctx.mapZoom));
  return doc;
}

/** `doc` with the value at `path` set the way `to` says (spec 4.1 to 4.3); "classes" is added by the classification editor. */
export function switchMode(doc: LayerStyle, path: Path, to: Mode, ctx: SwitchContext): LayerStyle {
  const key = keyOf(path);
  let base = doc;
  let from = modeOf(doc, path, ctx.geometry);
  if (from === "classes" && to !== "classes") {
    base = leaveClasses(doc, key, ctx.geometry);
    from = modeOf(base, path, ctx.geometry);
  }
  if (from === to) return base;
  const cap = CAPABILITIES[key];
  switch (to) {
    case "fixed":
      return setIn(base, path, fixedValue(base, path, ctx));
    case "zoom":
      return setIn(base, path, zoomForm(key, fixedValue(base, path, ctx), ctx.mapZoom));
    case "attribute":
      if (!ctx.field) return base;
      return setIn(
        base,
        path,
        cap?.kind === "color"
          ? { field: ctx.field, palette: "goat:green" }
          : { field: ctx.field, range: defaultRange(key), scale: key.endsWith("opacity") ? "linear" : "sqrt" }
      );
    case "raw":
      return ctx.field ? setIn(base, path, { field: ctx.field }) : base;
    default:
      return base;
  }
}
