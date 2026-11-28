// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";

import { openFixtureDb } from "@/lib/explorer/__tests__/fixtureDb";
import type { SqlRunner } from "@/lib/explorer/db/types";
import { deleteLine } from "@/lib/explorer/edit/ops/deleteLine";
import { EditSession } from "@/lib/explorer/edit/session";

const TABLES = {
  routes: "route_idx",
  stops: "stop_idx",
  stop_times: "trip_idx, stop_sequence",
  frequencies: "trip_idx, start_s",
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
const routeIdx = async (db: SqlRunner, route_id: string) =>
  (await db.all<{ route_idx: number }>(`SELECT route_idx FROM routes WHERE route_id = '${route_id}'`))[0]
    .route_idx;
const count = async (db: SqlRunner, sql: string) =>
  Number((await db.all<{ n: number }>(`SELECT count(*) AS n FROM (${sql})`))[0].n);

describe("1.5 delete line", () => {
  let db: SqlRunner;
  beforeEach(async () => {
    db = await openFixtureDb();
  });

  it("takes the line, its trips, patterns and paths, keeps its stops, and undo puts it all back", async () => {
    const before = await all(db);
    const r1 = await routeIdx(db, "R1");
    const built = await deleteLine(db, r1, false);
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.facts).toMatchObject({ route_id: "R1", trips: 4, stops_deleted: false });
    // SH1 and the line through T3's stops: no other line runs them.
    expect(built.rows.dropped?.sort()).toEqual(
      (
        await db.all<{ shape_id: string }>(
          `SELECT DISTINCT m.shape_id FROM trips t JOIN shapes_meta m USING (shape_idx) WHERE t.route_idx = ${r1}`
        )
      )
        .map((x) => x.shape_id)
        .sort()
    );
    const stops = await count(db, "SELECT * FROM stops");
    const session = new EditSession(db);
    await session.apply({ id: "d", label: "Deleted", ...built.rows });

    expect(await count(db, `SELECT * FROM routes WHERE route_idx = ${r1}`)).toBe(0);
    expect(await count(db, `SELECT * FROM trips WHERE route_idx = ${r1}`)).toBe(0);
    expect(await count(db, `SELECT * FROM patterns WHERE route_idx = ${r1}`)).toBe(0);
    expect(await count(db, "SELECT * FROM shape_points WHERE shape_idx = 0")).toBe(0);
    expect(await count(db, "SELECT * FROM stops")).toBe(stops);
    // Saved as row deletes, children first: stop times, trips, the route.
    const roles = built.rows.gtfs.map((o) => o.role);
    expect(roles.lastIndexOf("stop_times")).toBeLessThan(roles.indexOf("trips"));
    expect(roles.lastIndexOf("trips")).toBeLessThan(roles.indexOf("routes"));
    expect(roles).not.toContain("stops");

    await session.undo();
    expect(await all(db)).toBe(before);
  });

  it("also takes the stops no other line calls at, when asked", async () => {
    const r1 = await routeIdx(db, "R1");
    // S5 called at by R1 alone: the other lines there call at S6 instead.
    await db.exec(`UPDATE stop_times SET stop_idx = (SELECT stop_idx FROM stops WHERE stop_id = 'S6')
      WHERE stop_idx = (SELECT stop_idx FROM stops WHERE stop_id = 'S5')
        AND trip_idx IN (SELECT trip_idx FROM trips WHERE route_idx <> ${r1})`);
    const built = await deleteLine(db, r1, true);
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.facts.stops_deleted).toBe(true);
    const deleted = built.rows.gtfs.flatMap((o) => (o.role === "stops" ? [o.key.stop_id] : []));
    expect(deleted).toContain("S5");
    expect(deleted.length).toBe(built.facts.only_here);
    // Each is called at by R1 alone.
    for (const id of deleted)
      expect(
        await count(
          db,
          `SELECT * FROM stop_times st JOIN trips t USING (trip_idx) JOIN stops s ON s.stop_idx = st.stop_idx
           WHERE s.stop_id = '${id}' AND t.route_idx <> ${r1}`
        )
      ).toBe(0);
  });

  it("deletes a frequency-based line's frequencies by their GTFS start time", async () => {
    const built = await deleteLine(db, await routeIdx(db, "R4"), false);
    if (!built.ok) throw new Error(built.refused.code);
    const runs = built.rows.gtfs.filter((o) => o.role === "frequencies");
    expect(runs.length).toBeGreaterThan(0);
    for (const o of runs)
      expect(String((o.key as Record<string, unknown>).start_time)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});
