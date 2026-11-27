// Classifications in the panel. A change of what the server computes from (a classification's field, method, count,
// palette or range; a value form's field or scale) is an intent edit: it is saved at once, and the classes or the
// domain stay pending until the reply brings them (spec 12, 13.1).
import type { Geometry } from "@/lib/style/compile/types";
import { categoryText, numberText } from "@/lib/style/editor/categoryText";
import {
  MAIN_COLOR,
  compoundKeys,
  compoundOf,
  isPerLayer,
  partOn,
  targetsOf,
} from "@/lib/style/editor/forms";
import { type Path, dropKey, getIn, setIn } from "@/lib/style/editor/paths";
import type { EditorStore, Scope } from "@/lib/style/editor/store";
import { CAPABILITIES } from "@/lib/style/generated/capabilities";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type JsonObject, deepEqual, isObject } from "@/lib/style/json";
import { paletteColors, paletteSteps } from "@/lib/style/palettes";

export const INTENT_KEYS = [
  "field",
  "method",
  "count",
  "palette",
  "reverse",
  "range",
  "scale",
  "target",
] as const;

const list = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isObject) : []);
// A save answered without a document (a failed or stubbed reply) leaves no stored document: read it as no classes.
const classifyOf = (doc: LayerStyle | undefined): JsonObject[] =>
  list((doc as unknown as JsonObject | undefined)?.classify);

/** How many classifications the style has; for a raster, how many classes its colors have: the categories
 * (`render.classes`) or the classes of a palette (`render.classify`, spec 9.3, 9.4), hidden ones too, and the
 * classification's `count` while no classes are written yet. */
export function classifyCount(doc: LayerStyle): number {
  const root = doc as unknown as JsonObject | undefined;
  if (root?.kind !== "raster") return classifyOf(doc).length;
  const render = isObject(root.render) ? root.render : {};
  if (render.type === "categorical") return list(render.classes).length;
  if (render.type !== "continuous" && render.type !== "hillshade") return 0;
  // Own stops color a range without classes; shading without a palette has no colors.
  if (render.type === "continuous" && Array.isArray(render.stops)) return 0;
  if (render.type === "hillshade" && render.palette == null) return 0;
  const classify = isObject(render.classify) ? render.classify : {};
  return list(classify.classes).length || (typeof classify.count === "number" ? classify.count : 0);
}

/** What the server computes a classification from. */
const intentOf = (c: JsonObject | undefined) =>
  c ? Object.fromEntries(INTENT_KEYS.map((key) => [key, c[key]])) : null;

/** What the server computes a value form's domain from: its field and scale (spec 12), by path. */
function formIntents(doc: LayerStyle): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (node: unknown, path: string) => {
    // Stops by zoom may hold value forms (spec 4.4).
    if (Array.isArray(node)) node.forEach((item, i) => walk(item, `${path}.${i}`));
    if (!isObject(node)) return;
    if (typeof node.field === "string") {
      out[path] = [node.field, node.scale];
      return;
    }
    for (const [key, value] of Object.entries(node)) if (key !== "computed") walk(value, `${path}.${key}`);
  };
  const root = doc as unknown as JsonObject;
  walk(root.symbol, "symbol");
  walk(root.render, "render");
  return out;
}

export function isIntentEdit(before: LayerStyle, after: LayerStyle): boolean {
  const a = classifyOf(before);
  const b = classifyOf(after);
  if (a.length !== b.length || a.some((c, i) => !deepEqual(intentOf(c), intentOf(b[i])))) return true;
  return !deepEqual(formIntents(before), formIntents(after));
}

/** Whether `classify[ci]` waits for the server: its intent differs from the last stored document's. */
export function classesPending(store: EditorStore, ci: number): boolean {
  const current = classifyOf(store.document)[ci];
  if (!current) return false;
  const stored = classifyOf(store.saver.stored);
  const match = typeof current.id === "string" ? stored.find((c) => c.id === current.id) : stored[ci];
  return !deepEqual(intentOf(current), intentOf(match));
}

/** Whether the value form at `path` waits for its computed domain: it has no domain of its own, and no computed one
 * yet or one from another field or scale than the last stored document's. */
