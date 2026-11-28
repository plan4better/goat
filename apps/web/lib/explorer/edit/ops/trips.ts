/**
 * Single trips (01-editing-operations § 4 and 5): 4.3 add, duplicate and
 * delete trips, 4.4 shift trips, 5.1 edit stop times.
 *
 * - A shift moves every stop time of a trip by the same amount; a stop with
 *   no time keeps none. A frequency-based trip (frequencies.txt) moves its
 *   windows instead: its stop times are a template, timed from each window.
 *   A shift taking a time before the service day's midnight is refused.
 * - A duplicate is a copy of the trip departing at another time: its
 *   pattern, path, running times and service, an id of its own and no
 *   block; the server copies what the browser does not hold (`copy_of`).
 *   A frequency-based trip is not duplicated (yet): its windows say when
 *   it runs, a second trip would run beside them.
 * - A trip deleted takes its stop times, extras and frequencies with it. A
 *   line's last trips are not deleted here: that is Delete line (1.5).
 * - Stop times typed for one trip never go backwards along it, and its
 *   first and last stop keep their times (GTFS requires both there). With
 *   "shift later stops", the stops after the last one typed move by as much
 *   as its departure did.
 *
 * Trips of one block now overlapping in time is a notice, not a refusal:
 * the block is the operator's, and the planner may fix it with the next
 * edit. Two trips of a block overlap only where their services run on a
 * day in common.
 */
import type { SqlRunner } from "@/lib/explorer/db/types";
import { gtfsTime } from "@/lib/explorer/edit/ops/deleteLine";
import { freshTripIds } from "@/lib/explorer/edit/ops/headway";
import type { Built, Check } from "@/lib/explorer/edit/ops/types";
import { sqlNumber, sqlText } from "@/lib/explorer/edit/sql";
import type { GtfsRowOp, Touch } from "@/lib/explorer/edit/types";

export interface TripsFacts {
  /** The line or lines, as riders know them: number, else name. */
  line: string;
  /** Trips edited: shifted, duplicated, deleted or re-timed. */
  trips: number;
  /** Every trip it touches, before or after it (the copy too): what the
   * edit costs. */
  trip_idxs: number[];
  /** Shift: seconds moved. Stop times with "shift later stops": seconds the
   * later stops moved. */
  by_s?: number;
  /** Duplicate: the copy's departure. */
  dep_s?: number;
  /** Delete: each trip, for the delete card. */
  deleted?: { trip_idx: number; dep_s: number | null; headsign: string | null }[];
  /** Stop times: how many were set or moved. */
  stops?: number;
}

interface TripRow {
  trip_idx: number;
  trip_id: string;
  route_idx: number;
  service_idx: number;
  pattern_idx: number;
  block_idx: number | null;
  headsign: string | null;
  first_dep_s: number | null;
  last_arr_s: number | null;
  freq: boolean;
}

interface Call {
  trip_idx: number;
  trip_id: string;
  stop_sequence: number;
  stop_id: string;
  stop_name: string | null;
  arrival_s: number | null;
  departure_s: number | null;
}

const list = (xs: number[]) => (xs.length ? xs.map(sqlNumber).join(", ") : "NULL");

async function tripRows(db: SqlRunner, trip_idxs: number[]): Promise<TripRow[]> {
  const rows = await db.all<TripRow>(`
    SELECT t.trip_idx, t.trip_id, t.route_idx, t.service_idx, t.pattern_idx, t.block_idx, t.headsign,
           t.first_dep_s, t.last_arr_s, t.trip_idx IN (SELECT trip_idx FROM frequencies) AS freq
    FROM trips t WHERE t.trip_idx IN (${list(trip_idxs)}) ORDER BY t.trip_idx`);
  const missing = trip_idxs.find((idx) => !rows.some((r) => r.trip_idx === idx));
  if (missing !== undefined) throw new Error(`No trip ${missing}`);
  return rows;
}

async function lineOf(db: SqlRunner, route_idxs: number[]): Promise<string> {
  const rows = await db.all<{ line: string }>(`
    SELECT COALESCE(NULLIF(short_name, ''), long_name, route_id) AS line
    FROM routes WHERE route_idx IN (${list([...new Set(route_idxs)])}) ORDER BY route_idx`);
  return rows.map((r) => r.line).join(", ");
}

