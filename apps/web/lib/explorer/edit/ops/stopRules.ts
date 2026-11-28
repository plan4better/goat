/**
 * GTFS's rules for a stop's fields (stops.txt), by its location type: which
 * fields it has, which are required, and what makes a value wrong. The
 * Explorer edits the fields planners need; a feed's others (fare zone, URL,
 * time zone, spoken name) are kept as they are. The Properties form shows and
 * checks fields by these rules; the stop operations refuse by them, with the
 * validator's notice codes; goatlib's change set checks the same on save.
 */
import type { LocationType, StopValues } from "@/lib/explorer/edit/drafts";

/** A field of the form: a stop's values, and a new stop's id. */
export type StopField = keyof StopValues | "stop_id";

/** The fields a location type has. */
export function stopFieldsShown(values: Pick<StopValues, "location_type" | "parent_idx">): Set<StopField> {
  const t = values.location_type;
  const shown = new Set<StopField>(["location_type", "name", "wheelchair"]);
  // A stop or platform may belong to a station; the others must.
  if (t !== 1) shown.add("parent_idx");
  // A platform's number, for a stop in a station.
  if (t === 0 && values.parent_idx !== null) shown.add("platform_code");
  return shown;
}

/** GTFS: a stop, station or entrance is named; a node or boarding area need not be. */
export const nameRequired = (t: LocationType) => t <= 2;
/** GTFS: an entrance, node or boarding area belongs to a station (a boarding
 * area, to a platform). */
export function parentRequired(t: LocationType): boolean {
  return t >= 2;
}
/** The location type a parent must have. */
export const parentTypeFor = (t: LocationType): LocationType => (t === 4 ? 0 : 1);

/** Values as they are kept: trimmed, and without the fields their location
 * type does not have. */
export function cleanStopValues(values: StopValues): StopValues {
  const shown = stopFieldsShown(values);
  const text = (k: keyof StopValues) => (shown.has(k) ? String(values[k] ?? "").trim() : "");
  return {
    name: values.name.trim(),
    wheelchair: values.wheelchair,
    location_type: values.location_type,
    parent_idx: shown.has("parent_idx") ? values.parent_idx : null,
    platform_code: text("platform_code"),
  };
}

/** The fields in the form's order. */
export const STOP_VALUE_KEYS: (keyof StopValues)[] = [
  "name",
  "location_type",
  "parent_idx",
  "platform_code",
  "wheelchair",
];

export function sameStopValues(a: StopValues, b: StopValues): boolean {
  const x = cleanStopValues(a);
  const y = cleanStopValues(b);
  return STOP_VALUE_KEYS.every((k) => x[k] === y[k]);
}

/** A position as one text, latitude first, as maps and sites copy it:
 * `52.52, 13.405` (a comma, semicolon or space between). */
const LAT_LON = /^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/;

export function parseLatLon(text: string): { lat: number; lon: number } | null {
  const m = LAT_LON.exec(text);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

/** A GTFS id: printable ASCII, no spaces (the validator's
 * `non_ascii_or_non_printable_char`, taken strictly for ids made here). */
const ID_RE = /^[\x21-\x7e]+$/;

/** What is wrong with each field, by notice code, that the values alone
 * show; `stop_id` only where it is given (a new stop's). */
export function stopFieldProblems(values: StopValues, stop_id?: string): Partial<Record<StopField, string>> {
  const v = cleanStopValues(values);
  const problems: Partial<Record<StopField, string>> = {};
  if (stop_id !== undefined) {
    const id = stop_id.trim();
    if (!id) problems.stop_id = "missing_stop_id";
    else if (!ID_RE.test(id)) problems.stop_id = "invalid_stop_id";
  }
  if (nameRequired(v.location_type) && !v.name) problems.name = "missing_stop_name";
  if (parentRequired(v.location_type) && v.parent_idx === null)
    problems.parent_idx = "location_without_parent_station";
  return problems;
}

/** What the panels call a location, by its type: a stop (or platform, node,
 * boarding area), a station, an entrance. */
export function locationKind(location_type: number | undefined): "stop" | "station" | "entrance" {
  return location_type === 1 ? "station" : location_type === 2 ? "entrance" : "stop";
}