export function domainPending(store: EditorStore, path: Path): boolean {
  const form = getIn(store.document, path);
  if (!isObject(form) || typeof form.field !== "string" || Array.isArray(form.domain)) return false;
  if (!isObject(form.computed) || !Array.isArray(form.computed.domain)) return true;
  const stored = getIn(store.saver.stored, path);
  return !isObject(stored) || stored.field !== form.field || stored.scale !== form.scale;
}

const NUMBER_FIELDS = new Set(["number", "integer"]);
/** How many classes a new classification asks the server for: the most frequent values, or numeric classes. */
export const CATEGORY_COUNT = 8;
/** The most classes a classification may ask for (goatlib `MAX_COUNT`, the schema's `count` maximum): "All values" of
 * a categories classification asks for that many, so every value of a field with up to this many gets its class. */
export const MAX_CLASS_COUNT = 256;
export const CLASS_COUNT = 5;
/** The class counts the panel's menus offer (up to 13, as the raster service computes breaks for); a stored count
 * outside them (spec: 1 to 256) is added (`withStored`). */
export const CLASS_COUNTS: readonly number[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

const isMain = (key: string, geometry?: Geometry) =>
  geometry ? MAIN_COLOR[geometry] === key : Object.values(MAIN_COLOR).includes(key);

/** A free classification id: the field name, else `k1`, `k2` (goatlib's assign_ids). */
export function freshId(doc: LayerStyle, field: string): string {
  const taken = new Set<string>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (isObject(node)) {
      if (typeof node.id === "string") taken.add(node.id);
      Object.values(node).forEach(walk);
    }
  };
  walk(doc);
  if (!taken.has(field)) return field;
  for (let n = 1; ; n += 1) if (!taken.has(`k${n}`)) return `k${n}`;
}

/** The light grey a new color classification draws features without a value in: without it they take the layer's
 * color (spec: an absent No data value is the base value), which reads like a class of the data. */
export const NO_DATA_COLOR = "#cccccc";

/** A classification of `field` that sets `key`, computed by the server: the most frequent values of a text or yes/no
 * field, quantiles of a number field. Palette, range and title stay out: the spec's defaults apply (18.4). A color
 * classification draws No data in light grey. */
export function addClassification(
  doc: LayerStyle,
  key: string,
  field: { name: string; type: string },
  geometry?: Geometry
): LayerStyle {
  const numeric = NUMBER_FIELDS.has(field.type);
  const c: JsonObject = {
    id: freshId(doc, field.name),
    field: field.name,
    method: numeric ? "quantile" : "categories",
    count: numeric ? CLASS_COUNT : CATEGORY_COUNT,
    ...(isMain(key, geometry) ? {} : { target: key }),
    ...(CAPABILITIES[key]?.kind === "color" ? { no_data: recordWith(key, NO_DATA_COLOR) } : {}),
  };
  return setIn(doc, "classify", [...classifyOf(doc), c]);
}

/** A record holding `value` at the dotted `key` ("fill.color" is `{ fill: { color } }`). */
const recordWith = (key: string, value: unknown): JsonObject =>
  key.split(".").reduceRight<unknown>((inner, part) => ({ [part]: inner }), value) as JsonObject;

export const recordPaths = (c: JsonObject): string[] => [
  ...list(c.classes).map((_, i) => `classes.${i}`),
  ...["other", "no_data"].filter((r) => isObject(c[r])),
];

/** `classify[ci]` setting `key` instead: the old key leaves its class records (a Font's weight with its style); a
 * palette stays only on a color, a range only on a number. */
export function retarget(doc: LayerStyle, ci: number, key: string, geometry?: Geometry): LayerStyle {
  const c = classifyOf(doc)[ci];
  if (!c) return doc;
  const old = targetsOf(c, geometry)[0];
  let next: JsonObject = { ...c };
  if (isMain(key, geometry)) delete next.target;
  else next.target = key;
  const kind = CAPABILITIES[key]?.kind;
  if (kind !== "color") {
    delete next.palette;
    delete next.reverse;
  }
  if (kind !== "number") delete next.range;
  const compound = compoundOf(old);
  if (old !== key)
    for (const record of recordPaths(next))
      for (const dropped of compound ? compoundKeys(compound) : [old]) next = dropKey(next, record, dropped);
  return setIn(doc, `classify.${ci}`, next);
}

export function removeClassification(doc: LayerStyle, ci: number): LayerStyle {
  const kept = classifyOf(doc).filter((_, i) => i !== ci);
  return setIn(doc, "classify", kept.length ? kept : undefined);
}

