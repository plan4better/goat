// The value of a part key for every feature (spec 6.1): the base (or the reference default), then each
// classification in list order (the class a feature falls in, else `other`, else `no_data`), then the rules in list
// order; the last one that sets the key wins. Visibility and the class and rule zooms go into the feature filter. A part
// the layer switches off (`false` in the symbol) stays off in every record; its other keys still cascade (an outline in
// the fill color takes the fill color a feature would have).
import { classTexts } from "@/lib/style/categoryTexts";
import { cqlToExpression } from "@/lib/style/compile/cql";
import type { FieldType, Geometry } from "@/lib/style/compile/types";
import {
  type Expr,
  type Kind,
  type Value,
  combine,
  fromForm,
  hasValue,
  isZoomed,
} from "@/lib/style/compile/values";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { PROPERTY_KINDS } from "@/lib/style/generated/properties";
import { type JsonObject, isObject } from "@/lib/style/json";

export interface CascadeContext {
  fields?: Record<string, FieldType>;
  /** The base value (a MapLibre value) where the symbol sets none; it replaces the reference default. */
  fallback?: Expr;
  /** Turns fixed values into MapLibre values (dash names into arrays). */
  map?: (value: unknown) => Expr;
  kind?: Kind;
  /** Turns the number a raw field reads into the property's unit (storeys into metres). */
  raw?: (get: Expr) => Expr;
}

const MAIN_PART: Record<Geometry, string> = { point: "marker", line: "line", polygon: "fill" };

/** Parts drawn with their defaults when the symbol leaves them out; every other absent part is off (spec 3). */
const MAIN_PARTS = new Set(Object.values(MAIN_PART));

const list = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isObject) : []);

const constant = (value: unknown): Expr => (Array.isArray(value) ? ["literal", value] : value);

/** Keys a part switched off sets to 0: its opacity, and a height part's height and base (a flat volume). */
const OFF_IS_ZERO = new Set(["extrude.height", "extrude.base"]);

/** What a record sets at `path`: a part switched off sets its opacity (or height) to 0, a fill also no pattern, and
 * nothing else. */
function read(record: unknown, path: string, baseOff: boolean): unknown {
  if (!isObject(record)) return undefined;
  const [part, ...keys] = path.split(".");
  const node = record[part];
  if (node === false)
    return path.endsWith(".opacity") || OFF_IS_ZERO.has(path)
      ? 0
      : path === "fill.pattern"
        ? "none"
        : undefined;
  let current: unknown = node;
  for (const key of keys) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  // An object switches on a part the base leaves out (a part the base switches off stays off: `cascade`).
  if (
    current === undefined &&
    baseOff &&
    isObject(node) &&
    (path.endsWith(".opacity") || OFF_IS_ZERO.has(path))
  )
    return DEFAULTS[path] ?? 1;
  return current === null ? undefined : current;
}

/** A label of a whole-number field: a whole number, or nothing for a value no feature can have. */
const wholeNumber = (value: unknown): number | undefined => {
  const n =
    typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isInteger(n) ? n : undefined;
};

/** Each class's labels, in the field's type; a label two classes give stays with the first. */
function ownLabels(classes: JsonObject[], label: (value: unknown) => string | number | undefined) {
  const seen = new Set<string | number>();
  return classes.map((k) =>
    (Array.isArray(k.values) ? k.values : []).flatMap((v) => {
      const l = label(v);
      if (l === undefined || seen.has(l)) return [];
      seen.add(l);
      return [l];
    })
  );
}

/**
 * The match input of a categories classification and each class's labels (none twice): text and whole-number fields
 * match their own values, the labels in the field's type; any other field, and one of unknown type (the map compiles
 * without field types, and converted styles hold a number field's values as text), compares as text, which matches
 * both, a value that writes a number also in the number's own spelling (`classTexts`).
 */
