/**
 * 2.3 Delete stop (01-editing-operations § 2; board 29): the stop goes from
 * the network, and from every trip that calls there. Later stops keep their
 * times; stop sequences are not renumbered (GTFS needs them increasing, not
 * consecutive). The cascade, in one change:
 *
 * - its stop times go, and any extras they had;
 * - each pattern through it loses it, and becomes another pattern of its
 *   route where that one runs the same stops (a short turn that differed
 *   only by this stop), its trips with it;
 * - a trip's first and last times, and its length where that is measured
 *   from its stops (the feed's distances, or stop to stop), follow;
 * - a trip that ended here and was headed for it is headed for its new last
 *   stop (`trip_headsign_matches_intermediate_stop` otherwise);
 * - the line through the stops, for trips without a shape, is drawn anew;
 * - transfers, pathways and stop areas naming it go on save (the server's
 *   cascade: the browser holds none).
 *
 * Refused, with the reason, when a trip would keep fewer than two stops
 * (`unusable_trip`, stricter in GOAT), would start or end, where it did not
 * before, at a stop without a time (`missing_trip_edge`), or is
 * frequency-based and would lose the first stop its runs are timed from
 * (`goat_frequency_start`): no time is ever made up.
 *
 * What lies under a stop or platform (its boarding areas, or whatever a feed
 * puts there) goes with it; a stop or platform under it is kept, on its own.
 *
 * A station goes with everything under it: its stops and platforms, each
 * as above, in the one change and under the same refusals, and its
 * entrances and generic nodes (cascade decided 5 Nov 2026). Any other
 * location (an entrance, a node) is called at by no trip: it goes alone.
 */
import type { SqlRunner } from "@/lib/explorer/db/types";
import { METRES_PER_UNIT } from "@/lib/explorer/derive/stopsLine";
import { STOP_CHAIN_PREFIX, chainId, chainShapeSql, chainStopsSql } from "@/lib/explorer/edit/ops/chains";
import { metresSql } from "@/lib/explorer/edit/ops/geo";
import type { Built, Check } from "@/lib/explorer/edit/ops/types";
import { sqlNumber, sqlText } from "@/lib/explorer/edit/sql";
import type { GtfsRowOp, Touch } from "@/lib/explorer/edit/types";

export interface DeleteStopFacts {
  stop_id: string;
  name: string;
  location_type: number;
  /** A station's: its stops and platforms, entrances and generic nodes, all
   * deleted with it. */
  entrances: number;
  nodes: number;
  platforms: number;
  /** Trips calling there (a station: at its stops and platforms), and the
   * routes they run on. */
  trips: number;
  routes: number[];
  /** Patterns through it, and those of them that became another. */
  patterns: number;
  merged: number;
  /** Trips now headed for their new last stop. */
  headsigns: number;
  /** The trips, for what the edit costs. */
  trip_idxs: number[];
}

const list = (xs: number[]) => (xs.length ? xs.map(sqlNumber).join(", ") : "NULL");

export async function deleteStop(
  db: SqlRunner,
  stop_idx: number,
  shapeDistUnit: string | null
): Promise<Built<DeleteStopFacts>> {
  const n = sqlNumber(stop_idx);
  const [stop] = await db.all<{
    stop_id: string;
    name: string | null;
    place: string;
    location_type: number;
  }>(`
    SELECT s.stop_id, s.name, COALESCE(p.name, s.name, s.stop_id) AS place, COALESCE(s.location_type, 0) AS location_type
    FROM stops s LEFT JOIN stops p ON p.stop_idx = s.parent_idx WHERE s.stop_idx = ${n}`);
  if (!stop) throw new Error(`No stop ${stop_idx}`);

  const facts: DeleteStopFacts = {
    stop_id: stop.stop_id,
    name: stop.place,
    location_type: stop.location_type,
    entrances: 0,
    nodes: 0,
    platforms: 0,
    trips: 0,
    routes: [],
    patterns: 0,
    merged: 0,
    headsigns: 0,
    trip_idxs: [],
  };
  if (stop.location_type === 0) return removeStops(db, [stop_idx], shapeDistUnit, facts);
  return deleteLocation(db, stop_idx, shapeDistUnit, facts);
}

