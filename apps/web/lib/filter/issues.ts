// What the panel says about a filter before it is saved, with the codes of goatlib's checker (goatlib/filter/issues.py):
// a row on a field the layer no longer has, a value that does not fit its field, and the limits on conditions, values,
// shapes, an area's points and the filter's length. The server checks the same on save; these let the panel mark the
// row at once.
import { FILTER_LIMITS } from "@/lib/filter/generated/operators";
import { type Fields, type FilterModel, type FilterRow, isCustomRow } from "@/lib/filter/model";
import { takesValue } from "@/lib/filter/rows";
import { overLimits } from "@/lib/filter/write";
import type { FieldType } from "@/lib/style/compile/types";

export type FilterIssueCode =
  | "unknown_field"
  | "field_type_mismatch"
  | "too_many_conditions"
  | "too_many_values"
  | "too_many_shapes"
  | "area_too_detailed"
  | "too_long";

/** One issue: its code and what its message names. */
export interface FilterIssue {
  code: FilterIssueCode;
  field?: string;
  type?: FieldType;
  limit?: number;
}

/** The issues of a filter: per row id, and those of the whole filter. */
export interface FilterIssues {
  rows: Record<string, FilterIssue[]>;
  filter: FilterIssue[];
}

export const NO_ISSUES: FilterIssues = { rows: {}, filter: [] };

/** The field's type, by its name or (as the server looks it up) its name in another case. */
function typeOf(fields: Fields, field: string): FieldType | undefined {
  if (Object.prototype.hasOwnProperty.call(fields, field)) return fields[field];
  const lower = field.toLowerCase();
  const match = Object.keys(fields).find((name) => name.toLowerCase() === lower);
  return match === undefined ? undefined : fields[match];
}

const numericText = (v: string) => v.trim() !== "" && Number.isFinite(Number(v));

/** Whether a value fits a field of `type` (goatlib's `_fits`). */
function fits(type: FieldType, v: unknown): boolean {
  switch (type) {
    case "string":
      return typeof v === "string";
    case "number":
    case "integer":
      return (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && numericText(v));
    case "boolean":
      return typeof v === "boolean";
    default:
      return typeof v === "string";
  }
}

/** The values a row compares with, left out where it has none yet. */
function valuesOf(row: FilterRow): unknown[] {
  if (!takesValue(row.op) || row.op === "in_the_last" || row.op === "not_in_the_last") return [];
  const given = (v: unknown) => v !== undefined && v !== null && v !== "";
  if (row.op === "includes" || row.op === "excludes")
    return Array.isArray(row.value) ? row.value.filter(given) : [];
  return [row.value, row.value2].filter(given);
}

/** One row's issues; a row without a field yet has none. */
export function rowIssues(row: FilterRow, fields: Fields): FilterIssue[] {
  if (!row.field) return [];
  const type = typeOf(fields, row.field);
  if (!type) return [{ code: "unknown_field", field: row.field }];
  const issues: FilterIssue[] = [];
  if (valuesOf(row).some((v) => !fits(type, v)))
    issues.push({ code: "field_type_mismatch", field: row.field, type });
  if (overLimits({ match: "all", rows: [row] }, fields).includes("values"))
    issues.push({ code: "too_many_values", limit: FILTER_LIMITS.values });
  return issues;
}

/** The filter's issues: each row's by its id (rows without any left out), and the limits the whole filter is over. */
export function filterIssues(model: FilterModel, fields: Fields): FilterIssues {
  const rows: FilterIssues["rows"] = {};
  for (const row of model.rows) {
    if (isCustomRow(row)) continue;
    const found = rowIssues(row, fields);
    if (found.length) rows[row.id] = found;
  }
  const over = overLimits(model, fields);
  const filter: FilterIssue[] = [];
  if (over.includes("conditions"))
    filter.push({ code: "too_many_conditions", limit: FILTER_LIMITS.conditions });
  if (over.includes("shapes")) filter.push({ code: "too_many_shapes", limit: FILTER_LIMITS.shapes });
  if (over.includes("points")) filter.push({ code: "area_too_detailed", limit: FILTER_LIMITS.points });
  if (over.includes("length")) filter.push({ code: "too_long", limit: FILTER_LIMITS.length });
  return { rows, filter };
}