export function categoryLabels(
  field: string,
  classes: JsonObject[],
  fields?: Record<string, FieldType>
): { input: Expr; labels: Array<Array<string | number>> } {
  const type = fields?.[field];
  if (type === "string") return { input: ["get", field], labels: ownLabels(classes, (v) => String(v)) };
  if (type === "integer") return { input: ["get", field], labels: ownLabels(classes, wholeNumber) };
  return { input: ["to-string", ["get", field]], labels: classTexts(classes) };
}

const isNumeric = (c: JsonObject) => c.method !== "categories";

const lower = (k: JsonObject) => (typeof k.from === "number" ? k.from : -Infinity);

/**
 * Numeric classes by `from`, without those whose bounds do not ascend (a break being edited, a duplicate):
 * MapLibre's step needs strictly ascending stops.
 */
function sortedClasses(c: JsonObject): JsonObject[] {
  const kept: JsonObject[] = [];
  for (const k of [...list(c.classes)].sort((a, b) => lower(a) - lower(b))) {
    const prev = kept[kept.length - 1];
    if (!prev || (typeof k.from === "number" && k.from > lower(prev))) kept.push(k);
  }
  return kept;
}

export function cascade(style: JsonObject, path: string, ctx: CascadeContext = {}): Value {
  const kind =
    ctx.kind ??
    (PROPERTY_KINDS[path] as Kind | undefined) ??
    (path.endsWith(".opacity") ? "number" : "choice");
  const map = ctx.map ?? constant;
  const symbol = isObject(style.symbol) ? style.symbol : {};
  const part = path.split(".")[0];
  // Off for the layer: no record switches it on.
  if (symbol[part] === false && (path.endsWith(".opacity") || OFF_IS_ZERO.has(path))) return { expr: 0 };
  const baseOff = symbol[part] === undefined && !MAIN_PARTS.has(part);
  // A caller's fallback is already a MapLibre value; only the reference default goes through `map`.
  const def = ctx.fallback !== undefined ? ctx.fallback : map(DEFAULTS[path]);
  const raw = ctx.raw;
  let value = fromForm(
    baseOff && path.endsWith(".opacity") ? 0 : read(symbol, path, false),
    kind,
    def,
    map,
    raw
  );
  const noDataOf = (v: Value) => (isZoomed(v) ? def : v.expr);
  const formOf = (record: unknown) => {
    const form = read(record, path, baseOff);
    return form === undefined ? null : fromForm(form, kind, noDataOf(value), map, raw);
  };
  const opts = { step: kind === "choice", kind };

  for (const c of list(style.classify)) {
    const field = c.field;
    if (typeof field !== "string") continue;
    const noData = formOf(c.no_data);
    if (isNumeric(c)) {
      const classes = sortedClasses(c);
      const forms = classes.map(formOf);
      if (!forms.some((f) => f) && !noData) continue;
      const prev = value;
      value = combine(
        [prev, ...forms.map((f) => f ?? prev), noData ?? prev],
        (exprs) => {
          const [fallback, ...rest] = exprs;
          const outs = rest.slice(0, classes.length);
          // No classes yet (not computed): features without a value take No data, the others keep their value.
          if (!classes.length) return ["case", hasValue(field), fallback, rest[0]];
          const steps: Expr[] = [];
          classes.forEach((k, i) => {
            if (i === 0) {
              if (typeof k.from === "number") steps.push(fallback, k.from, outs[0]);
              else steps.push(outs[0]);
            } else {
              steps.push(k.from, outs[i]);
            }
          });
          const last = classes[classes.length - 1];
          if (typeof last.to === "number" && last.to > lower(last)) steps.push(last.to, fallback);
          return [
            "case",
            hasValue(field),
            // One class without bounds (a field with a single value) has no stops to step through.
            steps.length === 1 ? steps[0] : ["step", ["to-number", ["get", field], 0], ...steps],
            rest[classes.length],
          ];
        },
        opts
      );
      continue;
    }
    const classes = list(c.classes);
    const { input, labels: labelsOf } = categoryLabels(field, classes, ctx.fields);
    const branches: Array<{ labels: unknown[]; form: Value }> = [];
    classes.forEach((k, i) => {
      const form = formOf(k);
      const labels = labelsOf[i];
      if (form && labels.length) branches.push({ labels, form });
    });
    const other = formOf(c.other);
    if (!branches.length && !other && !noData) continue;
    const prev = value;
    value = combine(
      [prev, other ?? prev, noData ?? prev, ...branches.map((b) => b.form)],
      ([fallback, otherExpr, noDataExpr, ...outs]) => {
        const matched = branches.length
          ? [
              "match",
              input,
              ...branches.flatMap((b, i) => [b.labels.length === 1 ? b.labels[0] : b.labels, outs[i]]),
              otherExpr,
            ]
          : ["case", hasValue(field), otherExpr, fallback];
        if (noData) return ["case", hasValue(field), matched, noDataExpr];
        // `other` takes values in no class; features without a value keep what they had (spec 5.1).
        return other && branches.length ? ["case", hasValue(field), matched, fallback] : matched;
      },
      opts
    );
  }

  const rules = list(style.rules).flatMap((r) => {
    const form = formOf(r);
    const when = r.when === undefined ? true : cqlToExpression(r.when);
    return form && when !== null ? [{ when, form }] : [];
  });
  if (rules.length) {
    const prev = value;
    value = combine(
      [prev, ...rules.map((r) => r.form)],
      ([fallback, ...outs]) => {
        const branches = rules
          .map((r, i) => [r.when, outs[i]])
          .reverse()
          .flat();
        return ["case", ...branches, fallback];
      },
      opts
    );
  }
  return value;
}

