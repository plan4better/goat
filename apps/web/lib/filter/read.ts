// A saved filter (`query.cql` with its notes `query.ui`) as the panel's rows and area. The top level is the match:
// `and` is all, `or` any; each of its args is one row, or a custom row holding the arg as it was when no row says it. A
// top level of another kind is one row. The area stands beside the rows under `and` (or alone); with it, the rows that
// match any are one `or` group. Reading never throws: anything it cannot read is a custom row.
import { type FilterArea, isAreaNode, readArea } from "@/lib/filter/area";
import type { CustomRow, Fields, FilterCondition, FilterModel, FilterRow } from "@/lib/filter/model";
import { readNotes } from "@/lib/filter/notes";
import { cqlToRow } from "@/lib/filter/rows";
import { isObject } from "@/lib/style/json";

/** The top level's args with the match, or the top level as the only arg. */
function topLevel(cql: unknown): { match: FilterModel["match"]; args: unknown[] } {
  if (isObject(cql) && (cql.op === "and" || cql.op === "or") && Array.isArray(cql.args))
    return { match: cql.op === "and" ? "all" : "any", args: cql.args };
  // No filter: nothing saved, or the empty object older panels saved. Anything else is kept, also what is no CQL.
  const none = cql === undefined || cql === null || (isObject(cql) && !Object.keys(cql).length);
  return { match: "all", args: none ? [] : [cql] };
}

/** The row a node says, or null when none does. */
function rowOf(node: unknown, fields: Fields, days?: number): FilterCondition | null {
  try {
    return cqlToRow(node, fields, { days });
  } catch {
    // Nothing in the reader should throw; a node that makes it anyway is kept as it is.
    return null;
  }
}

/** The filter's rows and area: the active rows from the CQL, the switched-off ones from the notes at their positions.
 * Row ids are `r` and the row's position. */
export function readFilter(cql: unknown, notes: unknown, fields: Fields): FilterModel {
  const noted = readNotes(notes);
  let { match, args } = topLevel(cql);
  let area: FilterArea | undefined;
  // An area that is one of several alternatives is no area of the filter: it stays a row.
  const at = match === "all" || args.length === 1 ? args.findIndex(isAreaNode) : -1;
  if (at >= 0) {
    area = readArea(args[at], noted.area, true);
    args = args.filter((_, i) => i !== at);
    const group = args.length === 1 ? args[0] : undefined;
    // One group of alternatives beside the area is the rows matching any, unless a single row says the group (a value
    // list) and no note tells otherwise.
    if (
      isObject(group) &&
      group.op === "or" &&
      Array.isArray(group.args) &&
      (noted.any || !rowOf(group, fields))
    ) {
      match = "any";
      args = group.args;
    } else {
      match = !args.length && noted.any ? "any" : "all";
    }
  } else {
    if (noted.area?.off) area = readArea(noted.area.off, noted.area, false);
    if (!args.length && noted.any) match = "any";
  }
  const { off = [], relative = [] } = noted;
  const slots = args.map((node) => ({ node, enabled: true }));
  for (const entry of [...off].sort((a, b) => a.at - b.at))
    slots.splice(Math.min(entry.at, slots.length), 0, { node: entry.cql, enabled: false });
  const rows = slots.map(({ node, enabled }, at): FilterRow | CustomRow => {
    const id = `r${at}`;
    const row = rowOf(node, fields, relative.find((r) => r.at === at)?.days);
    return row ? { id, ...row, enabled } : { id, cql: node, enabled };
  });
  return { match, rows, ...(area && { area }) };
}

/** How many parts of a saved filter filter: its conditions, and its area as one more. */
export function activeParts(cql: unknown): number {
  const model = readFilter(cql, undefined, {});
  return model.rows.length + (model.area ? 1 : 0);
}
