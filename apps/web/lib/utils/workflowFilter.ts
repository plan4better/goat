// A dataset step's filter for the filter panel. The workflow stores it as `{op, expressions}` (FilterExpression), not
// as CQL: goatlib's `workflow_runner.convert_filter_to_cql` reads it when the workflow runs and the assistant reads
// and writes it, so that is the shape it keeps. Older steps hold CQL (`{op, args}`) and keep CQL.
//
// A stored row the panel shows as a condition reads as one; an area or a row no condition says is a custom row
// holding the CQL it filters by (for the previews) and goes back as it was stored. A row the user did not change goes
// back as it was stored too, so opening and editing one row never rewrites the others.
import { areaGeometry } from "@/lib/filter/area";
import { FILTER_OPERATORS } from "@/lib/filter/generated/operators";
import {
  type CustomRow,
  type Fields,
  type FilterCondition,
  type FilterModel,
  type FilterOp,
  type FilterRow,
  isCustomRow,
} from "@/lib/filter/model";
import { readFilter } from "@/lib/filter/read";
import { operatorsFor, rowToCql, takesValue } from "@/lib/filter/rows";
import { writeFilter } from "@/lib/filter/write";
import type { FieldType } from "@/lib/style/compile/types";
import { type JsonObject, isObject } from "@/lib/style/json";
import { type FilterExpression, FilterType } from "@/lib/validations/workflow";

/** A dataset step's filter in the shape the workflow stores. */
export type NodeFilter = { op: "and" | "or"; expressions: FilterExpression[] };

const FILTER_OPS = new Set<string>(Object.values(FILTER_OPERATORS).flat());
const RANGES = new Set<FilterOp>(["is_between", "is_not_between"]);
const LISTS = new Set<FilterOp>(["includes", "excludes"]);
const DAYS = new Set<FilterOp>(["in_the_last", "not_in_the_last"]);

const typeIn = (fields: Fields, field: string): FieldType | undefined =>
  Object.prototype.hasOwnProperty.call(fields, field) ? fields[field] : undefined;

const scalar = (value: unknown): value is string | number | boolean =>
  ["string", "number", "boolean"].includes(typeof value);

/** A picked date as the filter's rows take it. The picker gave a wall time read as UTC: on a date field the day, the
 * start of a day as the day, another moment in UTC. */
const filterDate = (value: string, fieldType?: FieldType): string => {
  if (fieldType === "date" || /T00:00(:00)?$/.test(value)) return value.slice(0, 10);
  return /T\d{2}:\d{2}(:\d{2})?$/.test(value) ? `${value}Z` : value;
};

/** A picked moment as the filter's rows hold it (`2024-01-01T10:30:00Z`, a day's start as the day); other values as
 * they are. The old panel stored the picker's wall time without its zone mark. */
const rowValue = (value: unknown, type: FieldType | undefined): unknown =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)
    ? filterDate(value, type)
    : value;

/** A range stored before as `low-high` text. */
const LEGACY_RANGE = /^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*$/;

/** A stored logical row as the panel's condition, or null when no condition says it the same. */
function expressionCondition(expression: Record<string, unknown>, fields: Fields): FilterCondition | null {
  const { attribute: field, expression: op, value } = expression;
  if (expression.type === FilterType.Spatial || typeof field !== "string" || !field || typeof op !== "string")
    return null;
  // The assistant writes "is true" as `is` with true.
  if (op === "is" && typeof value === "boolean") return { field, op: value ? "is_true" : "is_false" };
  if (!FILTER_OPS.has(op)) return null;
  const filterOp = op as FilterOp;
  const type = typeIn(fields, field);
  if (type && !operatorsFor(type).includes(filterOp)) return null;
  if (!takesValue(filterOp)) return { field, op: filterOp };
  if (RANGES.has(filterOp)) {
    if (Array.isArray(value) && value.length === 2 && value.every(scalar))
      return { field, op: filterOp, value: rowValue(value[0], type), value2: rowValue(value[1], type) };
    const legacy = typeof value === "string" ? LEGACY_RANGE.exec(value) : null;
    return legacy ? { field, op: filterOp, value: Number(legacy[1]), value2: Number(legacy[2]) } : null;
  }
  if (LISTS.has(filterOp))
    return Array.isArray(value) && value.length && value.every(scalar)
      ? { field, op: filterOp, value }
      : null;
  if (DAYS.has(filterOp)) {
    const days = Number(value);
    return Number.isInteger(days) && days > 0 ? { field, op: filterOp, value: days } : null;
  }
  return scalar(value) ? { field, op: filterOp, value: rowValue(value, type) } : null;
}

/** The CQL a stored row the panel shows as custom filters by, as the workflow runner writes it; null when there is
 * none. */
function expressionCql(expression: Record<string, unknown>): unknown {
  const property = { property: typeof expression.attribute === "string" ? expression.attribute : "geom" };
  if (expression.expression === "s_intersects") {
    const { value } = expression;
    try {
      const geometry: unknown = typeof value === "string" ? JSON.parse(value) : value;
      return isObject(geometry) ? { op: "s_intersects", args: [property, geometry] } : null;
    } catch {
      return null;
    }
  }
  if (expression.expression === "is_empty_string") return { op: "=", args: [property, ""] };
  if (expression.expression === "is_not_empty_string") return { op: "<>", args: [property, ""] };
  return null;
}

const expressionsOf = (filter: unknown): Record<string, unknown>[] | null =>
  isObject(filter) && Array.isArray(filter.expressions) ? filter.expressions.filter(isObject) : null;

