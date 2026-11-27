// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";

import { openFixtureDb } from "@/lib/explorer/__tests__/fixtureDb";
import type { SqlRunner } from "@/lib/explorer/db/types";
import {
  type LineScope,
  addScopeOptions,
  addToLine,
  cutLine,
  removeFromLine,
  removeScopeOptions,
} from "@/lib/explorer/edit/ops/lineStops";
import { EditSession } from "@/lib/explorer/edit/session";

const TABLES = {
  stops: "stop_idx",
  stop_times: "trip_idx, stop_sequence",
  trips: "trip_idx",
  patterns: "pattern_idx",
  pattern_shape_stops: "pattern_idx, shape_idx, i",
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
  (
    await db.all<{ calls: string[] }>(`
      SELECT list(s.stop_id ORDER BY st.stop_sequence) AS calls
      FROM trips t JOIN stop_times st USING (trip_idx) JOIN stops s ON s.stop_idx = st.stop_idx
      WHERE t.trip_id = '${trip_id}'`)
  )[0].calls;

describe("3.2 remove a stop from a line", () => {
  let db: SqlRunner;
  let scope: LineScope;
  beforeEach(async () => {
    db = await openFixtureDb();
    // Line 0, its first direction shown: pattern 0 (S1..S5), with its
    // short turn (pattern 2, S1..S3); the other direction is pattern 1.
    scope = { route_idx: 0, level: "variant", pattern_idx: 0, direction: [0, 2] };
  });

  it("takes the stop off the variant's trips only, keeping the stop, and undo puts it all back", async () => {
    const before = await all(db);
    const s3 = await idx(db, "S3");
    const built = await removeFromLine(db, s3, scope, "km");
    if (!built.ok) throw new Error(built.refused.code);
    const session = new EditSession(db);
    await session.apply({ id: "r", label: "Removed", ...built.rows });
    expect(await calls(db, "T1")).not.toContain("S3");
    // The other direction and the short turn keep calling there.
    expect(await calls(db, "T4")).toContain("S3");
    expect(await db.all(`SELECT 1 FROM stops WHERE stop_idx = ${s3}`)).toHaveLength(1);
    // The bundle keeps the stop: only stop times go.
    expect(built.rows.gtfs.every((o) => o.role !== "stops")).toBe(true);
    await session.undo();
    expect(await all(db)).toBe(before);
  });

  it("offers each level with the trips it takes, and says why one takes none", async () => {
    const options = await removeScopeOptions(db, scope, await idx(db, "S3"));
    const by = Object.fromEntries(options.map((o) => [o.level, o]));
    expect(by.variant.trips).toBeGreaterThan(0);
    expect(by.direction.trips).toBeGreaterThan(by.variant.trips);
    expect(by.line.trips).toBeGreaterThan(by.direction.trips);
    // S5 is not on the short turn: the variant shown there takes none.
    const short = await removeScopeOptions(db, { ...scope, pattern_idx: 2 }, await idx(db, "S5"));
    expect(short.find((o) => o.level === "variant")).toMatchObject({ trips: 0, none: "not_here" });
  });

  it("refuses to leave a trip with fewer than two stops", async () => {
    // The short turn S1..S3 without two of its three stops: refused at the second.
    const first = await removeFromLine(db, await idx(db, "S3"), { ...scope, pattern_idx: 2 }, "km");
    if (!first.ok) throw new Error(first.refused.code);
    await new EditSession(db).apply({ id: "a", label: "a", ...first.rows });
    const [p] = await db.all<{ pattern_idx: number }>("SELECT pattern_idx FROM trips WHERE trip_id = 'T4'");
    const second = await removeFromLine(
      db,
      await idx(db, "S2"),
      { ...scope, pattern_idx: p.pattern_idx },
      "km"
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.refused.code).toBe("unusable_trip");
  });
});

describe("3.1 add a stop to a line", () => {
  let db: SqlRunner;
  let scope: LineScope;
  beforeEach(async () => {
    db = await openFixtureDb();
    scope = { route_idx: 0, level: "variant", pattern_idx: 0, direction: [0, 2] };
  });
  const times = (trip_id: string) =>
    db.all<{ stop_id: string; seq: number; arr: number | null; dep: number | null }>(`
      SELECT s.stop_id, st.stop_sequence AS seq, st.arrival_s AS arr, st.departure_s AS dep
      FROM stop_times st JOIN stops s USING (stop_idx) JOIN trips t USING (trip_idx)
      WHERE t.trip_id = '${trip_id}' ORDER BY st.stop_sequence`);

  it("adds a stop off the path between two neighbours: untimed, the path drawn through it, undo puts it all back", async () => {
    const before = await all(db);
    const t1 = await times("T1");
    const [s2, s3, x] = [await idx(db, "S2"), await idx(db, "S3"), await idx(db, "X")];
    const built = await addToLine(db, x, s2, s3, scope, "km");
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.facts.off_path_m).toBeGreaterThan(15);
    expect(built.facts.paths.length).toBeGreaterThan(0);
    const session = new EditSession(db);
    await session.apply({ id: "a", label: "Added", ...built.rows });
    const after = await times("T1");
    expect(after.map((r) => r.stop_id)).toEqual(["S1", "S2", "X", "S3", "S4", "S5"]);
    // Untimed; every other time as it was; numbered in order.
    const added = after.find((r) => r.stop_id === "X");
    expect(added).toMatchObject({ arr: null, dep: null });
    expect(after.filter((r) => r.stop_id !== "X").map((r) => [r.arr, r.dep])).toEqual(
      t1.map((r) => [r.arr, r.dep])
    );
    expect(after.every((r, k) => k === 0 || r.seq > after[k - 1].seq)).toBe(true);
    // Placed on T1's path, every stop of its pattern.
    const [n] = await db.all<{ placed: number; stops: number }>(`
      SELECT CAST(count(*) AS INTEGER) AS placed,
             any_value(len((SELECT stops FROM patterns WHERE pattern_idx = t.pattern_idx))) AS stops
      FROM trips t JOIN pattern_shape_stops ps ON ps.pattern_idx = t.pattern_idx AND ps.shape_idx = t.shape_idx
      WHERE t.trip_id = 'T1'`);
    expect(n.placed).toBe(n.stops);
    // The bundle: the row inserted (room made first where needed), the path redrawn.
    const ops = built.rows.gtfs;
    expect(ops).toContainEqual(
      expect.objectContaining({ role: "stop_times", op: "insert", values: { stop_id: "X" } })
    );
    expect(ops.some((o) => o.op === "reshape")).toBe(true);
    expect(ops.some((o) => o.role === "stops")).toBe(false);
    await session.undo();
    expect(await all(db)).toBe(before);
  });

  it("places a stop lying on the path where it passes, the path as it was", async () => {
    // A stop on SH1 halfway between S2 and S3.
    const [mid] = await db.all<{ lon: number; lat: number }>(`
      WITH placed AS (SELECT i, d FROM pattern_shape_stops WHERE pattern_idx = 0 AND shape_idx = 0)
      SELECT lon, lat FROM shape_points WHERE shape_idx = 0
      ORDER BY abs(d - ((SELECT d FROM placed WHERE i = 1) + (SELECT d FROM placed WHERE i = 2)) / 2) LIMIT 1`);
    await db.exec(`INSERT INTO stops (stop_idx, stop_id, name, lat, lon, location_type)
                   VALUES (950, 'ON', 'On the line', ${mid.lat}, ${mid.lon}, 0)`);
    const built = await addToLine(db, 950, await idx(db, "S2"), await idx(db, "S3"), scope, "km");
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.facts.off_path_m).toBeLessThan(15);
    expect(built.rows.gtfs.some((o) => o.op === "reshape")).toBe(false);
    await new EditSession(db).apply({ id: "a", label: "Added", ...built.rows });
    expect((await times("T1")).map((r) => r.stop_id)).toEqual(["S1", "S2", "ON", "S3", "S4", "S5"]);
  });

  it("counts the other direction for the whole line, and refuses a stop as its own neighbour", async () => {
    const [s2, s3] = [await idx(db, "S2"), await idx(db, "S3")];
    const options = await addScopeOptions(db, scope, s2, s3);
    const by = Object.fromEntries(options.map((o) => [o.level, o]));
    expect(by.line.trips).toBeGreaterThan(by.direction.trips);
    const own = await addToLine(db, s2, s2, s3, scope, "km");
    expect(own.ok).toBe(false);
    if (!own.ok) expect(own.refused.code).toBe("goat_add_neighbour");
  });
});

