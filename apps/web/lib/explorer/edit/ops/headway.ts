/**
 * 4.1 Headway by time period (01-editing-operations § 4): one direction of a
 * line runs every N minutes in a period, on the service patterns picked.
 *
 * Decided 25 Nov 2026, in the service dialog:
 * - The departures of a period run every N minutes from its first departure
 *   now, every departure of the direction counting (short turns and branches
 *   alike, as the Overview's headways count them).
 * - Each new departure keeps the trip nearest it in time, within half a
 *   headway, moved whole: its id, pattern and block stay, its stop times
 *   move by the same amount. Trips no departure keeps are deleted. A
 *   departure no trip is near gets a copy of the nearest trip kept (its
 *   pattern, path, running times and service), with an id of its own and no
 *   block; the server copies what the browser does not hold (`copy_of`). So
 *   a period's mix of short turns stays about as it was.
 * - A trip runs on every day of its service, and the patterns picked may
 *   share services with each other or with others: patterns sharing a
 *   service are edited together (the dialog links them). Within such a group
 *   the trips of the services that run on every one of its days take the new
 *   departures; trips of services that run on some of its days only (a
 *   school day's extras) leave the period, so every day of the group runs
 *   every N minutes there.
 * - A feed may give each day (or weekday) a service of its own, each with a
 *   whole day's trips: no service runs on all the days, but each runs on
 *   days of its own alone. Then each is given the new departures alike. A
 *   group whose services neither run on all its days nor on days of their
 *   own is refused: it would take a new calendar.
 * - Frequency-based trips (frequencies.txt) get the new headway in the
 *   period instead, their windows split at its bounds. A period with both
 *   kinds of trips is refused.
 */
import type { SqlRunner } from "@/lib/explorer/db/types";
import type { CalendarDay, DayType } from "@/lib/explorer/derive/serviceCalendar";
import { gtfsTime } from "@/lib/explorer/edit/ops/deleteLine";
import type { Built, Check } from "@/lib/explorer/edit/ops/types";
import { sqlNumber, sqlText } from "@/lib/explorer/edit/sql";
import type { GtfsRowOp, Touch } from "@/lib/explorer/edit/types";

/** The bounds of a headway in minutes (goat_headway_out_of_range). */
export const HEADWAY_MIN = 2;
export const HEADWAY_MAX = 120;

/** A period's new headway. */
export interface HeadwayPeriod {
  key: string;
  start_s: number;
  end_s: number;
  minutes: number;
}

/** Patterns that share a service, edited together. */
export interface DayTypeGroup {
  /** Day type keys (`DayType.key`). */
  types: string[];
  days: string[];
  /** The direction's services running on some day of the group, and those
   * running on every one. */
  services: number[];
  common: number[];
  /** Where no service runs on every day: the service sets its days run on,
   * each set on days of its own (a feed's service per day or weekday);
   * empty where they overlap. */
  own: number[][];
}

/** Whether a group can be edited: a service on all its days, or services
 * each on days of their own. */
export function editableGroup(g: DayTypeGroup): boolean {
  return g.common.length > 0 || g.own.length > 0;
}

/**
 * The day types linked by the services they share, among `services` (the
 * direction's): each group the types that change together. Pure.
 */
