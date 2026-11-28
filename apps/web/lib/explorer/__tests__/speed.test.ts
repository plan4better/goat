// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";

import { openFixtureDb } from "@/lib/explorer/__tests__/fixtureDb";
import type { SqlRunner } from "@/lib/explorer/db/types";
import { routeCalendar } from "@/lib/explorer/derive/serviceCalendar";
import { type DayTypeGroup, dayTypeGroups } from "@/lib/explorer/edit/ops/headway";
import { adjustSpeed } from "@/lib/explorer/edit/ops/speed";
import { EditSession } from "@/lib/explorer/edit/session";

const TABLES = {
  trips: "trip_idx",
  stop_times: "trip_idx, stop_sequence",
  stop_time_extras: "trip_idx, stop_sequence",
  frequencies: "trip_idx, start_s",
  patterns: "pattern_idx",
};
async function all(db: SqlRunner): Promise<string> {
  const out: Record<string, unknown> = {};
  for (const [t, order] of Object.entries(TABLES))
    out[t] = await db.all(`SELECT * FROM ${t} ORDER BY ${order}`);
  return JSON.stringify(out);
}
const at = (hh: number, mm: number, ss = 0) => hh * 3600 + mm * 60 + ss;

async function line(db: SqlRunner, route_id: string, direction: number | null) {
  const [r] = await db.all<{ route_idx: number; trip_lo: number; trip_hi: number }>(
    `SELECT route_idx, trip_lo, trip_hi FROM routes WHERE route_id = '${route_id}'`
  );
  const patterns = (
    await db.all<{ pattern_idx: number }>(
      `SELECT DISTINCT pattern_idx FROM trips WHERE route_idx = ${r.route_idx}
       AND direction_id IS NOT DISTINCT FROM ${direction === null ? "NULL" : direction}`
    )
  ).map((p) => p.pattern_idx);
  const services = (
    await db.all<{ service_idx: number }>(
      `SELECT DISTINCT service_idx FROM trips WHERE route_idx = ${r.route_idx}
       AND pattern_idx IN (${patterns.join(",")})`
    )
  ).map((s) => s.service_idx);
  return { route: r, patterns, services };
}

async function groups(db: SqlRunner, l: Awaited<ReturnType<typeof line>>): Promise<DayTypeGroup[]> {
  const cal = await routeCalendar(db, { ...l.route }, ["2026-01-05", "2026-01-16"]);
  return dayTypeGroups(cal.types, cal.days, l.services);
}

async function times(db: SqlRunner, trip_id: string) {
  return (
    await db.all<{ arrival_s: number | null; departure_s: number | null }>(`
      SELECT arrival_s, departure_s FROM stop_times st JOIN trips t USING (trip_idx)
      WHERE t.trip_id = '${trip_id}' ORDER BY stop_sequence`)
  ).map((x) => [x.arrival_s, x.departure_s]);
}