const showsDifferently = (r: JsonObject) =>
  r.visible !== undefined || r.min_zoom !== undefined || r.max_zoom !== undefined;

function shown(r: JsonObject): Expr {
  if (r.visible === false) return false;
  const conditions: Expr[] = [];
  if (typeof r.min_zoom === "number") conditions.push([">=", ["zoom"], r.min_zoom]);
  if (typeof r.max_zoom === "number") conditions.push(["<", ["zoom"], r.max_zoom]);
  if (!conditions.length) return true;
  return conditions.length === 1 ? conditions[0] : ["all", ...conditions];
}

/** The record, or the zoom range it gives one part (spec 3.5: a part range in a class record is a feature range). */
type Pick = (record: JsonObject) => JsonObject | undefined;

const wholeRecord: Pick = (r) => r;

const partRange =
  (part: string): Pick =>
  (r) => {
    const node = r[part];
    return isObject(node) ? { min_zoom: node.min_zoom, max_zoom: node.max_zoom } : undefined;
  };

interface Contributor {
  member: Expr;
  notMember: Expr;
  shown: Expr;
}

function classContributors(c: JsonObject, ctx: CascadeContext, pick: Pick): Contributor[] {
  const field = c.field as string;
  const out: Contributor[] = [];
  const has = hasValue(field);
  if (isNumeric(c)) {
    const x: Expr = ["to-number", ["get", field], 0];
    for (const k of sortedClasses(c)) {
      const node = pick(k);
      if (!node || !showsDifferently(node)) continue;
      const above = typeof k.from === "number" ? [[">=", x, k.from]] : [];
      const below = typeof k.to === "number" ? [["<", x, k.to]] : [];
      const aboveOut = typeof k.from === "number" ? [["<", x, k.from]] : [];
      const belowOut = typeof k.to === "number" ? [[">=", x, k.to]] : [];
      out.push({
        member: ["all", has, ...above, ...below],
        notMember: ["any", ["!", has], ...aboveOut, ...belowOut],
        shown: shown(node),
      });
    }
  } else {
    const classes = list(c.classes);
    const { input, labels: labelsOf } = categoryLabels(field, classes, ctx.fields);
    const all: unknown[] = labelsOf.flat();
    for (const [i, k] of classes.entries()) {
      const node = pick(k);
      if (!node || !showsDifferently(node)) continue;
      const labels = labelsOf[i];
      if (!labels.length) continue;
      const member: Expr =
        labels.length === 1 ? ["==", input, labels[0]] : ["in", input, ["literal", labels]];
      const notMember: Expr = labels.length === 1 ? ["!=", input, labels[0]] : ["!", member];
      out.push({ member, notMember, shown: shown(node) });
    }
    const other = isObject(c.other) ? pick(c.other) : undefined;
    if (other && showsDifferently(other)) {
      const inAny: Expr = ["in", input, ["literal", all]];
      out.push({
        member: ["all", has, ["!", inAny]],
        notMember: ["any", ["!", has], inAny],
        shown: shown(other),
      });
    }
  }
  const noData = isObject(c.no_data) ? pick(c.no_data) : undefined;
  if (noData && showsDifferently(noData))
    out.push({ member: ["!", has], notMember: has, shown: shown(noData) });
  return out;
}

