/**
 * The stop edits (01-editing-operations § 2), each from its draft to the
 * snapshot rows it changes and the bundle rows it saves.
 *
 * 2.4 Edit stop attributes: a stop's GTFS fields, its station among them,
 * on the stop alone (its location type is set when it is made); checked by GTFS's rules
 * (`stopRules.ts`), each on its field, so Apply waits without a word.
 */
import type { SqlRunner } from "@/lib/explorer/db/types";
import type { LocationType, StopValues, Wheelchair } from "@/lib/explorer/edit/drafts";
import {
  STOP_VALUE_KEYS,
  type StopField,
  cleanStopValues,
  parentTypeFor,
  stopFieldProblems,
} from "@/lib/explorer/edit/ops/stopRules";
import type { Built, Check } from "@/lib/explorer/edit/ops/types";
import { sqlNumber, sqlText } from "@/lib/explorer/edit/sql";
import type { GtfsValue } from "@/lib/explorer/edit/types";

export { cleanStopValues, sameStopValues } from "@/lib/explorer/edit/ops/stopRules";

/** A stop's details as the snapshot holds them, for Properties. */
export interface StopRecord extends StopValues {
  stop_idx: number;
  stop_id: string;
  lat: number | null;
  lon: number | null;
}

/** Each value's snapshot column and GTFS field. */
const COLUMNS: Record<keyof StopValues, { snapshot: string; gtfs: string }> = {
  name: { snapshot: "name", gtfs: "stop_name" },
  wheelchair: { snapshot: "wheelchair", gtfs: "wheelchair_boarding" },
  location_type: { snapshot: "location_type", gtfs: "location_type" },
  parent_idx: { snapshot: "parent_idx", gtfs: "parent_station" },
  platform_code: { snapshot: "platform_code", gtfs: "platform_code" },
};

export async function stopRecord(db: SqlRunner, stop_idx: number): Promise<StopRecord | null> {
  const [row] = await db.all<Record<string, string | number | boolean | null>>(`
    SELECT s.stop_idx, s.stop_id, s.lat, s.lon, s.name, s.code, s.wheelchair, s.location_type, s.parent_idx,
           s.platform_code
    FROM stops s WHERE s.stop_idx = ${sqlNumber(stop_idx)}`);
  if (!row) return null;
  const text = (k: string) => (row[k] === null ? "" : String(row[k]));
  return {
    stop_idx: Number(row.stop_idx),
    stop_id: String(row.stop_id),
    lat: row.lat === null ? null : Number(row.lat),
    lon: row.lon === null ? null : Number(row.lon),
    name: text("name"),
    wheelchair: wheelchairOf(row.wheelchair === null ? null : Number(row.wheelchair)),
    location_type: Number(row.location_type ?? 0) as LocationType,
    parent_idx: row.parent_idx === null ? null : Number(row.parent_idx),
    platform_code: text("platform_code"),
  };
}

/** GTFS leaves wheelchair_boarding empty or 0 alike: unknown. */
export function wheelchairOf(value: number | null): Wheelchair {
  return value === 1 || value === 2 ? value : 0;
}

/** A refusal on one of the form's fields: shown there, not in the Apply bar. */
export type FieldCheck = Check & { field: StopField };

/** The values' first problem, as the refusal of the edit; and a parent that
 * is no station (or, for a boarding area, no platform). Editing, only of the
 * fields it changes (`changed`): a problem the stop had in the feed is the
 * feed's, and does not block renaming it (the save, too, counts only the
 * problems a change makes). */
async function refusalOf(
  db: SqlRunner,
  values: StopValues,
  stop_id?: string,
  changed?: Set<string>
): Promise<FieldCheck | null> {
  const problems = stopFieldProblems(values, stop_id);
  const field = (Object.keys(problems) as StopField[]).find((f) => !changed || changed.has(f));
  if (field) return { code: problems[field] as string, severity: "error", field };
  if (values.parent_idx !== null && (!changed || changed.has("parent_idx"))) {
    const [parent] = await db.all<{ location_type: number }>(
      `SELECT COALESCE(location_type, 0) AS location_type FROM stops WHERE stop_idx = ${sqlNumber(values.parent_idx)}`
    );
    if (!parent || parent.location_type !== parentTypeFor(values.location_type))
      return { code: "wrong_parent_location_type", severity: "error", field: "parent_idx" };
  }
  return null;
}

/** A stop's GTFS id, by its index. */
async function stopIdOf(db: SqlRunner, stop_idx: number | null): Promise<string | null> {
  if (stop_idx === null) return null;
  const [row] = await db.all<{ stop_id: string }>(
    `SELECT stop_id FROM stops WHERE stop_idx = ${sqlNumber(stop_idx)}`
  );
  return row?.stop_id ?? null;
}

/** A value as the snapshot and the bundle keep it: empty text and an unknown
 * accessibility none. */
async function stored(
  db: SqlRunner,
  k: keyof StopValues,
  v: StopValues
): Promise<{ snapshot: string; gtfs: GtfsValue }> {
  if (k === "parent_idx")
    return { snapshot: sqlNumber(v.parent_idx), gtfs: await stopIdOf(db, v.parent_idx) };
  if (k === "wheelchair" || k === "location_type") {
    const n = k === "wheelchair" ? v.wheelchair || null : v.location_type;
    return { snapshot: sqlNumber(n), gtfs: n };
  }
  const text = (v[k] as string) || null;
  return { snapshot: sqlText(text), gtfs: text };
}