export function dayTypeGroups(types: DayType[], days: CalendarDay[], services: number[]): DayTypeGroup[] {
  const mine = new Set(services);
  const onDay = new Map(days.map((d) => [d.date, d.services.filter((s) => mine.has(s))]));
  const servicesOf = new Map(
    types.map((ty) => [ty.key, new Set(ty.days.flatMap((d) => onDay.get(d) ?? []))])
  );
  const parent = new Map(types.map((ty) => [ty.key, ty.key]));
  const find = (k: string): string => {
    while (parent.get(k) !== k) k = parent.get(k) as string;
    return k;
  };
  for (const a of types)
    for (const b of types) {
      if (a.key >= b.key) continue;
      const sa = servicesOf.get(a.key) as Set<number>;
      if ([...(servicesOf.get(b.key) as Set<number>)].some((s) => sa.has(s)))
        parent.set(find(a.key), find(b.key));
    }
  const groups = new Map<string, DayType[]>();
  for (const ty of types) groups.set(find(ty.key), [...(groups.get(find(ty.key)) ?? []), ty]);
  return [...groups.values()].map((group) => {
    const groupDays = group.flatMap((ty) => ty.days).sort();
    const sets = groupDays.map((d) => new Set(onDay.get(d) ?? []));
    const common = [...(sets[0] ?? [])].filter((s) => sets.every((set) => set.has(s))).sort((x, y) => x - y);
    const services = [...new Set(sets.flatMap((set) => [...set]))].sort((x, y) => x - y);
    // The days' service sets; disjoint sets are services on days of their own.
    const keys = new Map<string, number[]>();
    for (const set of sets) {
      const list = [...set].sort((x, y) => x - y);
      if (list.length) keys.set(list.join(","), list);
    }
    const distinct = [...keys.values()];
    const disjoint = distinct.flat().length === new Set(distinct.flat()).size;
    const own = !common.length && disjoint ? distinct : [];
    return { types: group.map((ty) => ty.key), days: groupDays, services, common, own };
  });
}

export interface HeadwayFacts {
  line: string;
  /** Per group edited: a day it runs on (the Explorer's date where it is
   * one), for the Apply bar's trips and vehicles before and after. */
  days: string[];
  moved: number;
  added: number;
  removed: number;
  /** Frequency windows given the new headway. */
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

/** A part of a frequency window, as it is cut up. */
interface Piece {
  start_s: number;
  end_s: number;
  headway_s: number;
}

/** `pc` cut at a period's bounds: its part in the period runs every `h`,
 * or goes where `h` is null. */
function splitPiece(pc: Piece, p: HeadwayPeriod, h: number | null): Piece[] {
  if (pc.end_s <= p.start_s || pc.start_s >= p.end_s) return [pc];
  const out: Piece[] = [];
  if (pc.start_s < p.start_s) out.push({ ...pc, end_s: p.start_s });
  if (h !== null)
    out.push({ start_s: Math.max(pc.start_s, p.start_s), end_s: Math.min(pc.end_s, p.end_s), headway_s: h });
  if (pc.end_s > p.end_s) out.push({ ...pc, start_s: p.end_s });
  return out;
}

/** Pieces in a row at the same headway, one again. */
function joinPieces(pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const pc of [...pieces].sort((a, b) => a.start_s - b.start_s)) {
    const prev = out[out.length - 1];
    if (prev && prev.end_s === pc.start_s && prev.headway_s === pc.headway_s) prev.end_s = pc.end_s;
    else out.push({ ...pc });
  }
  return out;
}

/** Fresh `goat_` trip ids, none the snapshot has. */
export async function freshTripIds(db: SqlRunner, n: number, random: () => number): Promise<string[]> {
  const out: string[] = [];
  while (out.length < n) {
    const id = `goat_${Math.floor(random() * 0x100000000)
      .toString(16)
      .padStart(8, "0")}`;
    if (out.includes(id)) continue;
    const [taken] = await db.all(`SELECT 1 FROM trips WHERE trip_id = ${sqlText(id)}`);
    if (!taken) out.push(id);
  }
  return out;
}

/** The service sets a group's departures are given: its services on all
 * its days carrying them (the others' trips leave), or each set of
 * services on days of their own alike. */
export interface ServiceUnit {
  common: number[];
  services: number[];
}

/** The units of the groups picked; null where a group has neither (it
 * would take a new calendar). */
export function serviceUnits(groups: DayTypeGroup[]): ServiceUnit[] | null {
  const units: ServiceUnit[] = [];
  for (const g of groups) {
    if (g.common.length) units.push({ common: g.common, services: g.services });
    else if (g.own.length) units.push(...g.own.map((set) => ({ common: set, services: set })));
    else return null;
  }
  return units;
}

/** What happens to the timetabled trips of one period. */
interface Plan {
  keep: Map<number, number>; // trip_idx → seconds moved
  remove: Set<number>;
  copies: { template: number; dep: number }[];
}