describe("1.4 cut a line back", () => {
  let db: SqlRunner;
  let scope: LineScope;
  beforeEach(async () => {
    db = await openFixtureDb();
    scope = { route_idx: 0, level: "variant", pattern_idx: 0, direction: [0, 2] };
  });

  it("ends the variant's trips at a stop, the stops past it gone from them, and undo puts it all back", async () => {
    const before = await all(db);
    const built = await cutLine(db, await idx(db, "S4"), "end", scope, "km");
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.facts).toMatchObject({ end: "end", dropped: 1 });
    expect(built.facts.trips).toBe(built.facts.trip_idxs.length);
    expect(built.facts.trips).toBeGreaterThan(0);
    // The path stays; the part past the cut is previewed faint.
    expect(built.facts.paths.length).toBeGreaterThan(0);
    for (const p of built.facts.paths) expect(p.old?.replaced.length).toBeGreaterThan(0);
    const session = new EditSession(db);
    await session.apply({ id: "c", label: "Cut", ...built.rows });
    expect(Array.from(await calls(db, "T1"))).toEqual(["S1", "S2", "S3", "S4"]);
    // The short turn and the other direction as they were.
    expect(Array.from(await calls(db, "T4"))).toEqual(["S1", "S2", "S3"]);
    // Its last time now at S4; the stops themselves stay.
    const [t1] = await db.all<{ last: number; s4: number }>(`
      SELECT t.last_arr_s AS last, st.arrival_s AS s4 FROM trips t JOIN stop_times st USING (trip_idx)
      JOIN stops s USING (stop_idx) WHERE t.trip_id = 'T1' AND s.stop_id = 'S4'`);
    expect(t1.last).toBe(t1.s4);
    expect(await db.all("SELECT 1 FROM stops WHERE stop_id = 'S5'")).toHaveLength(1);
    // The bundle loses each trip's stop time at S5, nothing else of the stop.
    const deleted = built.rows.gtfs.filter((o) => o.role === "stop_times" && o.op === "delete");
    expect(deleted).toHaveLength(built.facts.trips);
    expect(built.rows.gtfs.every((o) => o.role !== "stops" && o.op !== "reshape")).toBe(true);
    await session.undo();
    expect(await all(db)).toBe(before);
  });

  it("starts them at a stop, the stops before it gone", async () => {
    const built = await cutLine(db, await idx(db, "S2"), "start", scope, "km");
    if (!built.ok) throw new Error(built.refused.code);
    await new EditSession(db).apply({ id: "c", label: "Cut", ...built.rows });
    expect(Array.from(await calls(db, "T1"))).toEqual(["S2", "S3", "S4", "S5"]);
  });

  it("cuts the direction back, its variants merged where they now run the same stops", async () => {
    const before = await all(db);
    const built = await cutLine(db, await idx(db, "S2"), "end", { ...scope, level: "direction" }, "km");
    if (!built.ok) throw new Error(built.refused.code);
    const session = new EditSession(db);
    await session.apply({ id: "c", label: "Cut", ...built.rows });
    expect(Array.from(await calls(db, "T1"))).toEqual(["S1", "S2"]);
    expect(Array.from(await calls(db, "T4"))).toEqual(["S1", "S2"]);
    const [p] = await db.all<{ n: number }>(`
      SELECT CAST(count(DISTINCT pattern_idx) AS INTEGER) AS n FROM trips WHERE trip_id IN ('T1', 'T4')`);
    expect(p.n).toBe(1);
    await session.undo();
    expect(await all(db)).toBe(before);
  });

  it("refuses a cut that leaves one stop, cuts nothing, or ends a trip where it has no time", async () => {
    const one = await cutLine(db, await idx(db, "S1"), "end", scope, "km");
    expect(!one.ok && one.refused.code).toBe("unusable_trip");
    const none = await cutLine(db, await idx(db, "S5"), "end", scope, "km");
    expect(!none.ok && none.refused.code).toBe("goat_cut_nothing");
    await db.exec(`UPDATE stop_times SET arrival_s = NULL, departure_s = NULL
                   WHERE trip_idx = (SELECT trip_idx FROM trips WHERE trip_id = 'T1')
                     AND stop_idx = (SELECT stop_idx FROM stops WHERE stop_id = 'S4')`);
    const untimed = await cutLine(db, await idx(db, "S4"), "end", scope, "km");
    expect(!untimed.ok && untimed.refused.code).toBe("missing_trip_edge");
  });
});
