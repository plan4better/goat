// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";

import { openFixtureDb } from "@/lib/explorer/__tests__/fixtureDb";
import type { SqlRunner } from "@/lib/explorer/db/types";
import { routeCalendar } from "@/lib/explorer/derive/serviceCalendar";
import { gtfsTime } from "@/lib/explorer/edit/ops/deleteLine";
import { type DayTypeGroup, dayTypeGroups, respace, setHeadways } from "@/lib/explorer/edit/ops/headway";
import { EditSession } from "@/lib/explorer/edit/session";
import type { GtfsRowEdit, GtfsRowOp } from "@/lib/explorer/edit/types";

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
const at = (hh: number, mm: number) => hh * 3600 + mm * 60;
// Always the same id: the tests read the rows it names.
const fixed = () => 0.5;

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

async function groups(
  db: SqlRunner,
  l: Awaited<ReturnType<typeof line>>,
  window: [string, string]
): Promise<DayTypeGroup[]> {
  const cal = await routeCalendar(db, { ...l.route }, window);
  return dayTypeGroups(cal.types, cal.days, l.services);
}

async function departures(db: SqlRunner, route_idx: number, direction: number | null) {
  return (
    await db.all<{ first_dep_s: number; trip_id: string }>(`
      SELECT first_dep_s, trip_id FROM trips WHERE route_idx = ${route_idx}
      AND direction_id IS NOT DISTINCT FROM ${direction === null ? "NULL" : direction}
      ORDER BY first_dep_s, trip_id`)
  ).map((t) => [t.first_dep_s, t.trip_id]);
}

/** The copy `trip_id`'s stop times in the snapshot, beside those the
 * server is sent: both must agree. */
async function copyAgrees(db: SqlRunner, gtfs: GtfsRowOp[], trip_id: string) {
  const rows = await db.all<{ stop_sequence: number; arrival_s: number; departure_s: number }>(`
    SELECT stop_sequence, arrival_s, departure_s FROM stop_times st JOIN trips t USING (trip_idx)
    WHERE t.trip_id = '${trip_id}' ORDER BY stop_sequence`);
  const sent = gtfs
    .filter(
      (o): o is GtfsRowEdit =>
        o.role === "stop_times" && o.op === "insert" && (o.key as { trip_id: string }).trip_id === trip_id
    )
    .map((o) => [
      (o.key as { stop_sequence: number }).stop_sequence,
      o.values?.arrival_time,
      o.values?.departure_time,
    ]);
  expect(rows.map((r) => [r.stop_sequence, gtfsTime(r.arrival_s), gtfsTime(r.departure_s)])).toEqual(sent);
  return rows.map((r) => r.arrival_s);
}

describe("respace", () => {
  it("keeps the trip nearest each new departure, moves it, and copies the nearest kept one where none is near", () => {
    const plan = respace(
      [
        { trip_idx: 1, dep: at(8, 0) },
        { trip_idx: 2, dep: at(8, 10) },
        { trip_idx: 4, dep: at(8, 30) },
      ],
      at(8, 0),
      at(9, 0),
      15 * 60
    );
    expect([...plan.keep]).toEqual([
      [1, 0],
      [2, 300],
      [4, 0],
    ]);
    expect([...plan.remove]).toEqual([]);
    expect(plan.copies).toEqual([{ template: 4, dep: at(8, 45) }]);
  });

  it("removes the trips no departure is near", () => {
    const plan = respace(
      [
        { trip_idx: 1, dep: at(8, 0) },
        { trip_idx: 2, dep: at(8, 10) },
        { trip_idx: 4, dep: at(8, 30) },
      ],
      at(8, 0),
      at(9, 0),
      30 * 60
    );
    expect([...plan.keep.keys()]).toEqual([1, 4]);
    expect([...plan.remove]).toEqual([2]);
    expect(plan.copies).toEqual([]);
  });
});

