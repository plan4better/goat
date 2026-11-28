// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";

import { openFixtureDb } from "@/lib/explorer/__tests__/fixtureDb";
import type { SqlRunner } from "@/lib/explorer/db/types";
import type { Router } from "@/lib/explorer/edit/ops/moveStop";
import {
  NO_LINE_VALUES,
  type NewLineValues,
  newLine,
  newLineProblems,
} from "@/lib/explorer/edit/ops/newLine";
import { EditSession } from "@/lib/explorer/edit/session";

const TABLES = {
  routes: "route_idx",
  stop_times: "trip_idx, stop_sequence",
  trips: "trip_idx",
  patterns: "pattern_idx",
  pattern_shape_stops: "pattern_idx, shape_idx, i",
  shapes_meta: "shape_idx",
  shape_points: "shape_idx, i",
  shape_route: "shape_idx, route_idx",
};
async function all(db: SqlRunner): Promise<string> {
  const out: Record<string, unknown> = {};
  for (const [t, order] of Object.entries(TABLES))
    out[t] = await db.all(`SELECT * FROM ${t} ORDER BY ${order}`);
  return JSON.stringify(out);
}
const idx = async (db: SqlRunner, stop_id: string) =>
  (await db.all<{ stop_idx: number }>(`SELECT stop_idx FROM stops WHERE stop_id = '${stop_id}'`))[0].stop_idx;
// Always the same id: the tests read the rows it names.
const fixed = () => 0.5;

describe("1.1 draw a new line", () => {
  let db: SqlRunner;
  let values: NewLineValues;
  beforeEach(async () => {
    db = await openFixtureDb();
    // WK: the weekday service.
    values = {
      ...NO_LINE_VALUES,
      short_name: "9",
      long_name: "New Line",
      service_idx: 1,
      first: "07:00",
      last: "08:00",
      headway: "30",
      running: "10",
    };
  });

  it("runs both ways over the span, every stop timed by its share of the path, and undo takes it back", async () => {
    const before = await all(db);
    // S2, S4 and S6: 680 m apart each, straight along 52.5.
    const stops = [await idx(db, "S2"), await idx(db, "S4"), await idx(db, "S6")];
    const built = await newLine(db, stops, values, undefined, fixed);
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.facts).toMatchObject({ route_id: "goat_80000000", trips: 6, per_direction: 3 });
    const session = new EditSession(db);
    await session.apply({ id: "n", label: "New", ...built.rows });

    const trips = await db.all<{
      trip_id: string;
      headsign: string;
      first_dep_s: number;
      direction_id: number;
    }>(`
      SELECT trip_id, headsign, first_dep_s, direction_id FROM trips WHERE route_idx = ${built.facts.route_idx} ORDER BY trip_idx`);
    expect(trips.map((t) => t.first_dep_s)).toEqual([25200, 27000, 28800, 25200, 27000, 28800]);
    expect(trips[0]).toMatchObject({ trip_id: "goat_80000000_0_001", headsign: "Sixth", direction_id: 0 });
    expect(trips[3]).toMatchObject({ headsign: "Second", direction_id: 1 });
    const times = await db.all<{ arrival_s: number }>(`
      SELECT arrival_s FROM stop_times st JOIN trips t USING (trip_idx)
      WHERE t.trip_id = 'goat_80000000_0_001' ORDER BY stop_sequence`);
    // Halfway along at 5 minutes, the end at 10.
    expect(times.map((x) => x.arrival_s - 25200)).toEqual([0, 300, 600]);
    const [route] = await db.all<{ trip_lo: number; trip_hi: number }>(
      `SELECT trip_lo, trip_hi FROM routes WHERE route_id = 'goat_80000000'`
    );
    expect(route.trip_hi - route.trip_lo).toBe(5);

    // Saved: the route, its two shapes, its trips and their stop times.
    const roles = built.rows.gtfs.map((o) => o.role);
    expect(roles[0]).toBe("routes");
    expect(new Set(roles)).toEqual(new Set(["routes", "shapes", "trips", "stop_times"]));
    expect(built.rows.gtfs.find((o) => o.role === "stop_times")).toMatchObject({
      values: { arrival_time: "07:00:00" },
    });

    await session.undo();
    expect(await all(db)).toBe(before);
  });

  it("follows the streets each way with Snap, for a bus", async () => {
    const asked: [number, number][][] = [];
    const road: Router = async (waypoints) => {
      asked.push(waypoints);
      return { line: [waypoints[0], [13.42, 52.501], waypoints[waypoints.length - 1]], snapped: waypoints };
    };
    const built = await newLine(db, [await idx(db, "S2"), await idx(db, "S6")], values, road, fixed);
    if (!built.ok) throw new Error(built.refused.code);
    expect(asked).toHaveLength(2);
    expect(asked[1][0]).toEqual(asked[0][asked[0].length - 1]);
    expect(built.facts.paths[0].coordinates).toContainEqual([13.42, 52.501]);
  });

  it("needs two stops, a name, a service, and times that make sense", async () => {
    const one = await newLine(db, [await idx(db, "S2")], values, undefined, fixed);
    expect(one.ok ? null : one.refused.code).toBe("goat_line_two_stops");
    expect(
      newLineProblems({
        ...values,
        short_name: "",
        long_name: "",
        service_idx: null,
        last: "06:00",
        headway: "0",
      })
    ).toEqual({
      short_name: "route_both_short_and_long_name_missing",
      long_name: "route_both_short_and_long_name_missing",
      service_idx: "missing_service",
      last: "last_before_first",
      headway: "invalid_minutes",
    });
  });
});
