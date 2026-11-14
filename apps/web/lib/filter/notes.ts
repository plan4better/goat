// The filter's notes (`query.ui`): what only the panel needs and the CQL cannot say. Switched-off rows with their
// position, which rows were written as "in the last N days", the area's pieces (and the area itself while it is
// switched off), and "match any" where the CQL's top level cannot be `or`. Deleting the notes never changes which
// features pass; anything malformed in them is ignored.
import { type AreaNotes, readAreaNotes } from "@/lib/filter/area";
import { isObject } from "@/lib/style/json";

export interface FilterNotes {
  v: 1;
  /** Switched-off rows: their CQL and their position among all rows. */
  off?: Array<{ at: number; cql: unknown }>;
  /** Rows written as "in the last N days" (or not): the date was frozen when the filter was saved. */
  relative?: Array<{ at: number; days: number }>;
  /** The area's pieces, and a switched-off area's CQL. */
  area?: AreaNotes;
  /** The rows match any, where the CQL does not say it: beside an area, or with no active row. */
  any?: true;
}

const position = (at: unknown): at is number => typeof at === "number" && Number.isInteger(at) && at >= 0;

/** The notes as far as they are well formed: a block of another version, or an entry with a wrong shape, is left out. */
export function readNotes(ui: unknown): FilterNotes {
  const notes: FilterNotes = { v: 1 };
  if (!isObject(ui) || ui.v !== 1) return notes;
  if (Array.isArray(ui.off)) {
    const off = ui.off.filter(
      (entry): entry is { at: number; cql: unknown } =>
        isObject(entry) && position(entry.at) && entry.cql !== undefined && entry.cql !== null
    );
    if (off.length) notes.off = off.map(({ at, cql }) => ({ at, cql }));
  }
  if (Array.isArray(ui.relative)) {
    const relative = ui.relative.filter(
      (entry): entry is { at: number; days: number } =>
        isObject(entry) && position(entry.at) && position(entry.days) && entry.days > 0
    );
    if (relative.length) notes.relative = relative.map(({ at, days }) => ({ at, days }));
  }
  const area = readAreaNotes(ui.area);
  if (area) notes.area = area;
  if (ui.any === true) notes.any = true;
  return notes;
}
