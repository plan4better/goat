// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";

import { openFixtureDb } from "@/lib/explorer/__tests__/fixtureDb";
import type { SqlRunner } from "@/lib/explorer/db/types";
import {
  type TripsFacts,
  deleteTrips,
  duplicateTrip,
  setStopTimes,
  shiftTrips,
} from "@/lib/explorer/edit/ops/trips";
import type { Built } from "@/lib/explorer/edit/ops/types";
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
const at = (hh: number, mm: number) => hh * 3600 + mm * 60;
// Always the same id: the tests read the rows it names.
const fixed = () => 0.5;

async function idx(db: SqlRunner, trip_id: string): Promise<number> {
  const [t] = await db.all<{ trip_idx: number }>(`SELECT trip_idx FROM trips WHERE trip_id = '${trip_id}'`);
  return t.trip_idx;
}
async function times(db: SqlRunner, trip_id: string) {
  return db.all<{ stop_sequence: number; arrival_s: number | null; departure_s: number | null }>(`
    SELECT stop_sequence, arrival_s, departure_s FROM stop_times st JOIN trips t USING (trip_idx)
    WHERE t.trip_id = '${trip_id}' ORDER BY stop_sequence`);
}
async function trip(db: SqlRunner, trip_id: string) {
  const [t] = await db.all<{ first_dep_s: number; last_arr_s: number; block_idx: number | null }>(
    `SELECT first_dep_s, last_arr_s, block_idx FROM trips WHERE trip_id = '${trip_id}'`
  );
  return t;
}
function ok(built: Built<TripsFacts>) {
  if (!built.ok) throw new Error(built.refused.code);
  return built;
}
const refused = (built: Built<TripsFacts>) => (built.ok ? null : built.refused);

async function applyUndo(db: SqlRunner, built: Built<TripsFacts>, check: () => Promise<void>) {
  const before = await all(db);
  const session = new EditSession(db);
  await session.apply({ id: "x", label: "Trips", ...ok(built).rows });
  await check();
  await session.undo();
  expect(await all(db)).toBe(before);
}