/** New departures every `h` from `start` up to `end`, each matched to the
 * trip within half a headway of it, in order; the rest removed or copied. */
export function respace(
  candidates: { trip_idx: number; dep: number }[],
  start: number,
  end: number,
  h: number
): Plan {
  const sorted = [...candidates].sort((a, b) => a.dep - b.dep || a.trip_idx - b.trip_idx);
  const plan: Plan = { keep: new Map(), remove: new Set(), copies: [] };
  const targets: number[] = [];
  for (let t = start; t < end; t += h) targets.push(t);
  let j = 0;
  const unmatched: number[] = [];
  for (const t of targets) {
    while (j < sorted.length && sorted[j].dep < t - h / 2) plan.remove.add(sorted[j++].trip_idx);
    if (j < sorted.length && Math.abs(sorted[j].dep - t) <= h / 2) {
      plan.keep.set(sorted[j].trip_idx, t - sorted[j].dep);
      j++;
    } else unmatched.push(t);
  }
  for (; j < sorted.length; j++) plan.remove.add(sorted[j].trip_idx);
  // A departure no trip is near: a copy of the nearest trip kept, else of
  // the nearest at all (none kept: every trip was far from every departure).
  const kept = sorted.filter((c) => plan.keep.has(c.trip_idx));
  for (const t of unmatched) {
    const from = kept.length ? kept : sorted;
    const near = from.reduce((a, b) => (Math.abs(b.dep - t) < Math.abs(a.dep - t) ? b : a));
    plan.copies.push({ template: near.trip_idx, dep: t });
  }
  return plan;
}

