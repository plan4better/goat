// The layer filter as the panel edits it: rows of one condition each, matched all or any, and one area the features
// have to be in (area.ts). The saved CQL2 in `query.cql` is the whole truth; read.ts turns it into this model and
// write.ts back. A condition no row says stays a custom row holding its CQL as it was saved.
import type { FilterArea } from "@/lib/filter/area";
import type { FieldType } from "@/lib/style/compile/types";

/** The operators of a style rule's condition (their `filter_expressions` labels). */
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

/** The filter's operators: the style's and the ones only a filter has (relative dates are counted back from the day the
 * filter is read on). */
export type FilterOp =
  | ConditionOp
  | "is_not_between"
  | "is_on"
  | "is_not_on"
  | "in_the_last"
  | "not_in_the_last";

/** The layer's fields by name with their types. */
export type Fields = Record<string, FieldType>;

/** One condition: a field, an operator and its values. `in_the_last` and `not_in_the_last` take a number of days. */
export interface FilterCondition {
  field: string;
  op: FilterOp;
  value?: unknown;
  value2?: unknown;
  /** The field's type as the saved value showed it, for a field the layer no longer has. */
  type?: FieldType;
}

export interface FilterRow extends FilterCondition {
  id: string;
  enabled: boolean;
}

/** A condition no row says (a nested group, a function, a second area): its CQL as it was saved, never rewritten. */
export interface CustomRow {
  id: string;
  cql: unknown;
  enabled: boolean;
}

export interface FilterModel {
  match: "all" | "any";
  rows: Array<FilterRow | CustomRow>;
  /** Where the features have to be, next to the rows; the match does not count for it. */
  area?: FilterArea;
}

export const isCustomRow = (row: FilterRow | CustomRow): row is CustomRow => "cql" in row;

/** The model with `row` in place of the row with its id (which keeps its place and whether it is on), or appended. */
export const upsertRow = (model: FilterModel, row: FilterRow): FilterModel => {
  const at = model.rows.findIndex((r) => r.id === row.id);
  if (at < 0) return { ...model, rows: [...model.rows, row] };
  const enabled = model.rows[at].enabled;
  return { ...model, rows: model.rows.map((r, i) => (i === at ? { ...row, enabled } : r)) };
};

/** The model without the row with this id. */
export const removeRow = (model: FilterModel, id: string): FilterModel => ({
  ...model,
  rows: model.rows.filter((r) => r.id !== id),
});