describe("4.4 shift trips", () => {
  let db: SqlRunner;
  beforeEach(async () => {
    db = await openFixtureDb();
  });

  it("moves every stop time by the same amount, and undo takes it back", async () => {
    const built = ok(await shiftTrips(db, [await idx(db, "T1"), await idx(db, "T2")], 300));
    expect(built.facts).toMatchObject({ line: "1", trips: 2, by_s: 300 });
    expect(built.checks).toEqual([]);
    await applyUndo(db, built, async () => {
      expect((await times(db, "T1")).map((t) => t.departure_s)).toEqual(
        [0, 2, 4, 6, 8].map((m) => at(8, 5 + m))
      );
      expect(await trip(db, "T2")).toMatchObject({ first_dep_s: at(8, 15), last_arr_s: at(8, 23) });
    });
    expect(built.rows.gtfs[0]).toEqual({
      role: "stop_times",
      op: "update",
      key: { trip_id: "T1", stop_sequence: 1 },
      values: { arrival_time: "08:05:00", departure_time: "08:05:00" },
    });
    expect(built.rows.gtfs).toHaveLength(10);
  });

  it("keeps an untimed stop untimed", async () => {
    const t1 = await idx(db, "T1");
    await db.exec(`UPDATE stop_times SET arrival_s = NULL, departure_s = NULL
                   WHERE trip_idx = ${t1} AND stop_sequence = 3`);
    const built = ok(await shiftTrips(db, [t1], -60));
    await applyUndo(db, built, async () => {
      expect((await times(db, "T1")).map((t) => t.arrival_s)).toEqual([
        at(7, 59),
        at(8, 1),
        null,
        at(8, 5),
        at(8, 7),
      ]);
    });
    expect(built.rows.gtfs).toHaveLength(4);
  });

  it("moves a frequency-based trip's windows instead", async () => {
    const built = ok(await shiftTrips(db, [await idx(db, "F1")], 900));
    await applyUndo(db, built, async () => {
      expect(await db.all("SELECT start_s, end_s, headway_s FROM frequencies")).toEqual([
        { start_s: at(6, 15), end_s: at(9, 15), headway_s: 600 },
      ]);
      expect((await times(db, "F1"))[0].departure_s).toBe(at(6, 0));
    });
    expect(built.rows.gtfs).toEqual([
      { role: "frequencies", op: "delete", key: { trip_id: "F1", start_time: "06:00:00" } },
      {
        role: "frequencies",
        op: "insert",
        key: { trip_id: "F1", start_time: "06:15:00" },
        values: { end_time: "09:15:00", headway_secs: 600, exact_times: 0 },
      },
    ]);
  });

  it("notes a trip now overlapping the next of its block", async () => {
    const u1 = await idx(db, "U1");
    // U1 runs 23:50-24:10, U2 of the same block from 24:20.
    const built = ok(await shiftTrips(db, [u1], 900));
    expect(built.checks).toEqual([
      { code: "goat_block_overlap", severity: "notice", params: { trip: "U1", other: "U2" } },
    ]);
    // Shifted together, they still follow each other.
    const both = ok(await shiftTrips(db, [u1, await idx(db, "U2")], 900));
    expect(both.checks).toEqual([]);
    expect(ok(await shiftTrips(db, [u1], 300)).checks).toEqual([]);
  });

  it("does not note a block overlap on services with no day in common", async () => {
    const [{ sa }] = await db.all<{ sa: number }>(
      "SELECT service_idx AS sa FROM services WHERE service_id = 'SA'"
    );
    await db.exec(`UPDATE trips SET service_idx = ${sa} WHERE trip_id = 'U2'`);
    expect(ok(await shiftTrips(db, [await idx(db, "U1")], 900)).checks).toEqual([]);
  });

  it("refuses a shift of nothing and one before the day", async () => {
    const t1 = await idx(db, "T1");
    expect(refused(await shiftTrips(db, [t1], 0))?.code).toBe("goat_shift_unchanged");
    expect(refused(await shiftTrips(db, [t1], -at(9, 0)))).toMatchObject({
      code: "goat_shift_before_day",
      params: { earliest: "08:00:00" },
    });
  });
});

describe("4.3 duplicate trips", () => {
  let db: SqlRunner;
  beforeEach(async () => {
    db = await openFixtureDb();
  });

  it("copies a trip to another departure, with no block, and undo takes it back", async () => {
    const u1 = await idx(db, "U1");
    const built = ok(await duplicateTrip(db, u1, at(6, 0), fixed));
    const [{ next }] = await db.all<{ next: number }>(
      "SELECT CAST(max(trip_idx) + 1 AS INTEGER) AS next FROM trips"
    );
    expect(built.facts).toMatchObject({ line: "2", trips: 1, trip_idxs: [u1, next], dep_s: at(6, 0) });
    expect(built.checks).toEqual([]);
    await applyUndo(db, built, async () => {
      const [copy] = await db.all<Record<string, unknown>>(
        "SELECT * FROM trips WHERE trip_id = 'goat_80000000'"
      );
      const [orig] = await db.all<Record<string, unknown>>("SELECT * FROM trips WHERE trip_id = 'U1'");
      expect(copy).toEqual({
        ...orig,
        trip_idx: next,
        trip_id: "goat_80000000",
        block_idx: null,
        first_dep_s: at(6, 0),
        last_arr_s: at(6, 20),
      });
      expect((await times(db, "goat_80000000")).map((t) => t.arrival_s)).toEqual([at(6, 0), at(6, 20)]);
      const [p] = await db.all<{ n_trips: number }>(
        `SELECT n_trips FROM patterns WHERE pattern_idx = ${orig.pattern_idx as number}`
      );
      expect(p.n_trips).toBe(2);
    });
    expect(built.rows.gtfs[0]).toEqual({
      role: "trips",
      op: "insert",
      key: { trip_id: "goat_80000000" },
      values: {
        route_id: "R2",
        service_id: "WK",
        direction_id: null,
        trip_headsign: "Sixth",
        trip_short_name: null,
        block_id: null,
      },
      copy_of: { trip_id: "U1" },
    });
    expect(built.rows.gtfs[2]).toEqual({
      role: "stop_times",
      op: "insert",
      key: { trip_id: "goat_80000000", stop_sequence: 2 },
      values: { stop_id: "S6", arrival_time: "06:20:00", departure_time: "06:20:00" },
      copy_of: { trip_id: "U1", stop_sequence: 2 },
    });
  });

  it("notes another trip of the pattern and service departing in the same minute", async () => {
    const built = ok(await duplicateTrip(db, await idx(db, "T1"), at(8, 10) + 30, fixed));
    expect(built.checks).toEqual([
      { code: "goat_duplicate_departure", severity: "notice", params: { trip: "T2", time: "08:10" } },
    ]);
    expect(ok(await duplicateTrip(db, await idx(db, "T1"), at(8, 11), fixed)).checks).toEqual([]);
  });

  it("refuses a frequency-based trip", async () => {
    expect(refused(await duplicateTrip(db, await idx(db, "F1"), at(7, 0)))?.code).toBe(
      "goat_trip_frequency_based"
    );
  });
});

