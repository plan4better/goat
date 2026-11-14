// One condition as CQL2 and back, for the layer filter and the style's rule conditions. Two spellings, picked by
// `orEmpty`. The filter's (`orEmpty: true`, standard CQL2 as `query.cql` saves it): every negation and "is empty" take
// the empty value as an alternative, a range is `between` with three args, dates are `{"date"}` and `{"timestamp"}`
// literals. The style's (`orEmpty: false`, spec 6, unchanged): a bare `<>` and `not`, `isNull` alone, a range as `>=`
// and `<=`, dates as text. The reader of each spelling takes what its writer writes; the filter's also takes the
// shapes saved before (`!=`, `isNull` on a bare property, a value list as `=` alternatives, ...).
import { FILTER_OPERATORS } from "@/lib/filter/generated/operators";
import type { Fields, FilterCondition, FilterOp } from "@/lib/filter/model";
import type { FieldType } from "@/lib/style/compile/types";
import { type JsonObject, isObject } from "@/lib/style/json";

/** The table typed as operators: an operator added to goatlib's table and not handled here fails the typecheck. */
const OPERATORS: Readonly<Record<FieldType, readonly FilterOp[]>> = FILTER_OPERATORS;

/** The operators a filter offers for a field of `type`; a field the layer no longer has offers the plain ones. */
export function operatorsFor(type: FieldType | undefined): FilterOp[] {
  return type && type in OPERATORS ? [...OPERATORS[type]] : ["is", "is_not", "is_blank", "is_not_blank"];
}

/** Whether the operator takes a value (and a second one). */
export const takesValue = (op: FilterOp) => !["is_blank", "is_not_blank", "is_true", "is_false"].includes(op);

/** The operators that say "not": the filter writes them with the empty value as an alternative. */
const NEGATIONS = new Set<FilterOp>([
  "is_not",
  "excludes",
  "does_not_contains_the_text",
  "is_not_between",
  "is_not_on",
  "not_in_the_last",
]);

/** A value a row's box shows as it is: text, a number, true or false. A date object or another field is not. */
const scalar = (value: unknown) => value === null || ["string", "number", "boolean"].includes(typeof value);

const numeric = (type: FieldType | undefined) => type === "number" || type === "integer";
const temporal = (type: FieldType | undefined) => type === "date" || type === "datetime";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T/;
const MIDNIGHT = /^(\d{4}-\d{2}-\d{2})T00:00:00Z$/;
const DAY_MS = 86_400_000;

/** The calendar day of a date or timestamp text, or null. */
function dayOf(value: unknown): string | null {
  if (typeof value !== "string" || !(DAY.test(value) || STAMP.test(value))) return null;
  const day = value.slice(0, 10);
  return Number.isNaN(Date.parse(`${day}T00:00:00Z`)) ? null : day;
}

const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

/** The style's literal: a number for a number field, else text; null while it is not one yet. */
function textLiteral(value: unknown, type: FieldType | undefined): string | number | null {
  if (value === undefined || value === null || value === "") return null;
  if (numeric(type)) {
    const n = typeof value === "number" ? value : Number(String(value).trim());
    return Number.isFinite(n) ? n : null;
  }
  return String(value);
}

/** A date as the filter writes it: a day as `{"date"}` (on a timestamp field the day's start), a time as
 * `{"timestamp"}`, other text as it is. */
function dateLiteral(value: string, type: FieldType | undefined): unknown {
  if (DAY.test(value)) return type === "datetime" ? { timestamp: `${value}T00:00:00Z` } : { date: value };
  if (STAMP.test(value)) return { timestamp: value };
  return value;
}

/** The filter's literal of the field's type, or null while there is none yet (no value, blank text for a number). A
 * value of another type is written as it is, for the checker to name, never left out: leaving it out would widen
 * the filter without a word. */
function typedLiteral(value: unknown, type: FieldType | undefined): unknown {
  if (!scalar(value) || value === null || value === "") return null;
  switch (type) {
    case "number":
    case "integer": {
      if (typeof value !== "string") return value;
      if (!value.trim()) return null;
      const n = Number(value.trim());
      return Number.isFinite(n) ? n : value;
    }
    case "boolean":
      return value === "true" ? true : value === "false" ? false : value;
    case "date":
    case "datetime":
      return typeof value === "string" ? dateLiteral(value, type) : value;
    default:
      return value;
  }
}

