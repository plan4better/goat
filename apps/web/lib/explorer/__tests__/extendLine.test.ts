// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";

import { openFixtureDb } from "@/lib/explorer/__tests__/fixtureDb";
import type { SqlRunner } from "@/lib/explorer/db/types";
import { extendLine, extendScopeOptions } from "@/lib/explorer/edit/ops/extendLine";
import type { LineScope } from "@/lib/explorer/edit/ops/lineStops";
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
const calls = async (db: SqlRunner, trip_id: string) =>
  db.all<{ stop_id: string; seq: number; arr: number | null; dist: number | null }>(`
    SELECT s.stop_id, st.stop_sequence AS seq, st.arrival_s AS arr, st.shape_dist AS dist
    FROM trips t JOIN stop_times st USING (trip_idx) JOIN stops s ON s.stop_idx = st.stop_idx
    WHERE t.trip_id = '${trip_id}' ORDER BY st.stop_sequence`);
const trip = async (db: SqlRunner, trip_id: string) =>
  (
    await db.all<{
      headsign: string;
      first_dep_s: number;
      last_arr_s: number;
      shape_id: string;
      length_m: number;
    }>(`
      SELECT t.headsign, t.first_dep_s, t.last_arr_s, m.shape_id, t.length_m
      FROM trips t LEFT JOIN shapes_meta m USING (shape_idx) WHERE t.trip_id = '${trip_id}'`)
  )[0];

