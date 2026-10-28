// Classifications in the panel. A change of what the server computes from (a classification's field, method, count,
// palette or range; a value form's field or scale) is an intent edit: it is saved at once, and the classes or the
// domain stay pending until the reply brings them (spec 12, 13.1).
import type { Geometry } from "@/lib/style/compile/types";
import { MAIN_COLOR, targetsOf } from "@/lib/style/editor/forms";
import { type Path, dropKey, getIn, setIn } from "@/lib/style/editor/paths";
import type { EditorStore, Scope } from "@/lib/style/editor/store";
import { CAPABILITIES } from "@/lib/style/generated/capabilities";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type JsonObject, deepEqual, isObject } from "@/lib/style/json";

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
const classifyOf = (doc: LayerStyle): JsonObject[] => list((doc as unknown as JsonObject).classify);

/** How many classifications the style has. */
export const classifyCount = (doc: LayerStyle): number => classifyOf(doc).length;

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
export const MAX_CLASS_COUNT = 100;
export const CLASS_COUNT = 5;

const isMain = (key: string, geometry?: Geometry) =>
  geometry ? MAIN_COLOR[geometry] === key : Object.values(MAIN_COLOR).includes(key);

/** A free classification id: the field name, else `k1`, `k2` (goatlib's assign_ids). */
function freshId(doc: LayerStyle, field: string): string {
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

const recordPaths = (c: JsonObject): string[] => [
  ...list(c.classes).map((_, i) => `classes.${i}`),
  ...["other", "no_data"].filter((r) => isObject(c[r])),
];

/** `classify[ci]` setting `key` instead: the old key leaves its class records; a palette stays only on a color, a
 * range only on a number. */
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
  if (old !== key) for (const record of recordPaths(next)) next = dropKey(next, record, old);
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

/** `classify[ci]` as its classes are now, no longer the most frequent values the server computes: categories without
 * `count` keep the classes as written (spec 12). */
function handPicked(doc: LayerStyle, ci: number, classes: JsonObject[]): LayerStyle {
  const c = classifyOf(doc)[ci];
  if (!c) return doc;
  const { count: _count, computed: _computed, ...rest } = c;
  return setIn(doc, `classify.${ci}`, { ...rest, classes });
}

/** A value of the field as the unique values list it (as text), in the field's type: class values match by type. */
export function categoryValue(text: string, type?: string): string | number | boolean {
  if (type === "boolean") return text === "true" ? true : text === "false" ? false : text;
  if (type === "integer" || type === "number") {
    const n = Number(text);
    return text.trim() !== "" && Number.isFinite(n) ? n : text;
  }
  return text;
}

/** `value` in class `to` of `classify[ci]`, out of the class that had it; `to` null leaves it in no class. A value is in
 * one class at most; values compare as text, as goatlib compares them. */
export function moveCategoryValue(
  doc: LayerStyle,
  ci: number,
  value: string | number | boolean,
  to: number | null
): LayerStyle {
  const c = classifyOf(doc)[ci];
  if (!c) return doc;
  const classes = list(c.classes).map((k, i) => {
    const values = (Array.isArray(k.values) ? k.values : []).filter((v) => String(v) !== String(value));
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

const NUMERIC_METHODS = new Set([
  "quantile",
  "equal_interval",
  "natural_breaks",
  "std_dev",
  "heads_and_tails",
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
  line: ["line", "casing", "arrows", "label"],
  polygon: ["fill", "outline", "label"],
};
/** Per-feature keys the panel does not offer as targets: text, sizes of the text box, offsets, blur, the marker's
 * shape (a class picks its shape with its icon, in the icon picker) and its fill (a class draws hollow markers with
 * the Fill switch in its scope). */
const NOT_TARGETS = new Set([
  "label.text",
  "label.max_width",
  "label.offset",
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
        // Point outlines cannot be dashed (spec 3.3).
        !(geometry === "point" && key === "outline.dash")
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
    : scope.key === "other"
      ? `classify.${scope.classify}.other`
      : `classify.${scope.classify}.classes.${scope.key}`;

const PART_KEYS = new Set(["fill", "outline", "line", "casing", "arrows", "marker", "label"]);

function deepMerge(base: unknown, over: JsonObject): JsonObject {
  const out: JsonObject = { ...(isObject(base) ? base : {}) };
  for (const [key, value] of Object.entries(over))
    out[key] = isObject(value) && isObject(out[key]) ? deepMerge(out[key], value) : value;
  return out;
}

/** The part `symbol.<part>` as the scoped class draws it, as scopedView merges it, without building the whole view. */
export function scopedPart(doc: LayerStyle, scope: Scope | null, part: string): unknown {
  const base = getIn(doc, `symbol.${part}`);
  if (!scope) return base;
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
 * object is merged in, `false` switches the part off); writes go into the record. */
export function scopedView(doc: LayerStyle, scope: Scope): ScopedView {
  const recordPath = recordPathOf(scope);
  const record = getIn(doc, recordPath);
  const symbol = (getIn(doc, "symbol") ?? {}) as JsonObject;
  const merged: JsonObject = { ...symbol };
  if (isObject(record))
    for (const [part, value] of Object.entries(record)) {
      if (!PART_KEYS.has(part)) continue;
      if (value === false) merged[part] = false;
      else if (isObject(value)) merged[part] = deepMerge(symbol[part], value);
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