/** A value list: a list as it is, text split at commas. */
const list = (value: unknown): unknown[] =>
  Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean)
      : [];

const not = (inner: JsonObject): JsonObject => ({ op: "not", args: [inner] });

export interface WriteOptions {
  /** The filter's spelling (standard CQL2, negations keep the empty value); false for the style's. */
  orEmpty: boolean;
  /** The moment "in the last N days" counts back from; now when left out. */
  now?: Date;
}

/** One row as CQL2, or null while it is unfinished (no field, no value, `%` or `_` in a text; in the style's spelling
 * also a value of the wrong type). `type` is the field's type, undefined for a field the layer no longer has. */
export function rowToCql(
  row: FilterCondition,
  type: FieldType | undefined,
  opts: WriteOptions
): JsonObject | null {
  if (opts.orEmpty && (typeof row.field !== "string" || !row.field)) return null;
  const filter = opts.orEmpty;
  const p = { property: row.field };
  const isNull: JsonObject = { op: "isNull", args: [p] };
  const literal = (value: unknown) => (filter ? typedLiteral(value, type) : textLiteral(value, type));
  // The one place a negation takes the empty value: `x <> v` is unknown, not true, where x is empty, so on its own a
  // negation drops the rows without a value.
  const withEmpty = (node: JsonObject | null): JsonObject | null =>
    !node || !filter
      ? node
      : {
          op: "or",
          args: node.op === "or" && Array.isArray(node.args) ? [...node.args, isNull] : [node, isNull],
        };
  const compare = (op: string, value: unknown = row.value): JsonObject | null => {
    const v = literal(value);
    return v === null ? null : { op, args: [p, v] };
  };
  const pair = (): [unknown, unknown] | null => {
    const a = literal(row.value);
    const b = literal(row.value2);
    return a === null || b === null ? null : [a, b];
  };
  const like = (pattern: (text: string) => string): JsonObject | null => {
    const text = textLiteral(row.value, "string");
    return text === null || /[%_]/.test(String(text))
      ? null
      : { op: "like", args: [p, pattern(String(text))] };
  };
  const days = (): string | null => {
    const n = typeof row.value === "number" ? row.value : Number(row.value);
    if (!Number.isInteger(n) || n < 1) return null;
    const since = new Date((opts.now ?? new Date()).getTime() - n * DAY_MS).toISOString();
    return type === "date" ? since.slice(0, 10) : since.replace(/\.\d+Z$/, "Z");
  };
  const text = type === "string";
  switch (row.op) {
    case "is":
      return compare("=");
    case "is_not":
      return withEmpty(compare("<>"));
    case "includes":
    case "excludes": {
      const values = list(row.value).map(literal);
      if (!values.length || values.some((v) => v === null)) return null;
      const inside: JsonObject = { op: "in", args: [p, values] };
      return row.op === "includes" ? inside : withEmpty(not(inside));
    }
    case "is_blank":
      return filter && text ? { op: "or", args: [isNull, { op: "=", args: [p, ""] }] } : isNull;
    case "is_not_blank":
      return filter && text ? { op: "and", args: [not(isNull), { op: "<>", args: [p, ""] }] } : not(isNull);
    case "is_less_than":
    case "is_before":
      return compare("<");
    case "is_greater_than":
    case "is_after":
      return compare(">");
    case "is_at_most":
      return compare("<=");
    case "is_at_least":
      return compare(">=");
    case "is_between": {
      const bounds = pair();
      if (!bounds) return null;
      return filter
        ? { op: "between", args: [p, ...bounds] }
        : {
            op: "and",
            args: [
              { op: ">=", args: [p, bounds[0]] },
              { op: "<=", args: [p, bounds[1]] },
            ],
          };
    }
    case "is_not_between": {
      const bounds = pair();
      return bounds
        ? withEmpty({
            op: "or",
            args: [
              { op: "<", args: [p, bounds[0]] },
              { op: ">", args: [p, bounds[1]] },
            ],
          })
        : null;
    }
    case "contains_the_text":
      return like((x) => `%${x}%`);
    case "does_not_contains_the_text": {
      const inner = like((x) => `%${x}%`);
      return withEmpty(inner && not(inner));
    }
    case "starts_with":
      return like((x) => `${x}%`);
    case "ends_with":
      return like((x) => `%${x}`);
    case "is_true":
      return { op: "=", args: [p, true] };
    case "is_false":
      return { op: "=", args: [p, false] };
    case "is_on":
    case "is_not_on": {
      // A date field holds days: "on" is equality. A timestamp field holds moments: "on" is the day's range.
      const day = dayOf(row.value);
      if (!day) return null;
      const negated = row.op === "is_not_on";
      if (type !== "datetime") {
        const on: JsonObject = { op: negated ? "<>" : "=", args: [p, typedLiteral(day, "date")] };
        return negated ? withEmpty(on) : on;
      }
      const start = { timestamp: `${day}T00:00:00Z` };
      const end = { timestamp: `${nextDay(day)}T00:00:00Z` };
      return negated
        ? withEmpty({
            op: "or",
            args: [
              { op: "<", args: [p, start] },
              { op: ">=", args: [p, end] },
            ],
          })
        : {
            op: "and",
            args: [
              { op: ">=", args: [p, start] },
              { op: "<", args: [p, end] },
            ],
          };
    }
    case "in_the_last":
    case "not_in_the_last": {
      // Counted back from the moment of writing: the saved date does not move with the day.
      const since = days();
      if (!since) return null;
      const bound = type === "date" ? { date: since } : { timestamp: since };
      return row.op === "in_the_last"
        ? { op: ">=", args: [p, bound] }
        : withEmpty({ op: "<", args: [p, bound] });
    }
  }
  return null;
}