/** The trips' stop times, as the bundle names them. */
async function callsOf(db: SqlRunner, trip_idxs: number[]): Promise<Call[]> {
  return db.all<Call>(`
    SELECT st.trip_idx, t.trip_id, st.stop_sequence, s.stop_id, s.name AS stop_name,
           st.arrival_s, st.departure_s
    FROM stop_times st JOIN trips t USING (trip_idx) JOIN stops s USING (stop_idx)
    WHERE st.trip_idx IN (${list(trip_idxs)})
    ORDER BY st.trip_idx, st.stop_sequence`);
}

const time = (s: number | null) => (s === null ? null : gtfsTime(s));

/** The service pairs (lower first) that run on a day in common. */
async function sharedDays(db: SqlRunner, services: number[]): Promise<Set<string>> {
  const s = list(services);
  const rows = await db.all<{ a: number; b: number }>(`
    WITH spans AS (
      SELECT service_idx, days, CAST(unnest(generate_series(start_date, end_date, INTERVAL 1 DAY)) AS DATE) AS date
      FROM services WHERE service_idx IN (${s}) AND days IS NOT NULL
    ),
    regular AS (
      SELECT service_idx, date FROM spans WHERE (CAST(days AS INTEGER) >> (isodow(date) - 1)) & 1 = 1
    ),
    added AS (SELECT service_idx, date FROM calendar_dates WHERE service_idx IN (${s}) AND exception_type = 1),
    removed AS (SELECT service_idx, date FROM calendar_dates WHERE service_idx IN (${s}) AND exception_type = 2),
    active AS ((SELECT * FROM regular UNION SELECT * FROM added) EXCEPT SELECT * FROM removed)
    SELECT DISTINCT x.service_idx AS a, y.service_idx AS b
    FROM active x JOIN active y ON x.date = y.date AND x.service_idx < y.service_idx`);
  return new Set(rows.map((r) => `${r.a},${r.b}`));
}

/**
 * goat_block_overlap: a trip of `changed` (its new first departure and last
 * arrival given) running at the same time as another trip of its block, on
 * a day both run.
 */
async function blockOverlaps(
  db: SqlRunner,
  changed: Map<number, { first: number | null; last: number | null }>
): Promise<Check[]> {
  const ids = [...changed.keys()];
  const block = await db.all<{
    trip_idx: number;
    trip_id: string;
    block_idx: number;
    service_idx: number;
    first_dep_s: number | null;
    last_arr_s: number | null;
  }>(`
    SELECT trip_idx, trip_id, block_idx, service_idx, first_dep_s, last_arr_s FROM trips
    WHERE block_idx IN (SELECT block_idx FROM trips WHERE trip_idx IN (${list(ids)}))
      AND trip_idx NOT IN (SELECT trip_idx FROM frequencies)
    ORDER BY trip_idx`);
  if (block.length < 2) return [];
  const span = block.map((t) => {
    const c = changed.get(t.trip_idx);
    return { ...t, first: c ? c.first : t.first_dep_s, last: c ? c.last : t.last_arr_s };
  });
  const pairs: [(typeof span)[number], (typeof span)[number]][] = [];
  for (const [i, a] of span.entries())
    for (const b of span.slice(i + 1)) {
      if (a.block_idx !== b.block_idx || !(changed.has(a.trip_idx) || changed.has(b.trip_idx))) continue;
      if (a.first === null || a.last === null || b.first === null || b.last === null) continue;
      if (a.first < b.last && b.first < a.last) pairs.push([a, b]);
    }
  if (!pairs.length) return [];
  const differ = pairs.filter(([a, b]) => a.service_idx !== b.service_idx);
  const shared = differ.length
    ? await sharedDays(db, [...new Set(differ.flatMap(([a, b]) => [a.service_idx, b.service_idx]))])
    : new Set<string>();
  return pairs
    .filter(
      ([a, b]) =>
        a.service_idx === b.service_idx ||
        shared.has(`${Math.min(a.service_idx, b.service_idx)},${Math.max(a.service_idx, b.service_idx)}`)
    )
    .map(([a, b]) => {
      const [mine, other] = changed.has(a.trip_idx) ? [a, b] : [b, a];
      return {
        code: "goat_block_overlap",
        severity: "notice",
        params: { trip: mine.trip_id, other: other.trip_id },
      };
    });
}

const refusal = <F>(facts: F, code: string, params?: Record<string, string | number>): Built<F> => ({
  ok: false,
  refused: { code, severity: "error", params },
  facts,
  checks: [],
});