/** The stops `gone` (stops or platforms) out of the network and every trip
 * calling there, with their boarding areas: the cascade above, in one
 * change. The rows of a station's own delete are added by the caller. */
export async function removeStops(
  db: SqlRunner,
  gone: number[],
  shapeDistUnit: string | null,
  facts: DeleteStopFacts,
  /** Only these trips (3.2, a stop off a line): the stops themselves stay. */
  only?: number[]
): Promise<Built<DeleteStopFacts>> {
  const set = new Set(gone);
  const n = list(gone);
  const inScope = only ? `AND trip_idx IN (${list(only)})` : "";
  const trips = await db.all<{
    trip_idx: number;
    trip_id: string;
    route_idx: number;
    left: number;
    edge_untimed: boolean;
    frequency_start: boolean;
    ends_here: boolean;
    headsign: string | null;
    new_last: string | null;
  }>(`
    WITH aff AS (SELECT DISTINCT trip_idx FROM stop_times WHERE stop_idx IN (${n}) ${inScope}),
    rest AS (
      SELECT st.*, COALESCE(p.name, s.name, s.stop_id) AS place
      FROM stop_times st JOIN aff USING (trip_idx)
      JOIN stops s ON s.stop_idx = st.stop_idx LEFT JOIN stops p ON p.stop_idx = s.parent_idx
      WHERE st.stop_idx NOT IN (${n})
    ),
    ends AS (
      SELECT trip_idx, count(*) AS left,
             arg_min_null(arrival_s, stop_sequence) AS a0, arg_min_null(departure_s, stop_sequence) AS d0,
             arg_max_null(arrival_s, stop_sequence) AS a1, arg_max_null(departure_s, stop_sequence) AS d1,
             arg_max(place, stop_sequence) AS new_last
      FROM rest GROUP BY trip_idx
    ),
    was AS (
      SELECT trip_idx, arg_min(stop_idx, stop_sequence) IN (${n}) AS starts_here,
             arg_max(stop_idx, stop_sequence) IN (${n}) AS ends_here
      FROM stop_times WHERE trip_idx IN (SELECT trip_idx FROM aff) GROUP BY trip_idx
    )
    SELECT t.trip_idx, t.trip_id, t.route_idx, CAST(COALESCE(e.left, 0) AS INTEGER) AS left,
           -- Only an end the delete makes: one the trip already had untimed
           -- is the feed's, not this edit's.
           ((w.starts_here AND (e.a0 IS NULL OR e.d0 IS NULL))
             OR (w.ends_here AND (e.a1 IS NULL OR e.d1 IS NULL))) AS edge_untimed,
           w.starts_here AND t.trip_idx IN (SELECT trip_idx FROM frequencies) AS frequency_start,
           w.ends_here, t.headsign, e.new_last
    FROM aff JOIN trips t USING (trip_idx) LEFT JOIN ends e USING (trip_idx) JOIN was w USING (trip_idx)
    ORDER BY t.trip_idx`);
  facts.trips = trips.length;
  facts.routes = [...new Set(trips.map((t) => t.route_idx))].sort((a, b) => a - b);
  facts.trip_idxs = trips.map((t) => t.trip_idx);
  const refuse = (check: Check): Built<DeleteStopFacts> => ({ ok: false, refused: check, facts, checks: [] });
  const short = trips.filter((t) => t.left < 2);
  if (short.length)
    return refuse({ code: "unusable_trip", severity: "error", params: { count: short.length } });
  const untimed = trips.filter((t) => t.edge_untimed);
  if (untimed.length)
    return refuse({ code: "missing_trip_edge", severity: "error", params: { count: untimed.length } });
  // A frequency-based trip's runs are timed from its first stop: without it,
  // every later stop would run earlier, a time no one set.
  const frequency = trips.filter((t) => t.frequency_start);
  if (frequency.length)
    return refuse({ code: "goat_frequency_start", severity: "error", params: { count: frequency.length } });

  // Each pattern through the stop, without it; one that then runs as
  // another pattern of its route does becomes that one.
  const patterns = await db.all<{ pattern_idx: number; route_idx: number; stops: ArrayLike<number> }>(`
    SELECT pattern_idx, route_idx, stops FROM patterns
    WHERE route_idx IN (SELECT route_idx FROM patterns WHERE list_has_any(stops, [${n}]))
    ORDER BY pattern_idx`);
  const keyOf = (route: number, stops: number[]) => `${route}|${stops.join(",")}`;
  // The trips calling here each pattern has, and those of them in scope: a
  // pattern only some of whose trips go without the stop keeps it for the
  // rest, the others running as another pattern.
  const inPattern = new Map(
    (
      await db.all<{ pattern_idx: number; n: number }>(`
        SELECT pattern_idx, CAST(count(*) AS INTEGER) AS n FROM trips
        WHERE pattern_idx IN (SELECT pattern_idx FROM patterns WHERE list_has_any(stops, [${n}]))
        GROUP BY 1`)
    ).map((r) => [r.pattern_idx, r.n])
  );
  const going = new Map(
    (
      await db.all<{ pattern_idx: number; n: number }>(`
        SELECT pattern_idx, CAST(count(*) AS INTEGER) AS n FROM trips
        WHERE trip_idx IN (${list(facts.trip_idxs)}) GROUP BY 1`)
    ).map((r) => [r.pattern_idx, r.n])
  );
  const unaffected = new Map<string, number>();
  const affected: {
    pattern_idx: number;
    stops: number[];
    kept: number[];
    removed: number[];
    /** Some of its trips stay as they are. */
    split: boolean;
  }[] = [];
  for (const p of patterns) {
    const stops = Array.from(p.stops);
    if (!stops.some((s) => set.has(s)) || !going.has(p.pattern_idx)) {
      if (!stops.some((s) => set.has(s))) unaffected.set(keyOf(p.route_idx, stops), p.pattern_idx);
      continue;
    }
    affected.push({
      pattern_idx: p.pattern_idx,
      stops,
      kept: stops.filter((s) => !set.has(s)),
      removed: stops.flatMap((s, i) => (set.has(s) ? [i] : [])),
      split: (going.get(p.pattern_idx) ?? 0) < (inPattern.get(p.pattern_idx) ?? 0),
    });
  }
  const routeOf = new Map(patterns.map((p) => [p.pattern_idx, p.route_idx]));
  const target = new Map<number, number>();
  const first = new Map<string, number>();
  let [{ nextPattern }] = await db.all<{ nextPattern: number }>(
    `SELECT CAST(COALESCE(max(pattern_idx) + 1, 0) AS INTEGER) AS nextPattern FROM patterns`
  );
  const created: number[] = [];
  for (const p of affected) {
    const key = keyOf(routeOf.get(p.pattern_idx) as number, p.kept);
    let to = unaffected.get(key) ?? first.get(key);
    if (to === undefined) {
      // A pattern split: its trips in scope as a new one.
      to = p.split ? nextPattern++ : p.pattern_idx;
      if (p.split) created.push(to);
    }
    if (!first.has(key)) first.set(key, to);
    target.set(p.pattern_idx, to);
  }
  const touchedPatterns = [...new Set([...affected.map((p) => p.pattern_idx), ...target.values()])];
  facts.patterns = affected.length;
  facts.merged = affected.filter((p) => target.get(p.pattern_idx) !== p.pattern_idx).length;

  const tripList = list(facts.trip_idxs);
  const sql: string[] = [];
  // Stop times, and their extras, at the stops: on the trips in scope.
  sql.push(
    `DELETE FROM stop_time_extras WHERE EXISTS (
       SELECT 1 FROM stop_times st WHERE st.stop_idx IN (${n}) AND st.trip_idx IN (${tripList})
       AND st.trip_idx = stop_time_extras.trip_idx AND st.stop_sequence = stop_time_extras.stop_sequence)`,
    `DELETE FROM stop_times WHERE stop_idx IN (${n}) AND trip_idx IN (${tripList})`
  );
  // Patterns: places on their shapes renumbered past the stop, merged into
  // the pattern they now run as, or kept with the stop left out.
  for (const p of affected) {
    const idx = sqlNumber(p.pattern_idx);
    const to = target.get(p.pattern_idx) as number;
    const renumber = p.stops
      .map((_, i) => i)
      .filter((i) => !p.removed.includes(i))
      .map((i) => `WHEN ${i} THEN ${i - p.removed.filter((r) => r < i).length}`)
      .join(" ");
    if (p.split) {
      // Its trips in scope onto the pattern they now run as (new, or
      // another), placed on their shapes as it was, the stop left out.
      const t = sqlNumber(to);
      if (created.includes(to))
        sql.push(
          `INSERT INTO patterns SELECT * REPLACE (${t} AS pattern_idx, [${list(p.kept)}]::INTEGER[] AS stops,
             ${p.kept.length} AS n_stops) FROM patterns WHERE pattern_idx = ${idx}`
        );
      sql.push(
        `INSERT INTO pattern_shape_stops
         SELECT ${t}, shape_idx, CASE i ${renumber} END, d FROM pattern_shape_stops
         WHERE pattern_idx = ${idx} AND i NOT IN (${list(p.removed)})
           AND shape_idx IN (SELECT shape_idx FROM trips WHERE trip_idx IN (${tripList}) AND pattern_idx = ${idx})
           AND shape_idx NOT IN (SELECT shape_idx FROM pattern_shape_stops WHERE pattern_idx = ${t})`,
        `UPDATE trips SET pattern_idx = ${t} WHERE pattern_idx = ${idx} AND trip_idx IN (${tripList})`
      );
      continue;
    }
    sql.push(
      `DELETE FROM pattern_shape_stops WHERE pattern_idx = ${idx} AND i IN (${list(p.removed)})`,
      `UPDATE pattern_shape_stops SET i = CASE i ${renumber} END WHERE pattern_idx = ${idx}`
    );
    if (to === p.pattern_idx) {
      sql.push(
        `UPDATE patterns SET stops = [${list(p.kept)}]::INTEGER[], n_stops = ${p.kept.length}
         WHERE pattern_idx = ${idx}`
      );
    } else {
      const t = sqlNumber(to);
      sql.push(
        `UPDATE trips SET pattern_idx = ${t} WHERE pattern_idx = ${idx}`,
        // The shapes its trips run on, placed on the pattern they join where
        // that one has no place on them yet.
        `UPDATE pattern_shape_stops SET pattern_idx = ${t}
         WHERE pattern_idx = ${idx}
           AND shape_idx NOT IN (SELECT shape_idx FROM pattern_shape_stops WHERE pattern_idx = ${t})`,
        `DELETE FROM pattern_shape_stops WHERE pattern_idx = ${idx}`,
        `DELETE FROM patterns WHERE pattern_idx = ${idx}`
      );
    }
  }

  // The line through the stops, for trips without a shape: drawn anew for
  // the stops each pattern now has (or taken where another trip has it).
  const chained = await db.all<{ pattern_idx: number; shape_idx: number }>(`
    SELECT DISTINCT t.pattern_idx, t.shape_idx FROM trips t JOIN shapes_meta m USING (shape_idx)
    WHERE t.trip_idx IN (${tripList}) AND starts_with(m.shape_id, ${sqlText(STOP_CHAIN_PREFIX)})`);
  const newShapes: number[] = [];
  if (chained.length) {
    const ids = new Map(
      (await db.all<{ stop_idx: number; stop_id: string }>(`SELECT stop_idx, stop_id FROM stops`)).map(
        (r) => [r.stop_idx, r.stop_id]
      )
    );
    const known = new Map(
      (
        await db.all<{ shape_idx: number; shape_id: string }>(
          `SELECT shape_idx, shape_id FROM shapes_meta WHERE starts_with(shape_id, ${sqlText(STOP_CHAIN_PREFIX)})`
        )
      ).map((r) => [r.shape_id, r.shape_idx])
    );
    let [{ next }] = await db.all<{ next: number }>(
      "SELECT CAST(COALESCE(max(shape_idx) + 1, 0) AS INTEGER) AS next FROM shapes_meta"
    );
    for (const c of chained) {
      const p = affected.find((a) => a.pattern_idx === c.pattern_idx);
      if (!p) continue;
      const to = target.get(p.pattern_idx) as number;
      const id = await chainId(
        db,
        p.kept.map((s) => ids.get(s) as string)
      );
      let shape = known.get(id);
      if (shape === undefined) {
        shape = next++;
        known.set(id, shape);
        newShapes.push(shape);
        sql.push(
          `INSERT INTO shapes_meta VALUES (${sqlNumber(shape)}, ${sqlText(id)}, NULL)`,
          ...chainShapeSql(shape, p.kept),
          `INSERT INTO shape_route VALUES (${sqlNumber(shape)}, ${sqlNumber(routeOf.get(p.pattern_idx) as number)})`
        );
      }
      sql.push(
        `UPDATE trips SET shape_idx = ${sqlNumber(shape)}
         WHERE trip_idx IN (${tripList}) AND shape_idx = ${sqlNumber(c.shape_idx)}`,
        `DELETE FROM pattern_shape_stops WHERE pattern_idx = ${sqlNumber(to)} AND shape_idx = ${sqlNumber(c.shape_idx)}`,
        ...chainStopsSql(to, shape, p.kept)
      );
    }
  }
  // A line through the stops no trip runs any more, every one of its trips
  // on the new line: out of the snapshot, and its tile left out until a save.
  const dropped: { shape_idx: number; shape_id: string }[] = [];
  for (const old of [...new Set(chained.map((c) => c.shape_idx))]) {
    const [kept] = await db.all(
      `SELECT 1 FROM trips WHERE shape_idx = ${sqlNumber(old)} AND trip_idx NOT IN (${tripList}) LIMIT 1`
    );
    if (kept) continue;
    const [m] = await db.all<{ shape_id: string }>(
      `SELECT shape_id FROM shapes_meta WHERE shape_idx = ${sqlNumber(old)}`
    );
    if (!m) continue;
    dropped.push({ shape_idx: old, shape_id: m.shape_id });
    const o = sqlNumber(old);
    sql.push(
      `DELETE FROM pattern_shape_stops WHERE shape_idx = ${o}`,
      `DELETE FROM shape_points WHERE shape_idx = ${o}`,
      `DELETE FROM shape_route WHERE shape_idx = ${o}`,
      `DELETE FROM shapes_meta WHERE shape_idx = ${o}`
    );
  }

  // Trips: times at their ends, lengths measured from their stops, and the
  // headsign of a trip that was headed for the stop it no longer reaches.
  sql.push(tripFiguresSql(tripList, shapeDistUnit));
  const gtfs: GtfsRowOp[] = [];
  // What a trip headed for one of them may be headed for: its name, or its
  // station's.
  const named = new Set(
    (
      await db.all<{ name: string | null; place: string }>(`
        SELECT s.name, COALESCE(p.name, s.name, s.stop_id) AS place
        FROM stops s LEFT JOIN stops p ON p.stop_idx = s.parent_idx WHERE s.stop_idx IN (${n})`)
    )
      .flatMap((r) => [r.name, r.place])
      .filter(Boolean)
  );
  for (const t of trips)
    if (t.ends_here && t.headsign !== null && named.has(t.headsign) && t.new_last) {
      facts.headsigns++;
      sql.push(
        `UPDATE trips SET headsign = ${sqlText(t.new_last)} WHERE trip_idx = ${sqlNumber(t.trip_idx)}`
      );
      gtfs.push({
        role: "trips",
        op: "update",
        key: { trip_id: t.trip_id },
        values: { trip_headsign: t.new_last },
      });
    }
  // What the patterns left hold: their trips, and their length from them.
  if (touchedPatterns.length)
    sql.push(
      `UPDATE patterns SET
         n_trips = (SELECT CAST(count(*) AS INTEGER) FROM trips t WHERE t.pattern_idx = patterns.pattern_idx),
         length_m = (SELECT CAST(median(t.length_m) AS REAL) FROM trips t WHERE t.pattern_idx = patterns.pattern_idx)
       WHERE pattern_idx IN (${list(touchedPatterns)})`
    );
  // The stops themselves, unless only taken off some trips (they stay).
  const removed: number[] = [];
  const orphans: { stop_idx: number; stop_id: string }[] = [];
  const idOf = new Map<number, string>();
  if (!only) {
    // What lies under the stops: any location but a stop or platform goes
    // with them, and what lies under that in turn, deepest first (a boarding
    // area, or whatever a feed puts there); a stop or platform under any of
    // them is kept, on its own.
    const under = await db.all<{ stop_idx: number; stop_id: string }>(`
      WITH RECURSIVE u(stop_idx, depth) AS (
        SELECT stop_idx, 1 FROM stops
        WHERE parent_idx IN (${n}) AND COALESCE(location_type, 0) <> 0 AND stop_idx NOT IN (${n})
        UNION ALL
        SELECT s.stop_idx, u.depth + 1 FROM stops s JOIN u ON s.parent_idx = u.stop_idx
        WHERE COALESCE(s.location_type, 0) <> 0 AND s.stop_idx NOT IN (${n})
      )
      SELECT s.stop_idx, s.stop_id FROM (SELECT stop_idx, max(depth) AS depth FROM u GROUP BY 1) u
      JOIN stops s USING (stop_idx) ORDER BY u.depth DESC, s.stop_idx`);
    removed.push(...under.map((u) => u.stop_idx), ...gone);
    orphans.push(
      ...(await db.all<{ stop_idx: number; stop_id: string }>(`
      SELECT stop_idx, stop_id FROM stops
      WHERE parent_idx IN (${list(removed)}) AND COALESCE(location_type, 0) = 0 AND stop_idx NOT IN (${list(removed)})
      ORDER BY stop_idx`))
    );
    const ids = await db.all<{ stop_idx: number; stop_id: string }>(
      `SELECT stop_idx, stop_id FROM stops WHERE stop_idx IN (${list(removed)})`
    );
    for (const r of ids) idOf.set(r.stop_idx, r.stop_id);
    if (orphans.length)
      sql.push(
        `UPDATE stops SET parent_idx = NULL WHERE stop_idx IN (${list(orphans.map((o) => o.stop_idx))})`
      );
    sql.push(`DELETE FROM stops WHERE stop_idx IN (${list(removed)})`);
  }

  // One row each, in case a feed repeats a stop_sequence in a trip.
  const calls = await db.all<{ trip_id: string; stop_sequence: number }>(`
    SELECT DISTINCT t.trip_idx, t.trip_id, st.stop_sequence FROM stop_times st JOIN trips t USING (trip_idx)
    WHERE st.stop_idx IN (${n}) AND st.trip_idx IN (${tripList}) ORDER BY t.trip_idx, st.stop_sequence`);
  gtfs.unshift(
    ...calls.map((c) => ({
      role: "stop_times" as const,
      op: "delete" as const,
      key: { trip_id: c.trip_id, stop_sequence: c.stop_sequence },
    })),
    ...orphans.map((o) => ({
      role: "stops" as const,
      op: "update" as const,
      key: { stop_id: o.stop_id },
      values: { parent_station: null },
    })),
    // Children before parents: no row names a parent that is gone.
    ...removed.map((x) => ({
      role: "stops" as const,
      op: "delete" as const,
      key: { stop_id: idOf.get(x) as string },
    }))
  );

  const touches: Touch[] = [
    { table: "stops", where: `stop_idx IN (${list([...removed, ...orphans.map((x) => x.stop_idx)])})` },
    { table: "stop_times", where: `trip_idx IN (${tripList})` },
    { table: "stop_time_extras", where: `trip_idx IN (${tripList})` },
    { table: "trips", where: `trip_idx IN (${tripList})` },
    { table: "patterns", where: `pattern_idx IN (${list(touchedPatterns)})` },
    { table: "pattern_shape_stops", where: `pattern_idx IN (${list(touchedPatterns)})` },
  ];
  const lines = [...newShapes, ...dropped.map((x) => x.shape_idx)];
  if (lines.length)
    touches.push(
      { table: "shapes_meta", where: `shape_idx IN (${list(lines)})` },
      { table: "shape_points", where: `shape_idx IN (${list(lines)})` },
      { table: "shape_route", where: `shape_idx IN (${list(lines)})` },
      { table: "pattern_shape_stops", where: `shape_idx IN (${list(lines)})` }
    );
  return {
    ok: true,
    facts,
    checks: [],
    rows: {
      kind: "stop_delete",
      touches,
      sql,
      gtfs,
      // The new lines drawn from the snapshot; the old ones left out.
      shapes: newShapes,
      dropped: dropped.map((x) => x.shape_id),
    },
  };
}

