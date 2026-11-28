/**
 * 1.5 Delete line (01-editing-operations § 1): the line goes from the
 * network, with everything that runs it, in one change:
 *
 * - its trips, their stop times (and any extras) and frequencies;
 * - its patterns, and their places on the paths;
 * - every path only its trips ran (the feed's shapes and the lines drawn
 *   through the stops alike): out of the snapshot, and its tile left out
 *   until a save; a path another line runs too stays, for that line;
 * - with `stops`, the stops and platforms no other line calls at (asked on
 *   the delete card): a stop no trip serves is no error, so they stay
 *   unless asked. A stop with anything under it (a boarding area) stays.
 *
 * On save the server takes what the browser does not hold with it: fare
 * rules, attributions and transfers naming the line or its trips, and the
 * shapes no trip runs any more (changeset.py).
 */
import type { SqlRunner } from "@/lib/explorer/db/types";
import type { Built } from "@/lib/explorer/edit/ops/types";
import { sqlNumber } from "@/lib/explorer/edit/sql";
import type { GtfsRowOp, Touch } from "@/lib/explorer/edit/types";

export interface DeleteLineFacts {
  route_id: string;
  /** The line as riders know it: its number, else its name. */
  line: string;
  trips: number;
  patterns: number;
  /** Paths only its trips ran, that go with it. */
  paths: number;
  /** Stops and platforms no other line calls at, and whether they go too. */
  only_here: number;
  stops_deleted: boolean;
  /** The trips, for what the edit costs. */
  trip_idxs: number[];
}

const list = (xs: number[]) => (xs.length ? xs.map(sqlNumber).join(", ") : "NULL");

/** Seconds as a GTFS time, past midnight where it runs on ("25:10:00"). */
export function gtfsTime(s: number): string {
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

export async function deleteLine(
  db: SqlRunner,
  route_idx: number,
  /** Also the stops and platforms no other line calls at. */
  stops: boolean
): Promise<Built<DeleteLineFacts>> {
  const r = sqlNumber(route_idx);
  const [route] = await db.all<{ route_id: string; line: string }>(`
    SELECT route_id, COALESCE(NULLIF(short_name, ''), long_name, route_id) AS line
    FROM routes WHERE route_idx = ${r}`);
  if (!route) throw new Error(`No route ${route_idx}`);
  const trips = await db.all<{ trip_idx: number; trip_id: string }>(
    `SELECT trip_idx, trip_id FROM trips WHERE route_idx = ${r} ORDER BY trip_idx`
  );
  const tripIdxs = trips.map((t) => t.trip_idx);
  const tripList = list(tripIdxs);
  const patterns = (
    await db.all<{ pattern_idx: number }>(`SELECT pattern_idx FROM patterns WHERE route_idx = ${r}`)
  ).map((p) => p.pattern_idx);
  // Paths only its trips run.
  const paths = await db.all<{ shape_idx: number; shape_id: string }>(`
    SELECT m.shape_idx, m.shape_id FROM shapes_meta m
    WHERE m.shape_idx IN (SELECT shape_idx FROM trips WHERE trip_idx IN (${tripList}))
      AND NOT EXISTS (SELECT 1 FROM trips t WHERE t.shape_idx = m.shape_idx AND t.route_idx <> ${r})
    ORDER BY m.shape_idx`);
  // Stops and platforms no other line calls at, with nothing under them.
  const onlyHere = await db.all<{ stop_idx: number; stop_id: string }>(`
    SELECT s.stop_idx, s.stop_id FROM stops s
    WHERE s.stop_idx IN (SELECT stop_idx FROM stop_times WHERE trip_idx IN (${tripList}))
      AND NOT EXISTS (SELECT 1 FROM stop_times st JOIN trips t USING (trip_idx)
                      WHERE st.stop_idx = s.stop_idx AND t.route_idx <> ${r})
      AND NOT EXISTS (SELECT 1 FROM stops c WHERE c.parent_idx = s.stop_idx)
    ORDER BY s.stop_idx`);
  const facts: DeleteLineFacts = {
    route_id: route.route_id,
    line: route.line,
    trips: trips.length,
    patterns: patterns.length,
    paths: paths.length,
    only_here: onlyHere.length,
    stops_deleted: stops && onlyHere.length > 0,
    trip_idxs: tripIdxs,
  };

  const shapeList = list(paths.map((p) => p.shape_idx));
  const gone = stops ? onlyHere.map((s) => s.stop_idx) : [];
  const sql = [
    `DELETE FROM stop_time_extras WHERE trip_idx IN (${tripList})`,
    `DELETE FROM stop_times WHERE trip_idx IN (${tripList})`,
    `DELETE FROM frequencies WHERE trip_idx IN (${tripList})`,
    `DELETE FROM trips WHERE trip_idx IN (${tripList})`,
    `DELETE FROM pattern_shape_stops WHERE pattern_idx IN (${list(patterns)}) OR shape_idx IN (${shapeList})`,
    `DELETE FROM patterns WHERE route_idx = ${r}`,
    `DELETE FROM shape_points WHERE shape_idx IN (${shapeList})`,
    `DELETE FROM shape_route WHERE route_idx = ${r} OR shape_idx IN (${shapeList})`,
    `DELETE FROM shapes_meta WHERE shape_idx IN (${shapeList})`,
    `DELETE FROM routes WHERE route_idx = ${r}`,
    ...(gone.length ? [`DELETE FROM stops WHERE stop_idx IN (${list(gone)})`] : []),
  ];

  // Children before parents: stop times and frequencies, then trips, the
  // route, then the stops no row names any more.
  const calls = await db.all<{ trip_id: string; stop_sequence: number }>(`
    SELECT t.trip_id, st.stop_sequence FROM stop_times st JOIN trips t USING (trip_idx)
    WHERE st.trip_idx IN (${tripList}) ORDER BY st.trip_idx, st.stop_sequence`);
  const runs = await db.all<{ trip_id: string; start_s: number }>(`
    SELECT t.trip_id, f.start_s FROM frequencies f JOIN trips t USING (trip_idx)
    WHERE f.trip_idx IN (${tripList}) ORDER BY f.trip_idx, f.start_s`);
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
    { role: "routes", op: "delete", key: { route_id: route.route_id } },
    ...onlyHere
      .filter((s) => gone.includes(s.stop_idx))
      .map((s): GtfsRowOp => ({ role: "stops", op: "delete", key: { stop_id: s.stop_id } })),
  ];

  const touches: Touch[] = [
    { table: "routes", where: `route_idx = ${r}` },
    { table: "trips", where: `trip_idx IN (${tripList})` },
    { table: "stop_times", where: `trip_idx IN (${tripList})` },
    { table: "stop_time_extras", where: `trip_idx IN (${tripList})` },
    { table: "frequencies", where: `trip_idx IN (${tripList})` },
    { table: "patterns", where: `route_idx = ${r}` },
    {
      table: "pattern_shape_stops",
      where: `pattern_idx IN (${list(patterns)}) OR shape_idx IN (${shapeList})`,
    },
    { table: "shapes_meta", where: `shape_idx IN (${shapeList})` },
    { table: "shape_points", where: `shape_idx IN (${shapeList})` },
    { table: "shape_route", where: `route_idx = ${r} OR shape_idx IN (${shapeList})` },
  ];
  if (gone.length) touches.push({ table: "stops", where: `stop_idx IN (${list(gone)})` });
  return {
    ok: true,
    facts,
    checks: [],
    rows: {
      kind: "line_delete",
      touches,
      sql,
      gtfs,
      // Its paths' tiles left out until a save.
      dropped: paths.map((p) => p.shape_id),
    },
  };
}