/** Classifications apply in order; a later one wins where two set the same key (spec 5.7). */
export function moveClassification(doc: LayerStyle, ci: number, to: number): LayerStyle {
  const items = [...classifyOf(doc)];
  const [moved] = items.splice(ci, 1);
  if (!moved) return doc;
  items.splice(Math.max(0, Math.min(to, items.length)), 0, moved);
  return setIn(doc, "classify", items);
}

/** What stays computed of a classification that turns manual: the field's minimum and maximum its open classes read
 * (the server computes them for manual classes too), not the values it wrote into the classes. */
function manualComputed(computed: unknown): JsonObject | undefined {
  if (!isObject(computed) || !Array.isArray(computed.domain)) return undefined;
  const { generated: _generated, ...rest } = computed;
  return rest;
}

/** A break typed by hand: class `k` starts at `value` and class `k - 1` ends there; the method becomes manual, whose
 * classes the server never recomputes (spec 5.2). */
export function setManualBound(doc: LayerStyle, ci: number, k: number, value: number): LayerStyle {
  const base = `classify.${ci}`;
  let next = setIn(doc, `${base}.classes.${k}.from`, value);
  if (k > 0) next = setIn(next, `${base}.classes.${k - 1}.to`, value);
  next = setIn(next, `${base}.method`, "manual");
  next = setIn(next, `${base}.count`, undefined);
  return setIn(next, `${base}.computed`, manualComputed(classifyOf(doc)[ci]?.computed));
}

/** A class record's own content: everything but its id and bounds, and but the value at the server's `target` while it
 * is still the one the server wrote (`written`), which a palette or range picked clears. */
function ownContent(k: JsonObject, target: unknown, written: JsonObject): JsonObject {
  const { id, from: _from, to: _to, ...rest } = k;
  const wrote = typeof id === "string" && id in written ? written[id] : undefined;
  if (typeof target !== "string" || wrote === undefined || !deepEqual(getIn(rest, target), wrote))
    return rest;
  return dropKey(rest as unknown as LayerStyle, "", target) as unknown as JsonObject;
}

/** Whether `after` holds a key `before` lacks, or a value other than its. */
function gains(before: unknown, after: unknown): boolean {
  if (isObject(after) && isObject(before))
    return Object.entries(after).some(([key, value]) => !(key in before) || gains(before[key], value));
  return !deepEqual(before, after);
}

/** Whether a class in both `before` and `after` (by id) gained a key or changed a key's value in its own content
 * (`ownContent`). A key removed (a palette or range picked clears the values at the target) is no class edit. A new
 * `target` moves each class's value from the old one (as the retarget fix does) before the two are compared, so values
 * it moved are no class edit. */
function classEdited(before: JsonObject, after: JsonObject): boolean {
  const generated =
    isObject(before.computed) && isObject(before.computed.generated) ? before.computed.generated : {};
  const written = isObject(generated.values) ? generated.values : {};
  const old = typeof before.target === "string" ? before.target : generated.target;
  const moved = typeof old === "string" && typeof after.target === "string" && old !== after.target;
  const at = moved ? after.target : generated.target;
  const relocated = (k: JsonObject): JsonObject => {
    const value = moved ? getIn(k, old as string) : undefined;
    if (value === undefined || value === null) return k;
    const without = dropKey(k as unknown as LayerStyle, "", old as string) as unknown as JsonObject;
    return setIn(without as unknown as LayerStyle, after.target as string, value) as unknown as JsonObject;
  };
  const earlier = new Map(
    list(before.classes)
      .filter((k) => typeof k.id === "string")
      .map((k) => [k.id, k])
  );
  return list(after.classes).some((k) => {
    const prior = earlier.get(k.id);
    return (
      prior !== undefined && gains(ownContent(relocated(prior), at, written), ownContent(k, at, written))
    );
  });
}

/** `c` with its classes as they are, manual: without `count` and the values the server wrote (`manualComputed`). */
function asManual(c: JsonObject): JsonObject {
  const { count: _count, computed, ...rest } = c;
  const kept = manualComputed(computed);
  return { ...rest, method: "manual", ...(kept ? { computed: kept } : {}) };
}