/** The field a comparison reads (its first arg), or null. */
const fieldOf = (node: JsonObject): string | null => {
  const first = Array.isArray(node.args) ? node.args[0] : undefined;
  return isObject(first) && typeof first.property === "string" ? first.property : null;
};

/** The field of `isNull`, with its args as a list or (saved before) as the bare property. */
function nullField(node: unknown): string | null {
  if (!isObject(node) || node.op !== "isNull") return null;
  const arg = Array.isArray(node.args) ? (node.args.length === 1 ? node.args[0] : undefined) : node.args;
  return isObject(arg) && typeof arg.property === "string" ? arg.property : null;
}

/** The type of a field the layer no longer has, as the saved value shows it. */
function guessType(raw: unknown): FieldType | undefined {
  if (isObject(raw))
    return typeof raw.date === "string" ? "date" : typeof raw.timestamp === "string" ? "datetime" : undefined;
  if (typeof raw === "number") return "number";
  if (typeof raw === "boolean") return "boolean";
  if (typeof raw === "string") return "string";
  return undefined;
}

/** A field's type, never one of Object's own keys. */
const typeIn = (fields: Fields, field: string): FieldType | undefined =>
  Object.prototype.hasOwnProperty.call(fields, field) ? fields[field] : undefined;

/** A saved value as the filter's row holds it, or undefined when the filter's writer would not write it back the same:
 * a `{"date"}` or `{"timestamp"}` literal on a date field gives its text (the start of a day on a timestamp field the
 * day); text, a number, true or false stay as they are, also on a field of another type (the checker names it). */
function filterValue(raw: unknown, type: FieldType | undefined): unknown {
  if (isObject(raw)) {
    if (Object.keys(raw).length !== 1 || !(type === undefined || temporal(type))) return undefined;
    if (typeof raw.date === "string") return DAY.test(raw.date) ? raw.date : undefined;
    if (typeof raw.timestamp === "string") {
      const midnight = type === "datetime" ? MIDNIGHT.exec(raw.timestamp) : null;
      return midnight ? midnight[1] : STAMP.test(raw.timestamp) ? raw.timestamp : undefined;
    }
    return undefined;
  }
  if (raw === null || raw === "" || !scalar(raw)) return undefined;
  return typeof raw === "string" && !raw.trim() && type !== "string" ? undefined : raw;
}

/** The parts of a reading the nested nodes share. */
interface Reader {
  fields: Fields;
  filter: boolean;
  /** "In the last N days", from the notes, for the row at this position. */
  days?: number;
}

