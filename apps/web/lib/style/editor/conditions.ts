// Rule conditions (spec 6) as builder rows: a field, an operator and a value, all or any of them. The operator names
// are today's filter operators (their `filter_expressions` labels); the CQL2 they write is spec 6's: `<>` for "is
// not", `isNull` with a list of args, `like` only as contains, starts with and ends with.
import type { TFunction } from "i18next";

import type { FieldType } from "@/lib/style/compile/types";
import { type JsonObject, isObject } from "@/lib/style/json";

export type ConditionOp =
  | "is"
  | "is_not"
  | "includes"
  | "excludes"
  | "is_blank"
  | "is_not_blank"
  | "is_less_than"
  | "is_greater_than"
  | "is_at_most"
  | "is_at_least"
  | "is_between"
  | "contains_the_text"
  | "does_not_contains_the_text"
  | "starts_with"
  | "ends_with"
  | "is_true"
  | "is_false"
  | "is_before"
  | "is_after";

export interface ConditionRow {
  field: string;
  op: ConditionOp;
  value?: unknown;
  value2?: unknown;
}

export interface ConditionRows {
  match: "all" | "any";
  rows: ConditionRow[];
}

type Fields = Record<string, FieldType>;

const BLANKS: ConditionOp[] = ["is_blank", "is_not_blank"];

/** The operators a field of `type` offers (no relative dates: a style does not change with the day). */
export function operatorsFor(type: FieldType | undefined): ConditionOp[] {
  if (type === "boolean") return ["is_true", "is_false", ...BLANKS];
  if (type === "number" || type === "integer")
    return [
      "is",
      "is_not",
      "includes",
      "excludes",
      "is_less_than",
      "is_greater_than",
      "is_at_most",
      "is_at_least",
      "is_between",
      ...BLANKS,
    ];
  if (type === "string")
    return [
      "is",
      "is_not",
      "includes",
      "excludes",
      "contains_the_text",
      "does_not_contains_the_text",
      "starts_with",
      "ends_with",
      ...BLANKS,
    ];
  if (type === "date" || type === "datetime")
    return ["is", "is_not", "is_before", "is_after", "is_between", ...BLANKS];
  return ["is", "is_not", ...BLANKS];
}

/** Whether the operator takes a value (and a second one). */
export const takesValue = (op: ConditionOp) =>
  !["is_blank", "is_not_blank", "is_true", "is_false"].includes(op);

const numeric = (type: FieldType | undefined) => type === "number" || type === "integer";

/** A typed literal for the field, or null while it is not one yet. */
function literal(value: unknown, type: FieldType | undefined): string | number | null {
  if (value === undefined || value === null || value === "") return null;
  if (numeric(type)) {
    const n = typeof value === "number" ? value : Number(String(value).trim());
    return Number.isFinite(n) ? n : null;
  }
  return String(value);
}

const list = (value: unknown): unknown[] =>
  Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean)
      : [];

const prop = (field: string) => ({ property: field });
const not = (inner: JsonObject): JsonObject => ({ op: "not", args: [inner] });

/** One row as CQL2, or null while it is unfinished (no value, a value of the wrong type, `%` or `_` in a text). */
function rowToCql(row: ConditionRow, fields: Fields): JsonObject | null {
  const type = fields[row.field];
  const p = prop(row.field);
  const compare = (op: string): JsonObject | null => {
    const v = literal(row.value, type);
    return v === null ? null : { op, args: [p, v] };
  };
  const like = (pattern: (text: string) => string): JsonObject | null => {
    const text = literal(row.value, "string");
    return text === null || /[%_]/.test(String(text))
      ? null
      : { op: "like", args: [p, pattern(String(text))] };
  };
  switch (row.op) {
    case "is":
      return compare("=");
    case "is_not":
      return compare("<>");
    case "includes":
    case "excludes": {
      const values = list(row.value).map((v) => literal(v, type));
      if (!values.length || values.some((v) => v === null)) return null;
      const inside: JsonObject = { op: "in", args: [p, values] };
      return row.op === "includes" ? inside : not(inside);
    }
    case "is_blank":
      return { op: "isNull", args: [p] };
    case "is_not_blank":
      return not({ op: "isNull", args: [p] });
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
      const a = literal(row.value, type);
      const b = literal(row.value2, type);
      return a === null || b === null
        ? null
        : {
            op: "and",
            args: [
              { op: ">=", args: [p, a] },
              { op: "<=", args: [p, b] },
            ],
          };
    }
    case "contains_the_text":
      return like((x) => `%${x}%`);
    case "does_not_contains_the_text": {
      const inner = like((x) => `%${x}%`);
      return inner && not(inner);
    }
    case "starts_with":
      return like((x) => `${x}%`);
    case "ends_with":
      return like((x) => `%${x}`);
    case "is_true":
      return { op: "=", args: [p, true] };
    case "is_false":
      return { op: "=", args: [p, false] };
  }
}

