// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";

import { openFixtureDb } from "@/lib/explorer/__tests__/fixtureDb";
import type { SqlRunner } from "@/lib/explorer/db/types";
import { routeCalendar } from "@/lib/explorer/derive/serviceCalendar";
import { type DayTypeGroup, dayTypeGroups } from "@/lib/explorer/edit/ops/headway";
import { setSpan } from "@/lib/explorer/edit/ops/span";
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
// Ids in turn: goat_10000000, goat_20000000, …
const counter = () => {
  let i = 0;
  return () => ++i / 16;
};

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

const WEEKS: [string, string] = ["2026-01-05", "2026-01-16"];

describe("4.2 span of service", () => {
  let db: SqlRunner;
  beforeEach(async () => {
    db = await openFixtureDb();
  });

  it("starts later by deleting the trips before the new first departure, and undo takes it back", async () => {
    const before = await all(db);
    const l = await line(db, "R1", 0);
    const g = await groups(db, l, WEEKS);
    const built = await setSpan(
      db,
      l.route.route_idx,
      l.patterns,
      { first_s: at(8, 5), last_s: null },
      g,
      "2026-01-07"
    );
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.facts).toMatchObject({ added: 0, removed: 1, windows: 0, days: ["2026-01-07"] });
    const session = new EditSession(db);
    await session.apply({ id: "s", label: "Span", ...built.rows });
    expect(await departures(db, l.route.route_idx, 0)).toEqual([
      [at(8, 10), "T2"],
      [at(8, 30), "T4"],
    ]);
    const ops = built.rows.gtfs;
    expect(ops.filter((o) => o.op === "delete").map((o) => o.role)).toEqual([
      ...Array(5).fill("stop_times"),
      "trips",
    ]);
    await session.undo();
    expect(await all(db)).toBe(before);
  });

  it("starts earlier with copies of the first trip at the gap between the first two departures", async () => {
    const before = await all(db);
    const l = await line(db, "R1", 0);
    const g = await groups(db, l, WEEKS);
    // T1 08:00 and T2 08:10: every 10 minutes back to 07:35, the rhythm's
    // earliest not before it 07:40.
    const built = await setSpan(
      db,
      l.route.route_idx,
      l.patterns,
      { first_s: at(7, 35), last_s: null },
      g,
      "2026-01-07",
      counter()
    );
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.facts).toMatchObject({ added: 2, removed: 0 });
    const session = new EditSession(db);
    await session.apply({ id: "s", label: "Span", ...built.rows });
    expect(await departures(db, l.route.route_idx, 0)).toEqual([
      [at(7, 40), "goat_20000000"],
      [at(7, 50), "goat_10000000"],
      [at(8, 0), "T1"],
      [at(8, 10), "T2"],
      [at(8, 30), "T4"],
    ]);
    const [copy] = await db.all<{ block_idx: number | null; last_arr_s: number }>(
      "SELECT block_idx, last_arr_s FROM trips WHERE trip_id = 'goat_20000000'"
    );
    expect(copy).toEqual({ block_idx: null, last_arr_s: at(7, 48) });
    const ops = built.rows.gtfs;
    expect(ops.find((o) => o.role === "trips" && o.op === "insert")).toMatchObject({
      key: { trip_id: "goat_10000000" },
      values: { route_id: "R1", service_id: "WK", block_id: null },
      copy_of: { trip_id: "T1" },
    });
    expect(ops.find((o) => o.role === "stop_times" && o.op === "insert")).toMatchObject({
      key: { trip_id: "goat_10000000", stop_sequence: 1 },
      values: { stop_id: "S1", arrival_time: "07:50:00", departure_time: "07:50:00" },
      copy_of: { trip_id: "T1", stop_sequence: 1 },
    });
    await session.undo();
    expect(await all(db)).toBe(before);
  });

  it("ends later at the gap between the last two departures, and earlier by deleting", async () => {
    const l = await line(db, "R1", 0);
    const g = await groups(db, l, WEEKS);
    // T2 08:10, T4 08:30: a copy of T4 at 08:50.
    const later = await setSpan(
      db,
      l.route.route_idx,
      l.patterns,
      { first_s: null, last_s: at(8, 55) },
      g,
      "2026-01-07",
      counter()
    );
    if (!later.ok) throw new Error(later.refused.code);
    expect(later.facts).toMatchObject({ added: 1, removed: 0 });
    expect(later.rows.gtfs.find((o) => o.role === "trips")).toMatchObject({ copy_of: { trip_id: "T4" } });

    const earlier = await setSpan(
      db,
      l.route.route_idx,
      l.patterns,
      { first_s: null, last_s: at(8, 20) },
      g,
      "2026-01-07"
    );
    if (!earlier.ok) throw new Error(earlier.refused.code);
    expect(earlier.facts).toMatchObject({ added: 0, removed: 1 });
    await new EditSession(db).apply({ id: "s", label: "Span", ...earlier.rows });
    expect(await departures(db, l.route.route_idx, 0)).toEqual([
      [at(8, 0), "T1"],
      [at(8, 10), "T2"],
    ]);
  });

  it("moves a frequency window's end instead, and drops a day's extra outside the span", async () => {
    const before = await all(db);
    const l = await line(db, "R4", null);
    const g = await groups(db, l, ["2026-12-18", "2026-12-25"]);
    const built = await setSpan(
      db,
      l.route.route_idx,
      l.patterns,
      { first_s: at(6, 5), last_s: at(8, 0) },
      g,
      "2026-12-25"
    );
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.facts).toMatchObject({ added: 0, removed: 1, windows: 1 });
    const session = new EditSession(db);
    await session.apply({ id: "s", label: "Span", ...built.rows });
    expect(await db.all("SELECT start_s, end_s, headway_s FROM frequencies ORDER BY start_s")).toEqual([
      { start_s: at(6, 5), end_s: at(8, 0), headway_s: 600 },
    ]);
    expect(await departures(db, l.route.route_idx, null)).toEqual([[at(6, 0), "F1"]]);
    expect(built.rows.gtfs.filter((o) => o.role === "frequencies")).toEqual([
      { role: "frequencies", op: "delete", key: { trip_id: "F1", start_time: "06:00:00" } },
      {
        role: "frequencies",
        op: "insert",
        key: { trip_id: "F1", start_time: "06:05:00" },
        values: { end_time: "08:00:00", headway_secs: 600, exact_times: 0 },
      },
    ]);
    await session.undo();
    expect(await all(db)).toBe(before);
  });

  it("refuses spans that change nothing, end before they start, have no gap to repeat or leave nothing", async () => {
    const code = async (route: string, dir: number | null, first_s: number | null, last_s: number | null) => {
      const l = await line(db, route, dir);
      const g = await groups(db, l, WEEKS);
      const out = await setSpan(db, l.route.route_idx, l.patterns, { first_s, last_s }, g, "2026-01-07");
      return out.ok ? null : out.refused.code;
    };
    // 07:55: the rhythm's next departure back, 07:50, is before it.
    expect(await code("R1", 0, at(7, 55), null)).toBe("goat_span_unchanged");
    expect(await code("R1", 0, null, null)).toBe("goat_span_unchanged");
    expect(await code("R1", 0, at(9, 0), at(8, 0))).toBe("goat_span_order");
    // Direction 1 runs T3 alone.
    expect(await code("R1", 1, at(7, 0), null)).toBe("goat_span_no_headway");
    expect(await code("R1", 0, at(9, 0), null)).toBe("goat_span_empty");
  });
});
