// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";

import { openFixtureDb } from "@/lib/explorer/__tests__/fixtureDb";
import type { SqlRunner } from "@/lib/explorer/db/types";
import { type Router, cutAt, forkId, moveStop, splice } from "@/lib/explorer/edit/ops/moveStop";
import { EditSession } from "@/lib/explorer/edit/session";

const TABLES = {
  stops: "stop_idx",
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

describe("cutting a path at its stretches", () => {
  const pts = [0, 1, 2, 3, 4].map((k) => ({ lon: k * 0.001, lat: 0, d: k * 100 }));

  it("keeps what lies outside them and gives what lies inside as replaced", () => {
    const { kept, replaced } = cutAt(pts, [{ a: 150, b: 250 }]);
    expect(kept).toEqual([
      [
        [0, 0],
        [0.001, 0],
        [0.0015, 0],
      ],
      [
        [0.0025, 0],
        [0.003, 0],
        [0.004, 0],
      ],
    ]);
    expect(replaced).toEqual([
      [
        [0.0015, 0],
        [0.002, 0],
        [0.0025, 0],
      ],
    ]);
  });

  it("replaces up to the path's end at a terminus", () => {
    const { kept, replaced } = cutAt(pts, [{ a: 250, b: null }]);
    expect(kept).toEqual([
      [
        [0, 0],
        [0.001, 0],
        [0.002, 0],
        [0.0025, 0],
      ],
    ]);
    expect(replaced[0][0]).toEqual([0.0025, 0]);
    expect(replaced[0].at(-1)).toEqual([0.004, 0]);
  });
});

describe("splicing a path through a moved stop", () => {
  // A straight path east along the equator, a point every ~111 m.
  const pts = [0, 1, 2, 3, 4].map((k) => ({ lon: k * 0.001, lat: 0, d: k * 111.195 }));

  it("draws the stretch through the stop and moves the rest on by what it grew", () => {
    const sp = splice(pts, [{ a: 111.195, b: 333.585 }], [0.002, 0.001]);
    // Drawn anew only from the stretch's start through the stop to its end.
    expect(sp.drawn).toEqual([
      [
        [0.001, 0],
        [0.002, 0.001],
        [0.003, 0],
      ],
    ]);
    expect(sp.points.map((p) => [p.lon, p.lat])).toEqual([
      [0, 0],
      [0.001, 0],
      [0.002, 0.001],
      [0.003, 0],
      [0.004, 0],
    ]);
    // Up the side of a triangle and down again: longer than the base.
    const grew = sp.length - 444.78;
    expect(grew).toBeGreaterThan(50);
    expect(sp.map(50)).toBeCloseTo(50);
    expect(sp.map(400)).toBeCloseTo(400 + grew);
    expect(sp.at[0]).toBeCloseTo(111.195 + Math.hypot(111.195, 110.574), 0);
  });

  it("draws a stretch along its road, the stop at the road's point by it", () => {
    // Out north to the road, along it past the stop, back down.
    const via = {
      points: [
        [0.001, 0.0005],
        [0.002, 0.0005],
        [0.003, 0.0005],
      ] as [number, number][],
      stop: 1,
    };
    const sp = splice(pts, [{ a: 111.195, b: 333.585, via }], [0.002, 0.0006]);
    expect(sp.points.map((p) => [p.lon, p.lat])).toEqual([
      [0, 0],
      [0.001, 0],
      [0.001, 0.0005],
      [0.002, 0.0005],
      [0.003, 0.0005],
      [0.003, 0],
      [0.004, 0],
    ]);
    // The stop lies at the road's middle point: one leg up, one along.
    expect(sp.at[0]).toBeCloseTo(111.195 + 55.287 + 111.195, 0);
  });

  it("ends the path at a terminus moved", () => {
    const sp = splice(pts, [{ a: 222.39, b: null }], [0.0025, 0.0005]);
    expect(sp.points.at(-1)).toMatchObject({ lon: 0.0025, lat: 0.0005 });
    expect(sp.points).toHaveLength(4);
  });
});

describe("2.2 move stop", () => {
  let db: SqlRunner;
  beforeEach(async () => {
    db = await openFixtureDb();
  });

  it("moves the stop, bends the path through it, keeps times, and undo puts all of it back", async () => {
    const before = await all(db);
    const t1Before = await placesOn(db, "T1");
    const times = await db.all(
      "SELECT trip_idx, stop_sequence, arrival_s, departure_s FROM stop_times ORDER BY 1, 2"
    );
    const built = await moveStop(db, await idx(db, "S3"), [13.42, 52.502], "km");
    if (!built.ok) throw new Error(built.refused.code);
    // T1, T2 and T4 keep SH1, bent through S3: T4 ends at S3, and runs the
    // bent path as far as it goes, not a copy of its own.
    expect(built.facts).toMatchObject({ forked: 0 });
    const session = new EditSession(db);
    await session.apply({ id: "m", label: "Moved", ...built.rows });

    expect(await db.all("SELECT lon, lat FROM stops WHERE stop_id = 'S3'")).toEqual([
      { lon: 13.42, lat: 52.502 },
    ]);
    expect(
      await db.all("SELECT trip_idx, stop_sequence, arrival_s, departure_s FROM stop_times ORDER BY 1, 2")
    ).toEqual(times);
    const sh1 = await db.all<{ lon: number; lat: number }>(
      "SELECT lon, lat FROM shape_points WHERE shape_idx = 0 ORDER BY i"
    );
    expect(sh1.some((p) => Math.abs(p.lat - 52.502) < 1e-4 && Math.abs(p.lon - 13.42) < 1e-4)).toBe(true);
    // S3's place on T1's path is the new point; S4 and S5 moved on by as
    // much as the path grew; S1 and S2 where they were.
    const t1 = await placesOn(db, "T1");
    const grew = t1[3].d - t1Before[3].d;
    // Redrawn 666 m either side (three times the 222 m moved): about
    // 72 m longer.
    expect(grew).toBeGreaterThan(65);
    expect(grew).toBeLessThan(80);
    expect(t1[4].d - t1Before[4].d).toBeCloseTo(grew, 0);
    expect(t1[0].d).toBeCloseTo(t1Before[0].d);
    expect(t1[1].d).toBeCloseTo(t1Before[1].d);
    // The feed's distances, in km, follow; and so does T1's length.
    const [s4] = await db.all<{ shape_dist: number }>(
      "SELECT shape_dist FROM stop_times WHERE trip_idx = 0 AND stop_sequence = 4"
    );
    expect(s4.shape_dist).toBeCloseTo(2.04 + grew / 1000, 2);
    const [t1Trip] = await db.all<{ length_m: number }>("SELECT length_m FROM trips WHERE trip_id = 'T1'");
    expect(t1Trip.length_m).toBeCloseTo(2720 + grew, -1);
    // T4 still on SH1, its last stop at S3's new place on it.
    const [t4] = await db.all<{ shape_id: string; shape_idx: number }>(`
      SELECT m.shape_id, m.shape_idx FROM trips t JOIN shapes_meta m USING (shape_idx) WHERE t.trip_id = 'T4'`);
    expect(t4.shape_id).toBe("SH1");
    const t4Places = await placesOn(db, "T4");
    expect(t4Places.at(-1)?.d).toBeCloseTo(t1[2].d, 3);
    // T3, drawn through its stops, follows S3.
    const [t3] = await db.all<{ shape_idx: number }>("SELECT shape_idx FROM trips WHERE trip_id = 'T3'");
    const chain = await db.all<{ lat: number }>(
      `SELECT lat FROM shape_points WHERE shape_idx = ${t3.shape_idx} ORDER BY i`
    );
    expect(chain[2].lat).toBeCloseTo(52.502);
    expect(session.redrawnShapes.sort()).toEqual(
      [0, t3.shape_idx, t4.shape_idx, ...(built.rows.shapes ?? [])]
        .filter((v, i, a) => a.indexOf(v) === i)
        .sort()
    );

    await session.undo();
    expect(await all(db)).toBe(before);
  });

  it("copies the path where another pattern runs the stretch without stopping, and saves both", async () => {
    // T9, an express on SH1 from S2 to S4, running past S3 without calling.
    await db.exec(`INSERT INTO patterns SELECT * REPLACE (8 AS pattern_idx, [2, 4]::INTEGER[] AS stops, 2 AS n_stops)
      FROM patterns WHERE pattern_idx = 0`);
    await db.exec(`INSERT INTO trips SELECT * REPLACE (99 AS trip_idx, 'T9' AS trip_id, 8 AS pattern_idx)
      FROM trips WHERE trip_id = 'T1'`);
    await db.exec(`INSERT INTO pattern_shape_stops
      SELECT 8, shape_idx, CASE i WHEN 1 THEN 0 ELSE 1 END, d FROM pattern_shape_stops
      WHERE pattern_idx = 0 AND shape_idx = 0 AND i IN (1, 3)`);
    const built = await moveStop(db, await idx(db, "S3"), [13.42, 52.502], "km");
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.facts).toMatchObject({ forked: 1 });
    const ops = built.rows.gtfs;
    expect(ops[0]).toEqual({
      role: "stops",
      op: "update",
      key: { stop_id: "S3" },
      values: { stop_lat: 52.502, stop_lon: 13.42 },
    });
    // The trips calling at S3 onto the copy, T9 left on SH1 as it was.
    const moved = ops.flatMap((o) => (o.role === "trips" && o.op === "update" ? [o.key.trip_id] : []));
    expect(moved).toContain("T4");
    expect(moved).toContain("T1");
    expect(moved).not.toContain("T9");
    const reshapes = ops.filter((o) => o.op === "reshape");
    expect(reshapes.map((o) => [o.key.shape_id, "source" in o ? o.source : null])).toEqual([
      ["SH1_goat1", "SH1"],
    ]);
    const copy = reshapes[0];
    if (copy.op !== "reshape") throw new Error();
    expect(copy.through).toBe("S3");
    // The trips its distances follow, named: those calling at S3, not T9.
    expect(copy.trips).toContain("T1");
    expect(copy.trips).toContain("T4");
    expect(copy.trips).not.toContain("T9");
    expect(copy.stretches).toHaveLength(1);
    expect(copy.stretches[0].from).toBeGreaterThan(0);
    expect(copy.stretches[0].to).toBeLessThan(1);
    expect(copy.stretches[0].points).toEqual([[13.42, 52.502]]);
  });

  describe("with Snap on", () => {
    const setType = (type: number) => db.all(`UPDATE routes SET route_type = ${type}`);
    // A road leaving the old path, past the dropped stop a little to its
    // south, and back: where the router met the stop, the second of three.
    const road =
      (calls: [number, number][][]): Router =>
      async (waypoints) => {
        calls.push(waypoints);
        const [start, , end] = waypoints;
        return {
          line: [start, [13.418, 52.5015], [13.42, 52.5018], [13.422, 52.5015], end ?? [13.423, 52.5]],
          snapped: [start, [13.42, 52.5018], end ?? [13.423, 52.5]],
        };
      };

    it("draws a bus's stretch along the road and saves where the stop lies on it", async () => {
      await setType(3);
      const calls: [number, number][][] = [];
      const built = await moveStop(db, await idx(db, "S3"), [13.42, 52.502], "km", road(calls));
      if (!built.ok) throw new Error(built.refused.code);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0][1]).toEqual([13.42, 52.502]);
      const reshapes = built.rows.gtfs.filter((o) => o.op === "reshape");
      const main = reshapes.find((o) => o.key.shape_id === "SH1");
      if (!main || main.op !== "reshape") throw new Error();
      // The road's points, the stop at the one the router met it at.
      expect(main.stretches[0].points).toContainEqual([13.42, 52.5018]);
      expect(main.stretches[0].points[main.stretches[0].stop_point ?? 0]).toEqual([13.42, 52.5018]);
      expect(built.checks.map((c) => c.code)).not.toContain("goat_snap_route_failed");
      // The stop stays where it was dropped.
      expect(built.rows.gtfs[0]).toMatchObject({ values: { stop_lat: 52.502, stop_lon: 13.42 } });
    });

    it("routes a bus from the stop before to the stop after, leaving none of the old path between", async () => {
      await setType(3);
      const s3 = await idx(db, "S3");
      // Where the stops either side of S3 lie on SH1, as shares of its line's length.
      const [near] = await db.all<{ prev: number; next: number }>(`
        WITH t AS (
          SELECT t.pattern_idx, t.shape_idx, list_position(pt.stops, ${s3}) - 1 AS i
          FROM trips t JOIN shapes_meta m USING (shape_idx) JOIN patterns pt USING (pattern_idx)
          WHERE m.shape_id = 'SH1' AND list_contains(pt.stops, ${s3}) LIMIT 1)
        SELECT max(p.d) FILTER (WHERE p.i = t.i - 1) / max(l.len) AS prev,
               max(p.d) FILTER (WHERE p.i = t.i + 1) / max(l.len) AS next
        FROM t JOIN pattern_shape_stops p USING (pattern_idx, shape_idx)
        JOIN (SELECT shape_idx, max(d) AS len FROM shape_points GROUP BY 1) l USING (shape_idx)`);
      const built = await moveStop(db, s3, [13.42, 52.502], "km", road([]));
      if (!built.ok) throw new Error(built.refused.code);
      const main = built.rows.gtfs.find((o) => o.op === "reshape" && o.key.shape_id === "SH1");
      if (!main || main.op !== "reshape") throw new Error();
      expect(main.stretches[0].from).toBeCloseTo(near.prev, 6);
      expect(main.stretches[0].to).toBeCloseTo(near.next, 6);
    });

    it("keeps a train's stretch straight: it does not run on the roads", async () => {
      await setType(2);
      const calls: [number, number][][] = [];
      const built = await moveStop(db, await idx(db, "S3"), [13.42, 52.502], "km", road(calls));
      if (!built.ok) throw new Error(built.refused.code);
      expect(calls).toEqual([]);
      const main = built.rows.gtfs.find((o) => o.op === "reshape" && o.key.shape_id === "SH1");
      if (!main || main.op !== "reshape") throw new Error();
      expect(main.stretches[0].points).toEqual([[13.42, 52.502]]);
    });

    it("draws the stretch straight and says so when there is no road, or it detours", async () => {
      await setType(3);
      const none: Router = async () => {
        throw new Error("offline");
      };
      const detour: Router = async (waypoints) => ({
        line: [waypoints[0], [14.5, 53.5], waypoints.at(-1) as [number, number]],
        snapped: waypoints,
      });
      for (const router of [none, detour]) {
        const built = await moveStop(db, await idx(db, "S3"), [13.42, 52.502], "km", router);
        if (!built.ok) throw new Error(built.refused.code);
        expect(built.checks.map((c) => c.code)).toContain("goat_snap_route_failed");
        const main = built.rows.gtfs.find((o) => o.op === "reshape" && o.key.shape_id === "SH1");
        if (!main || main.op !== "reshape") throw new Error();
        expect(main.stretches[0].points).toEqual([[13.42, 52.502]]);
      }
    });
  });

  it("gives each copy of a path made in one move an id of its own", async () => {
    // Two copies of one path: one id each, not the same one twice (the copies
    // read back as one line, zigzagging between them).
    const issued = new Set<string>();
    const a = await forkId(db, "SH1", issued);
    const b = await forkId(db, "SH1", issued);
    expect(a).not.toEqual(b);
    expect([a, b]).toEqual(["SH1_goat1", "SH1_goat2"]);
  });

  it("changes nothing when the stop is let go where it was", async () => {
    const [s3] = await db.all<{ lon: number; lat: number }>(
      "SELECT lon, lat FROM stops WHERE stop_id = 'S3'"
    );
    const built = await moveStop(db, await idx(db, "S3"), [s3.lon, s3.lat], "km");
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.rows.sql).toEqual([]);
    expect(built.rows.gtfs).toEqual([]);
  });

  it("keeps the path before a neighbour that has no place on it, not taking it for the path's start", async () => {
    // S2 unplaced on T1's path.
    await db.exec(`DELETE FROM pattern_shape_stops WHERE pattern_idx = 0 AND shape_idx = 0 AND i = 1`);
    const [first] = await db.all<{ lon: number; lat: number }>(
      "SELECT lon, lat FROM shape_points WHERE shape_idx = 0 ORDER BY i LIMIT 1"
    );
    const built = await moveStop(db, await idx(db, "S3"), [13.42, 52.502], "km");
    if (!built.ok) throw new Error(built.refused.code);
    const main = built.rows.gtfs.find((o) => o.op === "reshape" && o.key.shape_id === "SH1");
    if (!main || main.op !== "reshape") throw new Error();
    expect(main.stretches[0].from).not.toBeNull();
    await new EditSession(db).apply({ id: "m", label: "Moved", ...built.rows });
    const [after] = await db.all<{ lon: number; lat: number }>(
      "SELECT lon, lat FROM shape_points WHERE shape_idx = 0 ORDER BY i LIMIT 1"
    );
    expect(after).toEqual(first);
  });

  it("moves a stop no line calls at alone", async () => {
    const built = await moveStop(db, await idx(db, "X"), [13.5, 52.61], "km");
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.rows.gtfs).toHaveLength(1);
    await new EditSession(db).apply({ id: "m", label: "Moved", ...built.rows });
    expect(await db.all("SELECT lat FROM stops WHERE stop_id = 'X'")).toEqual([{ lat: 52.61 }]);
  });
});