describe("5.2 adjust speed", () => {
  let db: SqlRunner;
  beforeEach(async () => {
    db = await openFixtureDb();
  });

  it("runs a direction 25% faster: times x0.8 from each trip's departure, and undo takes it back", async () => {
    const before = await all(db);
    const l = await line(db, "R1", 0);
    const g = await groups(db, l);
    const built = await adjustSpeed(db, l.route.route_idx, l.patterns, 25, g, "2026-01-07", null);
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.facts).toMatchObject({ trips: 3, days: ["2026-01-07"] });
    expect(built.facts.trip_idxs).toHaveLength(3);
    expect(built.checks).toEqual([]);

    const session = new EditSession(db);
    await session.apply({ id: "v", label: "Speed", ...built.rows });
    const t1 = [at(8, 0), at(8, 1, 36), at(8, 3, 12), at(8, 4, 48), at(8, 6, 24)];
    expect(await times(db, "T1")).toEqual(t1.map((s) => [s, s]));
    const [trip] = await db.all<{ first_dep_s: number; last_arr_s: number }>(
      "SELECT first_dep_s, last_arr_s FROM trips WHERE trip_id = 'T1'"
    );
    expect(trip).toEqual({ first_dep_s: at(8, 0), last_arr_s: at(8, 6, 24) });

    // Saved: the times that change, the first stop's not among them.
    const t1Ops = built.rows.gtfs.filter((o) => (o.key as { trip_id: string }).trip_id === "T1");
    expect(t1Ops).toHaveLength(4);
    expect(t1Ops[0]).toEqual({
      role: "stop_times",
      op: "update",
      key: { trip_id: "T1", stop_sequence: 2 },
      values: { arrival_time: "08:01:36", departure_time: "08:01:36" },
    });

    await session.undo();
    expect(await all(db)).toBe(before);
  });

  it("slows only the trips departing in the period, and leaves untimed stops untimed", async () => {
    await db.exec(`UPDATE stop_times SET arrival_s = NULL, departure_s = NULL
                   WHERE stop_sequence = 3 AND trip_idx = (SELECT trip_idx FROM trips WHERE trip_id = 'T2')`);
    const before = await all(db);
    const l = await line(db, "R1", 0);
    const g = await groups(db, l);
    const built = await adjustSpeed(db, l.route.route_idx, l.patterns, -20, g, "2026-01-07", {
      start_s: at(8, 5),
      end_s: at(8, 35),
    });
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.facts.trips).toBe(2);
    const session = new EditSession(db);
    await session.apply({ id: "v", label: "Speed", ...built.rows });
    // x1.25: T1 departs before the period and stays.
    expect(await times(db, "T1")).toEqual([0, 2, 4, 6, 8].map((m) => [at(8, m), at(8, m)]));
    expect(await times(db, "T2")).toEqual([
      [at(8, 10), at(8, 10)],
      [at(8, 12, 30), at(8, 12, 30)],
      [null, null],
      [at(8, 17, 30), at(8, 17, 30)],
      [at(8, 20), at(8, 20)],
    ]);
    expect(await times(db, "T4")).toEqual([
      [at(8, 30), at(8, 30)],
      [at(8, 32, 30), at(8, 32, 30)],
      [at(8, 35), at(8, 35)],
    ]);
    expect(
      built.rows.gtfs.some((o) => {
        const key = o.key as { trip_id: string; stop_sequence?: number };
        return key.trip_id === "T2" && key.stop_sequence === 3;
      })
    ).toBe(false);
    await session.undo();
    expect(await all(db)).toBe(before);
  });

  it("says when a trip would run faster than its mode plausibly does", async () => {
    // 30 km in 8 minutes, at +25% in 6:24: about 281 km/h for a bus.
    await db.exec("UPDATE trips SET length_m = 30000 WHERE trip_id = 'T1'");
    const l = await line(db, "R1", 0);
    const g = await groups(db, l);
    const built = await adjustSpeed(db, l.route.route_idx, l.patterns, 25, g, "2026-01-07", null);
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.checks).toEqual([
      { code: "goat_speed_implausible", severity: "notice", params: { speed: 281 } },
    ]);
  });

  it("refuses changes out of range, none at all, and periods without trips", async () => {
    const l = await line(db, "R1", 0);
    const g = await groups(db, l);
    const code = async (percent: number, period: { start_s: number; end_s: number } | null = null) => {
      const out = await adjustSpeed(db, l.route.route_idx, l.patterns, percent, g, "2026-01-07", period);
      return out.ok ? null : out.refused.code;
    };
    expect(await code(150)).toBe("goat_speed_out_of_range");
    expect(await code(-60)).toBe("goat_speed_out_of_range");
    expect(await code(0)).toBe("goat_speed_unchanged");
    expect(await code(10, { start_s: at(12, 0), end_s: at(13, 0) })).toBe("goat_speed_no_trips");
  });
});
