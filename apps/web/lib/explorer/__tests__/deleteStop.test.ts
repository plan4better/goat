// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";

import { openFixtureDb } from "@/lib/explorer/__tests__/fixtureDb";
import type { SqlRunner } from "@/lib/explorer/db/types";
import { tripsAnnualFigures } from "@/lib/explorer/derive/cost";
import { deleteStop } from "@/lib/explorer/edit/ops/deleteStop";
import { EditSession } from "@/lib/explorer/edit/session";

/** Every table the edit may touch, as text: "exactly as before". */
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
const trip = async (db: SqlRunner, trip_id: string) =>
  (
    await db.all<Record<string, unknown>>(`
      SELECT t.*, list(s.stop_id ORDER BY st.stop_sequence) AS calls
      FROM trips t JOIN stop_times st USING (trip_idx) JOIN stops s ON s.stop_idx = st.stop_idx
      WHERE t.trip_id = '${trip_id}' GROUP BY ALL`)
  )[0];

describe("2.3 delete stop", () => {
  let db: SqlRunner;
  beforeEach(async () => {
    db = await openFixtureDb();
  });

  it("takes the stop out of every trip, the cascade with it, and undo puts all of it back", async () => {
    const before = await all(db);
    const built = await deleteStop(db, await idx(db, "S5"), "km");
    if (!built.ok) throw new Error(built.refused.code);
    // T1, T2 end there; T3 starts there; F1 calls there.
    expect(built.facts).toMatchObject({ trips: 4, patterns: 3, merged: 1, headsigns: 2 });
    const session = new EditSession(db);
    await session.apply({ id: "d", label: "Deleted", ...built.rows });

    expect(await db.all("SELECT * FROM stops WHERE stop_id = 'S5'")).toEqual([]);
    const t1 = await trip(db, "T1");
    expect(Array.from(t1.calls as ArrayLike<string>)).toEqual(["S1", "S2", "S3", "S4"]);
    // Later stops keep their times; the trip ends a stop earlier, and is
    // headed for it; its length is the feed's distance to it.
    expect(t1).toMatchObject({ first_dep_s: 28800, last_arr_s: 29160, headsign: "Fourth" });
    expect(t1.length_m).toBeCloseTo(2040);
    const t3 = await trip(db, "T3");
    expect(t3).toMatchObject({ first_dep_s: 30120, headsign: "Main Station" });
    // F1 now runs as F2 does, S4 to S6: one pattern, on F2's line.
    const f1 = await trip(db, "F1");
    const f2 = await trip(db, "F2");
    expect(f1.pattern_idx).toBe(f2.pattern_idx);
    expect(f1.shape_idx).toBe(f2.shape_idx);
    expect(await db.all(`SELECT n_trips FROM patterns WHERE pattern_idx = ${f2.pattern_idx}`)).toEqual([
      { n_trips: 2 },
    ]);
    // T3's line through its stops is drawn anew, without S5, and placed.
    const line = await db.all<{ n: number; first_lon: number }>(`
      SELECT count(*) AS n, arg_min(lon, i) AS first_lon FROM shape_points WHERE shape_idx = ${t3.shape_idx}`);
    expect(line[0]).toMatchObject({ n: 4 });
    expect(line[0].first_lon).toBeCloseTo(13.43);
    const placed = await db.all<{ i: number }>(
      `SELECT i FROM pattern_shape_stops WHERE pattern_idx = ${t3.pattern_idx} AND shape_idx = ${t3.shape_idx} ORDER BY i`
    );
    expect(placed.map((p) => p.i)).toEqual([0, 1, 2, 3]);

    await session.undo();
    expect(await all(db)).toBe(before);
  });

  it("saves the stop, its stop times and the new headsigns as bundle rows", async () => {
    const built = await deleteStop(db, await idx(db, "S5"), "km");
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.rows.gtfs).toEqual([
      { role: "stop_times", op: "delete", key: { trip_id: "T1", stop_sequence: 5 } },
      { role: "stop_times", op: "delete", key: { trip_id: "T2", stop_sequence: 5 } },
      { role: "stop_times", op: "delete", key: { trip_id: "T3", stop_sequence: 1 } },
      { role: "stop_times", op: "delete", key: { trip_id: "F1", stop_sequence: 2 } },
      { role: "stops", op: "delete", key: { stop_id: "S5" } },
      { role: "trips", op: "update", key: { trip_id: "T1" }, values: { trip_headsign: "Fourth" } },
      { role: "trips", op: "update", key: { trip_id: "T2" }, values: { trip_headsign: "Fourth" } },
    ]);
  });

  it("keeps a loop a loop without its middle stop", async () => {
    const built = await deleteStop(db, await idx(db, "S3"), "km");
    if (!built.ok) throw new Error(built.refused.code);
    await new EditSession(db).apply({ id: "d", label: "Deleted", ...built.rows });
    const l1 = await trip(db, "L1");
    expect(Array.from(l1.calls as ArrayLike<string>)).toEqual(["S1", "S2", "S1"]);
    // T4 ended at S3, headed "Third": now for S2.
    expect((await trip(db, "T4")).headsign).toBe("Second");
  });

  it("previews what it costs without applying it", async () => {
    const before = await all(db);
    const built = await deleteStop(db, await idx(db, "S5"), "km");
    if (!built.ok) throw new Error(built.refused.code);
    const where = `trip_idx IN (${built.facts.trip_idxs.join(", ")})`;
    const seen = await new EditSession(db).preview(built.rows.sql, (d) =>
      tripsAnnualFigures(d, where, ["2026-03-01", "2026-12-31"])
    );
    // Shorter trips, the same days: fewer vehicle-kilometres.
    expect(seen?.after.vehicle_km).toBeLessThan(seen?.before.vehicle_km as number);
    expect(await all(db)).toBe(before);
  });

  it("refuses to leave a trip with one stop", async () => {
    const built = await deleteStop(db, await idx(db, "S6"), "km");
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.refused).toMatchObject({ code: "unusable_trip", params: { count: 3 } });
  });

  it("refuses to leave a trip ending where it has no time", async () => {
    await db.exec(`UPDATE stop_times SET arrival_s = NULL, departure_s = NULL
                   WHERE trip_idx = (SELECT trip_idx FROM trips WHERE trip_id = 'T1') AND stop_sequence = 4`);
    const built = await deleteStop(db, await idx(db, "S5"), "km");
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.refused).toMatchObject({ code: "missing_trip_edge", params: { count: 1 } });
  });

  it("lets a trip keep an untimed end it already had", async () => {
    // T1's first stop has no time in the feed; deleting S3 does not touch it.
    await db.exec(`UPDATE stop_times SET arrival_s = NULL, departure_s = NULL
                   WHERE trip_idx = (SELECT trip_idx FROM trips WHERE trip_id = 'T1') AND stop_sequence = 0`);
    const built = await deleteStop(db, await idx(db, "S3"), "km");
    expect(built.ok).toBe(true);
  });

  it("refuses to take a frequency-based trip's first stop", async () => {
    await db.exec(
      `INSERT INTO frequencies SELECT trip_idx, 21600, 36000, 600, 0 FROM trips WHERE trip_id = 'T1'`
    );
    const [first] = await db.all<{ stop_id: string }>(`
      SELECT s.stop_id FROM stop_times st JOIN stops s USING (stop_idx)
      WHERE st.trip_idx = (SELECT trip_idx FROM trips WHERE trip_id = 'T1') ORDER BY st.stop_sequence LIMIT 1`);
    const built = await deleteStop(db, await idx(db, first.stop_id), "km");
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.refused.code).toBe("goat_frequency_start");
  });

  it("deletes a station trips call at, as a stop, leaving no stop time behind", async () => {
    const p = await idx(db, "P");
    // T1 runs on from S5 to the station itself, as some feeds have it.
    await db.exec(`INSERT INTO stop_times SELECT * REPLACE (${p} AS stop_idx, stop_sequence + 1 AS stop_sequence,
                     arrival_s + 120 AS arrival_s, departure_s + 120 AS departure_s)
                   FROM stop_times WHERE trip_idx = (SELECT trip_idx FROM trips WHERE trip_id = 'T1')
                   ORDER BY stop_sequence DESC LIMIT 1`);
    const built = await deleteStop(db, p, "km");
    if (!built.ok) throw new Error(built.refused.code);
    await new EditSession(db).apply({ id: "d", label: "Deleted", ...built.rows });
    expect(await db.all(`SELECT 1 FROM stop_times WHERE stop_idx = ${p}`)).toEqual([]);
  });

  it("deletes what lies under a deleted location, whatever its type, and keeps a stop under it on its own", async () => {
    const p = await idx(db, "P");
    const s1 = await idx(db, "S1");
    // A boarding area straight under the station, and a stop under platform S1.
    await db.exec(
      `INSERT INTO stops (stop_idx, stop_id, name, lat, lon, location_type, parent_idx)
       VALUES (910, 'B9', 'Odd area', 52.5, 13.4, 4, ${p}), (911, 'Q9', 'Odd stop', 52.5, 13.4, 0, ${s1})`
    );
    const built = await deleteStop(db, p, "km");
    if (!built.ok) throw new Error(built.refused.code);
    await new EditSession(db).apply({ id: "d", label: "Deleted", ...built.rows });
    expect(await db.all("SELECT stop_id FROM stops WHERE stop_id = 'B9'")).toEqual([]);
    expect(await db.all("SELECT parent_idx FROM stops WHERE stop_id = 'Q9'")).toEqual([{ parent_idx: null }]);
    expect(built.rows.gtfs).toContainEqual({
      role: "stops",
      op: "update",
      key: { stop_id: "Q9" },
      values: { parent_station: null },
    });
  });

  it("says which lines through the stops it redraws, and which it takes out", async () => {
    const built = await deleteStop(db, await idx(db, "S5"), "km");
    if (!built.ok) throw new Error(built.refused.code);
    const session = new EditSession(db);
    await session.apply({ id: "d", label: "Deleted", ...built.rows });
    for (const id of built.rows.dropped ?? []) {
      expect(await db.all(`SELECT 1 FROM shapes_meta WHERE shape_id = '${id}'`)).toEqual([]);
    }
    // Every trip on a line that is still there.
    expect(
      await db.all(
        "SELECT trip_id FROM trips WHERE shape_idx IS NOT NULL AND shape_idx NOT IN (SELECT shape_idx FROM shapes_meta)"
      )
    ).toEqual([]);
    expect([...(built.rows.shapes ?? []), ...(built.rows.dropped ?? [])].length).toBeGreaterThan(0);
    expect(session.droppedShapeIds).toEqual(built.rows.dropped);
  });

  it("deletes a stop no line calls at, and nothing else", async () => {
    const built = await deleteStop(db, await idx(db, "X"), "km");
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.facts).toMatchObject({ trips: 0, patterns: 0 });
    expect(built.rows.gtfs).toEqual([{ role: "stops", op: "delete", key: { stop_id: "X" } }]);
    await new EditSession(db).apply({ id: "d", label: "Deleted", ...built.rows });
    expect(await db.all("SELECT * FROM stops WHERE stop_id = 'X'")).toEqual([]);
  });

  it("deletes a station with everything under it: its platforms, as stops are, and its entrances", async () => {
    const p = await idx(db, "P");
    const s1 = await idx(db, "S1");
    // An entrance to Main Station, and a boarding area on its platform S1.
    await db.exec(
      `INSERT INTO stops (stop_idx, stop_id, name, lat, lon, location_type, parent_idx)
       VALUES (900, 'E1', 'North exit', 52.5, 13.4, 2, ${p}), (901, 'B1', 'Front', 52.5, 13.4, 4, ${s1})`
    );
    const before = await all(db);
    const alone = await deleteStop(db, s1, "km");
    const built = await deleteStop(db, p, "km");
    if (!built.ok || !alone.ok) throw new Error("refused");
    // Its platform's trips and lines, as the platform's own delete has them.
    expect(built.facts).toMatchObject({
      location_type: 1,
      platforms: 1,
      entrances: 1,
      nodes: 0,
      trips: alone.facts.trips,
      routes: alone.facts.routes,
    });
    expect(built.facts.trips).toBeGreaterThan(0);
    expect(built.rows.gtfs.filter((o) => o.role === "stops")).toEqual([
      { role: "stops", op: "delete", key: { stop_id: "E1" } },
      { role: "stops", op: "delete", key: { stop_id: "B1" } },
      { role: "stops", op: "delete", key: { stop_id: "S1" } },
      { role: "stops", op: "delete", key: { stop_id: "P" } },
    ]);
    const session = new EditSession(db);
    await session.apply({ id: "c1", label: "Deleted", ...built.rows });
    expect(await db.all("SELECT stop_id FROM stops WHERE stop_id IN ('P', 'E1', 'S1', 'B1')")).toEqual([]);
    expect((await trip(db, "T1")).calls).not.toContain("S1");
    await session.undo();
    expect(await all(db)).toEqual(before);
  });

  it("deletes an entrance alone", async () => {
    await db.exec(
      `INSERT INTO stops (stop_idx, stop_id, name, lat, lon, location_type, parent_idx)
       VALUES (900, 'E1', 'North exit', 52.5, 13.4, 2, ${await idx(db, "P")})`
    );
    const built = await deleteStop(db, 900, "km");
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.rows.gtfs).toEqual([{ role: "stops", op: "delete", key: { stop_id: "E1" } }]);
  });
});