/**
 * The feature filter of visibility and class and rule zooms; with `part`, of the zoom ranges class and rule records
 * give that part. Undefined when nothing hides features.
 */
export function featureFilter(style: JsonObject, ctx: CascadeContext = {}, part?: string): Expr | undefined {
  const pick = part ? partRange(part) : wholeRecord;
  const contributors: Contributor[] = [];
  for (const c of list(style.classify)) {
    if (typeof c.field === "string") contributors.push(...classContributors(c, ctx, pick));
  }
  for (const r of list(style.rules)) {
    const node = pick(r);
    if (!node || !showsDifferently(node)) continue;
    const when = r.when === undefined ? true : cqlToExpression(r.when);
    if (when !== null) contributors.push({ member: when, notMember: ["!", when], shown: shown(node) });
  }
  if (!contributors.length) return undefined;
  if (contributors.length === 1) {
    const [only] = contributors;
    if (only.shown === true) return undefined;
    return only.shown === false ? only.notMember : ["any", only.notMember, only.shown];
  }
  return ["case", ...[...contributors].reverse().flatMap((c) => [c.member, c.shown]), true];
}

/** Every record that sets parts, in cascade order: the base, class records, `other`, `no_data`, rules. */
function records(style: JsonObject): JsonObject[] {
  const symbol = isObject(style.symbol) ? style.symbol : {};
  return [
    symbol,
    ...list(style.classify).flatMap((c) => [...list(c.classes), c.other, c.no_data].filter(isObject)),
    ...list(style.rules),
  ];
}

/** Whether the layer draws `part`: never when the base switches it off; else the geometry's main part, or any record
 * that sets it. */
export function partUsed(style: JsonObject, part: string, geometry?: Geometry): boolean {
  const symbol = isObject(style.symbol) ? style.symbol : {};
  if (symbol[part] === false) return false;
  if (records(style).some((r) => isObject(r[part]))) return true;
  return geometry !== undefined && MAIN_PART[geometry] === part && symbol[part] !== false;
}

/** Whether any record sets `path` (a part switched off sets its opacity). */
export const isSet = (style: JsonObject, path: string): boolean =>
  records(style).some((r) => read(r, path, false) !== undefined);

/** The fixed values records set at `path`, zoom stop values included. */
export function setValues(style: JsonObject, path: string): unknown[] {
  return records(style).flatMap((r) => {
    const v = read(r, path, false);
    if (v === undefined) return [];
    if (isObject(v) && Array.isArray(v.zoom)) return (v.zoom as unknown[][]).map((stop) => stop[1]);
    return isObject(v) ? [] : [v];
  });
}

/** A per-layer key (spec 6.1): set in one place only, the first record that sets it, else the reference. */
export function perLayer(style: JsonObject, path: string): unknown {
  for (const r of records(style)) {
    const v = read(r, path, false);
    if (v !== undefined) return v;
  }
  return DEFAULTS[path];
}
