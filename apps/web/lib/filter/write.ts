// The panel's rows and area as the saved filter: `query.cql` holds the active rows under one `and` or `or` (also a
// single row), `query.ui` the notes (switched-off rows, relative dates, the area's pieces). Unfinished rows are left
// out; custom rows go back as they were read, at their place. An active area comes first under `and`; rows that match
// any stand beside it as one `or` group, also a single row, so the group always reads back as the rows.
import { areaCql, areaNotes, areaPolygons, pointCount } from "@/lib/filter/area";
import { FILTER_LIMITS } from "@/lib/filter/generated/operators";
import { shapePoints, urlLength } from "@/lib/filter/limits";
import { type Fields, type FilterModel, type FilterRow, isCustomRow } from "@/lib/filter/model";
import type { FilterNotes } from "@/lib/filter/notes";
import { rowToCql } from "@/lib/filter/rows";
import type { JsonObject } from "@/lib/style/json";

/** The CQL a row saves, or undefined when it saves nothing (unfinished). */
function rowCql(row: FilterModel["rows"][number], fields: Fields, now: Date | undefined): unknown {
  if (isCustomRow(row)) return row.cql ?? undefined;
  const type = Object.prototype.hasOwnProperty.call(fields, row.field) ? fields[row.field] : row.type;
  return rowToCql(row, type, { orEmpty: true, now }) ?? undefined;
}

/** The filter to save: no `cql` without an active row or area, no `ui` with nothing to note. `now` is the moment relative
 * dates count back from (now when left out). */
export function writeFilter(
  model: FilterModel,
  fields: Fields,
  opts: { now?: Date } = {}
): { cql?: JsonObject; ui?: FilterNotes } {
  const active: unknown[] = [];
  const off: NonNullable<FilterNotes["off"]> = [];
  const relative: NonNullable<FilterNotes["relative"]> = [];
  for (const row of model.rows) {
    const cql = rowCql(row, fields, opts.now);
    if (cql === undefined) continue;
    // Positions count the rows saved, so a row left out does not move the others.
    const at = active.length + off.length;
    if (row.enabled) active.push(cql);
    else off.push({ at, cql });
    if (!isCustomRow(row) && (row.op === "in_the_last" || row.op === "not_in_the_last"))
      relative.push({ at, days: Number(row.value) });
  }
  const area = model.area ? areaCql(model.area) : undefined;
  const on = model.area?.enabled ? area : undefined;
  const any = model.match === "any";
  let cql: JsonObject | undefined;
  if (on) cql = { op: "and", args: [on, ...(any && active.length ? [{ op: "or", args: active }] : active)] };
  else if (active.length) cql = { op: any ? "or" : "and", args: active };
  const ui: FilterNotes = { v: 1 };
  if (off.length) ui.off = off;
  if (relative.length) ui.relative = relative;
  // A switched-off area is in the notes only, as it would be written.
  if (model.area && area) ui.area = { ...areaNotes(model.area), ...(!model.area.enabled && { off: area }) };
  // The top level is no `or` beside an area or without an active row: the notes keep the match for the rows there are.
  if (any && (on || !active.length) && active.length + off.length) ui.any = true;
  return { cql, ui: Object.keys(ui).length > 1 ? ui : undefined };
}

/** The values one row holds against the limit: a value list's length (text split at commas), else one. */
const valueCount = (row: FilterRow) => {
  if (row.op !== "includes" && row.op !== "excludes") return 1;
  if (Array.isArray(row.value)) return row.value.length;
  return typeof row.value === "string" ? row.value.split(",").filter((v) => v.trim()).length : 1;
};

export type OverLimit = "conditions" | "values" | "shapes" | "points" | "length";

/** The limits the saved filter would be over; empty when it is within them. Counts what is saved as active: a
 * switched-off or unfinished row does not count, a custom row counts once. The area is a shape, as is every geometry a
 * custom row holds; an area with too many points counts also while it is switched off (it is saved in the notes). The
 * length is that of the filter a map request carries. */
export function overLimits(model: FilterModel, fields: Fields = {}): OverLimit[] {
  const saved = model.rows.filter((row) => row.enabled && rowCql(row, fields, undefined) !== undefined);
  const over: OverLimit[] = [];
  if (saved.length > FILTER_LIMITS.conditions) over.push("conditions");
  const values = saved.map((row) => (isCustomRow(row) ? 0 : valueCount(row)));
  if (Math.max(0, ...values) > FILTER_LIMITS.values) over.push("values");
  const shapes = saved.flatMap((row) => (isCustomRow(row) ? shapePoints(row.cql) : []));
  const areaPoints = model.area ? pointCount(areaPolygons(model.area)) : 0;
  if (model.area?.enabled && areaPoints) shapes.push(areaPoints);
  if (shapes.length > FILTER_LIMITS.shapes) over.push("shapes");
  if (Math.max(areaPoints, ...shapes) > FILTER_LIMITS.points) over.push("points");
  if (urlLength(writeFilter(model, fields).cql) > FILTER_LIMITS.length) over.push("length");
  return over;
}