/** 4.4 Every stop time of each trip moved by `by_s`; a frequency-based
 * trip's windows instead. */
export async function shiftTrips(
  db: SqlRunner,
  trip_idxs: number[],
  by_s: number
): Promise<Built<TripsFacts>> {
  const trips = await tripRows(db, trip_idxs);
  const idxs = trips.map((t) => t.trip_idx);
  const facts: TripsFacts = {
    line: await lineOf(
      db,
      trips.map((t) => t.route_idx)
    ),
    trips: trips.length,
    trip_idxs: idxs,
    by_s,
  };
  if (!Number.isInteger(by_s)) throw new Error(`Not whole seconds: ${by_s}`);
  if (by_s === 0) return refusal(facts, "goat_shift_unchanged");

  const timed = trips.filter((t) => !t.freq);
  const windowed = trips.filter((t) => t.freq);
  const calls = await callsOf(
    db,
    timed.map((t) => t.trip_idx)
  );
  const freqs = await db.all<{
    trip_idx: number;
    trip_id: string;
    start_s: number;
    end_s: number;
    headway_s: number;
    exact_times: number;
  }>(`
    SELECT f.trip_idx, t.trip_id, f.start_s, f.end_s, f.headway_s, CAST(f.exact_times AS INTEGER) AS exact_times
    FROM frequencies f JOIN trips t USING (trip_idx)
    WHERE f.trip_idx IN (${list(windowed.map((t) => t.trip_idx))})
    ORDER BY f.trip_idx, f.start_s`);
  // The earliest time it moves: none may go before the day's midnight.
  const earliest = Math.min(
    ...calls.flatMap((c) => [c.arrival_s, c.departure_s].filter((s): s is number => s !== null)),
    ...freqs.map((f) => f.start_s)
  );
  if (earliest + by_s < 0) return refusal(facts, "goat_shift_before_day", { earliest: gtfsTime(earliest) });

  const t = list(timed.map((x) => x.trip_idx));
  const w = list(windowed.map((x) => x.trip_idx));
  const sql = [
    `UPDATE stop_times SET arrival_s = arrival_s + ${by_s}, departure_s = departure_s + ${by_s} WHERE trip_idx IN (${t})`,
    `UPDATE trips SET first_dep_s = first_dep_s + ${by_s}, last_arr_s = last_arr_s + ${by_s} WHERE trip_idx IN (${t})`,
    `UPDATE frequencies SET start_s = start_s + ${by_s}, end_s = end_s + ${by_s} WHERE trip_idx IN (${w})`,
  ];
  // A window's key is its start: every window of a trip goes before any
  // comes back moved, so none collides with one not yet moved.
  const gtfs: GtfsRowOp[] = [
    ...calls
      .filter((c) => c.arrival_s !== null || c.departure_s !== null)
      .map(
        (c): GtfsRowOp => ({
          role: "stop_times",
          op: "update",
          key: { trip_id: c.trip_id, stop_sequence: c.stop_sequence },
          values: {
            ...(c.arrival_s !== null ? { arrival_time: gtfsTime(c.arrival_s + by_s) } : {}),
            ...(c.departure_s !== null ? { departure_time: gtfsTime(c.departure_s + by_s) } : {}),
          },
        })
      ),
    ...freqs.map(
      (f): GtfsRowOp => ({
        role: "frequencies",
        op: "delete",
        key: { trip_id: f.trip_id, start_time: gtfsTime(f.start_s) },
      })
    ),
    ...freqs.map(
      (f): GtfsRowOp => ({
        role: "frequencies",
        op: "insert",
        key: { trip_id: f.trip_id, start_time: gtfsTime(f.start_s + by_s) },
        values: { end_time: gtfsTime(f.end_s + by_s), headway_secs: f.headway_s, exact_times: f.exact_times },
      })
    ),
  ];
  const all = list(idxs);
  const touches: Touch[] = [
    { table: "trips", where: `trip_idx IN (${all})` },
    { table: "stop_times", where: `trip_idx IN (${all})` },
    { table: "frequencies", where: `trip_idx IN (${all})` },
  ];
  const checks = await blockOverlaps(
    db,
    new Map(
      timed
        .filter((x) => x.block_idx !== null)
        .map((x) => [
          x.trip_idx,
          {
            first: x.first_dep_s === null ? null : x.first_dep_s + by_s,
            last: x.last_arr_s === null ? null : x.last_arr_s + by_s,
          },
        ])
    )
  );
  return { ok: true, rows: { kind: "trips_shift", touches, sql, gtfs }, facts, checks };
}