/** A stored row's id: its own, or for a row stored without one its position. */
const expressionId = (expression: Record<string, unknown>, at: number) =>
  typeof expression.id === "string" && expression.id ? expression.id : `e${at}`;

/** A filter stored as CQL (older steps): `args` and no `expressions`. */
const storedAsCql = (filter: unknown): filter is JsonObject =>
  isObject(filter) && Array.isArray(filter.args) && !Array.isArray(filter.expressions);

/** The stored filter as the panel's rows. A row's id is its stored id. */
export function nodeFilterModel(filter: unknown, fields: Fields): FilterModel {
  if (storedAsCql(filter)) return readFilter(filter, undefined, fields);
  const expressions = expressionsOf(filter);
  if (!expressions) return { match: "all", rows: [] };
  const match = isObject(filter) && filter.op === "or" ? "any" : "all";
  const rows = expressions.map((expression, at): FilterRow | CustomRow => {
    const id = expressionId(expression, at);
    const condition = expressionCondition(expression, fields);
    return condition
      ? { id, ...condition, enabled: true }
      : { id, cql: expressionCql(expression), enabled: true };
  });
  return { match, rows };
}

/** A row as the stored row the workflow runner reads, or null while it is unfinished. */
function rowExpression(row: FilterRow, fields: Fields): FilterExpression | null {
  const type = typeIn(fields, row.field) ?? row.type;
  if (rowToCql(row, type, { orEmpty: true }) === null) return null;
  const expression = (value: FilterExpression["value"]): FilterExpression => ({
    id: row.id,
    type: FilterType.Logical,
    attribute: row.field,
    expression: row.op,
    value,
  });
  if (!takesValue(row.op)) return expression("");
  if (RANGES.has(row.op)) return expression([row.value, row.value2] as [string | number, string | number]);
  return expression(row.value as FilterExpression["value"]);
}

/** A row compared by what it filters, without its id and switch. */
const conditionKey = (row: FilterCondition) =>
  JSON.stringify([row.field, row.op, row.value ?? null, row.value2 ?? null]);

/** The rows as the step's filter in the shape it was stored in (rows of the old panel for a step without one), or
 * undefined for no row. A row switched off or unfinished is left out: the stored rows have no switch, and the runner
 * applies every row it is given. */
export function nodeFilterFrom(
  model: FilterModel,
  stored: unknown,
  fields: Fields
): NodeFilter | JsonObject | undefined {
  const active = model.rows.filter((row) => row.enabled);
  if (storedAsCql(stored)) return writeFilter({ ...model, rows: active }, fields).cql;
  const originals = new Map((expressionsOf(stored) ?? []).map((e, at) => [expressionId(e, at), e]));
  const expressions: FilterExpression[] = [];
  for (const row of active) {
    const original = originals.get(row.id);
    if (isCustomRow(row)) {
      if (original) expressions.push(original as FilterExpression);
      continue;
    }
    const read = original ? expressionCondition(original, fields) : null;
    if (original && read && conditionKey(read) === conditionKey(row)) {
      expressions.push(original as FilterExpression);
      continue;
    }
    const written = rowExpression(row, fields);
    if (written) expressions.push(written);
  }
  return expressions.length ? { op: model.match === "any" ? "or" : "and", expressions } : undefined;
}

/** Whether the step filters at all: by a row, or by the area an older step's CQL holds. */
export function nodeHasFilter(filter: unknown): boolean {
  const model = nodeFilterModel(filter, {});
  return model.rows.length > 0 || !!model.area;
}

/** The CQL the step's filter filters by, for its previews (feature count, table, map); undefined for none. */
export function nodeFilterCql(filter: unknown, fields: Fields): JsonObject | undefined {
  return writeFilter(nodeFilterModel(filter, fields), fields).cql;
}

/** A project layer's filter copied onto a dataset step (its active rows; the layer's notes stay with the layer): the
 * conditions and areas as the step's stored rows. A part no stored row says is left out: a nested group, an outside
 * area, and beside an area the alternatives of "match any" (the stored rows are all or any, never both). */
export function inheritedNodeFilter(cql: unknown): NodeFilter | undefined {
  const model = readFilter(cql, undefined, {});
  const rows = model.rows.flatMap((row): FilterExpression[] => {
    if (!isCustomRow(row)) return [rowExpression(row, {})].filter((e): e is FilterExpression => !!e);
    const area = row.cql;
    if (!isObject(area) || area.op !== "s_intersects" || !Array.isArray(area.args)) return [];
    const [geometry, shape] = area.args;
    if (!isObject(geometry) || typeof geometry.property !== "string" || !isObject(shape)) return [];
    return [
      {
        id: row.id,
        type: FilterType.Spatial,
        attribute: geometry.property,
        expression: "s_intersects",
        value: JSON.stringify(shape),
      },
    ];
  });
  const { area } = model;
  const geometry = area?.enabled && area.op === "inside" ? areaGeometry(area) : null;
  if (!area || !geometry) {
    return rows.length ? { op: model.match === "any" ? "or" : "and", expressions: rows } : undefined;
  }
  const inside: FilterExpression = {
    id: "area",
    type: FilterType.Spatial,
    attribute: area.property ?? "geom",
    expression: "s_intersects",
    value: JSON.stringify(geometry),
  };
  return { op: "and", expressions: [inside, ...(model.match === "any" && rows.length > 1 ? [] : rows)] };
}