/** A comparison on one field as a row; `raw` is the compared value. */
function comparisonRow(
  op: unknown,
  field: string,
  raw: unknown,
  args: unknown[],
  r: Reader
): FilterCondition | null {
  const known = typeIn(r.fields, field);
  if (!r.filter) {
    // The style's reader: text, numbers, true and false only.
    if (op === "in" ? !Array.isArray(raw) || !raw.every(scalar) : op !== "isNull" && !scalar(raw))
      return null;
    const date = temporal(known);
    switch (op) {
      case "isNull":
        return { field, op: "is_blank" };
      case "=":
        if (raw === true) return { field, op: "is_true" };
        if (raw === false) return { field, op: "is_false" };
        return { field, op: "is", value: raw };
      case "<>":
        return { field, op: "is_not", value: raw };
      case "<":
        return { field, op: date ? "is_before" : "is_less_than", value: raw };
      case ">":
        return { field, op: date ? "is_after" : "is_greater_than", value: raw };
      case "<=":
        return { field, op: "is_at_most", value: raw };
      case ">=":
        return { field, op: "is_at_least", value: raw };
      case "in":
        return Array.isArray(raw) ? { field, op: "includes", value: raw } : null;
      case "like":
        return likeRow(field, raw, false);
      default:
        return null;
    }
  }
  // `isNull` the filter's reader took before, with either form of its args.
  if (args.length !== 2) return null;
  if (op === "like") return likeRow(field, raw, true);
  const guessed = known ?? guessType(Array.isArray(raw) ? raw[0] : raw);
  const typed = (row: FilterCondition): FilterCondition =>
    !known && guessed ? { ...row, type: guessed } : row;
  if (op === "in") {
    if (!Array.isArray(raw) || !raw.length) return null;
    const values = raw.map((v) => filterValue(v, guessed));
    return values.some((v) => v === undefined) ? null : typed({ field, op: "includes", value: values });
  }
  // Empty text on a field that is not text is no test for "is empty": the row stays as it was saved.
  if ((op === "=" || op === "<>" || op === "!=") && raw === "")
    return guessed === "string" ? typed({ field, op: op === "=" ? "is_blank" : "is_not_blank" }) : null;
  if (op === "=" && typeof raw === "boolean") return { field, op: raw ? "is_true" : "is_false" };
  const value = filterValue(raw, guessed);
  if (value === undefined) return null;
  const date = temporal(guessed);
  const onDay = guessed === "date" && typeof value === "string" && DAY.test(value);
  switch (op) {
    case "=":
      return typed({ field, op: onDay ? "is_on" : "is", value });
    case "<>":
    case "!=":
      return typed({ field, op: onDay ? "is_not_on" : "is_not", value });
    case "<":
      return typed({ field, op: date ? "is_before" : "is_less_than", value });
    case ">":
      return typed({ field, op: date ? "is_after" : "is_greater_than", value });
    case "<=":
      return typed({ field, op: "is_at_most", value });
    case ">=":
      return date && r.days !== undefined
        ? typed({ field, op: "in_the_last", value: r.days })
        : typed({ field, op: "is_at_least", value });
    default:
      return null;
  }
}

/** contains, starts with or ends with; null for a pattern no row says (`Primary%school`, `St_`, no `%` at all). */
function likeRow(field: string, raw: unknown, filter: boolean): FilterCondition | null {
  if (typeof raw !== "string") return null;
  const starts = raw.startsWith("%");
  const ends = raw.endsWith("%") && raw.length > 1;
  const text = raw.slice(starts ? 1 : 0, ends ? -1 : undefined);
  // A wildcard inside the text is a pattern no row says.
  if (/[%_]/.test(text) || (filter && !text)) return null;
  if (starts && ends) return { field, op: "contains_the_text", value: text };
  if (ends) return { field, op: "starts_with", value: text };
  if (starts) return { field, op: "ends_with", value: text };
  return null;
}

/** Two bounds of one field (`and[>=, <=]` and the like): the field, the two operators and the two raw values.
 * `exact` also wants each comparison to have exactly two args (the filter writes back only those). */
function bounds(args: unknown[], exact = true) {
  if (args.length !== 2 || !args.every(isObject)) return null;
  const [a, b] = args as JsonObject[];
  const field = fieldOf(a);
  if (!field || field !== fieldOf(b) || !Array.isArray(a.args) || !Array.isArray(b.args)) return null;
  if (exact && (a.args.length !== 2 || b.args.length !== 2)) return null;
  return { field, ops: [a.op, b.op], raws: [a.args[1], b.args[1]] };
}

