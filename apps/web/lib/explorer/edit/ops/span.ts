/**
 * 4.2 Span of service (01-editing-operations § 4): one direction of a line
 * starts earlier or later in the day, or ends earlier or later, on the
 * service patterns picked.
 *
 * Decided 26 Nov 2026, as a step of the service dialog:
 * - The day types picked are grouped as for headways (4.1): the services on
 *   all of a group's days carry the new departures, or each set of services
 *   on days of their own alike; a group with neither is refused.
 * - A first departure later than now deletes every trip of the group's
 *   services departing before it (a day's extras too, so no day of the group
 *   starts earlier); a last departure earlier deletes those departing after.
 * - A first departure earlier than now adds departures before the current
 *   first, at the gap between its first two departures, each a copy of the
 *   first trip moved whole (its pattern, path, running times and service;
 *   an id of its own, no block; `copy_of` copies what the browser does not
 *   hold). They keep the line's rhythm: the earliest is the last that is not
 *   before the time asked, so the new first may be a little after it. The
 *   last departure is mirrored, at the gap between the last two.
 * - A direction with a single departure has no gap to repeat: refused,
 *   rather than guessing one.
 * - Frequency-based trips (frequencies.txt) move their first window's start
 *   or last window's end instead; windows wholly outside the span go, and a
 *   trip left without windows with them. A group whose carrying services
 *   have both kinds of trips is refused.
 * - An end left empty (null) stays as it is. A span leaving a group no
 *   departure is refused: that is deleting the direction, not its span.
 */
import type { SqlRunner } from "@/lib/explorer/db/types";
import { gtfsTime } from "@/lib/explorer/edit/ops/deleteLine";
import { type DayTypeGroup, freshTripIds, serviceUnits } from "@/lib/explorer/edit/ops/headway";
import type { Built, Check } from "@/lib/explorer/edit/ops/types";
import { sqlNumber, sqlText } from "@/lib/explorer/edit/sql";
import type { GtfsRowOp, Touch } from "@/lib/explorer/edit/types";

/** The new first and last departure; null leaves that end. */
export interface ServiceSpan {
  first_s: number | null;
  last_s: number | null;
}

export interface SpanFacts {
  line: string;
  /** Per group edited: a day it runs on (the Explorer's date where it is
   * one), for the Apply bar's trips and vehicles before and after. */
  days: string[];
  added: number;
  removed: number;
  /** Frequency windows moved or dropped. */
  windows: number;
  /** Every trip it touches, before or after it: what the edit costs. */
  trip_idxs: number[];
}

interface TripRow {
  trip_idx: number;
  trip_id: string;
  service_idx: number;
  pattern_idx: number;
  dep: number | null;
  freq: boolean;
}

interface FreqRow {
  trip_idx: number;
  trip_id: string;
  service_idx: number;
  start_s: number;
  end_s: number;
  headway_s: number;
  exact_times: number;
}

const list = (xs: number[]) => (xs.length ? xs.map(sqlNumber).join(", ") : "NULL");

/** The gap between the first two distinct departures of `deps` (sorted). */
function firstGap(deps: number[]): number | null {
  const next = deps.find((d) => d > deps[0]);
  return next === undefined ? null : next - deps[0];
}

