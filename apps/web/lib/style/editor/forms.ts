// How a property's value is set (spec 4): fixed, by zoom, by attribute, a field's values as they are, or by the
// classes of a classification. The panel's value mode button reads the mode, offers the modes the property takes
// (spec 4.5, from CAPABILITIES) and switches between them.
import { DERIVED, derivedColor, followedKey } from "@/lib/style/compile/derived";
import type { Geometry } from "@/lib/style/compile/types";
import { fromForm, valueAt } from "@/lib/style/compile/values";
import { type Path, dropKey, getIn, setIn } from "@/lib/style/editor/paths";
import { rowsOpening } from "@/lib/style/editor/sources";
import { CAPABILITIES, defaultRange } from "@/lib/style/generated/capabilities";
import { PALETTES } from "@/lib/style/generated/catalog";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type JsonObject, clone, isObject } from "@/lib/style/json";
import { scaleT, scaled } from "@/lib/style/legend";

export type Mode = "fixed" | "zoom" | "attribute" | "raw" | "classes";

/** The property a classification without `target` sets (spec 18.4). */
export const MAIN_COLOR: Record<Geometry, string> = {
  point: "marker.color",
  line: "line.color",
  polygon: "fill.color",
};

/** The part a geometry draws when the symbol leaves it out (spec 3). */
export const MAIN_PART: Readonly<Record<Geometry, string>> = {
  polygon: "fill",
  line: "line",
  point: "marker",
};

/** Whether a part is drawn: `false` is off; an absent part is off except the geometry's main part (spec 3). */
export const partOn = (value: unknown, part: string, geometry: Geometry): boolean =>
  value === false ? false : value === undefined ? MAIN_PART[geometry] === part : true;

/** A key the layer sets once (spec 6.1): one value for all features, held by the base or a single record. */
export const isPerLayer = (key: string): boolean => CAPABILITIES[key]?.perFeature === false;

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
  if (path.startsWith("render.extrude.") || path.startsWith("render.outline."))
    return `h3.${path.slice("render.".length)}`;
  // The cluster symbol is a symbol: its keys are the parts' keys.
  if (path.startsWith("render.symbol.")) return path.slice("render.symbol.".length);
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

/** A classification whose classes the server has yet to compute: it sets its target once they come. */
const pending = (c: JsonObject) => !Array.isArray(c.classes) || c.classes.length === 0;

/** A classification whose classes the server computes (a method, or categories by count): it fills their target on
 * every computation (spec 12). */
const computed = (c: JsonObject) =>
  c.method !== "manual" && !(c.method === "categories" && typeof c.count !== "number");

/** Whether a classification sets `key` by `target`: an explicit one, or the main color of one without, while its
 * records set that color or its classes are still to come (a classification without `target` may set other keys
 * only, spec 5.5). */
export function targets(c: JsonObject, key: string, geometry?: Geometry): boolean {
  if (typeof c.target === "string") return c.target === key;
  return targetsOf(c, geometry).includes(key) && (pending(c) || computed(c) || setsIn(c, key));
}

const setsIn = (c: JsonObject, key: string) => classRecords(c).some((r) => getIn(r, key) !== undefined);

/** The classification that sets `key` for the whole layer: the last one that targets it (a later one wins, spec 5.7),
 * else the last one whose records set it. A class of a later classification that sets the key draws over the targeting
 * one only for its own features (class scope shows it there). A key set once for the layer (spec 6.1) is never set by
 * classes. */