describe("1.3 extend a line", () => {
  let db: SqlRunner;
  // Line 0's first direction: pattern 0 (S1..S5, T1 and T2) and its short
  // turn (pattern 2, S1..S3, T4), on SH1; its speed 2720 m in 8 min.
  const scope = (level: LineScope["level"], pattern_idx = 0): LineScope => ({
    route_idx: 0,
    level,
    pattern_idx,
    direction: [0, 2],
  });
  beforeEach(async () => {
    db = await openFixtureDb();
  });

  it("runs on past the end, the new end timed from the line's speed, and undo puts it all back", async () => {
    const before = await all(db);
    const built = await extendLine(
      db,
      await idx(db, "S5"),
      "end",
      [await idx(db, "S6")],
      scope("direction"),
      "km"
    );
    if (!built.ok) throw new Error(built.refused.code);
    // T1 and T2 end at S5; T4, the short turn, ends at S3 and keeps SH1:
    // the two get a copy that runs on.
    expect(built.facts).toMatchObject({ trips: 2, forked: 1, speed_kmh: 20 });
    expect(built.facts.metres).toBeCloseTo(677, -1);
    const session = new EditSession(db);
    await session.apply({ id: "x", label: "Extended", ...built.rows });

    const t1 = await calls(db, "T1");
    expect(t1.map((c) => c.stop_id)).toEqual(["S1", "S2", "S3", "S4", "S5", "S6"]);
    // 08:08 at S5; 677 m at 5.67 m/s is 2 minutes.
    expect(t1[5].arr).toBe((t1[4].arr as number) + 120);
    expect(t1[5].dist).toBeCloseTo(2.72 + 0.677, 2);
    expect(await trip(db, "T1")).toMatchObject({
      headsign: "Sixth",
      last_arr_s: t1[5].arr,
      shape_id: "SH1_goat1",
    });
    expect((await trip(db, "T1")).length_m).toBeCloseTo(2720 + 677, -1);
    expect((await trip(db, "T4")).shape_id).toBe("SH1");

    // Saved: the stop time inserted, timed, the trip headed for S6, the copy.
    const insert = built.rows.gtfs.find((o) => o.role === "stop_times" && o.op === "insert");
    expect(insert).toMatchObject({
      values: { stop_id: "S6", arrival_time: "08:10:00", departure_time: "08:10:00" },
    });
    const reshape = built.rows.gtfs.find((o) => o.op === "reshape");
    expect(reshape).toMatchObject({ key: { shape_id: "SH1_goat1" }, source: "SH1" });
    expect(built.rows.gtfs.at(-1)?.op).toBe("reshape");

    await session.undo();
    expect(await all(db)).toBe(before);
  });

  it("leaves the stops between the old end and the new untimed", async () => {
    const built = await extendLine(
      db,
      await idx(db, "S5"),
      "end",
      [await idx(db, "X"), await idx(db, "S6")],
      scope("direction"),
      "km"
    );
    if (!built.ok) throw new Error(built.refused.code);
    await new EditSession(db).apply({ id: "x", label: "Extended", ...built.rows });
    const t1 = await calls(db, "T1");
    expect(t1.map((c) => c.stop_id).slice(-2)).toEqual(["X", "S6"]);
    expect(t1[5].arr).toBeNull();
    expect(t1[6].arr).not.toBeNull();
  });

  it("runs from a new first stop at the start, timed before the old one", async () => {
    const built = await extendLine(
      db,
      await idx(db, "S1"),
      "start",
      [await idx(db, "X")],
      scope("variant"),
      "km"
    );
    if (!built.ok) throw new Error(built.refused.code);
    await new EditSession(db).apply({ id: "x", label: "Extended", ...built.rows });
    const t1 = await calls(db, "T1");
    expect(t1.map((c) => c.stop_id)).toEqual(["X", "S1", "S2", "S3", "S4", "S5"]);
    expect(t1[0].arr).toBeLessThan(t1[1].arr as number);
    expect(t1[0].seq).toBeLessThan(t1[1].seq);
    expect((await trip(db, "T1")).first_dep_s).toBe(t1[0].arr);
  });

  it("makes room below a first stop numbered 0", async () => {
    await db.exec("UPDATE stop_times SET stop_sequence = stop_sequence - 1 WHERE trip_idx = 0");
    const built = await extendLine(
      db,
      await idx(db, "S1"),
      "start",
      [await idx(db, "X")],
      scope("variant"),
      "km"
    );
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.rows.gtfs.filter((o) => o.op === "shift").length).toBeGreaterThan(0);
    await new EditSession(db).apply({ id: "x", label: "Extended", ...built.rows });
    expect((await calls(db, "T1")).map((c) => c.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("draws a line through its stops again, through the new ones", async () => {
    // T3 runs the other way, S5 to S1, through its stops.
    const other: LineScope = {
      route_idx: 0,
      level: "direction",
      pattern_idx: 1,
      direction: [1],
    };
    const built = await extendLine(db, await idx(db, "S1"), "end", [await idx(db, "X")], other, "km");
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.rows.dropped?.length).toBe(1);
    await new EditSession(db).apply({ id: "x", label: "Extended", ...built.rows });
    const [last] = await db.all<{ lat: number }>(`
      SELECT p.lat FROM trips t JOIN shape_points p USING (shape_idx) WHERE t.trip_id = 'T3' ORDER BY p.i DESC LIMIT 1`);
    expect(last.lat).toBeCloseTo(52.6);
  });

  it("offers the levels whose trips end there", async () => {
    const options = await extendScopeOptions(db, scope("variant", 2), await idx(db, "S3"), "end");
    expect(options.find((o) => o.level === "variant")?.trips).toBe(1);
    expect(options.find((o) => o.level === "direction")?.trips).toBe(1);
  });

  it("refuses at the start of a frequency-based trip", async () => {
    const [f] = await db.all<{ route_idx: number; pattern_idx: number; first: number }>(`
      SELECT t.route_idx, t.pattern_idx, p.stops[1] AS first FROM trips t JOIN patterns p USING (pattern_idx)
      WHERE t.trip_id = 'F1'`);
    const built = await extendLine(
      db,
      f.first,
      "start",
      [await idx(db, "X")],
      {
        route_idx: f.route_idx,
        level: "variant",
        pattern_idx: f.pattern_idx,
        direction: [f.pattern_idx],
      },
      "km"
    );
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.refused.code).toBe("goat_frequency_start");
  });
});