export async function setSpan(
  db: SqlRunner,
  route_idx: number,
  /** The direction's patterns. */
  patterns: number[],
  span: ServiceSpan,
  /** The groups picked, whole (dayTypeGroups). */
  groups: DayTypeGroup[],
  /** The Explorer's date: the day the Apply bar counts a group on, where it
   * is one of its days. */
  date: string,
  random: () => number = Math.random
): Promise<Built<SpanFacts>> {
  const r = sqlNumber(route_idx);
  const [route] = await db.all<{ route_id: string; line: string }>(`
    SELECT route_id, COALESCE(NULLIF(short_name, ''), long_name, route_id) AS line
    FROM routes WHERE route_idx = ${r}`);
  if (!route) throw new Error(`No route ${route_idx}`);
  const facts: SpanFacts = {
    line: route.line,
    days: groups.map((g) => (g.days.includes(date) ? date : g.days[0])),
    added: 0,
    removed: 0,
    windows: 0,
    trip_idxs: [],
  };
  const refused = (code: string, params?: Record<string, string | number>): Built<SpanFacts> => ({
    ok: false,
    refused: { code, severity: "error", params },
    facts,
    checks: [],
  });
  const { first_s, last_s } = span;
  if (first_s !== null && last_s !== null && last_s < first_s) return refused("goat_span_order");
  if ((first_s === null && last_s === null) || !groups.length) return refused("goat_span_unchanged");
  const units = serviceUnits(groups);
  if (!units) return refused("goat_span_no_common_service");

  const trips = await db.all<TripRow>(`
    SELECT t.trip_idx, t.trip_id, t.service_idx, t.pattern_idx, t.first_dep_s AS dep,
           t.trip_idx IN (SELECT trip_idx FROM frequencies) AS freq
    FROM trips t
    WHERE t.route_idx = ${r} AND t.pattern_idx IN (${list(patterns)})
    ORDER BY t.trip_idx`);
  const freqs = await db.all<FreqRow>(`
    SELECT f.trip_idx, t.trip_id, t.service_idx, f.start_s, f.end_s, f.headway_s,
           CAST(f.exact_times AS INTEGER) AS exact_times
    FROM frequencies f JOIN trips t USING (trip_idx)
    WHERE t.route_idx = ${r} AND t.pattern_idx IN (${list(patterns)})
    ORDER BY f.trip_idx, f.start_s`);

  const remove = new Set<number>();
  const copies: { template: number; dep: number }[] = [];
  // Frequency windows changed: each one's new bounds, or null where it goes.
  const windows: { row: FreqRow; next: { start_s: number; end_s: number } | null }[] = [];

  for (const u of units) {
    const common = new Set(u.common);
    const onGroup = new Set(u.services);
    const timed = trips.filter((t) => !t.freq && onGroup.has(t.service_idx) && t.dep !== null);
    const carriers = timed
      .filter((t) => common.has(t.service_idx))
      .sort((a, b) => (a.dep as number) - (b.dep as number) || a.trip_idx - b.trip_idx);
    const windowed = freqs.filter((f) => onGroup.has(f.service_idx));
    const carrying = windowed.filter((f) => common.has(f.service_idx));
    if (carrying.length && carriers.length) return refused("goat_span_mixed_frequencies");
    const deps = carriers.map((t) => t.dep as number);
    const added: number[] = [];

    // Timetabled trips: those outside the span go; the ends extend at the
    // gap between their two outermost departures.
    for (const t of timed) {
      const dep = t.dep as number;
      if ((first_s !== null && dep < first_s) || (last_s !== null && dep > last_s)) remove.add(t.trip_idx);
    }
    if (first_s !== null && deps.length && first_s < deps[0]) {
      const h = firstGap(deps);
      if (h === null) return refused("goat_span_no_headway");
      for (let dep = deps[0] - h; dep >= first_s; dep -= h)
        if (last_s === null || dep <= last_s) {
          copies.push({ template: carriers[0].trip_idx, dep });
          added.push(dep);
        }
    }
    if (last_s !== null && deps.length && last_s > deps[deps.length - 1]) {
      const h = firstGap([...deps].reverse().map((d) => -d));
      if (h === null) return refused("goat_span_no_headway");
      const last = carriers[carriers.length - 1];
      for (let dep = (last.dep as number) + h; dep <= last_s; dep += h)
        if (first_s === null || dep >= first_s) {
          copies.push({ template: last.trip_idx, dep });
          added.push(dep);
        }
    }

    // Frequency windows: cut to the span, the outermost carrying ones
    // stretched to it.
    const earliest = carrying.reduce<FreqRow | null>((a, b) => (!a || b.start_s < a.start_s ? b : a), null);
    const latest = carrying.reduce<FreqRow | null>((a, b) => (!a || b.end_s > a.end_s ? b : a), null);
    let left = 0;
    for (const f of windowed) {
      let start = f.start_s;
      let end = f.end_s;
      if (first_s !== null && (start < first_s || f === earliest)) start = first_s;
      if (last_s !== null && (end > last_s || f === latest)) end = last_s;
      const next = start < end ? { start_s: start, end_s: end } : null;
      if (next) left++;
      if (!next || next.start_s !== f.start_s || next.end_s !== f.end_s) windows.push({ row: f, next });
    }
    // Trips left without a window go with them.
    for (const idx of new Set(windowed.map((f) => f.trip_idx)))
      if (
        windowed.filter((f) => f.trip_idx === idx).every((f) => windows.some((w) => w.row === f && !w.next))
      )
        remove.add(idx);

    const stays = timed.some((t) => !remove.has(t.trip_idx)) || added.length > 0 || left > 0;
    if ((timed.length || windowed.length) && !stays) return refused("goat_span_empty");
  }
  // Windows of trips that go are deleted with them.
  const changed = windows.filter((w) => !remove.has(w.row.trip_idx));

  facts.removed = remove.size;
  facts.added = copies.length;
  facts.windows = changed.length;
  if (!remove.size && !copies.length && !changed.length) return refused("goat_span_unchanged");

  // New trips, numbered after every trip there is (inTripRange finds them).
  const [{ next }] = await db.all<{ next: number }>(
    "SELECT CAST(COALESCE(max(trip_idx) + 1, 0) AS INTEGER) AS next FROM trips"
  );
  const ids = await freshTripIds(db, copies.length, random);
  const made = copies.map((c, i) => ({ ...c, trip_idx: next + i, trip_id: ids[i] }));
  const byIdx = new Map(trips.map((t) => [t.trip_idx, t]));
  const shiftOf = (m: { template: number; dep: number }) => m.dep - (byIdx.get(m.template)?.dep as number);

  facts.trip_idxs = [
    ...new Set([...remove, ...changed.map((w) => w.row.trip_idx), ...made.map((m) => m.trip_idx)]),
  ];
  const all = list(facts.trip_idxs);
  const affectedPatterns = [
    ...new Set([...remove, ...made.map((m) => m.template)].map((idx) => byIdx.get(idx)?.pattern_idx ?? -1)),
  ].filter((p) => p >= 0);

  // Copies first: their template may be a trip that goes.
  const removed = list([...remove]);
  const sql = [
    ...made.flatMap((m) => {
      const by = shiftOf(m);
      return [
        `INSERT INTO trips SELECT * REPLACE (${m.trip_idx} AS trip_idx, ${sqlText(m.trip_id)} AS trip_id,
           CAST(NULL AS INTEGER) AS block_idx, first_dep_s + ${by} AS first_dep_s, last_arr_s + ${by} AS last_arr_s)
         FROM trips WHERE trip_idx = ${m.template}`,
        `INSERT INTO stop_times SELECT * REPLACE (${m.trip_idx} AS trip_idx, arrival_s + ${by} AS arrival_s,
           departure_s + ${by} AS departure_s) FROM stop_times WHERE trip_idx = ${m.template}`,
        `INSERT INTO stop_time_extras SELECT * REPLACE (${m.trip_idx} AS trip_idx)
         FROM stop_time_extras WHERE trip_idx = ${m.template}`,
      ];
    }),
    ...changed.flatMap(({ row, next: w }) => [
      `DELETE FROM frequencies WHERE trip_idx = ${row.trip_idx} AND start_s = ${row.start_s}`,
      ...(w
        ? [
            `INSERT INTO frequencies (trip_idx, start_s, end_s, headway_s, exact_times)
             VALUES (${row.trip_idx}, ${w.start_s}, ${w.end_s}, ${row.headway_s}, ${row.exact_times})`,
          ]
        : []),
    ]),
    `DELETE FROM stop_time_extras WHERE trip_idx IN (${removed})`,
    `DELETE FROM stop_times WHERE trip_idx IN (${removed})`,
    `DELETE FROM frequencies WHERE trip_idx IN (${removed})`,
    `DELETE FROM trips WHERE trip_idx IN (${removed})`,
    `UPDATE patterns SET
       n_trips = (SELECT CAST(count(*) AS INTEGER) FROM trips t WHERE t.pattern_idx = patterns.pattern_idx)
     WHERE pattern_idx IN (${list(affectedPatterns)})`,
  ];

  // The same as the bundle's rows.
  const calls = await db.all<{
    trip_idx: number;
    trip_id: string;
    stop_sequence: number;
    stop_id: string;
    arrival_s: number | null;
    departure_s: number | null;
  }>(`
    SELECT st.trip_idx, t.trip_id, st.stop_sequence, s.stop_id, st.arrival_s, st.departure_s
    FROM stop_times st JOIN trips t USING (trip_idx) JOIN stops s USING (stop_idx)
    WHERE st.trip_idx IN (${list([...remove, ...made.map((m) => m.template)])})
    ORDER BY st.trip_idx, st.stop_sequence`);
  const callsOf = (idx: number) => calls.filter((c) => c.trip_idx === idx);
  const time = (s: number | null, by: number) => (s === null ? null : gtfsTime(s + by));
  const fields = await db.all<{
    trip_idx: number;
    route_id: string;
    service_id: string;
    direction_id: number | null;
    headsign: string | null;
    short_name: string | null;
  }>(`
    SELECT t.trip_idx, r.route_id, sv.service_id, t.direction_id, t.headsign, t.short_name
    FROM trips t JOIN routes r USING (route_idx) JOIN services sv USING (service_idx)
    WHERE t.trip_idx IN (${list(made.map((m) => m.template))})`);
  const tripFields = new Map(fields.map((x) => [x.trip_idx, x]));
  const removedFreqs = freqs.filter((f) => remove.has(f.trip_idx));

  const gtfs: GtfsRowOp[] = [
    ...made.flatMap((m): GtfsRowOp[] => {
      const t = byIdx.get(m.template) as TripRow;
      const by = shiftOf(m);
      const f = tripFields.get(m.template);
      return [
        {
          role: "trips",
          op: "insert",
          key: { trip_id: m.trip_id },
          values: {
            route_id: f?.route_id ?? route.route_id,
            service_id: f?.service_id ?? null,
            direction_id: f?.direction_id ?? null,
            trip_headsign: f?.headsign ?? null,
            trip_short_name: f?.short_name ?? null,
            block_id: null,
          },
          copy_of: { trip_id: t.trip_id },
        },
        ...callsOf(m.template).map(
          (c): GtfsRowOp => ({
            role: "stop_times",
            op: "insert",
            key: { trip_id: m.trip_id, stop_sequence: c.stop_sequence },
            values: {
              stop_id: c.stop_id,
              arrival_time: time(c.arrival_s, by),
              departure_time: time(c.departure_s, by),
            },
            copy_of: { trip_id: t.trip_id, stop_sequence: c.stop_sequence },
          })
        ),
      ];
    }),
    ...changed.flatMap(({ row, next: w }): GtfsRowOp[] => [
      { role: "frequencies", op: "delete", key: { trip_id: row.trip_id, start_time: gtfsTime(row.start_s) } },
      ...(w
        ? [
            {
              role: "frequencies",
              op: "insert",
              key: { trip_id: row.trip_id, start_time: gtfsTime(w.start_s) },
              values: {
                end_time: gtfsTime(w.end_s),
                headway_secs: row.headway_s,
                exact_times: row.exact_times,
              },
            } as GtfsRowOp,
          ]
        : []),
    ]),
    ...[...remove].flatMap((idx) =>
      callsOf(idx).map(
        (c): GtfsRowOp => ({
          role: "stop_times",
          op: "delete",
          key: { trip_id: c.trip_id, stop_sequence: c.stop_sequence },
        })
      )
    ),
    ...removedFreqs.map(
      (f): GtfsRowOp => ({
        role: "frequencies",
        op: "delete",
        key: { trip_id: f.trip_id, start_time: gtfsTime(f.start_s) },
      })
    ),
    ...[...remove].map(
      (idx): GtfsRowOp => ({ role: "trips", op: "delete", key: { trip_id: byIdx.get(idx)?.trip_id ?? "" } })
    ),
  ];

  const touches: Touch[] = [
    { table: "trips", where: `trip_idx IN (${all})` },
    { table: "stop_times", where: `trip_idx IN (${all})` },
    { table: "stop_time_extras", where: `trip_idx IN (${all})` },
    { table: "frequencies", where: `trip_idx IN (${all})` },
    { table: "patterns", where: `pattern_idx IN (${list(affectedPatterns)})` },
  ];
  const checks: Check[] = [];
  return { ok: true, rows: { kind: "span", touches, sql, gtfs }, facts, checks };
}
