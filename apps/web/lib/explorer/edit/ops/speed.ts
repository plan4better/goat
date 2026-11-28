/**
 * 5.2 Adjust speed (01-editing-operations § 5): one direction of a line runs
 * faster or slower (a bus lane, congestion), on the service patterns picked,
 * all day or in a period.
 *
 * Decided 26 Nov 2026, as a step of the service dialog:
 * - Every trip of the groups' services is scaled (their extras of a day
 *   too: the road is the same), or with a period those departing in it.
 * - A trip keeps its departure from its first stop; every later time is
 *   scaled from it by 100 / (100 + percent), so +25% faster runs in 0.8 of
 *   the time and -20% slower in 1.25. Dwells scale with the rest. Times are
 *   whole seconds and never go backwards along the trip.
 * - Untimed stop times stay untimed: the feed leaves them to the rider's
 *   estimate, and so do we.
 * - Frequency-based trips have their template trip scaled the same way,
 *   with a period where any of their windows runs in it.
 * - A trip faster on average than its mode plausibly runs is let be, with a
 *   notice: the planner may mean it (a new express), or not.
 */
import type { SqlRunner } from "@/lib/explorer/db/types";
import { gtfsTime } from "@/lib/explorer/edit/ops/deleteLine";
import type { DayTypeGroup } from "@/lib/explorer/edit/ops/headway";
import type { Built, Check } from "@/lib/explorer/edit/ops/types";
import { sqlNumber } from "@/lib/explorer/edit/sql";
import type { GtfsRowOp, Touch } from "@/lib/explorer/edit/types";
import { type ModeKey, modeOf } from "@/lib/explorer/modes";

/** The bounds of a speed change in percent (goat_speed_out_of_range). */
export const SPEED_MIN = -50;
export const SPEED_MAX = 100;

/** The fastest average speed, in km/h, a trip of each mode plausibly runs. */
const PLAUSIBLE_KMH: Partial<Record<ModeKey, number>> = {
  bus: 80,
  trolleybus: 80,
  tram: 70,
  metro: 100,
  rail: 200,
  ferry: 60,
};
const PLAUSIBLE_OTHER_KMH = 120;

export interface SpeedFacts {
  line: string;
  /** Per group edited: a day it runs on (the Explorer's date where it is
   * one), for the Apply bar's trips and vehicles before and after. */
  days: string[];
  /** Trips whose times change. */
  trips: number;
  trip_idxs: number[];
}

/** `s` scaled from `dep` by `factor`, in whole seconds; times at or before
 * the departure stay. */
export function scaleTime(s: number, dep: number, factor: number): number {
  return s <= dep ? s : dep + Math.round((s - dep) * factor);
}

const list = (xs: number[]) => (xs.length ? xs.map(sqlNumber).join(", ") : "NULL");