/** 4.3 A copy of the trip departing at `dep_s`. */
export async function duplicateTrip(
  db: SqlRunner,
  trip_idx: number,
  dep_s: number,
  random: () => number = Math.random
): Promise<Built<TripsFacts>> {
  const [trip] = await tripRows(db, [trip_idx]);
  const facts: TripsFacts = {
    line: await lineOf(db, [trip.route_idx]),
    trips: 1,
    trip_idxs: [trip_idx],
    dep_s,
  };
  if (!Number.isInteger(dep_s)) throw new Error(`Not whole seconds: ${dep_s}`);
  if (trip.freq) return refusal(facts, "goat_trip_frequency_based");
  if (trip.first_dep_s === null) return refusal(facts, "goat_trip_end_untimed");
  const by = dep_s - trip.first_dep_s;
  const calls = await callsOf(db, [trip_idx]);
  const earliest = Math.min(
    ...calls.flatMap((c) => [c.arrival_s, c.departure_s].filter((s): s is number => s !== null))
  );
  if (earliest + by < 0) return refusal(facts, "goat_shift_before_day", { earliest: gtfsTime(earliest) });

  // Numbered after every trip there is (inTripRange finds it).
  const [{ next }] = await db.all<{ next: number }>(
    "SELECT CAST(COALESCE(max(trip_idx) + 1, 0) AS INTEGER) AS next FROM trips"
  );
  const [id] = await freshTripIds(db, 1, random);
  facts.trip_idxs = [trip_idx, next];

  const checks: Check[] = [];
  const [same] = await db.all<{ trip_id: string; first_dep_s: number }>(`
    SELECT trip_id, first_dep_s FROM trips
    WHERE pattern_idx = ${trip.pattern_idx} AND service_idx = ${trip.service_idx}
      AND abs(first_dep_s - ${dep_s}) < 60
    ORDER BY abs(first_dep_s - ${dep_s}), trip_idx LIMIT 1`);
  if (same)
    checks.push({
      code: "goat_duplicate_departure",
      severity: "notice",
      params: { trip: same.trip_id, time: gtfsTime(same.first_dep_s).slice(0, 5) },
    });

  const sql = [
    `INSERT INTO trips SELECT * REPLACE (${next} AS trip_idx, ${sqlText(id)} AS trip_id,
       CAST(NULL AS INTEGER) AS block_idx, first_dep_s + ${by} AS first_dep_s, last_arr_s + ${by} AS last_arr_s)
     FROM trips WHERE trip_idx = ${trip_idx}`,
    `INSERT INTO stop_times SELECT * REPLACE (${next} AS trip_idx, arrival_s + ${by} AS arrival_s,
       departure_s + ${by} AS departure_s) FROM stop_times WHERE trip_idx = ${trip_idx}`,
    `INSERT INTO stop_time_extras SELECT * REPLACE (${next} AS trip_idx)
     FROM stop_time_extras WHERE trip_idx = ${trip_idx}`,
    `UPDATE patterns SET n_trips = n_trips + 1 WHERE pattern_idx = ${trip.pattern_idx}`,
  ];
  const [fields] = await db.all<{
    route_id: string;
    service_id: string;
    direction_id: number | null;
    short_name: string | null;
  }>(`
    SELECT r.route_id, sv.service_id, t.direction_id, t.short_name
    FROM trips t JOIN routes r USING (route_idx) JOIN services sv USING (service_idx)
    WHERE t.trip_idx = ${trip_idx}`);
  const gtfs: GtfsRowOp[] = [
    {
      role: "trips",
      op: "insert",
      key: { trip_id: id },
      values: {
        route_id: fields.route_id,
        service_id: fields.service_id,
        direction_id: fields.direction_id,
        trip_headsign: trip.headsign,
        trip_short_name: fields.short_name,
        block_id: null,
      },
      copy_of: { trip_id: trip.trip_id },
    },
    ...calls.map(
      (c): GtfsRowOp => ({
        role: "stop_times",
        op: "insert",
        key: { trip_id: id, stop_sequence: c.stop_sequence },
        values: {
          stop_id: c.stop_id,
          arrival_time: time(c.arrival_s === null ? null : c.arrival_s + by),
          departure_time: time(c.departure_s === null ? null : c.departure_s + by),
        },
        copy_of: { trip_id: trip.trip_id, stop_sequence: c.stop_sequence },
      })
    ),
  ];
  const touches: Touch[] = [
    { table: "trips", where: `trip_idx = ${next}` },
    { table: "stop_times", where: `trip_idx = ${next}` },
    { table: "stop_time_extras", where: `trip_idx = ${next}` },
    { table: "patterns", where: `pattern_idx = ${trip.pattern_idx}` },
  ];
  return { ok: true, rows: { kind: "trip_duplicate", touches, sql, gtfs }, facts, checks };
}