describe("4.3 delete trips", () => {
  let db: SqlRunner;
  beforeEach(async () => {
    db = await openFixtureDb();
  });

  it("takes the trips with their stop times, and undo puts them back", async () => {
    const t2 = await idx(db, "T2");
    const t4 = await idx(db, "T4");
    const built = ok(await deleteTrips(db, [t2, t4]));
    expect(built.facts).toMatchObject({
      line: "1",
      trips: 2,
      deleted: [
        { trip_idx: t2, dep_s: at(8, 10), headsign: "Fifth" },
        { trip_idx: t4, dep_s: at(8, 30), headsign: "Third" },
      ],
    });
    await applyUndo(db, built, async () => {
      expect(await db.all(`SELECT 1 FROM stop_times WHERE trip_idx IN (${t2}, ${t4})`)).toEqual([]);
      const pats = await db.all<{ n_trips: number }>(`
        SELECT n_trips FROM patterns WHERE pattern_idx IN
          (SELECT pattern_idx FROM trips WHERE trip_id = 'T1') ORDER BY pattern_idx`);
      expect(pats).toEqual([{ n_trips: 1 }]);
    });
    const ops = built.rows.gtfs.map((o) => [o.role, o.op, (o.key as { trip_id: string }).trip_id]);
    expect(ops.slice(-2)).toEqual([
      ["trips", "delete", "T2"],
      ["trips", "delete", "T4"],
    ]);
    expect(ops.filter(([role]) => role === "stop_times")).toHaveLength(8);
  });

  it("deletes a frequency-based trip's windows, and refuses a line's last trips", async () => {
    const built = ok(await deleteTrips(db, [await idx(db, "F1")]));
    expect(built.rows.gtfs.filter((o) => o.role === "frequencies")).toEqual([
      { role: "frequencies", op: "delete", key: { trip_id: "F1", start_time: "06:00:00" } },
    ]);
    await applyUndo(db, built, async () => {
      expect(await db.all("SELECT * FROM frequencies")).toEqual([]);
    });
    expect(refused(await deleteTrips(db, [await idx(db, "U1"), await idx(db, "U2")]))).toMatchObject({
      code: "goat_trips_whole_line",
      params: { line: "2" },
    });
  });
});