/** One classification with `fit` as the edit from `before` leaves it (goatlib's `settle_fit`). */
/** `after` without `fit`. The decimals the server recorded with the fitted classes (`computed.decimals`) become the
 * format's where the format states none, beside its other keys: the next compute records none (goatlib's
 * `_without_fit`). */
function withoutFit(before: JsonObject, after: JsonObject): JsonObject {
  const { fit: _fit, ...rest } = after;
  const decimals = isObject(before.computed) ? before.computed.decimals : undefined;
  const format = after.format;
  if (typeof decimals !== "number" || !Number.isInteger(decimals)) return rest;
  if (format !== undefined && !isObject(format)) return rest;
  if (isObject(format) && "decimals" in format) return rest;
  return { ...rest, format: { ...(format ?? {}), decimals } };
}

function settledFit(before: JsonObject, after: JsonObject): JsonObject {
  if (after.method === "manual") return before.method === "manual" ? after : asManual(after);
  if ((["field", "method", "count"] as const).some((key) => !deepEqual(before[key], after[key])))
    return withoutFit(before, after);
  if (after.method !== "quantile" || !classEdited(before, after)) return after;
  return asManual(after);
}

/** `after` with each classification fitted to the data (`fit`, set by tools) settled as the edit from `before` leaves
 * it (spec 5.2), as goatlib's `settle_fit` settles the assistant's edits: a new field, count or method other than manual
 * ends `fit`, and the classes compute as asked; a class that gains a key or changes a value of its own content
 * (`classEdited`) keeps the classes as they are, manual (as a moved break does); anything else keeps `fit`. A classification is matched by its id, else by
 * its place. `after` itself where nothing settles. */
export function settleFit(before: LayerStyle, after: LayerStyle): LayerStyle {
  const old = classifyOf(before);
  const now = classifyOf(after);
  let changed = false;
  const settled = now.map((c, ci) => {
    if (c.fit !== true) return c;
    const match = typeof c.id === "string" ? old.find((o) => o.id === c.id) : old[ci];
    if (!match) return c;
    const next = settledFit(match, c);
    changed ||= next !== c;
    return next;
  });
  return changed ? setIn(after, "classify", settled) : after;
}

/** `classify[ci]` as its classes are now, no longer the most frequent values the server computes: categories without
 * `count` keep the classes as written (spec 12). */
function handPicked(doc: LayerStyle, ci: number, classes: JsonObject[]): LayerStyle {
  const c = classifyOf(doc)[ci];
  if (!c) return doc;
  const { count: _count, computed: _computed, ...rest } = c;
  return setIn(doc, `classify.${ci}`, { ...rest, classes });
}

/** A value of the field as the unique values list it (as text), as goatlib writes it into category classes: a whole
 * number or yes/no in the field's type, a number field's value as text in goatlib's spelling ("2.5" for "2.50"). */
export function categoryValue(text: string, type?: string): string | number | boolean {
  if (type === "boolean") return text === "true" ? true : text === "false" ? false : text;
  if (type === "number") return numberText(text);
  if (type === "integer") {
    const n = Number(text);
    return text.trim() !== "" && Number.isFinite(n) ? n : text;
  }
  return text;
}

/** `value` in class `to` of `classify[ci]`, out of the class that had it; `to` null leaves it in no class. A value is in
 * one class at most; values compare as text, as goatlib compares them, a number field's (`type` "number") in goatlib's
 * spelling ("2.50" is "2.5"). */
export function moveCategoryValue(
  doc: LayerStyle,
  ci: number,
  value: string | number | boolean,
  to: number | null,
  type?: string
): LayerStyle {
  const c = classifyOf(doc)[ci];
  if (!c) return doc;
  const key = categoryText(value, type);
  const classes = list(c.classes).map((k, i) => {
    const values = (Array.isArray(k.values) ? k.values : []).filter((v) => categoryText(v, type) !== key);
    return { ...k, values: i === to ? [...values, value] : values };
  });
  return handPicked(doc, ci, classes);
}

/** A new class at the end of `classify[ci]`, without values yet; `record` holds its value for the target. */
export function addCategoryClass(doc: LayerStyle, ci: number, record: JsonObject = {}): LayerStyle {
  const c = classifyOf(doc)[ci];
  if (!c) return doc;
  const classes = list(c.classes);
  const ids = new Set(classes.map((k) => k.id));
  let n = classes.length + 1;
  while (ids.has(`c${n}`)) n += 1;
  return handPicked(doc, ci, [...classes, { id: `c${n}`, values: [], ...record }]);
}