/** 4.3 The trips, with their stop times, extras and frequencies. */
export async function deleteTrips(db: SqlRunner, trip_idxs: number[]): Promise<Built<TripsFacts>> {
  const trips = await tripRows(db, trip_idxs);
  const idxs = trips.map((t) => t.trip_idx);
  const facts: TripsFacts = {
    line: await lineOf(
      db,
      trips.map((t) => t.route_idx)
    ),
    trips: trips.length,
    trip_idxs: idxs,
    deleted: trips.map((t) => ({ trip_idx: t.trip_idx, dep_s: t.first_dep_s, headsign: t.headsign })),
  };
  const routes = [...new Set(trips.map((t) => t.route_idx))];
  const [whole] = await db.all<{ route_idx: number }>(`
    SELECT route_idx FROM trips WHERE route_idx IN (${list(routes)})
    GROUP BY route_idx HAVING bool_and(trip_idx IN (${list(idxs)})) ORDER BY route_idx LIMIT 1`);
  if (whole) return refusal(facts, "goat_trips_whole_line", { line: await lineOf(db, [whole.route_idx]) });

  const all = list(idxs);
  const patterns = list([...new Set(trips.map((t) => t.pattern_idx))]);
  const sql = [
    `DELETE FROM stop_time_extras WHERE trip_idx IN (${all})`,
    `DELETE FROM stop_times WHERE trip_idx IN (${all})`,
    `DELETE FROM frequencies WHERE trip_idx IN (${all})`,
    `DELETE FROM trips WHERE trip_idx IN (${all})`,
    `UPDATE patterns SET
       n_trips = (SELECT CAST(count(*) AS INTEGER) FROM trips t WHERE t.pattern_idx = patterns.pattern_idx)
     WHERE pattern_idx IN (${patterns})`,
  ];
  // Children before parents: stop times and frequencies, then the trips.
  const calls = await callsOf(db, idxs);
  const runs = await db.all<{ trip_id: string; start_s: number }>(`
    SELECT t.trip_id, f.start_s FROM frequencies f JOIN trips t USING (trip_idx)
    WHERE f.trip_idx IN (${all}) ORDER BY f.trip_idx, f.start_s`);
  const gtfs: GtfsRowOp[] = [
    ...calls.map(
      (c): GtfsRowOp => ({
        role: "stop_times",
        op: "delete",
        key: { trip_id: c.trip_id, stop_sequence: c.stop_sequence },
      })
    ),
    ...runs.map(
      (f): GtfsRowOp => ({
        role: "frequencies",
        op: "delete",
        key: { trip_id: f.trip_id, start_time: gtfsTime(f.start_s) },
      })
    ),
    ...trips.map((t): GtfsRowOp => ({ role: "trips", op: "delete", key: { trip_id: t.trip_id } })),
  ];
  const touches: Touch[] = [
    { table: "trips", where: `trip_idx IN (${all})` },
    { table: "stop_times", where: `trip_idx IN (${all})` },
    { table: "stop_time_extras", where: `trip_idx IN (${all})` },
    { table: "frequencies", where: `trip_idx IN (${all})` },
    { table: "patterns", where: `pattern_idx IN (${patterns})` },
  ];
  return { ok: true, rows: { kind: "trips_delete", touches, sql, gtfs }, facts, checks: [] };
}

/** A stop time typed: null leaves the stop untimed. */
export interface StopTimeInput {
  stop_sequence: number;
  arrival_s: number | null;
  departure_s: number | null;
}

/** 5.1 The stop times typed for one trip; with `follow`, the stops after
 * the last one typed move by as much as its departure did. */
