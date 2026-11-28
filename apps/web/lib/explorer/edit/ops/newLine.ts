/**
 * 1.1 Draw a new line (01-editing-operations § 1): a line through stops
 * picked on the map in order, run both ways, its trips every `headway`
 * minutes from the first departure to the last, on a service the feed has.
 *
 * Times (decided 9 Nov 2026): the user types the end-to-end running time;
 * every stop is timed from it in proportion to its distance along the path
 * (the user gives the time, the path spreads it), to the second. The way
 * back is timed alike over its own path, its trips leaving the other end at
 * the same times.
 *
 * The path, each way: straight from stop to stop, or with Snap, for a line
 * on the streets (bus, trolleybus, tram), along them (routed each way, so a
 * one-way street is kept to); a route that cannot be had or detours
 * implausibly stays straight, and says so. Its trips are headed for their
 * last stop. Ids are `goat_` and 8 hex digits, none the feed uses; its
 * paths' and trips' ids follow from it.
 */
import type { SqlRunner } from "@/lib/explorer/db/types";
import type { NewLineValues } from "@/lib/explorer/edit/drafts";
import { gtfsTime } from "@/lib/explorer/edit/ops/deleteLine";
import { placesOn } from "@/lib/explorer/edit/ops/extendLine";
import { metres } from "@/lib/explorer/edit/ops/geo";
import { ROAD_MODES, type Router, plausible } from "@/lib/explorer/edit/ops/moveStop";
import type { MoveStopFacts } from "@/lib/explorer/edit/ops/moveStop";
import { cleanRouteValues, routeFieldProblems } from "@/lib/explorer/edit/ops/routes";
import type { Built, Check } from "@/lib/explorer/edit/ops/types";
import { sqlNumber, sqlText } from "@/lib/explorer/edit/sql";
import type { GtfsRowOp, GtfsValue, Touch } from "@/lib/explorer/edit/types";
import { modeOf, routeColor } from "@/lib/explorer/modes";

type LonLat = [number, number];

export type NewLineField = keyof NewLineValues;
export { NO_LINE_VALUES, type NewLineValues } from "@/lib/explorer/edit/drafts";