/** `classify[ci]` with class `from` moved to place `to` (the legend lists the classes in their order); the classes are
 * picked by hand from then on, so the server keeps the order. */
export function moveClass(doc: LayerStyle, ci: number, from: number, to: number): LayerStyle {
  const c = classifyOf(doc)[ci];
  if (!c) return doc;
  const classes = list(c.classes);
  const [moved] = classes.splice(from, 1);
  if (!moved) return doc;
  classes.splice(to, 0, moved);
  return handPicked(doc, ci, classes);
}

/** `classify[ci]` without class `k`: its values fall to Other. */
export function removeClass(doc: LayerStyle, ci: number, k: number): LayerStyle {
  const c = classifyOf(doc)[ci];
  if (!c) return doc;
  return handPicked(
    doc,
    ci,
    list(c.classes).filter((_, i) => i !== k)
  );
}

/** The classes of `classify[ci]` colored with `colors` in order, from the start again past the last: a new palette
 * on classes the server no longer computes. */
export function recolorClasses(doc: LayerStyle, ci: number, target: string, colors: string[]): LayerStyle {
  const c = classifyOf(doc)[ci];
  if (!c || !colors.length) return doc;
  const classes = list(c.classes).map((k, i) =>
    setIn(k as unknown as LayerStyle, target, colors[i % colors.length])
  );
  return setIn(doc, `classify.${ci}.classes`, classes);
}

/** Whether the server fills the classes with the palette's or the range's values: not manual classes, nor categories
 * picked by hand, whose values the panel writes. */
export const serverFillsClasses = (c: JsonObject): boolean =>
  c.method !== "manual" && !(c.method === "categories" && typeof c.count !== "number");

/** The colors `n` classes of `c` take from `palette`, as goatlib's `sample_colors` colors the classes the server
 * computes: spread over the whole palette, turned round when `c.reverse`; a list of colors on categories repeats in
 * order, as a qualitative palette does. */
export function classPaletteColors(c: JsonObject, palette: string | string[], n: number): string[] {
  return paletteSteps(palette, n, {
    reverse: c.reverse === true,
    kind: c.method === "categories" && Array.isArray(palette) ? "qualitative" : undefined,
  });
}

/** `classify[ci]` with the palette `palette`, turned round when `reversed`. The server colors the classes it fills
 * again, also a color picked by hand; the panel colors manual classes and categories picked by hand itself, with the
 * colors the server gives computed classes of the same count. */
export function pickClassPalette(
  doc: LayerStyle,
  ci: number,
  target: string,
  palette: string | string[],
  reversed: boolean
): LayerStyle {
  const c = classifyOf(doc)[ci];
  if (!c) return doc;
  let out = setIn(doc, `classify.${ci}.palette`, palette);
  out = setIn(out, `classify.${ci}.reverse`, reversed || undefined);
  if (serverFillsClasses(c)) return clearClassValues(out, ci, target);
  const colors = classPaletteColors({ ...c, reverse: reversed }, palette, list(c.classes).length);
  return recolorClasses(out, ci, target, colors);
}

/** The classes of `classify[ci]` without their value at `target`: a palette or range picked for classes the server
 * fills takes every class, also one picked by hand (the server only replaces the values it wrote). */
export function clearClassValues(doc: LayerStyle, ci: number, target: string): LayerStyle {
  const c = classifyOf(doc)[ci];
  if (!c) return doc;
  return setIn(
    doc,
    `classify.${ci}.classes`,
    list(c.classes).map((k) => dropKey(k, "", target))
  );
}

/** `n` values from `r0` to `r1` by position, as the server writes them into classes: rounded to 0.1, to 0.01 for
 * opacities; one class gets `r0`. */
export function rangeValues(r0: number, r1: number, n: number, opacity = false): number[] {
  const scale = opacity ? 100 : 10;
  if (n <= 0) return [];
  const values = n === 1 ? [r0] : Array.from({ length: n }, (_, i) => r0 + (i * (r1 - r0)) / (n - 1));
  return values.map((v) => Math.round(v * scale) / scale);
}