export async function setStopTimes(
  db: SqlRunner,
  trip_idx: number,
  times: StopTimeInput[],
  follow: boolean
): Promise<Built<TripsFacts>> {
  const [trip] = await tripRows(db, [trip_idx]);
  const facts: TripsFacts = { line: await lineOf(db, [trip.route_idx]), trips: 1, trip_idxs: [trip_idx] };
  const calls = await callsOf(db, [trip_idx]);
  const typed = new Map(times.map((x) => [x.stop_sequence, x]));
  for (const x of times) {
    if (!calls.some((c) => c.stop_sequence === x.stop_sequence))
      throw new Error(`Trip ${trip_idx} has no stop_sequence ${x.stop_sequence}`);
    for (const s of [x.arrival_s, x.departure_s])
      if (s !== null && !Number.isInteger(s)) throw new Error(`Not whole seconds: ${s}`);
  }

  // The later stops move by as much as the last stop typed departs later.
  let by = 0;
  const lastSeq = Math.max(...times.map((x) => x.stop_sequence));
  if (follow && times.length) {
    const was = calls.find((c) => c.stop_sequence === lastSeq) as Call;
    const now = typed.get(lastSeq) as StopTimeInput;
    const before = was.departure_s ?? was.arrival_s;
    const after = now.departure_s ?? now.arrival_s;
    if (before !== null && after !== null) by = after - before;
  }
  const next = calls.map((c) => {
    const x = typed.get(c.stop_sequence);
    if (x) return { ...c, arrival_s: x.arrival_s, departure_s: x.departure_s };
    if (by && c.stop_sequence > lastSeq)
      return {
        ...c,
        arrival_s: c.arrival_s === null ? null : c.arrival_s + by,
        departure_s: c.departure_s === null ? null : c.departure_s + by,
      };
    return c;
  });
  const changed = next.filter(
    (c, i) => c.arrival_s !== calls[i].arrival_s || c.departure_s !== calls[i].departure_s
  );
  facts.stops = changed.length;
  if (by) facts.by_s = by;
  if (!changed.length) return refusal(facts, "goat_stop_times_unchanged");

  // Every stop timed both ways or not at all, the ends timed, and never
  // backwards along the trip.
  const named = (c: Call) => ({ stop_sequence: c.stop_sequence, stop: c.stop_name ?? c.stop_id });
  for (const [i, c] of next.entries()) {
    const end = i === 0 || i === next.length - 1;
    if (end && (c.arrival_s === null || c.departure_s === null))
      return refusal(facts, "goat_trip_end_untimed", named(c));
    if ((c.arrival_s === null) !== (c.departure_s === null))
      return refusal(facts, "stop_time_with_only_arrival_or_departure_time", named(c));
    if ((c.arrival_s !== null && c.arrival_s < 0) || (c.departure_s !== null && c.departure_s < 0))
      return refusal(facts, "goat_shift_before_day", named(c));
    if (c.arrival_s !== null && c.departure_s !== null && c.departure_s < c.arrival_s)
      return refusal(facts, "stop_time_with_departure_before_arrival_time", named(c));
  }
  let prev: number | null = null;
  for (const c of next) {
    if (c.arrival_s === null) continue;
    if (prev !== null && c.arrival_s < prev)
      return refusal(facts, "stop_time_with_arrival_before_previous_departure_time", named(c));
    prev = c.departure_s;
  }
  const first = next[0].departure_s as number;
  const last = next[next.length - 1].arrival_s as number;

  const sql = [
    ...changed.map(
      (c) =>
        `UPDATE stop_times SET arrival_s = ${sqlNumber(c.arrival_s)}, departure_s = ${sqlNumber(c.departure_s)}
         WHERE trip_idx = ${trip_idx} AND stop_sequence = ${c.stop_sequence}`
    ),
    `UPDATE trips SET first_dep_s = ${first}, last_arr_s = ${last} WHERE trip_idx = ${trip_idx}`,
  ];
  const gtfs: GtfsRowOp[] = changed.map(
    (c): GtfsRowOp => ({
      role: "stop_times",
      op: "update",
      key: { trip_id: c.trip_id, stop_sequence: c.stop_sequence },
      values: { arrival_time: time(c.arrival_s), departure_time: time(c.departure_s) },
    })
  );
  const touches: Touch[] = [
    { table: "trips", where: `trip_idx = ${trip_idx}` },
    { table: "stop_times", where: `trip_idx = ${trip_idx}` },
  ];
  const checks =
    trip.block_idx !== null && !trip.freq
      ? await blockOverlaps(db, new Map([[trip_idx, { first, last }]]))
      : [];
  return { ok: true, rows: { kind: "stop_times", touches, sql, gtfs }, facts, checks };
}