export interface StopDetailsFacts {
  stop_id: string;
  from: StopValues;
  to: StopValues;
  /** What the edit changes, in the form's order. */
  changed: (keyof StopValues)[];
}

/** 2.4: the stop's fields, as the draft has them. */
export async function editStopDetails(
  db: SqlRunner,
  stop_idx: number,
  values: StopValues
): Promise<Built<StopDetailsFacts>> {
  const stop = await stopRecord(db, stop_idx);
  if (!stop) throw new Error(`No stop ${stop_idx}`);
  const to = cleanStopValues(values);
  const from = cleanStopValues(stop);
  const changed = STOP_VALUE_KEYS.filter((k) => from[k] !== to[k]);
  const facts = { stop_id: stop.stop_id, from, to, changed };
  // A location keeps its type: what calls at it or belongs to it would be
  // left wrong. Another type is another location, deleted and made anew
  // (decided 29 Oct 2026).
  if (changed.includes("location_type"))
    return {
      ok: false,
      refused: { code: "goat_type_fixed", severity: "error", field: "location_type" },
      facts,
      checks: [],
    };
  const refused = await refusalOf(db, to, undefined, new Set(changed));
  if (refused) return { ok: false, refused, facts, checks: [] };

  const where = `stop_idx = ${sqlNumber(stop_idx)}`;
  const set: string[] = [];
  const gtfs: Record<string, GtfsValue> = {};
  for (const k of changed) {
    const value = await stored(db, k, to);
    set.push(`${COLUMNS[k].snapshot} = ${value.snapshot}`);
    gtfs[COLUMNS[k].gtfs] = value.gtfs;
  }
  return {
    ok: true,
    facts,
    checks: [],
    rows: {
      kind: changed.length === 1 && changed[0] === "name" ? "stop_rename" : "stop_details",
      touches: [{ table: "stops", where }],
      sql: set.length ? [`UPDATE stops SET ${set.join(", ")} WHERE ${where}`] : [],
      gtfs: set.length ? [{ role: "stops", op: "update", key: { stop_id: stop.stop_id }, values: gtfs }] : [],
    },
  };
}

/** A GTFS id for a stop made here: `goat_` and 8 hex digits, none the feed
 * uses. */
export async function newStopId(db: SqlRunner, random: () => number = Math.random): Promise<string> {
  for (;;) {
    const id = `goat_${Math.floor(random() * 0x100000000)
      .toString(16)
      .padStart(8, "0")}`;
    const [taken] = await db.all(`SELECT 1 FROM stops WHERE stop_id = ${sqlText(id)}`);
    if (!taken) return id;
  }
}

export interface NewStopFacts {
  stop_idx: number;
  stop_id: string;
  name: string;
  location_type: LocationType;
}

/** 2.1: a location where it was placed: a stop, unserved until a line
 * calls there (added from the line, 3.1), a station or an entrance. Its id
 * is the one given, checked unused. */
export async function createStop(
  db: SqlRunner,
  lon: number,
  lat: number,
  values: StopValues,
  stopId?: string
): Promise<Built<NewStopFacts>> {
  const to = cleanStopValues(values);
  const [{ next }] = await db.all<{ next: number }>(
    "SELECT CAST(COALESCE(max(stop_idx) + 1, 0) AS INTEGER) AS next FROM stops"
  );
  const stop_id = (stopId ?? (await newStopId(db))).trim();
  const facts = { stop_idx: next, stop_id, name: to.name, location_type: to.location_type };
  const checks: Check[] = [];
  const refused = await refusalOf(db, to, stop_id);
  if (refused) return { ok: false, refused, facts, checks };
  const [taken] = await db.all(`SELECT 1 FROM stops WHERE stop_id = ${sqlText(stop_id)}`);
  if (taken)
    return {
      ok: false,
      refused: { code: "duplicate_key", severity: "error", field: "stop_id" },
      facts,
      checks,
    };

  const columns = ["stop_idx", "stop_id", "lat", "lon"];
  const snapshot = [sqlNumber(next), sqlText(stop_id), sqlNumber(lat), sqlNumber(lon)];
  const gtfs: Record<string, GtfsValue> = { stop_lat: lat, stop_lon: lon };
  for (const k of STOP_VALUE_KEYS) {
    const value = await stored(db, k, to);
    columns.push(COLUMNS[k].snapshot);
    snapshot.push(value.snapshot);
    // A new row says only what it has: GTFS's empty is a field left out.
    if (value.gtfs !== null) gtfs[COLUMNS[k].gtfs] = value.gtfs;
  }
  return {
    ok: true,
    facts,
    checks,
    rows: {
      kind: "stop_create",
      touches: [{ table: "stops", where: `stop_idx = ${sqlNumber(next)}` }],
      sql: [`INSERT INTO stops (${columns.join(", ")}) VALUES (${snapshot.join(", ")})`],
      gtfs: [{ role: "stops", op: "insert", key: { stop_id }, values: gtfs }],
    },
  };
}