/** Any other location: a station, an entrance, a node. A station's stops
 * and platforms go as stops do, and so does any location under it, or the
 * location itself, that trips call at though no trip should (some feeds
 * have them); the rest under it goes with it (removeStops). */
async function deleteLocation(
  db: SqlRunner,
  stop_idx: number,
  shapeDistUnit: string | null,
  facts: DeleteStopFacts
): Promise<Built<DeleteStopFacts>> {
  const n = sqlNumber(stop_idx);
  const under = await db.all<{
    stop_idx: number;
    location_type: number;
    parent_idx: number;
    called: boolean;
  }>(`
    WITH RECURSIVE u(stop_idx) AS (
      SELECT stop_idx FROM stops WHERE parent_idx = ${n}
      UNION SELECT s.stop_idx FROM stops s JOIN u ON s.parent_idx = u.stop_idx
    )
    SELECT s.stop_idx, CAST(COALESCE(s.location_type, 0) AS INTEGER) AS location_type, s.parent_idx,
           EXISTS (SELECT 1 FROM stop_times st WHERE st.stop_idx = s.stop_idx) AS called
    FROM u JOIN stops s USING (stop_idx) ORDER BY s.stop_idx`);
  const stops = under.filter((u) => u.location_type === 0 && u.parent_idx === stop_idx);
  facts.platforms = stops.length;
  facts.entrances = under.filter((u) => u.location_type === 2).length;
  facts.nodes = under.filter((u) => u.location_type === 3).length;
  const called = under.filter((u) => u.called && !stops.includes(u)).map((u) => u.stop_idx);
  return removeStops(db, [...stops.map((u) => u.stop_idx), ...called, stop_idx], shapeDistUnit, facts);
}