export function classificationFor(doc: LayerStyle, key: string, geometry?: Geometry): JsonObject | undefined {
  if (CAPABILITIES[key]?.perFeature === false) return undefined;
  const classify = list(getIn(doc, "classify"));
  const last = (test: (c: JsonObject) => boolean) => classify.filter(test).at(-1);
  return last((c) => targets(c, key, geometry)) ?? last((c) => setsIn(c, key));
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

/** The modes a property offers. `zoom: false` leaves By zoom out: the value has nothing stops could start from
 * (offersZoom). On a layer with heights (`extruded`, drawsHeights) the fill opacity is one for the whole layer: fixed
 * or by zoom. */
export function modesFor(
  key: string,
  ctx: {
    scoped: boolean;
    hasNumberField: boolean;
    hasColorField?: boolean;
    zoom?: boolean;
    extruded?: boolean;
  }
): Mode[] {
  const cap = CAPABILITIES[key];
  if (!cap) return ["fixed"];
  const modes: Mode[] = ["fixed"];
  if (cap.zoom && ctx.zoom !== false) modes.push("zoom");
  if (!ctx.scoped && cap.perFeature && !(ctx.extruded && key === FILL_OPACITY)) {
    if (cap.attribute && ctx.hasNumberField) modes.push("attribute");
    // Field values as they are: a bearing for rotation, a hex text for colors.
    if (
      key === "marker.rotation" || key.startsWith("extrude.")
        ? ctx.hasNumberField
        : cap.kind === "color" && ctx.hasColorField
    )
      modes.push("raw");
    modes.push("classes");
  }
  return modes;
}

const FILL_OPACITY = "fill.opacity";

/** Whether the layer draws heights as goatlib's checks read it: any record (the symbol, a class, `other`, `no_data`, a
 * rule) has an `extrude` part. Heights draw with one fill opacity for the whole layer. */
export function drawsHeights(doc: LayerStyle): boolean {
  const records = [
    getIn(doc, "symbol"),
    ...list(getIn(doc, "classify")).flatMap(classRecords),
    ...list(getIn(doc, "rules")),
  ];
  return records.some((record) => isObject(record) && isObject(record.extrude));
}

/** Whether a value differs by feature: it reads a field, or zoom stops hold one that does. */
function perFeature(value: unknown): boolean {
  if (isObject(value) && Array.isArray(value.zoom))
    return value.zoom.some((stop) => Array.isArray(stop) && stop.length === 2 && perFeature(stop[1]));
  return isObject(value) && "field" in value;
}

/** `doc` with one fill opacity for the whole layer while it draws heights: a fill opacity by feature or by classes
 * becomes the fixed value it shows, and classes and rules keep no fill opacity of their own. Every edit that switches
 * heights on goes through it. */
export function oneFillOpacity(doc: LayerStyle, ctx: SwitchContext): LayerStyle {
  if (!drawsHeights(doc)) return doc;
  const path = `symbol.${FILL_OPACITY}`;
  let next =
    modeOf(doc, path, ctx.geometry) === "classes" || perFeature(getIn(doc, path))
      ? switchMode(doc, path, "fixed", ctx)
      : doc;
  list(getIn(next, "rules")).forEach((_, i) => {
    next = dropKey(next, `rules.${i}`, FILL_OPACITY);
  });
  return next;
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
    if (typeof at === "number") return round2(at);
    if (typeof at === "string" || typeof at === "boolean") return at;
    // Stops by attribute (spec 4.4): the value of the stop nearest the map zoom, for the sample feature.
    const stops = value.zoom as Array<[number, unknown]>;
    const near = stops.reduce((best, stop) =>
      Math.abs(stop[0] - ctx.mapZoom) < Math.abs(best[0] - ctx.mapZoom) ? stop : best
    );
    return isObject(near?.[1]) ? fixedValue(setIn(doc, path, near[1]), path, ctx) : fallback;
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

/** The document without `key` in any classification's records, and without the classifications that set it by
 * `target`. One without `target` stays, with classes the server no longer colors, while a row of the panel still opens
 * it (`rowsOpening`): everything its classes hold (names, the eye, zooms) stays reachable in its editor. Otherwise it
 * goes, and Undo brings it back. */
function leaveClasses(doc: LayerStyle, key: string, geometry?: Geometry): LayerStyle {
  const frozen = new Set<JsonObject>();
  const kept = list(getIn(doc, "classify")).flatMap((c) => {
    let next = c;
    list(c.classes).forEach((_, i) => {
      next = dropKey(next, `classes.${i}`, key);
    });
    for (const record of ["other", "no_data"]) if (isObject(next[record])) next = dropKey(next, record, key);
    if (!targets(c, key, geometry)) return [next];
    if (typeof c.target === "string" || !geometry) return [];
    // The classes become the author's, so a recompute does not color them again (spec 12): no palette or count, a
    // numeric method manual, nothing the server wrote for the color.
    const { palette: _palette, reverse: _reverse, count: _count, ...rest } = next;
    if (rest.method !== "categories") rest.method = "manual";
    if (isObject(rest.computed) && "generated" in rest.computed) {
      const { generated: _generated, ...computed } = rest.computed;
      rest.computed = computed;
    }
    frozen.add(rest);
    return [rest];
  });
  const next = setIn(doc, "classify", kept.length ? kept : undefined);
  if (!frozen.size || !geometry) return next;
  // A row of another key than the one left; a classification without classes (still to come) would claim the color
  // again.
  const reachable = kept.filter(
    (c) =>
      !frozen.has(c) ||
      (list(c.classes).length > 0 && rowsOpening(next, c, geometry).some((row) => row !== key))
  );
  return setIn(doc, "classify", reachable.length ? reachable : undefined);
}

const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/** The value stops by zoom start from: the value at `path` as one fixed value, or, while it is not set, the color the
 * resolver draws in its place (the arrows in the line's hue, "Same as line"; a pattern in the fill's); undefined where
 * neither gives one (a marker without an icon). */
function zoomStartOf(doc: LayerStyle, path: Path, ctx: SwitchContext): unknown {
  const value = fixedValue(doc, path, ctx);
  if (value !== undefined && value !== null) return value;
  const key = keyOf(path);
  const derivation = DERIVED[key];
  const follows = derivation?.absent && derivation.absent.only === undefined ? derivation.follows : undefined;
  const other = follows && (followedKey(key, ctx.geometry ?? "polygon") ?? Object.values(follows)[0]);
  if (!other || !path.endsWith(key)) return undefined;
  const shown = fixedValue(doc, `${path.slice(0, path.length - key.length)}${other}`, ctx);
  return shown === null || shown === undefined ? undefined : derivedColor(key, undefined, shown);
}

/** Whether By zoom has a value to start from (the row's value at `path` in `doc`, the view a class or rule shows in
 * scope): false while the value is not set and nothing is drawn in its place. */
export function offersZoom(doc: LayerStyle, path: Path, ctx: SwitchContext): boolean {
  const mode = modeOf(doc, path, ctx.geometry);
  if (mode === "zoom" || mode === "attribute") return true;
  const base = mode === "classes" ? leaveClasses(doc, keyOf(path), ctx.geometry) : doc;
  return zoomStartOf(base, path, ctx) !== undefined;
}

/** A value by zoom that starts flat at `value`, three zooms either side of the map's (on the half zoom nearest it, the
 * steps the stop chart moves in). */
function zoomForm(key: string, value: unknown, mapZoom: number): JsonObject {
  const at = Math.round(mapZoom * 2) / 2;
  const stops = [
    [clampZoom(at - 3), value],
    [clampZoom(at + 3), isObject(value) ? clone(value) : value],
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
  if (to === "fixed") return setIn(doc, writePath, fixedValue(view, path, ctx));
  if (to === "zoom") {
    const start = zoomStartOf(view, path, ctx);
    return start === undefined ? doc : setIn(doc, writePath, zoomForm(keyOf(path), start, ctx.mapZoom));
  }
  return doc;
}

/** A choice over several keys of a part, edited as one value: the label's Font, a weight upright or italic, over
 * `font.weight` and `font.style`. Its first key names it (a row's key, a classification's target); by zoom, every key
 * has the same stops, as steps. */
export interface CompoundChoice {
  /** The part the keys are in. */
  part: string;
  /** The keys it sets, relative to the part; the first names the choice. */
  keys: readonly string[];
  /** The object holding the keys, relative to the part: the issues about it show under the row. */
  at: string;
  /** The choices, in menu order. */
  values: readonly string[];
  /** The choice the part's fixed values make. */
  read(part: JsonObject): string;
  /** Each key's value for a choice. Scoped, every key is written, so a class, a rule or a template line draws the
   * choice whatever the label's values; for the layer, a default is left out. */
  write(choice: string, scoped: boolean): Record<string, unknown>;
  /** The key whose value labels a choice (`style_editor.value_<part>_<key>_<choice>`). */
  labelKey(choice: string): string;
  /** The menu's groups: the key and value whose label heads a choice's group, the key and value that name the choice
   * within it, and, where its full label does not hold that name, the key and value it is spoken as. Without, the
   * menu is one list of the choices' labels. */
  group?(choice: string): { heading: [string, string]; name: [string, string]; spoken?: [string, string] };
}

/** The label's font weights, lightest last after the two the basemaps' glyph servers have (menu order). */
const FONT_WEIGHTS = ["regular", "bold", "medium", "light"] as const;

/** A Font choice as its weight and style: "medium_italic" is Medium, italic; "italic" is Regular, italic. */
export function fontOfChoice(choice: string): { weight: string; style: "normal" | "italic" } {
  if (choice === "italic") return { weight: "regular", style: "italic" };
  const italic = choice.endsWith("_italic");
  return {
    weight: italic ? choice.slice(0, -"_italic".length) : choice,
    style: italic ? "italic" : "normal",
  };
}

/** A label's Font: Light, Regular, Medium or Bold, each upright or italic (spec 3.4). The menu groups them as Upright
 * and Italic; an italic font is named in full ("Bold italic"), Regular italic as "Italic". */
export const LABEL_FONT_CHOICE: CompoundChoice = {
  part: "label",
  keys: ["font.weight", "font.style"],
  at: "font",
  values: [...FONT_WEIGHTS, "italic", ...FONT_WEIGHTS.slice(1).map((weight) => `${weight}_italic`)],
  read: (part) => {
    const font = isObject(part.font) ? part.font : {};
    const weight = (FONT_WEIGHTS as readonly unknown[]).includes(font.weight)
      ? String(font.weight)
      : "regular";
    if (font.style !== "italic") return weight;
    return weight === "regular" ? "italic" : `${weight}_italic`;
  },
  write: (choice, scoped) => {
    const pick = (value: string, fallback: string) => (scoped || value !== fallback ? value : undefined);
    const { weight, style } = fontOfChoice(choice);
    return { "font.weight": pick(weight, "regular"), "font.style": pick(style, "normal") };
  },
  labelKey: (choice) => (fontOfChoice(choice).style === "italic" ? "font.style" : "font.weight"),
  group: (choice) => {
    const { weight, style } = fontOfChoice(choice);
    // "Italic" holds no "Regular": the row under Italic is spoken as "Regular italic".
    const spoken: [string, string] | undefined =
      choice === "italic" ? ["font.style", "regular_italic"] : undefined;
    return { heading: ["font.style", style], name: ["font.weight", weight], spoken };
  },
};

/** The choice a part's keys make while each is fixed; undefined while one of them is by zoom. */
export function fixedChoice(compound: CompoundChoice, part: unknown): string | undefined {
  const values = isObject(part) ? part : {};
  if (compound.keys.some((key) => isObject(getIn(values, key)))) return undefined;
  return compound.read(values);
}

/** The compound named by the property `key` ("label.font.weight" is the label's Font). */
export const compoundOf = (key: string): CompoundChoice | undefined =>
  [LABEL_FONT_CHOICE].find((c) => `${c.part}.${c.keys[0]}` === key);

/** A compound's keys as property keys ("label.font.weight", "label.font.style"). */
export const compoundKeys = (c: CompoundChoice): string[] => c.keys.map((key) => `${c.part}.${key}`);

/** The stops of a value by zoom, in zoom order; none for a fixed value. */
function stopsOf(value: unknown): Array<[number, unknown]> {
  if (!isObject(value) || !Array.isArray(value.zoom)) return [];
  return (value.zoom as unknown[])
    .filter((stop): stop is [number, unknown] => Array.isArray(stop) && typeof stop[0] === "number")
    .sort((a, b) => a[0] - b[0]);
}

/** A choice at `zoom`: fixed, or its last stop at or below `zoom` (below the first stop, the first stop's value). */
function stepAt(value: unknown, zoom: number): unknown {
  const stops = stopsOf(value);
  return stops.length ? stops.reduce((at, [z, v]) => (z <= zoom ? v : at), stops[0][1]) : value;
}

/** The choice the compound in the part at `record` makes at `zoom`. */
export function compoundAt(doc: LayerStyle, record: Path, compound: CompoundChoice, zoom: number): string {
  const part = compound.keys.reduce<JsonObject>((out, key) => {
    const value = stepAt(getIn(doc, `${record}.${key}`), zoom);
    return value === undefined ? out : setIn(out, key, value);
  }, {});
  return compound.read(part);
}

/** The compound in the part at `record` as stops of choices, at each zoom where one of its keys has a stop; none while
 * no key is by zoom. */
export function compoundStops(
  doc: LayerStyle,
  record: Path,
  compound: CompoundChoice
): Array<[number, string]> {
  const zooms = new Set(
    compound.keys.flatMap((key) => stopsOf(getIn(doc, `${record}.${key}`)).map(([z]) => z))
  );
  return [...zooms].sort((a, b) => a - b).map((z) => [z, compoundAt(doc, record, compound, z)]);
}

/** `doc` with the compound in the part at `record` (`doc` itself for "") set to one `choice`. */
export function writeCompound<T>(
  doc: T,
  compound: CompoundChoice,
  record: Path,
  choice: string,
  scoped: boolean
): T {
  let next = doc;
  for (const [key, value] of Object.entries(compound.write(choice, scoped)))
    next = setIn(next, record ? `${record}.${key}` : key, value);
  return next;
}

/** `doc` with the compound in the part at `record` by zoom: every key on the same stops, as steps. */
export function writeCompoundStops<T>(
  doc: T,
  compound: CompoundChoice,
  record: Path,
  stops: ReadonlyArray<readonly [number, string]>
): T {
  const values = stops.map(([, choice]) => compound.write(choice, true));
  let next = doc;
  for (const key of compound.keys)
    next = setIn(next, `${record}.${key}`, {
      zoom: stops.map(([z], i) => [z, values[i][key]]),
      interpolate: "step",
    });
  return next;
}

/** A compound's mode from its keys' paths: by classes when a classification sets one of them, by zoom when one is by
 * zoom, else fixed. */
export function compoundModeOf(doc: LayerStyle, paths: readonly Path[], geometry?: Geometry): Mode {
  const modes = paths.map((path) => modeOf(doc, path, geometry));
  return modes.includes("classes") ? "classes" : modes.includes("zoom") ? "zoom" : "fixed";
}

/** `doc` with the compound in the part at `record` set the way `to` says, keeping the choice the row shows: `view`
 * holds the part at `base` as drawn (in class or rule scope the record merged over the layer). Fixed takes the choice
 * at the map zoom; By zoom keeps the stops there are, or starts flat at that choice. Out of scope a key set by
 * classes leaves them first. */
export function switchCompound(
  doc: LayerStyle,
  view: LayerStyle,
  base: Path,
  record: Path,
  compound: CompoundChoice,
  to: Mode,
  ctx: SwitchContext & { scoped: boolean }
): LayerStyle {
  // The mode the row already shows, the record's own or the layer's, changes nothing.
  const shown = compound.keys.map((key) => `${base}.${key}`);
  if (compoundModeOf(view, shown, ctx.geometry) === to) return doc;
  let next = doc;
  if (!ctx.scoped)
    compound.keys.forEach((key, i) => {
      if (modeOf(next, `${base}.${key}`, ctx.geometry) === "classes")
        next = leaveClasses(next, compoundKeys(compound)[i], ctx.geometry);
    });
  const choice = compoundAt(view, base, compound, ctx.mapZoom);
  if (to === "fixed") return writeCompound(next, compound, record, choice, ctx.scoped);
  if (to !== "zoom") return next;
  const stops = compoundStops(view, base, compound);
  const flat = zoomForm(compoundKeys(compound)[0], choice, ctx.mapZoom).zoom as Array<[number, string]>;
  return writeCompoundStops(next, compound, record, stops.length > 1 ? stops : flat);
}

/** Values a new mapping by attribute grows in proportion to the field (a linear scale): opacities and heights. Sizes
 * start on a square root, so a symbol's area grows with the field. */
const proportional = (key: string) => key.endsWith("opacity") || key.startsWith("extrude.");

/** `doc` with the value at `path` set the way `to` says (spec 4.1 to 4.4); "classes" is added by the classification editor. */
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
    case "zoom": {
      // A value by attribute keeps its field at every stop (spec 4.4): the stops then change its range or palette.
      const value = getIn(base, path);
      const start = from === "attribute" && isObject(value) ? value : zoomStartOf(base, path, ctx);
      // Stops of nothing are refused: a value that is not set and drawn as nothing stays as it is.
      return start === undefined ? doc : setIn(base, path, zoomForm(key, start, ctx.mapZoom));
    }
    case "attribute":
      if (!ctx.field) return base;
      return setIn(
        base,
        path,
        cap?.kind === "color"
          ? { field: ctx.field, palette: "goat:green" }
          : { field: ctx.field, range: defaultRange(key), scale: proportional(key) ? "linear" : "sqrt" }
      );
    case "raw":
      return ctx.field ? setIn(base, path, { field: ctx.field }) : base;
    default:
      return base;
  }
}