export async function setHeadways(
  db: SqlRunner,
  route_idx: number,
  /** The direction's patterns. */
  patterns: number[],
  periods: HeadwayPeriod[],
  /** The groups picked, whole (dayTypeGroups). */
  groups: DayTypeGroup[],
  /** The Explorer's date: the day the Apply bar counts a group on, where it
   * is one of its days. */
  date: string,
  random: () => number = Math.random
): Promise<Built<HeadwayFacts>> {
  const r = sqlNumber(route_idx);
  const [route] = await db.all<{ route_id: string; line: string }>(`
    SELECT route_id, COALESCE(NULLIF(short_name, ''), long_name, route_id) AS line
    FROM routes WHERE route_idx = ${r}`);
  if (!route) throw new Error(`No route ${route_idx}`);
  const facts: HeadwayFacts = {
    line: route.line,
    days: groups.map((g) => (g.days.includes(date) ? date : g.days[0])),
    moved: 0,
    added: 0,
    removed: 0,
    windows: 0,
    trip_idxs: [],
  };
  const refused = (code: string, params?: Record<string, string | number>): Built<HeadwayFacts> => ({
    ok: false,
    refused: { code, severity: "error", params },
    facts,
    checks: [],
  });
  const bad = periods.find((p) => !(p.minutes >= HEADWAY_MIN && p.minutes <= HEADWAY_MAX));
  if (bad) return refused("goat_headway_out_of_range", { min: HEADWAY_MIN, max: HEADWAY_MAX });
  if (!groups.length || !periods.length) return refused("goat_headway_nothing");

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

  const keep = new Map<number, number>();
  const remove = new Set<number>();
  const copies: { template: number; dep: number }[] = [];
  // Frequency windows: each one's pieces, cut by every period in turn.
  const cuts = new Map<FreqRow, Piece[]>();

  // Each group, or each set of services on days of its own, given the new
  // departures: the services on all its days carry them, the others leave.
  const units = serviceUnits(groups);
  if (!units) return refused("goat_headway_no_common_service");
  for (const g of units) {
    const common = new Set(g.common);
    const onGroup = new Set(g.services);
    for (const p of periods) {
      const h = p.minutes * 60;
      const timed = trips.filter(
        (t) =>
          !t.freq && onGroup.has(t.service_idx) && t.dep !== null && t.dep >= p.start_s && t.dep < p.end_s
      );
      const windowed = freqs.filter(
        (f) => onGroup.has(f.service_idx) && f.start_s < p.end_s && f.end_s > p.start_s
      );
      if (windowed.some((f) => common.has(f.service_idx)) && timed.some((t) => common.has(t.service_idx)))
        return refused("goat_headway_mixed_frequencies", { period: p.key });

      // Frequency windows: the period's part runs every N, or leaves it where
      // its service runs on some of the group's days only. A window across
      // two periods is cut by both, the second cutting what the first left.
      for (const f of windowed) {
        const was = cuts.get(f) ?? [{ start_s: f.start_s, end_s: f.end_s, headway_s: f.headway_s }];
        cuts.set(
          f,
          was.flatMap((pc) => splitPiece(pc, p, common.has(f.service_idx) ? h : null))
        );
      }
      // Timetabled trips of the services on some of the group's days only
      // leave the period; the common ones take its new departures.
      for (const t of timed) if (!common.has(t.service_idx)) remove.add(t.trip_idx);
      if (windowed.some((f) => common.has(f.service_idx))) continue;
      const candidates = timed
        .filter((t) => common.has(t.service_idx))
        .map((t) => ({ trip_idx: t.trip_idx, dep: t.dep as number }));
      const first = timed.length ? Math.min(...timed.map((t) => t.dep as number)) : p.start_s;
      if (!candidates.length) {
        // Nothing of the common services in the period: its departures copy
        // the nearest trip of theirs outside it.
        const outside = trips.filter((t) => !t.freq && common.has(t.service_idx) && t.dep !== null);
        if (!outside.length) return refused("goat_headway_no_trips", { period: p.key });
        const near = outside.reduce((a, b) =>
          Math.abs((b.dep as number) - first) < Math.abs((a.dep as number) - first) ? b : a
        );
        for (let dep = first; dep < p.end_s; dep += h) copies.push({ template: near.trip_idx, dep });
        continue;
      }
      const plan = respace(candidates, first, p.end_s, h);
      for (const [idx, by] of plan.keep) keep.set(idx, by);
      for (const idx of plan.remove) remove.add(idx);
      copies.push(...plan.copies);
    }
  }

  const windows = [...cuts]
    .map(([row, pieces]) => ({ row, pieces: joinPieces(pieces) }))
    .filter(
      ({ row, pieces }) =>
        !(
          pieces.length === 1 &&
          pieces[0].start_s === row.start_s &&
          pieces[0].end_s === row.end_s &&
          pieces[0].headway_s === row.headway_s
        )
    );

  // Shown as it is built: nothing moved, nothing to apply.
  const moved = [...keep].filter(([, by]) => by !== 0);
  facts.moved = moved.length;
  facts.removed = remove.size;
  facts.added = copies.length;
  facts.windows = windows.length;
  if (!moved.length && !remove.size && !copies.length && !windows.length)
    return refused("goat_headway_unchanged");

  // New trips, numbered after every trip there is (inTripRange finds them).
  const [{ next }] = await db.all<{ next: number }>(
    "SELECT CAST(COALESCE(max(trip_idx) + 1, 0) AS INTEGER) AS next FROM trips"
  );
  const ids = await freshTripIds(db, copies.length, random);
  const made = copies.map((c, i) => ({ ...c, trip_idx: next + i, trip_id: ids[i] }));
  const byIdx = new Map(trips.map((t) => [t.trip_idx, t]));

  const shifts = moved.map(([idx, by]) => ({ idx, by }));
  const touched = [
    ...new Set([...remove, ...shifts.map((s) => s.idx), ...windows.map((w) => w.row.trip_idx)]),
  ];
  facts.trip_idxs = [...touched, ...made.map((m) => m.trip_idx)];
  const all = list(facts.trip_idxs);
  const affectedPatterns = [
    ...new Set([...remove, ...made.map((m) => m.template)].map((idx) => byIdx.get(idx)?.pattern_idx ?? -1)),
  ].filter((p) => p >= 0);

  // Copies first, from the trips as they are: their template may be a trip
  // that moves or goes, and the server copies it as it was.
  const removed = list([...remove]);
  const sql = [
    ...made.flatMap((m) => {
      const t = byIdx.get(m.template) as TripRow;
      const by = m.dep - (t.dep as number);
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
    `DELETE FROM stop_time_extras WHERE trip_idx IN (${removed})`,
    `DELETE FROM stop_times WHERE trip_idx IN (${removed})`,
    `DELETE FROM trips WHERE trip_idx IN (${removed})`,
    ...shifts.flatMap(({ idx, by }) => [
      `UPDATE stop_times SET arrival_s = arrival_s + ${by}, departure_s = departure_s + ${by} WHERE trip_idx = ${idx}`,
      `UPDATE trips SET first_dep_s = first_dep_s + ${by}, last_arr_s = last_arr_s + ${by} WHERE trip_idx = ${idx}`,
    ]),
    ...windows.flatMap(({ row, pieces }) => [
      `DELETE FROM frequencies WHERE trip_idx = ${row.trip_idx} AND start_s = ${row.start_s}`,
      ...pieces.map(
        (pc) =>
          `INSERT INTO frequencies (trip_idx, start_s, end_s, headway_s, exact_times)
           VALUES (${row.trip_idx}, ${pc.start_s}, ${pc.end_s}, ${pc.headway_s}, ${row.exact_times})`
      ),
    ]),
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
    WHERE st.trip_idx IN (${list([...remove, ...shifts.map((s) => s.idx), ...made.map((m) => m.template)])})
    ORDER BY st.trip_idx, st.stop_sequence`);
  const callsOf = (idx: number) => calls.filter((c) => c.trip_idx === idx);
  const time = (s: number | null, by: number) => (s === null ? null : gtfsTime(s + by));
  const ids2 = await db.all<{
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
  const tripFields = new Map(ids2.map((x) => [x.trip_idx, x]));

  const gtfs: GtfsRowOp[] = [
    ...[...remove].flatMap((idx) =>
      callsOf(idx).map(
        (c): GtfsRowOp => ({
          role: "stop_times",
          op: "delete",
          key: { trip_id: c.trip_id, stop_sequence: c.stop_sequence },
        })
      )
    ),
    ...[...remove].map(
      (idx): GtfsRowOp => ({ role: "trips", op: "delete", key: { trip_id: byIdx.get(idx)?.trip_id ?? "" } })
    ),
    ...shifts.flatMap(({ idx, by }) =>
      callsOf(idx)
        .filter((c) => c.arrival_s !== null || c.departure_s !== null)
        .map(
          (c): GtfsRowOp => ({
            role: "stop_times",
            op: "update",
            key: { trip_id: c.trip_id, stop_sequence: c.stop_sequence },
            values: {
              ...(c.arrival_s !== null ? { arrival_time: time(c.arrival_s, by) } : {}),
              ...(c.departure_s !== null ? { departure_time: time(c.departure_s, by) } : {}),
            },
          })
        )
    ),
    ...made.flatMap((m): GtfsRowOp[] => {
      const t = byIdx.get(m.template) as TripRow;
      const by = m.dep - (t.dep as number);
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
    ...windows.flatMap(({ row, pieces }): GtfsRowOp[] => [
      { role: "frequencies", op: "delete", key: { trip_id: row.trip_id, start_time: gtfsTime(row.start_s) } },
      ...pieces.map(
        (pc): GtfsRowOp => ({
          role: "frequencies",
          op: "insert",
          key: { trip_id: row.trip_id, start_time: gtfsTime(pc.start_s) },
          values: { end_time: gtfsTime(pc.end_s), headway_secs: pc.headway_s, exact_times: row.exact_times },
        })
      ),
    ]),
  ];

  const touches: Touch[] = [
    { table: "trips", where: `trip_idx IN (${all})` },
    { table: "stop_times", where: `trip_idx IN (${all})` },
    { table: "stop_time_extras", where: `trip_idx IN (${all})` },
    { table: "frequencies", where: `trip_idx IN (${all})` },
    { table: "patterns", where: `pattern_idx IN (${list(affectedPatterns)})` },
  ];
  const checks: Check[] = [];
  return { ok: true, rows: { kind: "headway", touches, sql, gtfs }, facts, checks };
}