/** Trips' first and last times, and their length where it is measured from
 * their stops (the feed's distances, or stop to stop), from the stop times
 * they have now: after stops were taken off them. */
export function tripFiguresSql(tripList: string, shapeDistUnit: string | null): string {
  const perUnit = shapeDistUnit ? METRES_PER_UNIT[shapeDistUnit] : undefined;
  return `UPDATE trips SET first_dep_s = x.f, last_arr_s = x.l,
       length_m = CASE trips.length_src
         WHEN 1 THEN ${perUnit ? `CAST(x.dist * ${sqlNumber(perUnit)} AS REAL)` : "trips.length_m"}
         WHEN 3 THEN CAST(x.chain AS REAL)
         ELSE trips.length_m END
     FROM (
       SELECT trip_idx, arg_min_null(coalesce(departure_s, arrival_s), stop_sequence) AS f,
              arg_max_null(coalesce(arrival_s, departure_s), stop_sequence) AS l,
              max(shape_dist) - min(shape_dist) AS dist, coalesce(sum(hop), 0) AS chain
       FROM (
         SELECT st.*, ${metresSql(
           "lag(coalesce(s.lon, p.lon)) OVER w",
           "lag(coalesce(s.lat, p.lat)) OVER w",
           "coalesce(s.lon, p.lon)",
           "coalesce(s.lat, p.lat)"
         )} AS hop
         FROM stop_times st JOIN stops s USING (stop_idx) LEFT JOIN stops p ON p.stop_idx = s.parent_idx
         WHERE st.trip_idx IN (${tripList})
         WINDOW w AS (PARTITION BY st.trip_idx ORDER BY st.stop_sequence)
       ) GROUP BY trip_idx
     ) x WHERE trips.trip_idx = x.trip_idx`;
}