describe("4.1 headway by time period", () => {
  let db: SqlRunner;
  beforeEach(async () => {
    db = await openFixtureDb();
  });

  it("runs a direction every N minutes in a period, short turns kept in the mix, and undo takes it back", async () => {
    const before = await all(db);
    const l = await line(db, "R1", 0);
    const g = await groups(db, l, ["2026-01-05", "2026-01-16"]);
    expect(g).toHaveLength(1);
    const built = await setHeadways(
      db,
      l.route.route_idx,
      l.patterns,
      [{ key: "am", start_s: at(7, 0), end_s: at(9, 0), minutes: 15 }],
      g,
      "2026-01-07",
      fixed
    );
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.facts).toMatchObject({ moved: 1, added: 1, removed: 0, days: ["2026-01-07"] });

    const session = new EditSession(db);
    await session.apply({ id: "h", label: "Headway", ...built.rows });
    // T1 08:00 stays, T2 moves from 08:10 to 08:15, the short turn T4 stays
    // at 08:30, and 08:45 is a copy of it.
    expect(await departures(db, l.route.route_idx, 0)).toEqual([
      [at(8, 0), "T1"],
      [at(8, 15), "T2"],
      [at(8, 30), "T4"],
      [at(8, 45), "goat_80000000"],
    ]);
    const [copy] = await db.all<{ pattern_idx: number; block_idx: number | null }>(
      "SELECT pattern_idx, block_idx FROM trips WHERE trip_id = 'goat_80000000'"
    );
    const [t4] = await db.all<{ pattern_idx: number }>("SELECT pattern_idx FROM trips WHERE trip_id = 'T4'");
    expect(copy).toEqual({ pattern_idx: t4.pattern_idx, block_idx: null });
    const times = await db.all<{ arrival_s: number }>(`
      SELECT arrival_s FROM stop_times st JOIN trips t USING (trip_idx)
      WHERE t.trip_id = 'goat_80000000' ORDER BY stop_sequence`);
    expect(times.map((x) => x.arrival_s)).toEqual([at(8, 45), at(8, 47), at(8, 49)]);
    // The line finds the trip added past its range.
    const cal = await routeCalendar(db, { ...l.route }, ["2026-01-05", "2026-01-09"]);
    expect(cal.days[0].trips).toBe(5);

    // Saved: T2's times moved, the copy inserted as a copy of T4.
    const ops = built.rows.gtfs;
    expect(ops.find((o) => o.op === "update")).toMatchObject({
      role: "stop_times",
      key: { trip_id: "T2", stop_sequence: 1 },
      values: { arrival_time: "08:15:00", departure_time: "08:15:00" },
    });
    expect(ops.find((o) => o.role === "trips" && o.op === "insert")).toMatchObject({
      key: { trip_id: "goat_80000000" },
      values: { route_id: "R1", service_id: "WK", block_id: null },
      copy_of: { trip_id: "T4" },
    });
    expect(ops.filter((o) => o.role === "stop_times" && o.op === "insert")).toHaveLength(3);

    await session.undo();
    expect(await all(db)).toBe(before);
  });

  it("deletes the trips the new headway has no room for", async () => {
    const l = await line(db, "R1", 0);
    const g = await groups(db, l, ["2026-01-05", "2026-01-16"]);
    const built = await setHeadways(
      db,
      l.route.route_idx,
      l.patterns,
      [{ key: "am", start_s: at(7, 0), end_s: at(9, 0), minutes: 30 }],
      g,
      "2026-01-07",
      fixed
    );
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.facts).toMatchObject({ moved: 0, added: 0, removed: 1 });
    await new EditSession(db).apply({ id: "h", label: "Headway", ...built.rows });
    expect(await departures(db, l.route.route_idx, 0)).toEqual([
      [at(8, 0), "T1"],
      [at(8, 30), "T4"],
    ]);
    expect(
      built.rows.gtfs
        .filter((o) => o.op === "delete")
        .map((o) => [o.role, (o.key as { trip_id: string }).trip_id])
    ).toEqual([
      ["stop_times", "T2"],
      ["stop_times", "T2"],
      ["stop_times", "T2"],
      ["stop_times", "T2"],
      ["stop_times", "T2"],
      ["trips", "T2"],
    ]);
  });

  it("links patterns sharing a service, gives a frequency window the new headway and folds in the extras of a day", async () => {
    const before = await all(db);
    const l = await line(db, "R4", null);
    // Fridays in December: Christmas runs the weekday service and an extra.
    const g = await groups(db, l, ["2026-12-18", "2026-12-25"]);
    expect(g).toHaveLength(1);
    expect(g[0].types).toHaveLength(2);
    expect(g[0].common).toHaveLength(1);
    expect(g[0].services).toHaveLength(2);
    const built = await setHeadways(
      db,
      l.route.route_idx,
      l.patterns,
      [{ key: "early", start_s: at(5, 0), end_s: at(7, 0), minutes: 20 }],
      g,
      "2026-12-25",
      fixed
    );
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.facts).toMatchObject({ windows: 1, removed: 1, added: 0 });
    const session = new EditSession(db);
    await session.apply({ id: "h", label: "Headway", ...built.rows });
    const windows = await db.all<{ start_s: number; end_s: number; headway_s: number }>(
      "SELECT start_s, end_s, headway_s FROM frequencies ORDER BY start_s"
    );
    expect(windows).toEqual([
      { start_s: at(6, 0), end_s: at(7, 0), headway_s: 1200 },
      { start_s: at(7, 0), end_s: at(9, 0), headway_s: 600 },
    ]);
    expect(await departures(db, l.route.route_idx, null)).toEqual([[at(6, 0), "F1"]]);
    await session.undo();
    expect(await all(db)).toBe(before);
  });

  it("copies a trip that moves as it was, in the browser as on the server", async () => {
    const before = await all(db);
    const l = await line(db, "R1", 0);
    const g = await groups(db, l, ["2026-01-05", "2026-01-16"]);
    // Every 25 minutes from 08:00: T2 (08:10) goes, T4 moves from 08:30 to
    // 08:25, and 08:50 is a copy of T4 as it runs now (08:30 + 20 min).
    const built = await setHeadways(
      db,
      l.route.route_idx,
      l.patterns,
      [{ key: "am", start_s: at(8, 0), end_s: at(9, 0), minutes: 25 }],
      g,
      "2026-01-07",
      fixed
    );
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.facts).toMatchObject({ moved: 1, added: 1, removed: 1 });
    const session = new EditSession(db);
    await session.apply({ id: "h", label: "Headway", ...built.rows });
    expect(await departures(db, l.route.route_idx, 0)).toEqual([
      [at(8, 0), "T1"],
      [at(8, 25), "T4"],
      [at(8, 50), "goat_80000000"],
    ]);
    expect(await copyAgrees(db, built.rows.gtfs, "goat_80000000")).toEqual([at(8, 50), at(8, 52), at(8, 54)]);
    await session.undo();
    expect(await all(db)).toBe(before);
  });

  it("copies a trip that goes, where no trip is kept, in the browser as on the server", async () => {
    // A Christmas extra on line 1 at 07:00: the period's first departure,
    // leaving it (Christmas is one of the Fridays only).
    const [{ next }] = await db.all<{ next: number }>(
      "SELECT CAST(max(trip_idx) + 1 AS INTEGER) AS next FROM trips"
    );
    await db.exec(`INSERT INTO trips SELECT * REPLACE (${next} AS trip_idx, 'X1' AS trip_id,
                   (SELECT service_idx FROM services WHERE service_id = 'XMAS') AS service_idx,
                   first_dep_s - 3600 AS first_dep_s, last_arr_s - 3600 AS last_arr_s)
                   FROM trips WHERE trip_id = 'T1'`);
    await db.exec(`INSERT INTO stop_times SELECT * REPLACE (${next} AS trip_idx, arrival_s - 3600 AS arrival_s,
                   departure_s - 3600 AS departure_s)
                   FROM stop_times WHERE trip_idx = (SELECT trip_idx FROM trips WHERE trip_id = 'T1')`);
    const before = await all(db);
    const l = await line(db, "R1", 0);
    const g = await groups(db, l, ["2026-12-18", "2026-12-25"]);
    // Every 100 minutes from 07:00 up to 08:40: 07:00 alone, no weekday trip
    // near it. Every one goes; 07:00 is a copy of the nearest, T1.
    const built = await setHeadways(
      db,
      l.route.route_idx,
      l.patterns,
      [{ key: "am", start_s: at(7, 0), end_s: at(8, 40), minutes: 100 }],
      g,
      "2026-12-25",
      fixed
    );
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.facts).toMatchObject({ moved: 0, added: 1, removed: 4 });
    const session = new EditSession(db);
    await session.apply({ id: "h", label: "Headway", ...built.rows });
    expect(await departures(db, l.route.route_idx, 0)).toEqual([[at(7, 0), "goat_80000000"]]);
    expect(await copyAgrees(db, built.rows.gtfs, "goat_80000000")).toEqual([
      at(7, 0),
      at(7, 2),
      at(7, 4),
      at(7, 6),
      at(7, 8),
    ]);
    await session.undo();
    expect(await all(db)).toBe(before);
  });

  it("cuts a frequency window across two periods once, each period cutting what the other left", async () => {
    await db.exec(`UPDATE frequencies SET end_s = ${at(22, 0)}`);
    const before = await all(db);
    const l = await line(db, "R4", null);
    const g = await groups(db, l, ["2026-01-05", "2026-01-16"]);
    const built = await setHeadways(
      db,
      l.route.route_idx,
      l.patterns,
      [
        { key: "am", start_s: at(7, 0), end_s: at(9, 0), minutes: 20 },
        { key: "pm", start_s: at(16, 0), end_s: at(18, 0), minutes: 15 },
      ],
      g,
      "2026-01-07",
      fixed
    );
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.facts).toMatchObject({ windows: 1 });
    const freqOps = built.rows.gtfs.filter((o) => o.role === "frequencies");
    expect(freqOps.filter((o) => o.op === "delete").map((o) => o.key)).toEqual([
      { trip_id: "F1", start_time: "06:00:00" },
    ]);
    const session = new EditSession(db);
    await session.apply({ id: "h", label: "Headway", ...built.rows });
    const windows = await db.all<{ start_s: number; end_s: number; headway_s: number }>(
      "SELECT start_s, end_s, headway_s FROM frequencies ORDER BY start_s"
    );
    const pieces = [
      { start_s: at(6, 0), end_s: at(7, 0), headway_s: 600 },
      { start_s: at(7, 0), end_s: at(9, 0), headway_s: 1200 },
      { start_s: at(9, 0), end_s: at(16, 0), headway_s: 600 },
      { start_s: at(16, 0), end_s: at(18, 0), headway_s: 900 },
      { start_s: at(18, 0), end_s: at(22, 0), headway_s: 600 },
    ];
    expect(windows).toEqual(pieces);
    // The server is sent the same pieces.
    expect(
      freqOps
        .filter((o): o is GtfsRowEdit => o.op === "insert")
        .map((o) => [
          (o.key as { start_time: string }).start_time,
          o.values?.end_time,
          o.values?.headway_secs,
        ])
    ).toEqual(pieces.map((pc) => [gtfsTime(pc.start_s), gtfsTime(pc.end_s), pc.headway_s]));
    await session.undo();
    expect(await all(db)).toBe(before);

    // Its own headway in a period cuts nothing.
    const same = await setHeadways(
      db,
      l.route.route_idx,
      l.patterns,
      [{ key: "am", start_s: at(7, 0), end_s: at(9, 0), minutes: 10 }],
      g,
      "2026-01-07"
    );
    expect(same.ok ? null : same.refused.code).toBe("goat_headway_unchanged");
  });

  it("refuses headways out of range and edits that change nothing", async () => {
    const l = await line(db, "R1", 0);
    const g = await groups(db, l, ["2026-01-05", "2026-01-16"]);
    const out = await setHeadways(
      db,
      l.route.route_idx,
      l.patterns,
      [{ key: "am", start_s: at(7, 0), end_s: at(9, 0), minutes: 1 }],
      g,
      "2026-01-07"
    );
    expect(out.ok ? null : out.refused.code).toBe("goat_headway_out_of_range");
    // Every 10 minutes from 08:00 in 08:00-08:20: T1 and T2 already.
    const same = await setHeadways(
      db,
      l.route.route_idx,
      l.patterns,
      [{ key: "x", start_s: at(8, 0), end_s: at(8, 20), minutes: 10 }],
      g,
      "2026-01-07"
    );
    expect(same.ok ? null : same.refused.code).toBe("goat_headway_unchanged");
  });
});