/** `classify[ci]` with the range `range` for the number at `target`: every class takes its value from it. The server
 * writes the values of the classes it fills; the panel writes the others'. */
export function pickClassRange(
  doc: LayerStyle,
  ci: number,
  target: string,
  range: [number, number]
): LayerStyle {
  const c = classifyOf(doc)[ci];
  if (!c) return doc;
  const next = setIn(doc, `classify.${ci}.range`, range);
  if (serverFillsClasses(c)) return clearClassValues(next, ci, target);
  const values = rangeValues(range[0], range[1], list(c.classes).length, target.endsWith("opacity"));
  return setIn(
    next,
    `classify.${ci}.classes`,
    list(c.classes).map((k, i) => setIn(k as unknown as LayerStyle, target, values[i]))
  );
}

/** Whether a class holds a number at `target` the range does not give: one typed by hand. The server hands category
 * values out in any order, so any of the range's values counts as the range's. */
export function classValuesByHand(c: JsonObject, target: string, range: [number, number]): boolean {
  const classes = list(c.classes);
  const given = new Set(rangeValues(range[0], range[1], classes.length, target.endsWith("opacity")));
  return classes.some((k) => {
    const value = getIn(k, target);
    return typeof value === "number" && !given.has(value);
  });
}

/** Whether a class holds a color at `target` that was picked by hand. Classes the server fills: a color other than the
 * one it recorded writing (`computed.generated`), which it keeps on a new palette. Classes the panel colors: a color
 * `palette` does not give them: neither one of its own colors nor one sampled for as many classes, as the server
 * colors computed classes (classes switched to manual keep those). */
export function classColorsByHand(c: JsonObject, target: string, palette: string | string[]): boolean {
  const generated = isObject(c.computed) && isObject(c.computed.generated) ? c.computed.generated : undefined;
  const written = generated?.target === target && isObject(generated.values) ? generated.values : {};
  const classes = list(c.classes);
  const given = new Set(
    [
      ...paletteColors(palette),
      ...paletteColors(palette, classes.length || undefined),
      ...classPaletteColors(c, palette, classes.length),
    ].map((color) => color.toLowerCase())
  );
  const server = serverFillsClasses(c);
  return classes.some((k) => {
    const color = getIn(k, target);
    if (typeof color !== "string") return false;
    if (server) return typeof k.id !== "string" || written[k.id] !== color;
    return !given.has(color.toLowerCase());
  });
}

const NUMERIC_METHODS = new Set([
  "quantile",
  "equal_interval",
  "natural_breaks",
  "std_dev",
  "heads_and_tails",
  "geometric_interval",
  "manual",
]);
const family = (method: unknown) => (method === "categories" ? "categories" : "numeric");

/** `classify[ci]` on another field: its classes and what the server computed go; the method follows the field's type
 * (categories for text and yes/no, quantiles for numbers); hand-picked palette colors go with the old classes. */
export function setClassificationField(
  doc: LayerStyle,
  ci: number,
  field: { name: string; type: string }
): LayerStyle {
  const c = classifyOf(doc)[ci];
  if (!c) return doc;
  const numeric = NUMBER_FIELDS.has(field.type);
  const { classes: _classes, other: _other, computed: _computed, ...rest } = c;
  const next: JsonObject = { ...rest, field: field.name };
  if (Array.isArray(next.palette)) delete next.palette;
  if (numeric !== NUMERIC_METHODS.has(String(c.method))) {
    next.method = numeric ? "quantile" : "categories";
    next.count = numeric ? CLASS_COUNT : CATEGORY_COUNT;
  }
  return setIn(doc, `classify.${ci}`, next);
}

/** `classify[ci]` with another method: manual keeps the current breaks; categories and numeric classes do not
 * convert, so switching between them clears the classes. */
export function setMethod(doc: LayerStyle, ci: number, method: string): LayerStyle {
  const c = classifyOf(doc)[ci];
  if (!c || c.method === method) return doc;
  let next: JsonObject = { ...c, method };
  if (family(c.method) !== family(method)) {
    const { classes: _classes, other: _other, computed: _computed, ...rest } = next;
    next = { ...rest, count: method === "categories" ? CATEGORY_COUNT : CLASS_COUNT };
  } else if (method === "manual") {
    const { count: _count, computed, ...rest } = next;
    const kept = manualComputed(computed);
    next = kept ? { ...rest, computed: kept } : rest;
  } else if (c.method === "manual") {
    next.count = list(c.classes).length || CLASS_COUNT;
  }
  return setIn(doc, `classify.${ci}`, next);
}

