// Rule conditions (spec 6) as builder rows: a field, an operator and a value, all or any of them. The operator names
// are today's filter operators (their `filter_expressions` labels); the CQL2 they write is spec 6's: `<>` for "is
// not", `isNull` with a list of args, `like` only as contains, starts with and ends with. One row to CQL2 and back is
// lib/filter/rows.ts, in the style's spelling (`orEmpty: false`).
import type { TFunction } from "i18next";

import type { ConditionOp, FilterCondition } from "@/lib/filter/model";
import { cqlToRow, takesValue as filterTakesValue, rowToCql } from "@/lib/filter/rows";
import type { FieldType } from "@/lib/style/compile/types";
import { type JsonObject, isObject } from "@/lib/style/json";

export type { ConditionOp } from "@/lib/filter/model";

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

/** Rows to write: a rule's own, or the rows of the filter panel's draft the rule's editor keeps (with ids). */
interface RowsToWrite {
  match: ConditionRows["match"];
  rows: readonly FilterCondition[];
}

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
export const takesValue = (op: ConditionOp) => filterTakesValue(op);

const writeRow = (row: FilterCondition, fields: Fields) =>
  rowToCql(row, fields[row.field], { orEmpty: false });

/** The rows as a rule's `when`, or null while a row is unfinished. */
export function fromRows(rows: RowsToWrite, fields: Fields): JsonObject | null {
  const parts = rows.rows.map((row) => writeRow(row, fields));
  if (!parts.length || parts.some((part) => part === null)) return null;
  if (parts.length === 1) return parts[0];
  return { op: rows.match === "all" ? "and" : "or", args: parts as JsonObject[] };
}

/** The complete rows as a rule's `when`, or null while none is: a row being written stays out until it reads, as
 * an unfinished row of the filter panel saves nothing. */
export const writtenWhen = (rows: RowsToWrite, fields: Fields): JsonObject | null =>
  fromRows({ match: rows.match, rows: rows.rows.filter((row) => writeRow(row, fields) !== null) }, fields);

/** One condition as a row, or null when no single row says it. */
const parseRow = (node: unknown, fields: Fields) =>
  cqlToRow(node, fields, { orEmpty: false }) as ConditionRow | null;

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