describe("5.1 edit stop times", () => {
  let db: SqlRunner;
  beforeEach(async () => {
    db = await openFixtureDb();
  });

  it("sets the times typed and keeps the trip's ends in step, and undo takes it back", async () => {
    const t1 = await idx(db, "T1");
    const built = ok(
      await setStopTimes(
        db,
        t1,
        [
          { stop_sequence: 3, arrival_s: at(8, 5), departure_s: at(8, 6) },
          { stop_sequence: 5, arrival_s: at(8, 10), departure_s: at(8, 10) },
        ],
        false
      )
    );
    expect(built.facts).toMatchObject({ line: "1", trips: 1, stops: 2, trip_idxs: [t1] });
    await applyUndo(db, built, async () => {
      expect((await times(db, "T1")).map((t) => [t.arrival_s, t.departure_s])).toEqual([
        [at(8, 0), at(8, 0)],
        [at(8, 2), at(8, 2)],
        [at(8, 5), at(8, 6)],
        [at(8, 6), at(8, 6)],
        [at(8, 10), at(8, 10)],
      ]);
      expect(await trip(db, "T1")).toMatchObject({ first_dep_s: at(8, 0), last_arr_s: at(8, 10) });
    });
    expect(built.rows.gtfs).toEqual([
      {
        role: "stop_times",
        op: "update",
        key: { trip_id: "T1", stop_sequence: 3 },
        values: { arrival_time: "08:05:00", departure_time: "08:06:00" },
      },
      {
        role: "stop_times",
        op: "update",
        key: { trip_id: "T1", stop_sequence: 5 },
        values: { arrival_time: "08:10:00", departure_time: "08:10:00" },
      },
    ]);
  });

  it("moves the later stops by as much as the last stop typed, when asked", async () => {
    const t1 = await idx(db, "T1");
    const built = ok(
      await setStopTimes(db, t1, [{ stop_sequence: 2, arrival_s: at(8, 3), departure_s: at(8, 4) }], true)
    );
    expect(built.facts).toMatchObject({ stops: 4, by_s: 120 });
    await applyUndo(db, built, async () => {
      expect((await times(db, "T1")).map((t) => t.departure_s)).toEqual([
        at(8, 0),
        at(8, 4),
        at(8, 6),
        at(8, 8),
        at(8, 10),
      ]);
      expect(await trip(db, "T1")).toMatchObject({ first_dep_s: at(8, 0), last_arr_s: at(8, 10) });
    });
  });

  it("refuses times going backwards, an end left untimed and a change of nothing", async () => {
    const t1 = await idx(db, "T1");
    expect(
      refused(
        await setStopTimes(db, t1, [{ stop_sequence: 2, arrival_s: at(8, 5), departure_s: at(8, 5) }], false)
      )
    ).toEqual({
      code: "stop_time_with_arrival_before_previous_departure_time",
      severity: "error",
      params: { stop_sequence: 3, stop: "Third" },
    });
    expect(
      refused(await setStopTimes(db, t1, [{ stop_sequence: 1, arrival_s: null, departure_s: null }], false))
    ).toMatchObject({ code: "goat_trip_end_untimed", params: { stop_sequence: 1 } });
    expect(
      refused(
        await setStopTimes(db, t1, [{ stop_sequence: 3, arrival_s: at(8, 5), departure_s: at(8, 4) }], false)
      )?.code
    ).toBe("stop_time_with_departure_before_arrival_time");
    // A departure before the day's midnight, not only an arrival.
    expect(
      refused(await setStopTimes(db, t1, [{ stop_sequence: 1, arrival_s: 0, departure_s: -60 }], false))
    ).toMatchObject({ code: "goat_shift_before_day", params: { stop_sequence: 1 } });
    expect(
      refused(
        await setStopTimes(db, t1, [{ stop_sequence: 3, arrival_s: at(8, 4), departure_s: at(8, 4) }], false)
      )?.code
    ).toBe("goat_stop_times_unchanged");
    // A stop in between may be left untimed.
    expect(
      (await setStopTimes(db, t1, [{ stop_sequence: 3, arrival_s: null, departure_s: null }], false)).ok
    ).toBe(true);
  });

  it("notes a re-timed trip overlapping the next of its block", async () => {
    const built = ok(
      await setStopTimes(
        db,
        await idx(db, "U1"),
        [{ stop_sequence: 2, arrival_s: at(24, 25), departure_s: at(24, 25) }],
        false
      )
    );
    expect(built.checks.map((c) => c.code)).toEqual(["goat_block_overlap"]);
  });
});