/** The properties a classification can set on a geometry: the usual ones first, then every other per-feature key. */
const COMMON_TARGETS: Record<Geometry, string[]> = {
  point: [
    "marker.color",
    "marker.size",
    "marker.opacity",
    "outline.color",
    "outline.width",
    "outline.opacity",
    "label.color",
    "label.size",
  ],
  line: [
    "line.color",
    "line.width",
    "line.opacity",
    "line.dash",
    "casing.color",
    "casing.width",
    "label.color",
    "label.size",
  ],
  polygon: [
    "fill.color",
    "fill.opacity",
    "outline.color",
    "outline.width",
    "outline.opacity",
    "outline.dash",
    "label.color",
    "label.size",
  ],
};
const PARTS: Record<Geometry, string[]> = {
  point: ["marker", "outline", "label"],
  line: ["line", "casing", "arrows", "marker", "label"],
  polygon: ["fill", "outline", "marker", "label"],
};
/** Per-feature keys the panel does not offer as targets: text, sizes and spacing of the text box, offsets, blur, the marker's
 * shape (a class picks its shape with its icon, in the icon picker), its fill (a class draws hollow markers with
 * the Fill switch in its scope) and the label's font style (the Font target sets it with the weight). */
const NOT_TARGETS = new Set([
  "label.text",
  "label.max_width",
  "label.letter_spacing",
  "label.offset",
  "label.font.style",
  "marker.offset",
  "line.blur",
  "marker.shape",
  "marker.fill",
]);

export function classifyTargets(geometry: Geometry): string[] {
  const common = COMMON_TARGETS[geometry];
  const others = Object.entries(CAPABILITIES)
    .filter(
      ([key, cap]) =>
        cap.perFeature &&
        PARTS[geometry].includes(key.split(".")[0]) &&
        !NOT_TARGETS.has(key) &&
        !common.includes(key) &&
        // Point outlines cannot be dashed and run on their edge (spec 3.3).
        !(geometry === "point" && (key === "outline.dash" || key === "outline.position"))
    )
    .map(([key]) => key);
  return [...common, ...others];
}

/** Where a scoped class record lives: `classify[ci].classes[k]` or `classify[ci].other`. */
/** What the rows outside a classification's own editor read of the classifications, as one string: ids, titles,
 * fields, methods, palettes and targets, and per class its label parts and its value for the target. A class record
 * changing another key (a scoped opacity) leaves it as it was, so the rows that follow it do not render again. */
export function classifyShape(doc: LayerStyle, geometry?: Geometry): string {
  return JSON.stringify(
    classifyOf(doc).map((c) => {
      const target = targetsOf(c, geometry)[0];
      const records = [...list(c.classes), c.other, c.no_data];
      return [
        c.id,
        c.title,
        c.field,
        c.method,
        c.count,
        c.palette,
        c.reverse,
        target,
        records.map((r) =>
          isObject(r) ? [r.id, r.name, r.values, r.from, r.to, r.visible, getIn(r, target)] : null
        ),
      ];
    })
  );
}

export const recordPathOf = (scope: Scope): Path =>
  "rule" in scope
    ? `rules.${scope.index}`
    : typeof scope.key === "number"
      ? `classify.${scope.classify}.classes.${scope.key}`
      : `classify.${scope.classify}.${scope.key}`;

const PART_KEYS = new Set(["fill", "outline", "extrude", "line", "casing", "arrows", "marker", "label"]);

function deepMerge(base: unknown, over: JsonObject): JsonObject {
  const out: JsonObject = { ...(isObject(base) ? base : {}) };
  for (const [key, value] of Object.entries(over))
    out[key] = isObject(value) && isObject(out[key]) ? deepMerge(out[key], value) : value;
  return out;
}

/** The part `symbol.<part>` as the scoped class draws it, as scopedView merges it, without building the whole view. */
export function scopedPart(doc: LayerStyle, scope: Scope | null, part: string): unknown {
  const base = getIn(doc, `symbol.${part}`);
  // A part the layer switches off is off in every class too (spec 3).
  if (!scope || base === false) return base;
  const own = getIn(doc, `${recordPathOf(scope)}.${part}`);
  if (own === false) return false;
  return isObject(own) ? deepMerge(base, own) : base;
}