/** The rows as a rule's `when`, or null while a row is unfinished. */
export function fromRows(rows: ConditionRows, fields: Fields): JsonObject | null {
  const parts = rows.rows.map((row) => rowToCql(row, fields));
  if (!parts.length || parts.some((part) => part === null)) return null;
  if (parts.length === 1) return parts[0];
  return { op: rows.match === "all" ? "and" : "or", args: parts as JsonObject[] };
}

const fieldOf = (node: JsonObject): string | null => {
  const first = Array.isArray(node.args) ? node.args[0] : undefined;
  return isObject(first) && typeof first.property === "string" ? first.property : null;
};

/** A value a row's box shows as it is: text, a number, true or false. A date object or another field is not. */
const scalar = (value: unknown) => value === null || ["string", "number", "boolean"].includes(typeof value);

/** One condition as a row, or null when no single row says it. */
function parseRow(node: unknown, fields: Fields): ConditionRow | null {
  if (!isObject(node) || !Array.isArray(node.args)) return null;
  const { op, args } = node;
  if (op === "not") {
    const inner = isObject(args[0]) ? args[0] : null;
    const row = inner ? parseRow(inner, fields) : null;
    if (!row) return null;
    if (row.op === "includes") return { ...row, op: "excludes" };
    if (row.op === "contains_the_text") return { ...row, op: "does_not_contains_the_text" };
    if (row.op === "is_blank") return { field: row.field, op: "is_not_blank" };
    return null;
  }
  if (op === "and") {
    const [low, high] = args.map((a) => (isObject(a) ? a : null));
    const field = low && fieldOf(low);
    if (args.length !== 2 || !low || !high || !field || field !== fieldOf(high)) return null;
    if (low.op !== ">=" || high.op !== "<=") return null;
    const from = Array.isArray(low.args) ? low.args[1] : undefined;
    const to = Array.isArray(high.args) ? high.args[1] : undefined;
    if (!scalar(from) || !scalar(to)) return null;
    return { field, op: "is_between", value: from, value2: to };
  }
  const field = fieldOf(node);
  if (!field) return null;
  const value = args[1];
  if (op === "in" ? !Array.isArray(value) || !value.every(scalar) : op !== "isNull" && !scalar(value))
    return null;
  const type = fields[field];
  const date = type === "date" || type === "datetime";
  switch (op) {
    case "isNull":
      return { field, op: "is_blank" };
    case "=":
      if (value === true) return { field, op: "is_true" };
      if (value === false) return { field, op: "is_false" };
      return { field, op: "is", value };
    case "<>":
      return { field, op: "is_not", value };
    case "<":
      return { field, op: date ? "is_before" : "is_less_than", value };
    case ">":
      return { field, op: date ? "is_after" : "is_greater_than", value };
    case "<=":
      return { field, op: "is_at_most", value };
    case ">=":
      return { field, op: "is_at_least", value };
    case "in":
      return Array.isArray(value) ? { field, op: "includes", value } : null;
    case "like": {
      if (typeof value !== "string") return null;
      const starts = value.startsWith("%");
      const ends = value.endsWith("%") && value.length > 1;
      const text = value.slice(starts ? 1 : 0, ends ? -1 : undefined);
      // A wildcard inside the text (`Primary%school`, `St_`) is a pattern no row says.
      if (/[%_]/.test(text)) return null;
      if (starts && ends) return { field, op: "contains_the_text", value: text };
      if (ends) return { field, op: "starts_with", value: text };
      if (starts) return { field, op: "ends_with", value: text };
      return null;
    }
    default:
      return null;
  }
}

/** A rule's `when` as rows: one condition, or all or any of single conditions; null for anything deeper. */
export function toRows(when: unknown, fields: Fields): ConditionRows | null {
  const single = parseRow(when, fields);
  if (single) return { match: "all", rows: [single] };
  if (!isObject(when) || (when.op !== "and" && when.op !== "or") || !Array.isArray(when.args)) return null;
  const rows = when.args.map((arg) => parseRow(arg, fields));
  if (!rows.length || rows.some((row) => row === null)) return null;
  return { match: when.op === "and" ? "all" : "any", rows: rows as ConditionRow[] };
}

/** "Traffic is less than 1500", rows joined by "and" / "or"; a condition the rows cannot show says so. */
export function conditionSentence(
  when: unknown,
  fieldLabel: (name: string) => string,
  t: TFunction,
  fields: Fields
): string {
  const rows = toRows(when, fields);
  if (!rows) return t("style_editor.condition_custom");
  const text = (row: ConditionRow) => {
    const words = [fieldLabel(row.field), t(`filter_expressions.${row.op}`).toLowerCase()];
    if (row.op === "is_between") words.push(`${row.value} ${t("style_editor.range_to")} ${row.value2}`);
    else if (takesValue(row.op))
      words.push(Array.isArray(row.value) ? row.value.join(", ") : String(row.value));
    return words.join(" ");
  };
  return rows.rows.map(text).join(` ${t(rows.match === "all" ? "style_editor.and" : "style_editor.or")} `);
}
