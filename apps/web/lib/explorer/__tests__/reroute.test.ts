// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";

import { openFixtureDb } from "@/lib/explorer/__tests__/fixtureDb";
import type { SqlRunner } from "@/lib/explorer/db/types";
import type { LineScope } from "@/lib/explorer/edit/ops/lineStops";
import type { Router } from "@/lib/explorer/edit/ops/moveStop";
import { reroutePath } from "@/lib/explorer/edit/ops/reroute";
import { EditSession } from "@/lib/explorer/edit/session";

const TABLES = {
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
const placesOn = async (db: SqlRunner, trip_id: string) =>
  db.all<{ i: number; d: number }>(`
    SELECT p.i, p.d FROM pattern_shape_stops p JOIN trips t ON t.pattern_idx = p.pattern_idx AND t.shape_idx = p.shape_idx
    WHERE t.trip_id = '${trip_id}' ORDER BY p.i`);
const dists = async (db: SqlRunner, trip_id: string) =>
  (
    await db.all<{ shape_dist: number }>(`
      SELECT st.shape_dist FROM stop_times st JOIN trips t USING (trip_idx)
      WHERE t.trip_id = '${trip_id}' ORDER BY st.stop_sequence`)
  ).map((r) => r.shape_dist);
const times = (db: SqlRunner) =>
  db.all("SELECT trip_idx, stop_sequence, arrival_s, departure_s FROM stop_times ORDER BY 1, 2");

// SH1 runs east along 52.5 from S1 to S5; S2 to S3 bent out north.
const VIA: [number, number][] = [[13.407, 52.51]];

describe("1.2 reroute a path", () => {
  let db: SqlRunner;
  // Line 0's first direction: pattern 0 (S1..S5, T1 and T2) and its short
  // turn (pattern 2, S1..S3, T4), all on SH1; the other direction, T3, is
  // drawn through its stops.
  const scope = (level: LineScope["level"]): LineScope => ({
    route_idx: 0,
    level,
    pattern_idx: 0,
    direction: [0, 2],
  });
  beforeEach(async () => {
    db = await openFixtureDb();
  });

  it("bends the direction's path in place, keeps times, moves the stops past it on, and undoes", async () => {
    const before = await all(db);
    const timesBefore = await times(db);
    const placesBefore = await placesOn(db, "T1");
    const distsBefore = await dists(db, "T1");
    const built = await reroutePath(
      db,
      await idx(db, "S2"),
      await idx(db, "S3"),
      VIA,
      scope("direction"),
      "km"
    );
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.facts).toMatchObject({ trips: 3, forked: 0 });
    expect(built.facts.metres).toBeGreaterThan(500);
    const session = new EditSession(db);
    await session.apply({ id: "r", label: "Rerouted", ...built.rows });

    expect(await times(db)).toEqual(timesBefore);
    const places = await placesOn(db, "T1");
    expect(places[0].d).toBeCloseTo(placesBefore[0].d);
    expect(places[1].d).toBeCloseTo(placesBefore[1].d);
    for (const k of [2, 3, 4]) expect(places[k].d - placesBefore[k].d).toBeCloseTo(built.facts.metres, 0);
    const d = await dists(db, "T1");
    expect(d[1]).toBeCloseTo(distsBefore[1]);
    expect(d[4] - distsBefore[4]).toBeCloseTo(built.facts.metres / 1000, 2);
    // T4's last stop, S3, where T1's is on the same path.
    expect((await placesOn(db, "T4")).at(-1)?.d).toBeCloseTo(places[2].d, 3);
    const [t1] = await db.all<{ length_m: number }>("SELECT length_m FROM trips WHERE trip_id = 'T1'");
    expect(t1.length_m).toBeCloseTo(2720 + built.facts.metres, -1);

    // Saved as a reshape through no stop, with the trips it names.
    const [reshape] = built.rows.gtfs.filter((o) => o.op === "reshape");
    if (reshape.op !== "reshape") throw new Error();
    expect(reshape.through).toBeUndefined();
    expect(reshape.stretches).toHaveLength(1);
    expect(reshape.stretches[0].points).toEqual(VIA);
    expect(reshape.trips?.sort()).toEqual(["T1", "T2", "T4"]);

    await session.undo();
    expect(await all(db)).toBe(before);
  });

  it("gives the variant's trips a copy when the short turn runs the stretch too", async () => {
    const built = await reroutePath(
      db,
      await idx(db, "S2"),
      await idx(db, "S3"),
      VIA,
      scope("variant"),
      "km"
    );
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.facts).toMatchObject({ trips: 2, forked: 1 });
    const session = new EditSession(db);
    await session.apply({ id: "r", label: "Rerouted", ...built.rows });
    const shapeOf = async (trip_id: string) =>
      (
        await db.all<{ shape_id: string }>(
          `SELECT m.shape_id FROM trips t JOIN shapes_meta m USING (shape_idx) WHERE t.trip_id = '${trip_id}'`
        )
      )[0].shape_id;
    expect(await shapeOf("T1")).toBe("SH1_goat1");
    expect(await shapeOf("T4")).toBe("SH1");
    // T4 keeps its places on SH1; T1's on the copy, S3 on.
    expect((await placesOn(db, "T4")).length).toBe(3);
    expect((await placesOn(db, "T1")).length).toBe(5);
  });

  it("passes over the other direction's path drawn through its stops, and says so", async () => {
    const built = await reroutePath(db, await idx(db, "S2"), await idx(db, "S3"), VIA, scope("line"), "km");
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.facts.trips).toBe(4);
    expect(built.checks.map((c) => c.code)).toContain("goat_reroute_chain_skipped");
  });

  it("refuses where the trips call at the two stops not back to back", async () => {
    const built = await reroutePath(
      db,
      await idx(db, "S1"),
      await idx(db, "S3"),
      VIA,
      scope("direction"),
      "km"
    );
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.refused.code).toBe("goat_scope_empty");
  });

  it("follows the streets through the point for a bus, with Snap", async () => {
    await db.all("UPDATE routes SET route_type = 3");
    const calls: [number, number][][] = [];
    const road: Router = async (waypoints) => {
      calls.push(waypoints);
      const [start, , end] = waypoints;
      return { line: [start, [13.405, 52.51], [13.409, 52.51], end], snapped: waypoints };
    };
    const built = await reroutePath(
      db,
      await idx(db, "S2"),
      await idx(db, "S3"),
      VIA,
      scope("direction"),
      "km",
      road
    );
    if (!built.ok) throw new Error(built.refused.code);
    // One request for the one stretch, from S2 through the point to S3.
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual(VIA[0]);
    const [reshape] = built.rows.gtfs.filter((o) => o.op === "reshape");
    if (reshape.op !== "reshape") throw new Error();
    expect(reshape.stretches[0].points).toContainEqual([13.409, 52.51]);
  });
});