/** A range of the filter's reader: between, not between, on or not on a day. */
function rangeRow(
  field: string,
  op: "is_between" | "is_not_between",
  lo: unknown,
  hi: unknown,
  r: Reader
): FilterCondition | null {
  const known = typeIn(r.fields, field);
  const type = known ?? guessType(lo);
  const value = filterValue(lo, type);
  const value2 = filterValue(hi, type);
  if (value === undefined || value2 === undefined) return null;
  return { field, op, value, value2, ...(!known && type ? { type } : {}) };
}

/** A day's range on a timestamp field (`>= day` and `< next day`), as is on or is not on. */
function dayRow(
  field: string,
  lo: unknown,
  hi: unknown,
  op: "is_on" | "is_not_on",
  r: Reader
): FilterCondition | null {
  const row = rangeRow(field, "is_between", lo, hi, r);
  if (!row || (row.type ?? typeIn(r.fields, field)) !== "datetime") return null;
  const day = typeof row.value === "string" && DAY.test(row.value) ? row.value : null;
  if (!day || row.value2 !== nextDay(day)) return null;
  return { field, op, value: day, ...(row.type ? { type: row.type } : {}) };
}

/** The rows a negation says: `not` of these reads as their opposite. */
const OPPOSITE: Partial<Record<FilterOp, FilterOp>> = {
  includes: "excludes",
  contains_the_text: "does_not_contains_the_text",
  is_blank: "is_not_blank",
};
const FILTER_OPPOSITE: Partial<Record<FilterOp, FilterOp>> = {
  ...OPPOSITE,
  is: "is_not",
  is_between: "is_not_between",
  is_on: "is_not_on",
};

/** One condition as a row, or null when no single row says it. Looks at most a few levels down, whatever the depth. */
function parse(node: unknown, r: Reader, depth: number): FilterCondition | null {
  if (depth > 3 || !isObject(node)) return null;
  const { op } = node;
  if (r.filter && op === "isNull") {
    const field = nullField(node);
    return field ? { field, op: "is_blank" } : null;
  }
  if (!Array.isArray(node.args)) return null;
  const args: unknown[] = node.args;
  if (op === "not") {
    if (r.filter && args.length !== 1) return null;
    const inner = parse(args[0], { ...r, days: undefined }, depth + 1);
    const opposite = inner && (r.filter ? FILTER_OPPOSITE : OPPOSITE)[inner.op];
    if (!inner || !opposite) return null;
    return opposite === "is_not_blank" ? { field: inner.field, op: opposite } : { ...inner, op: opposite };
  }
  if (op === "and") return r.filter ? filterAnd(args, r) : styleAnd(args);
  if (op === "or") return r.filter ? filterOr(args, r, depth) : null;
  if (r.filter && op === "between") {
    const field = fieldOf(node);
    if (!field) return null;
    if (args.length === 3) return rangeRow(field, "is_between", args[1], args[2], r);
    const pairOf = args[1];
    return args.length === 2 && Array.isArray(pairOf) && pairOf.length === 2
      ? rangeRow(field, "is_between", pairOf[0], pairOf[1], r)
      : null;
  }
  const field = fieldOf(node);
  return field ? comparisonRow(op, field, args[1], args, r) : null;
}

/** The style's range: `>=` then `<=` on one field. */
function styleAnd(args: unknown[]): FilterCondition | null {
  const b = bounds(args, false);
  if (!b || b.ops[0] !== ">=" || b.ops[1] !== "<=") return null;
  if (!scalar(b.raws[0]) || !scalar(b.raws[1])) return null;
  return { field: b.field, op: "is_between", value: b.raws[0], value2: b.raws[1] };
}