export interface ScopedView {
  recordPath: Path;
  /** The document as the scoped class draws: its parts merged over the base symbol (spec 3). */
  view: LayerStyle;
  read(path: Path): unknown;
  /** Where an edit of a symbol path goes: into the class record. */
  writePath(path: Path): Path;
  /** Whether the class sets this symbol path itself. */
  overridden(path: Path): boolean;
}

/** One class seen through the symbol section: reads merge the class record over the base symbol, part by part (an
 * object is merged in, `false` switches the part off, a part the base switches off stays off); writes go into the
 * record. */
export function scopedView(doc: LayerStyle, scope: Scope): ScopedView {
  const recordPath = recordPathOf(scope);
  const record = getIn(doc, recordPath);
  const symbol = (getIn(doc, "symbol") ?? {}) as JsonObject;
  const merged: JsonObject = { ...symbol };
  if (isObject(record))
    for (const [part, value] of Object.entries(record)) {
      if (!PART_KEYS.has(part)) continue;
      if (value === false) merged[part] = false;
      else if (isObject(value) && symbol[part] !== false) merged[part] = deepMerge(symbol[part], value);
    }
  const view = setIn(doc, "symbol", merged);
  const writePath = (path: Path) =>
    path.startsWith("symbol.") ? `${recordPath}.${path.slice("symbol.".length)}` : path;
  return {
    recordPath,
    view,
    read: (path) => getIn(view, path),
    writePath,
    overridden: (path) => path.startsWith("symbol.") && getIn(doc, writePath(path)) !== undefined,
  };
}

/** The keys a scoped class takes from its classification (its targets, a compound target's keys with it); none for a
 * rule. */
function ownTargets(doc: LayerStyle, scope: Scope, geometry?: Geometry): string[] {
  if ("rule" in scope) return [];
  const c = getIn(doc, `classify.${scope.classify}`);
  if (!isObject(c)) return [];
  return targetsOf(c, geometry).flatMap((target) => {
    const compound = compoundOf(target);
    return compound ? compoundKeys(compound) : [target];
  });
}

/** Whether `value` at `prefix` sets a key that is not one of `targets` (a target's parent object is looked into) nor
 * a key the layer sets once (spec 6.1: it holds for all features wherever it is kept). */
function setsBeyond(value: JsonObject, prefix: string, targets: string[]): boolean {
  return Object.entries(value).some(([key, inner]) => {
    const path = `${prefix}.${key}`;
    if (targets.includes(path) || isPerLayer(path)) return false;
    if (isObject(inner) && targets.some((t) => t.startsWith(`${path}.`)))
      return setsBeyond(inner, path, targets);
    return inner !== undefined;
  });
}

/** Whether the scoped class or rule draws `symbol.<part>` otherwise than all features beyond what its classification
 * gives it: it switches off a part that is on, switches on a part the base leaves out, or sets a key of the part other
 * than its classification's targets and the keys the layer sets once. An empty object over a part that is on changes
 * nothing, and a part the base switches off stays off whatever the record keeps of it (spec 3). */
export function partDiffers(doc: LayerStyle, scope: Scope, part: string, geometry: Geometry): boolean {
  const own = getIn(doc, `${recordPathOf(scope)}.${part}`);
  const base = getIn(doc, `symbol.${part}`);
  if (base === false) return false;
  const on = partOn(base, part, geometry);
  if (own === false) return on;
  if (!isObject(own)) return false;
  if (!on) return true;
  return setsBeyond(own, part, ownTargets(doc, scope, geometry));
}

/** The document with the scoped record's `part` removed once a reset left it an empty object over a part that is on,
 * where it changes nothing (spec 3). An empty part over a part the base leaves out or switches off stays: it switches
 * the part on for the record, now or once the layer allows it. */
export function withoutEmptyPart(
  doc: LayerStyle,
  record: Path,
  part: string,
  geometry: Geometry
): LayerStyle {
  const path = `${record}.${part}`;
  const own = getIn(doc, path);
  if (!isObject(own) || Object.keys(own).length > 0) return doc;
  return partOn(getIn(doc, `symbol.${part}`), part, geometry) ? setIn(doc, path, undefined) : doc;
}