describe("4.1 with a service per day", () => {
  it("gives each day's own service the new departures alike", async () => {
    const db = await openFixtureDb();
    // Saturday runs line 1's weekday trips as trips of its own (service SA),
    // as feeds giving each day a service do: one timetable, Mon–Sat.
    const [{ sa }] = await db.all<{ sa: number }>(
      "SELECT service_idx AS sa FROM services WHERE service_id = 'SA'"
    );
    const [{ next }] = await db.all<{ next: number }>(
      "SELECT CAST(max(trip_idx) + 1 AS INTEGER) AS next FROM trips"
    );
    const source = await db.all<{ trip_idx: number }>(
      "SELECT trip_idx FROM trips WHERE trip_id IN ('T1', 'T2', 'T3', 'T4') ORDER BY trip_idx"
    );
    for (const [i, s] of source.entries()) {
      await db.exec(`INSERT INTO trips SELECT * REPLACE (${next + i} AS trip_idx, 'S' || trip_id AS trip_id,
                     ${sa} AS service_idx) FROM trips WHERE trip_idx = ${s.trip_idx}`);
      await db.exec(`INSERT INTO stop_times SELECT * REPLACE (${next + i} AS trip_idx)
                     FROM stop_times WHERE trip_idx = ${s.trip_idx}`);
    }
    const l = await line(db, "R1", 0);
    const g = await groups(db, l, ["2026-01-05", "2026-01-17"]);
    // One day type, Mon–Sat; no service on all its days, each on its own.
    expect(g).toHaveLength(1);
    expect(g[0].common).toEqual([]);
    expect(g[0].own).toHaveLength(2);
    const built = await setHeadways(
      db,
      l.route.route_idx,
      l.patterns,
      [{ key: "am", start_s: at(7, 0), end_s: at(9, 0), minutes: 30 }],
      g,
      "2026-01-07",
      fixed
    );
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.facts).toMatchObject({ removed: 2 });
    await new EditSession(db).apply({ id: "h", label: "Headway", ...built.rows });
    expect(await departures(db, l.route.route_idx, 0)).toEqual([
      [at(8, 0), "ST1"],
      [at(8, 0), "T1"],
      [at(8, 30), "ST4"],
      [at(8, 30), "T4"],
    ]);
  });
});