/** The filter's `and` of one field: a range, a day, "is not empty" on text, or (saved before) excludes as `!=` each. */
function filterAnd(args: unknown[], r: Reader): FilterCondition | null {
  const b = bounds(args);
  if (b) {
    const at = (op: string) => b.ops.indexOf(op);
    if (at(">=") >= 0 && at("<=") >= 0)
      return rangeRow(b.field, "is_between", b.raws[at(">=")], b.raws[at("<=")], r);
    if (at(">=") >= 0 && at("<") >= 0) return dayRow(b.field, b.raws[at(">=")], b.raws[at("<")], "is_on", r);
  }
  if (args.length === 2) {
    const [a, c] = args;
    for (const [negated, other] of [
      [a, c],
      [c, a],
    ]) {
      const blank =
        isObject(negated) && negated.op === "not" && Array.isArray(negated.args) ? negated.args : null;
      const field = blank && blank.length === 1 ? nullField(blank[0]) : null;
      const row = field ? parse(other, r, 3) : null;
      if (row && row.field === field && row.op === "is_not_blank") return { field, op: "is_not_blank" };
    }
  }
  // Saved before: excludes as `x != a and x != b`.
  const values: unknown[] = [];
  let field: string | null = null;
  for (const arg of args) {
    if (!isObject(arg) || (arg.op !== "!=" && arg.op !== "<>")) return null;
    const row = parse(arg, r, 3);
    if (!row || row.op !== "is_not" || (field !== null && row.field !== field)) return null;
    field = row.field;
    values.push(row.value);
  }
  return field === null ? null : { field, op: "excludes", value: values };
}

/** The filter's `or` of one field: a negation with the empty value, "is empty" on text, or (saved before) a value list
 * as `=` alternatives, a range left out as `<` or `>`. */
function filterOr(args: unknown[], r: Reader, depth: number): FilterCondition | null {
  const empties = args.map(nullField);
  const field = empties.find((f) => f !== null) ?? null;
  if (field !== null) {
    if (empties.some((f) => f !== null && f !== field)) return null;
    const rest = args.filter((_, i) => empties[i] === null);
    if (!rest.length) return { field, op: "is_blank" };
    const inner = rest.length === 1 ? parse(rest[0], r, depth + 1) : filterOr(rest, r, depth + 1);
    if (!inner || inner.field !== field) return null;
    // Only a negation (or the empty text) takes the empty value as its alternative; `x = a or x is null` is no row.
    if (NEGATIONS.has(inner.op) || inner.op === "is_blank") return inner;
    if (
      r.days !== undefined &&
      (inner.op === "is_before" || inner.op === "is_less_than") &&
      temporal(inner.type ?? typeIn(r.fields, field))
    )
      return { field, op: "not_in_the_last", value: r.days, ...(inner.type ? { type: inner.type } : {}) };
    return null;
  }
  const b = bounds(args);
  if (b) {
    const at = (op: string) => b.ops.indexOf(op);
    if (at("<") >= 0 && at(">") >= 0)
      return rangeRow(b.field, "is_not_between", b.raws[at("<")], b.raws[at(">")], r);
    if (at("<") >= 0 && at(">=") >= 0)
      return dayRow(b.field, b.raws[at("<")], b.raws[at(">=")], "is_not_on", r);
  }
  // Saved before: includes as `x = a or x = b`.
  const values: unknown[] = [];
  let listed: string | null = null;
  let type: FieldType | undefined;
  for (const arg of args) {
    if (!isObject(arg) || arg.op !== "=") return null;
    const row = parse(arg, r, 3);
    if (!row || row.op !== "is" || (listed !== null && row.field !== listed)) return null;
    listed = row.field;
    type = row.type;
    values.push(row.value);
  }
  return listed === null ? null : { field: listed, op: "includes", value: values, ...(type ? { type } : {}) };
}

export interface ReadOptions {
  /** False reads the style's spelling only; the filter's reader takes both and the shapes saved before. */
  orEmpty?: boolean;
  /** The row was written as "in the last N days" (the filter's notes): its date bound reads as that again. */
  days?: number;
}

/** One condition as a row, or null when no single row says it (the filter keeps it as a custom row). The filter's
 * reader also gives null for an operator the field's type does not offer. */
export function cqlToRow(node: unknown, fields: Fields, opts: ReadOptions = {}): FilterCondition | null {
  const filter = opts.orEmpty !== false;
  const row = parse(node, { fields, filter, days: filter ? opts.days : undefined }, 0);
  if (!row || !filter) return row;
  const type = typeIn(fields, row.field);
  return type && !operatorsFor(type).includes(row.op) ? null : row;
}