/** "HH:MM" (or "H:MM", hours past 23 for after midnight) in seconds. */
export function clockSeconds(text: string): number | null {
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(text.trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 : null;
}
const minutes = (text: string): number | null => {
  const t = text.trim().replace(",", ".");
  return /^\d+(\.\d+)?$/.test(t) && Number(t) > 0 ? Number(t) : null;
};

/** Each field's problem, as an explorer_field_* code. */
export function newLineProblems(v: NewLineValues): Partial<Record<NewLineField, string>> {
  const named = routeFieldProblems({
    ...v,
    description: "",
    text_color: "",
  });
  const problems: Partial<Record<NewLineField, string>> = {};
  if (named.short_name) problems.short_name = named.short_name;
  if (named.long_name) problems.long_name = named.long_name;
  if (named.color) problems.color = named.color;
  if (v.service_idx === null) problems.service_idx = "missing_service";
  const first = clockSeconds(v.first);
  const last = clockSeconds(v.last);
  if (first === null) problems.first = "invalid_time";
  if (last === null) problems.last = "invalid_time";
  else if (first !== null && last < first) problems.last = "last_before_first";
  if (minutes(v.headway) === null) problems.headway = "invalid_minutes";
  if (minutes(v.running) === null) problems.running = "invalid_minutes";
  return problems;
}

export interface NewLineFacts {
  route_id: string;
  line: string;
  /** Trips each way, and their total. */
  trips: number;
  per_direction: number;
  /** The paths' lengths, the way drawn and back, in metres. */
  lengths: number[];
  trip_idxs: number[];
  route_idx: number;
  paths: MoveStopFacts["paths"];
}

async function freshRouteId(db: SqlRunner, random: () => number): Promise<string> {
  for (;;) {
    const id = `goat_${Math.floor(random() * 0x100000000)
      .toString(16)
      .padStart(8, "0")}`;
    const [taken] = await db.all(`SELECT 1 FROM routes WHERE route_id = ${sqlText(id)}`);
    const [shape] = await db.all(`SELECT 1 FROM shapes_meta WHERE starts_with(shape_id, ${sqlText(id)})`);
    if (!taken && !shape) return id;
  }
}

const list = (xs: number[]) => (xs.length ? xs.map(sqlNumber).join(", ") : "NULL");

export async function newLine(
  db: SqlRunner,
  stops: number[],
  values: NewLineValues,
  /** With Snap on: the router the streets are asked of. */
  route?: Router,
  random: () => number = Math.random,
  /** The line's id, once one is drawn for it: kept while the draft changes. */
  routeId?: string
): Promise<Built<NewLineFacts>> {
  const v = {
    ...values,
    ...cleanRouteValues({
      ...values,
      description: "",
      text_color: "",
    }),
  };
  const route_id = routeId ?? (await freshRouteId(db, random));
  const [{ route_idx }] = await db.all<{ route_idx: number }>(
    "SELECT CAST(COALESCE(max(route_idx) + 1, 0) AS INTEGER) AS route_idx FROM routes"
  );
  const facts: NewLineFacts = {
    route_id,
    line: v.short_name || v.long_name,
    trips: 0,
    per_direction: 0,
    lengths: [],
    trip_idxs: [],
    route_idx,
    paths: [],
  };
  const refuse = (code: string, field?: NewLineField): Built<NewLineFacts> => ({
    ok: false,
    refused: { code, severity: "error", ...(field ? { field } : {}) },
    facts,
    checks: [],
  });
  if (stops.length < 2) return refuse("goat_line_two_stops");
  if (stops.some((s, k) => k > 0 && s === stops[k - 1])) return refuse("goat_add_neighbour");
  const problems = newLineProblems(v);
  const field = (Object.keys(problems) as NewLineField[])[0];
  if (field) return refuse(problems[field] as string, field);

  const rows = await db.all<{
    stop_idx: number;
    stop_id: string;
    place: string;
    lon: number | null;
    lat: number | null;
    location_type: number;
  }>(`
    SELECT s.stop_idx, s.stop_id, COALESCE(p.name, s.name, s.stop_id) AS place,
           COALESCE(s.lon, p.lon) AS lon, COALESCE(s.lat, p.lat) AS lat,
           COALESCE(s.location_type, 0) AS location_type
    FROM stops s LEFT JOIN stops p ON p.stop_idx = s.parent_idx WHERE s.stop_idx IN (${list(stops)})`);
  const stopOf = new Map(rows.map((r) => [r.stop_idx, r]));
  for (const s of stops) {
    const r = stopOf.get(s);
    if (!r || r.location_type !== 0 || r.lon === null || r.lat === null) return refuse("goat_add_not_a_stop");
  }
  const [service] = await db.all<{ service_id: string }>(
    `SELECT service_id FROM services WHERE service_idx = ${sqlNumber(v.service_idx)}`
  );
  const [agency] = await db.all<{ agency_id: string }>(
    `SELECT agency_id FROM agencies WHERE agency_idx = ${sqlNumber(v.agency_idx)}`
  );
  if (!service) return refuse("missing_service", "service_idx");

  const first = clockSeconds(v.first) as number;
  const last = clockSeconds(v.last) as number;
  const headway = Math.round((minutes(v.headway) as number) * 60);
  const running = Math.round((minutes(v.running) as number) * 60);
  const departures: number[] = [];
  for (let t = first; t <= last; t += headway) departures.push(t);

  const ways = [stops, [...stops].reverse()];
  const routed = !!route && ROAD_MODES.has(modeOf(v.route_type));
  const checks: Check[] = [];
  let unrouted = false;
  const color = routeColor(v.color || null, modeOf(v.route_type));

  let [{ shape_idx, pattern_idx, trip_idx }] = await db.all<{
    shape_idx: number;
    pattern_idx: number;
    trip_idx: number;
  }>(`
    SELECT (SELECT CAST(COALESCE(max(shape_idx) + 1, 0) AS INTEGER) FROM shapes_meta) AS shape_idx,
           (SELECT CAST(COALESCE(max(pattern_idx) + 1, 0) AS INTEGER) FROM patterns) AS pattern_idx,
           (SELECT CAST(COALESCE(max(trip_idx) + 1, 0) AS INTEGER) FROM trips) AS trip_idx`);
  const trip_lo = trip_idx;
  const r = sqlNumber(route_idx);
  const sql: string[] = [];
  const gtfs: GtfsRowOp[] = [
    {
      role: "routes",
      op: "insert",
      key: { route_id },
      values: {
        ...(agency?.agency_id ? { agency_id: agency.agency_id } : {}),
        route_short_name: v.short_name || null,
        route_long_name: v.long_name || null,
        route_type: v.route_type,
        ...(v.color ? { route_color: v.color } : {}),
      },
    },
  ];
  const shapeIdxs: number[] = [];
  const patternIdxs: number[] = [];
  const stopTimes: string[] = [];
  const tripRows: string[] = [];

  for (const [dir, way] of ways.entries()) {
    const wps = way.map((s): LonLat => {
      const x = stopOf.get(s);
      return [x?.lon as number, x?.lat as number];
    });
    let line: LonLat[] = wps;
    if (routed) {
      try {
        const found = await (route as Router)(wps);
        if (found && found.line.length > 1 && plausible(wps, found.line)) line = found.line;
        else unrouted = true;
      } catch {
        unrouted = true;
      }
    }
    const d = [0];
    for (let k = 1; k < line.length; k++) d.push(d[k - 1] + metres(line[k - 1], line[k]));
    const length = d[d.length - 1];
    const places = placesOn(line, wps);
    // The stops in order along it: a route doubling back is no reason for
    // a stop to lie before the one it follows.
    for (let k = 1; k < places.length; k++) places[k] = Math.max(places[k], places[k - 1]);
    places[places.length - 1] = length;
    facts.lengths.push(length);
    const shape_id = `${route_id}_${dir}`;
    const s = sqlNumber(shape_idx);
    shapeIdxs.push(shape_idx);
    sql.push(
      `INSERT INTO shapes_meta VALUES (${s}, ${sqlText(shape_id)}, ${sqlNumber(length)})`,
      `INSERT INTO shape_points VALUES ${line
        .map((p, k) => `(${s}, ${k}, ${sqlNumber(p[0])}, ${sqlNumber(p[1])}, ${sqlNumber(d[k])})`)
        .join(", ")}`,
      `INSERT INTO shape_route VALUES (${s}, ${r})`
    );
    gtfs.push(
      ...line.map(
        (p, k): GtfsRowOp => ({
          role: "shapes",
          op: "insert",
          key: { shape_id, shape_pt_sequence: k + 1 },
          values: { shape_pt_lat: p[1], shape_pt_lon: p[0] },
        })
      )
    );
    const pt = sqlNumber(pattern_idx);
    patternIdxs.push(pattern_idx);
    sql.push(
      `INSERT INTO patterns (pattern_idx, route_idx, stops, n_stops, n_trips, length_m)
       VALUES (${pt}, ${r}, [${list(way)}]::INTEGER[], ${way.length}, ${departures.length}, ${sqlNumber(length)})`,
      `INSERT INTO pattern_shape_stops VALUES ${places.map((x, i) => `(${pt}, ${s}, ${i}, ${sqlNumber(x)})`).join(", ")}`
    );
    // Each stop timed in proportion to its distance along the path.
    const offsets = places.map((x) => (length > 0 ? Math.round((running * x) / length) : 0));
    const headsign = stopOf.get(way[way.length - 1])?.place ?? "";
    for (const [n, dep] of departures.entries()) {
      const trip_id = `${route_id}_${dir}_${String(n + 1).padStart(3, "0")}`;
      const t = sqlNumber(trip_idx);
      facts.trip_idxs.push(trip_idx);
      tripRows.push(
        `(${t}, ${sqlText(trip_id)}, ${r}, ${sqlNumber(v.service_idx)}, ${s}, ${dir}, ${sqlText(headsign)}, ${pt}, ${dep}, ${dep + running}, ${sqlNumber(length)}, 2)`
      );
      gtfs.push({
        role: "trips",
        op: "insert",
        key: { trip_id },
        values: {
          route_id,
          service_id: service.service_id,
          shape_id,
          direction_id: dir,
          trip_headsign: headsign,
        },
      });
      way.forEach((stop, i) => {
        const time = dep + offsets[i];
        stopTimes.push(`(${t}, ${i + 1}, ${sqlNumber(stop)}, ${time}, ${time}, NULL)`);
        const at: GtfsValue = gtfsTime(time);
        gtfs.push({
          role: "stop_times",
          op: "insert",
          key: { trip_id, stop_sequence: i + 1 },
          values: { stop_id: stopOf.get(stop)?.stop_id ?? "", arrival_time: at, departure_time: at },
        });
      });
      trip_idx++;
    }
    facts.paths.push({ shape_idx, color, coordinates: line, drawn: [line] });
    shape_idx++;
    pattern_idx++;
  }
  facts.per_direction = departures.length;
  facts.trips = departures.length * ways.length;
  const trip_hi = trip_idx - 1;
  sql.unshift(
    `INSERT INTO routes (route_idx, route_id, agency_idx, short_name, long_name, route_type, color, trip_lo, trip_hi)
     VALUES (${r}, ${sqlText(route_id)}, ${sqlNumber(v.agency_idx)}, ${sqlText(v.short_name || null)},
             ${sqlText(v.long_name || null)}, ${sqlNumber(v.route_type)}, ${sqlText(v.color || null)},
             ${trip_hi >= trip_lo ? trip_lo : "NULL"}, ${trip_hi >= trip_lo ? trip_hi : "NULL"})`
  );
  if (tripRows.length)
    sql.push(
      `INSERT INTO trips (trip_idx, trip_id, route_idx, service_idx, shape_idx, direction_id, headsign, pattern_idx,
                          first_dep_s, last_arr_s, length_m, length_src)
       VALUES ${tripRows.join(", ")}`,
      `INSERT INTO stop_times (trip_idx, stop_sequence, stop_idx, arrival_s, departure_s, shape_dist) VALUES ${stopTimes.join(", ")}`
    );
  if (unrouted) checks.push({ code: "goat_snap_route_failed", severity: "notice" });

  const touches: Touch[] = [
    { table: "routes", where: `route_idx = ${r}` },
    { table: "trips", where: `route_idx = ${r}` },
    { table: "stop_times", where: `trip_idx BETWEEN ${trip_lo} AND ${Math.max(trip_lo, trip_hi)}` },
    { table: "patterns", where: `pattern_idx IN (${list(patternIdxs)})` },
    { table: "pattern_shape_stops", where: `pattern_idx IN (${list(patternIdxs)})` },
    { table: "shapes_meta", where: `shape_idx IN (${list(shapeIdxs)})` },
    { table: "shape_points", where: `shape_idx IN (${list(shapeIdxs)})` },
    { table: "shape_route", where: `shape_idx IN (${list(shapeIdxs)})` },
  ];
  return { ok: true, facts, checks, rows: { kind: "line_new", touches, sql, gtfs, shapes: shapeIdxs } };
}