export async function adjustSpeed(
  db: SqlRunner,
  route_idx: number,
  /** The direction's patterns. */
  patterns: number[],
  /** Faster (+) or slower (-), in percent of the speed. */
  percent: number,
  /** The groups picked, whole (dayTypeGroups). */
  groups: DayTypeGroup[],
  /** The Explorer's date: the day the Apply bar counts a group on, where it
   * is one of its days. */
  date: string,
  /** Only the trips departing in it; null: all day. */
  period: { start_s: number; end_s: number } | null
): Promise<Built<SpeedFacts>> {
  const r = sqlNumber(route_idx);
  const [route] = await db.all<{ route_id: string; line: string; route_type: number | null }>(`
    SELECT route_id, COALESCE(NULLIF(short_name, ''), long_name, route_id) AS line, route_type
    FROM routes WHERE route_idx = ${r}`);
  if (!route) throw new Error(`No route ${route_idx}`);
  const facts: SpeedFacts = {
    line: route.line,
    days: groups.map((g) => (g.days.includes(date) ? date : g.days[0])),
    trips: 0,
    trip_idxs: [],
  };
  const refused = (code: string, params?: Record<string, string | number>): Built<SpeedFacts> => ({
    ok: false,
    refused: { code, severity: "error", params },
    facts,
    checks: [],
  });
  if (!(percent >= SPEED_MIN && percent <= SPEED_MAX))
    return refused("goat_speed_out_of_range", { min: SPEED_MIN, max: SPEED_MAX });
  if (percent === 0 || !groups.length) return refused("goat_speed_unchanged");
  const factor = 100 / (100 + percent);
  const services = [...new Set(groups.flatMap((g) => g.services))];

  const inPeriod = period
    ? `AND (t.trip_idx IN (SELECT trip_idx FROM frequencies f
             WHERE f.start_s < ${sqlNumber(period.end_s)} AND f.end_s > ${sqlNumber(period.start_s)})
           OR (t.trip_idx NOT IN (SELECT trip_idx FROM frequencies)
               AND t.first_dep_s >= ${sqlNumber(period.start_s)} AND t.first_dep_s < ${sqlNumber(period.end_s)}))`
    : "";
  const trips = await db.all<{
    trip_idx: number;
    trip_id: string;
    dep: number;
    last: number;
    length_m: number | null;
  }>(`
    SELECT t.trip_idx, t.trip_id, t.first_dep_s AS dep, t.last_arr_s AS last, t.length_m
    FROM trips t
    WHERE t.route_idx = ${r} AND t.pattern_idx IN (${list(patterns)})
      AND t.service_idx IN (${list(services)}) AND t.first_dep_s IS NOT NULL ${inPeriod}
    ORDER BY t.trip_idx`);
  const calls = await db.all<{
    trip_idx: number;
    stop_sequence: number;
    arrival_s: number | null;
    departure_s: number | null;
  }>(`
    SELECT trip_idx, stop_sequence, arrival_s, departure_s FROM stop_times
    WHERE trip_idx IN (${list(trips.map((t) => t.trip_idx))})
    ORDER BY trip_idx, stop_sequence`);
  const callsOf = new Map<number, typeof calls>();
  for (const c of calls) callsOf.set(c.trip_idx, [...(callsOf.get(c.trip_idx) ?? []), c]);

  // Each trip's new times, along it; never earlier than the time before.
  const updates: { trip: (typeof trips)[number]; seq: number; a: number | null; d: number | null }[] = [];
  const changed = new Map<number, number>(); // trip_idx → new last arrival
  for (const t of trips) {
    let prev = -Infinity;
    const next = (s: number | null) => {
      if (s === null) return null;
      prev = Math.max(prev, scaleTime(s, t.dep, factor));
      return prev;
    };
    let last = t.last;
    let moved = false;
    for (const c of callsOf.get(t.trip_idx) ?? []) {
      const a = next(c.arrival_s);
      const d = next(c.departure_s);
      // As the snapshot reads it: the last stop's arrival, else departure.
      last = a ?? d ?? last;
      if (a !== c.arrival_s || d !== c.departure_s) {
        updates.push({ trip: t, seq: c.stop_sequence, a, d });
        moved = true;
      }
    }
    if (moved) changed.set(t.trip_idx, last);
  }
  facts.trips = changed.size;
  facts.trip_idxs = [...changed.keys()];
  if (!changed.size) return refused(trips.length ? "goat_speed_unchanged" : "goat_speed_no_trips");

  // Faster than the mode plausibly runs: said, not refused.
  const limit = PLAUSIBLE_KMH[modeOf(route.route_type)] ?? PLAUSIBLE_OTHER_KMH;
  let fastest = 0;
  for (const t of trips) {
    const last = changed.get(t.trip_idx);
    if (last === undefined || !t.length_m || last <= t.dep) continue;
    fastest = Math.max(fastest, (t.length_m / (last - t.dep)) * 3.6);
  }
  const checks: Check[] =
    fastest > limit
      ? [{ code: "goat_speed_implausible", severity: "notice", params: { speed: Math.round(fastest) } }]
      : [];

  const value = (s: number | null) => (s === null ? "CAST(NULL AS INTEGER)" : sqlNumber(s));
  const rows = updates.map((u) => `(${u.trip.trip_idx}, ${u.seq}, ${value(u.a)}, ${value(u.d)})`).join(",\n");
  const all = list(facts.trip_idxs);
  const sql = [
    `UPDATE stop_times SET arrival_s = v.a, departure_s = v.d
     FROM (VALUES ${rows}) v(trip_idx, stop_sequence, a, d)
     WHERE stop_times.trip_idx = v.trip_idx AND stop_times.stop_sequence = v.stop_sequence`,
    `UPDATE trips SET last_arr_s = v.last
     FROM (VALUES ${[...changed].map(([idx, last]) => `(${idx}, ${last})`).join(", ")}) v(trip_idx, last)
     WHERE trips.trip_idx = v.trip_idx`,
  ];

  const gtfs: GtfsRowOp[] = updates.map((u) => ({
    role: "stop_times",
    op: "update",
    key: { trip_id: u.trip.trip_id, stop_sequence: u.seq },
    values: {
      ...(u.a !== null ? { arrival_time: gtfsTime(u.a) } : {}),
      ...(u.d !== null ? { departure_time: gtfsTime(u.d) } : {}),
    },
  }));

  const touches: Touch[] = [
    { table: "trips", where: `trip_idx IN (${all})` },
    { table: "stop_times", where: `trip_idx IN (${all})` },
  ];
  return { ok: true, rows: { kind: "speed", touches, sql, gtfs }, facts, checks };
}
