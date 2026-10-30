// @vitest-environment node

/**
 * What the Explorer derives from a snapshot, on the mini feed
 * (packages/python/goatlib/tests/fixtures/explorer_mini_gtfs). Every expected
 * value is worked out by hand from the feed:
 *
 * - stops 0.01° of longitude apart at 52.5° N, 676.9 m;
 * - R1 on weekdays: T1 08:00–08:08 and T2 08:10–08:18 S1→S5, T4 08:30–08:34
 *   S1→S3 (direction 0), T3 08:20–08:28 S5→S1 (direction 1); T1, T2, T4 give
 *   their distance in km (2.72, 2.72, 1.36), T3 none;
 * - R2: U1 23:50–24:10 and U2 24:20–24:50, one block, no direction_id;
 * - R3: the Saturday loop S1→S2→S3→S1;
 * - R4: F1 every 10 min 06:00–09:00 on weekdays, F2 on 25 December only.
 *
 * 2026-10-14 is a Wednesday; 2026-04-06 is Easter Monday, a removed date.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { openFixtureDb } from "@/lib/explorer/__tests__/fixtureDb";
import type { SqlRunner } from "@/lib/explorer/db/types";
import { activeServicesSql, serviceDayCounts } from "@/lib/explorer/derive/calendar";
import { annualFigures, costYear, defaultRate, yearOf } from "@/lib/explorer/derive/cost";
import { type Direction, deriveDirections, routeDirections } from "@/lib/explorer/derive/directions";
import { headways, operations, runningTimes, vehiclesInService } from "@/lib/explorer/derive/operations";
import { cut, patternSections } from "@/lib/explorer/derive/patternSections";
import { axisOf, routeTrips } from "@/lib/explorer/derive/routeTrips";
import { type TripRange, routeRuns } from "@/lib/explorer/derive/runs";
import {
  type CalendarDay,
  type DayType,
  dateRuns,
  dayTypes,
  exceptionMarks,
  isoWeekday,
  routeCalendar,
} from "@/lib/explorer/derive/serviceCalendar";
import { byDirection, byHour, stopDepartures, stopDetail } from "@/lib/explorer/derive/stopTimetable";
import { type PlaceRow, places } from "@/lib/explorer/derive/stops";
import { stopsLine } from "@/lib/explorer/derive/stopsLine";
import { tripDetail } from "@/lib/explorer/derive/trip";
import {
  type VehicleWindow,
  alongShape,
  positionsAt,
  prepareDay,
  runningAt,
  serviceSpan,
  vehicleAt,
  vehicleWindow,
} from "@/lib/explorer/derive/vehicles";
import {
  choiceFromValue,
  choiceValue,
  directionsOnShapes,
  highlightedPatterns,
  resolveChoice,
  shownLine,
  shownPattern,
} from "@/lib/explorer/directionChoice";
import {
  filterCount,
  listPlaces,
  matchingRouteIdxs,
  modeCounts,
  routeMatches,
  searchRoutes,
  shows,
} from "@/lib/explorer/filters";
import {
  convexHull,
  networkShapes,
  networkStations,
  networkStops,
  shapeColorExpression,
  stationArea,
} from "@/lib/explorer/network";

type Route = TripRange & { route_idx: number; route_id: string };

let db: SqlRunner;
const routes = new Map<string, Route>();

beforeAll(async () => {
  db = await openFixtureDb();
  for (const r of await db.all<Route>("SELECT route_idx, route_id, trip_lo, trip_hi FROM routes"))
    routes.set(r.route_id, r);
});

const route = (id: string) => routes.get(id) as Route;
/** A direction's name as the English UI words it. */
const label = (d: Direction) =>
  `${d.name.kind === "loop" ? "Loop via" : "To"} ${d.name.place}${d.name.via ? ` via ${d.name.via}` : ""}`;
const hm = (s: number) =>
  `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;

describe("calendar", () => {
  const services = async (date: string) =>
    (
      await db.all<{ service_id: string }>(
        `SELECT service_id FROM services WHERE service_idx IN ${activeServicesSql(date)} ORDER BY 1`
      )
    ).map((r) => r.service_id);

  it("runs a service on its weekdays within its range", async () => {
    expect(await services("2026-10-14")).toEqual(["WK"]);
    expect(await services("2026-10-17")).toEqual(["SA"]);
  });

  it("applies removed and added dates", async () => {
    expect(await services("2026-04-06")).toEqual([]);
    expect(await services("2026-12-25")).toEqual(["WK", "XMAS"]);
  });

  it("counts a service's days over a window", async () => {
    // 5 Jan–31 Dec 2026: 51 weeks and Mon–Thu, less Easter Monday.
    const days = await serviceDayCounts(db, "2026-01-05", "2026-12-31");
    const ids = new Map(
      (await db.all<{ service_idx: number; service_id: string }>("SELECT * FROM services")).map((s) => [
        s.service_id,
        s.service_idx,
      ])
    );
    expect(days.get(ids.get("WK") as number)).toBe(51 * 5 + 4 - 1);
    expect(days.get(ids.get("SA") as number)).toBe(51);
    expect(days.get(ids.get("XMAS") as number)).toBe(1);
  });
});

describe("runs", () => {
  it("lists a day's timetabled trips", async () => {
    const runs = await routeRuns(db, route("R1"), "2026-10-14");
    expect(runs.map((r) => [hm(r.dep_s), hm(r.arr_s)])).toEqual([
      ["08:00", "08:08"],
      ["08:10", "08:18"],
      ["08:20", "08:28"],
      ["08:30", "08:34"],
    ]);
  });

  it("runs a frequency trip every headway, up to its end", async () => {
    const runs = await routeRuns(db, route("R4"), "2026-10-14");
    expect(runs).toHaveLength(18); // 06:00, 06:10 … 08:50
    expect(hm(runs[0].dep_s)).toBe("06:00");
    expect(hm(runs[17].dep_s)).toBe("08:50");
    expect(hm(runs[17].arr_s)).toBe("08:58");
  });

  it("keeps trips past midnight on their service day", async () => {
    const runs = await routeRuns(db, route("R2"), "2026-10-14");
    expect(runs.map((r) => [hm(r.dep_s), hm(r.arr_s)])).toEqual([
      ["23:50", "24:10"],
      ["24:20", "24:50"],
    ]);
  });
});

describe("route trips", () => {
  const times = (t: Awaited<ReturnType<typeof routeTrips>>, r: number) =>
    Array.from(t.dep.slice(t.first[r], t.first[r + 1])).map(hm);

  it("gives each run its stop times", async () => {
    // R1 on a Wednesday: T1 08:00, T2 08:10, T3 08:20 (the other way), T4 08:30.
    const t = await routeTrips(db, route("R1"), "2026-10-14");
    expect(t.runs.map((r) => hm(r.dep_s))).toEqual(["08:00", "08:10", "08:20", "08:30"]);
    expect(times(t, 0)).toEqual(["08:00", "08:02", "08:04", "08:06", "08:08"]);
    // T4, numbered 10/20/30 in the feed, is a short turn to S3.
    expect(times(t, 3)).toEqual(["08:30", "08:32", "08:34"]);
  });

  it("runs a frequency-based trip at every headway", async () => {
    // F1 every 10 min from 06:00 to 09:00, 4 min a stop.
    const t = await routeTrips(db, route("R4"), "2026-10-14");
    expect(t.runs).toHaveLength(18);
    expect(times(t, 1)).toEqual(["06:10", "06:14", "06:18"]);
  });

  it("lays each direction along its main pattern", async () => {
    const t = await routeTrips(db, route("R1"), "2026-10-14");
    const [fifth, back] = t.directions.map((d) => t.axes.get(d.key)!);
    // Along SH1, which detours between S1 and S2; 676.9 m a stop after.
    expect(fifth.d.map(Math.round)).toEqual([0, 1302, 1979, 2656, 3332]);
    // T3 has no shape: along the line through its stops.
    expect(back.d.map(Math.round)).toEqual([0, 677, 1354, 2031, 2708]);
  });

  it("fills an axis where a stop has no distance", () => {
    expect(
      axisOf(
        [1, 2, 3],
        new Map([
          [0, 0],
          [2, 100],
        ])
      ).d
    ).toEqual([0, 50, 100]);
    expect(axisOf([1, 2, 3], new Map()).d).toEqual([0, 1, 2]);
  });
});

describe("direction choice", () => {
  it("is the first direction, whole, until one is picked", async () => {
    // R1: To Fifth (T1, T2, and T4's short turn) and To Main Station (T3).
    const { directions } = await routeDirections(db, route("R1"));
    const first = resolveChoice(null, directions);
    expect(first.direction?.key).toBe(directions[0].key);
    expect(first.pattern_idx).toBeNull();
    expect([...first.patterns].sort()).toEqual(directions[0].patterns.map((p) => p.pattern_idx).sort());
    expect(shownLine(first, directions)?.pattern_idx).toBe(directions[0].key);
  });

  it("knows each direction's first and last stop", async () => {
    const { directions } = await routeDirections(db, route("R1"));
    const toFifth = directions.find((d) => label(d) === "To Fifth") as Direction;
    const toMain = directions.find((d) => label(d) === "To Main Station") as Direction;
    expect(toFifth.ends).toEqual(["Main Station", "Fifth"]);
    expect(toMain.ends[1]).toBe("Main Station");
  });

  it("takes one variant", async () => {
    const { directions } = await routeDirections(db, route("R1"));
    const short = directions[0].patterns.find((p) => p.kind === "short_turn")?.pattern_idx as number;
    const one = resolveChoice({ direction: directions[0].key, pattern_idx: short }, directions);
    expect([...one.patterns]).toEqual([short]);
    expect(shownLine(one, directions)?.pattern_idx).toBe(short);
    expect(choiceFromValue(choiceValue(one))).toEqual({ direction: directions[0].key, pattern_idx: short });
  });

  it("draws the first direction on the map while nothing is picked", async () => {
    const { directions } = await routeDirections(db, route("R4"));
    const drawn = directions.map((d) => ({ key: d.key, patterns: d.patterns.map((p) => p.pattern_idx) }));
    expect(shownPattern(null, drawn)).toBe(directions[0].key);
  });

  it("cuts a short turn's own stretch from the shape it rides", async () => {
    const { directions } = await routeDirections(db, route("R1"));
    const main = directions[0].key;
    const short = directions[0].patterns.find((p) => p.kind === "short_turn")?.pattern_idx as number;
    const { features } = await patternSections(db, [main, short]);
    const length = (idx: number) =>
      features
        .filter((f) => f.properties.pattern_idx === idx)
        .reduce((sum, f) => {
          const c = f.geometry.coordinates;
          for (let i = 1; i < c.length; i++) sum += Math.hypot(c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1]);
          return sum;
        }, 0);
    expect(length(main)).toBeGreaterThan(0);
    expect(length(short)).toBeGreaterThan(0);
    expect(length(short)).toBeLessThan(length(main));
  });

  it("cuts a line between its points, where the stops fall", () => {
    const pts = [
      { lon: 0, lat: 0, d: 0 },
      { lon: 10, lat: 0, d: 100 },
      { lon: 10, lat: 10, d: 200 },
    ];
    expect(cut(pts, 50, 150)).toEqual([
      [5, 0],
      [10, 0],
      [10, 5],
    ]);
    // Both ends inside one segment.
    expect(cut(pts, 20, 40)).toEqual([
      [2, 0],
      [4, 0],
    ]);
  });

  it("finds the directions running on shapes clicked on the map", () => {
    const directions = [
      { key: 10, patterns: [10, 11] },
      { key: 20, patterns: [20] },
    ];
    const shapes = { 10: ["a"], 11: ["b"], 20: ["c", "shared"] };
    expect(directionsOnShapes(["b"], directions, { ...shapes, 10: ["a", "shared"] })).toEqual([10]);
    expect(directionsOnShapes(["shared"], directions, { ...shapes, 10: ["a", "shared"] })).toEqual([10, 20]);
    expect(directionsOnShapes(["elsewhere"], directions, shapes)).toEqual([]);
  });

  it("highlights on the map what the picker chose, on any tab", () => {
    const drawn = [
      { key: 10, patterns: [10, 11] },
      { key: 20, patterns: [20] },
    ];
    // Nothing picked: the first direction, whole.
    expect(highlightedPatterns(null, drawn, false)).toEqual([10, 11]);
    // A whole direction, with its variants; a variant alone.
    expect(highlightedPatterns({ direction: 10, pattern_idx: null }, drawn, false)).toEqual([10, 11]);
    expect(highlightedPatterns({ direction: 10, pattern_idx: 11 }, drawn, false)).toEqual([11]);
    // The Stops tab draws one line: the variant, else the main pattern.
    expect(highlightedPatterns(null, drawn, true)).toEqual([10]);
    expect(highlightedPatterns({ direction: 10, pattern_idx: null }, drawn, true)).toEqual([10]);
  });
});

describe("directions", () => {
  const summary = async (id: string) =>
    (await routeDirections(db, route(id))).directions.map((d) => ({
      label: label(d),
      patterns: d.patterns.map((p) => `${p.kind} to ${p.destination}`),
    }));

  it("groups by direction_id when every trip has one, and finds short turns", async () => {
    expect(await summary("R1")).toEqual([
      { label: "To Fifth", patterns: ["main to Fifth", "short_turn to Third"] },
      { label: "To Main Station", patterns: ["main to Main Station"] },
    ]);
  });

  it("tells directions apart by stop order when the feed has no direction_id", async () => {
    expect((await summary("R2")).map((d) => d.label).sort()).toEqual(["To Second", "To Sixth"]);
  });

  it("names a loop by its farthest stop", async () => {
    expect(await summary("R3")).toEqual([{ label: "Loop via Third", patterns: ["main to Loop"] }]);
  });

  it("names a short turn by where it ends, not by a headsign it keeps from the line", () => {
    // As TMB's 113: the short turn's trips sign the line's end, Pl. Pius XII.
    const stop = (stop_idx: number, name: string) => ({ stop_idx, name, lat: 0, lon: 0, station: null });
    const stops = new Map(
      [1, 2, 3, 4].map((i) => [i, stop(i, ["", "Mercè", "Mid", "González Tablas", "Pius XII"][i])])
    );
    const [direction] = deriveDirections(
      [
        { pattern_idx: 0, stops: [1, 2, 3, 4], n_trips: 62 },
        { pattern_idx: 1, stops: [1, 2, 3], n_trips: 3 },
      ],
      [
        { pattern_idx: 0, direction_id: 1, headsign: "Pl. Pius XII", n: 62 },
        { pattern_idx: 1, direction_id: 1, headsign: "Pl. Pius XII", n: 3 },
      ],
      stops
    );
    expect(direction.patterns.map((p) => `${p.kind} to ${p.destination}`)).toEqual([
      "main to Pl. Pius XII",
      "short_turn to González Tablas",
    ]);
  });

  it("calls a pattern that skips stops of the main one an express", async () => {
    expect(await summary("R4")).toEqual([
      { label: "To Sixth", patterns: ["main to Sixth", "express to Sixth"] },
    ]);
  });
});

describe("operations", () => {
  it("adds up a day", async () => {
    const ops = operations(await routeRuns(db, route("R1"), "2026-10-14"));
    expect(ops.runs).toBe(4);
    expect(hm(ops.first_dep_s as number)).toBe("08:00");
    expect(hm(ops.last_dep_s as number)).toBe("08:30");
    // 2.72 + 2.72 + 1.36 km given, plus T3's four stop-to-stop hops.
    expect(ops.vehicle_km).toBeCloseTo(6.8 + 4 * 0.6769, 2);
    expect(ops.vehicle_hours).toBeCloseTo(28 / 60, 6);
  });

  it("takes peak vehicles from trips plus layover without blocks", async () => {
    // 08:00–08:14, 08:10–08:24, 08:20–08:34, 08:30–08:40: never more than two.
    const ops = operations(await routeRuns(db, route("R1"), "2026-10-14"));
    expect(ops.peak_vehicles).toBe(2);
    expect(hm(ops.peak_at_s as number)).toBe("08:10");
    expect(ops.peak_from_blocks).toBe(false);
  });

  it("takes peak vehicles from blocks where the feed has them", async () => {
    const ops = operations(await routeRuns(db, route("R2"), "2026-10-14"));
    expect(ops.peak_vehicles).toBe(1); // U1 and U2 are one vehicle
    expect(ops.peak_from_blocks).toBe(true);
  });

  it("gives the headway per period", async () => {
    const runs = await routeRuns(db, route("R4"), "2026-10-14");
    const h = headways(runs);
    expect(h.get("early")).toEqual({ minutes: 10, departures: 6 }); // 06:00–06:50
    expect(h.get("am_peak")).toEqual({ minutes: 10, departures: 12 });
    expect(h.get("midday")).toEqual({ minutes: null, departures: 0 });
  });

  it("counts vehicles in service through the day", async () => {
    const curve = vehiclesInService(await routeRuns(db, route("R1"), "2026-10-14"), 60);
    expect(curve[8 * 60 - 1]).toBe(0); // 07:59: nothing out yet
    expect(curve[8 * 60 + 5]).toBe(1); // 08:05: T1 on its way
    expect(curve[8 * 60 + 9]).toBe(0); // 08:09: T1 in, T2 not yet out
    expect(curve).toHaveLength(8 * 60 + 34 + 1); // to the last arrival, 08:34
  });
});

describe("cost", () => {
  it("takes a year's km from the calendar and prices them", async () => {
    const r = route("R1");
    const rate = defaultRate(3);
    const year = await annualFigures(db, r, ["2026-01-05", "2026-12-31"], rate);
    // R1 runs on WK only: 258 days in a 361-day window, scaled to 365.
    const daily = 6.8 + 4 * 0.6769;
    expect(year.window_days).toBe(361);
    expect(year.vehicle_km).toBeCloseTo(daily * 258 * (365 / 361), 0);
    expect(year.cost).toBeCloseTo(year.vehicle_km * 5.5, 6);
  });

  it("counts this calendar year where the feed covers it, else a year of it", () => {
    const today = new Date("2026-10-21T12:00:00Z");
    // All of 2026 in the feed, a placeholder range or not: 2026.
    expect(costYear(["2018-01-01", "2028-12-31"], today)).toEqual({
      from: "2026-01-01",
      to: "2026-12-31",
      kind: "calendar",
    });
    expect(yearOf(["2025-06-01", "2027-03-31"], today)).toEqual(["2026-01-01", "2026-12-31"]);
    // 2026 not all in it: 365 days from today, kept inside the feed.
    expect(costYear(["2026-03-01", "2027-12-31"], today)).toEqual({
      from: "2026-10-21",
      to: "2027-10-20",
      kind: "year",
    });
    expect(yearOf(["2026-03-01", "2027-06-30"], today)).toEqual(["2026-07-01", "2027-06-30"]);
    // Before the feed: its first year.
    expect(yearOf(["2027-01-01", "2028-06-30"], today)).toEqual(["2027-01-01", "2027-12-31"]);
    // A year or less: all of it, scaled.
    expect(costYear(["2026-10-06", "2026-12-12"], today)).toEqual({
      from: "2026-10-06",
      to: "2026-12-12",
      kind: "scaled",
    });
  });

  it("prices by route type until rates are set", () => {
    expect(defaultRate(3).per_km).toBe(5.5);
    expect(defaultRate(0).per_km).toBe(8);
    // Per train-km: a trip of a metro or train is the whole train.
    expect(defaultRate(1).per_km).toBe(24);
    expect(defaultRate(2).per_km).toBe(24);
    expect(defaultRate(700).per_km).toBe(5.5);
    expect(defaultRate(null).per_hour).toBeNull();
  });
});

describe("network cost", () => {
  it("adds every route type at its rate", async () => {
    const { networkAnnualFigures } = await import("@/lib/explorer/derive/cost");
    const window: [string, string] = ["2026-01-05", "2026-12-31"];
    const network = await networkAnnualFigures(db, window);
    let expected = 0;
    for (const id of ["R1", "R2", "R3", "R4"]) {
      const r = route(id);
      const type = (
        await db.all<{ t: number }>(`SELECT route_type AS t FROM routes WHERE route_id = '${id}'`)
      )[0].t;
      expected += (await annualFigures(db, r, window, defaultRate(type))).cost;
    }
    expect(network.cost).toBeCloseTo(expected, 6);
  });
});

describe("stations and platforms", () => {
  const ids = (route_idxs: number[]) => {
    const byIdx = new Map([...routes.values()].map((r) => [r.route_idx, r.route_id]));
    return route_idxs.map((i) => byIdx.get(i)).sort();
  };

  it("puts platforms under their station and lists the routes calling there", async () => {
    const byId = new Map((await places(db)).map((p) => [p.stop_id, p]));
    // S1 is a platform of P: it is listed under the station, not on its own.
    expect([...byId.keys()].sort()).toEqual(["P", "S2", "S3", "S4", "S5", "S6", "X"]);
    const station = byId.get("P") as PlaceRow;
    expect(station.is_station).toBe(true);
    expect(station.platforms.map((p) => p.stop_id)).toEqual(["S1"]);
    expect(ids(station.route_idxs)).toEqual(["R1", "R3"]);
    expect(ids(station.platforms[0].route_idxs)).toEqual(["R1", "R3"]);
    expect(ids((byId.get("S2") as PlaceRow).route_idxs)).toEqual(["R1", "R2", "R3"]);
    expect(ids((byId.get("S6") as PlaceRow).route_idxs)).toEqual(["R2", "R4"]);
    expect(byId.get("X")?.route_idxs).toEqual([]);
    expect(byId.get("S2")?.platforms).toEqual([]);
  });

  it("finds a platform by its name and opens its station", async () => {
    const all = await places(db);
    const found = listPlaces(all, "platform 1", null);
    expect(found.map((f) => [f.place.stop_id, f.opened, f.platforms.map((p) => p.stop_id)])).toEqual([
      ["P", true, ["S1"]],
    ]);
    // A station found by its own name stays folded.
    expect(listPlaces(all, "main station", null)[0].opened).toBe(false);
  });
});

describe("search ranking", () => {
  let idx = 0;
  const route = (short_name: string, route_id: string, long_name = "") => ({
    route_idx: idx++,
    short_name,
    long_name,
    agency: "BVG",
    route_id,
  });

  it("puts the route numbered as typed first, numbers in natural order", () => {
    const routes = [
      route("25", "10525_700"), // found only by its id
      route("152", "152_1"),
      route("520", "520_1"),
      route("52", "52_1"),
      route("X52", "X52_1"),
      route("M1", "M1_1", "Bus 52 Express"),
    ];
    expect(searchRoutes(routes, "52").map((r) => r.short_name)).toEqual([
      "52",
      "520",
      "152",
      "X52",
      "M1",
      "25",
    ]);
    // No search: as listed.
    expect(searchRoutes(routes, "")).toBe(routes);
  });

  it("puts routes running on the date first, the busiest first, among equal matches", () => {
    const routes = [route("50", "a"), route("51", "b"), route("52", "c"), route("5", "d")];
    const runs = new Map([
      [routes[1].route_idx, 40],
      [routes[2].route_idx, 120],
    ]);
    // The exact number still leads, though it does not run that day.
    expect(searchRoutes(routes, "5", runs).map((r) => r.short_name)).toEqual(["5", "52", "51", "50"]);
  });

  it("puts places named as typed first, then a word starting with it", () => {
    const place = (stop_id: string, name: string) =>
      ({
        stop_idx: 0,
        stop_id,
        name,
        lat: 0,
        lon: 0,
        is_station: false,
        route_idxs: [],
        platforms: [],
      }) as PlaceRow;
    const all = [
      place("a", "Gartenlindenweg"),
      place("b", "Am Lindenplatz"),
      place("c", "Lindenstr."),
      place("d", "Linden"),
      place("e", "Alt-Linden"),
    ];
    // Then names holding it mid-word; equals keep their order.
    expect(listPlaces(all, "linden", null).map((p) => p.place.name)).toEqual([
      "Linden",
      "Lindenstr.",
      "Am Lindenplatz",
      "Alt-Linden",
      "Gartenlindenweg",
    ]);
  });
});

describe("filters", () => {
  const all = [
    { route_idx: 0, route_type: 3, agency_idx: 0 },
    { route_idx: 1, route_type: 0, agency_idx: 0 },
    { route_idx: 2, route_type: 3, agency_idx: 1 },
  ];
  const none = { types: [], modes: [], agencies: [] };

  it("narrows routes by route type and agency, and stops through them", () => {
    const f = { ...none, modes: ["bus" as const], agencies: [1] };
    expect(all.filter((r) => routeMatches(r, f)).map((r) => r.route_idx)).toEqual([2]);
    expect(matchingRouteIdxs(all, f)).toEqual(new Set([2]));
    expect(matchingRouteIdxs(all, { ...none, types: ["stops" as const] })).toBeNull();
  });

  it("shows both lists until one is picked, and counts what the feed has", () => {
    expect(shows(none, "stops")).toBe(true);
    expect(shows({ ...none, types: ["routes"] }, "stops")).toBe(false);
    expect(modeCounts(all)).toEqual([
      ["bus", 2],
      ["tram", 1],
    ]);
    expect(filterCount({ types: ["routes"], modes: ["bus"], agencies: [0, 1] })).toBe(4);
  });
});

describe("stops line", () => {
  // R1 towards Fifth: T1 and T2 run S1→S5, 2 min and 0.68 km a hop (the
  // feed's shape_dist is in km); T4 turns at S3.
  const line = async (date: string) => {
    const r = route("R1");
    const { directions } = await routeDirections(db, r);
    const toFifth = directions.find((d) => label(d) === "To Fifth") as Direction;
    return { toFifth, result: await stopsLine(db, r, toFifth, toFifth.key, date, "km") };
  };

  it("times and measures every hop of the main pattern", async () => {
    const { result } = await line("2026-10-14");
    expect(result.stops.map((s) => s.minutes)).toEqual([0, 2, 4, 6, 8]);
    expect(result.stops.slice(0, -1).map((s) => Math.round(s.next_m ?? 0))).toEqual([680, 680, 680, 680]);
    expect(result.stops.slice(0, -1).map((s) => s.next_min)).toEqual([2, 2, 2, 2]);
    expect(result.stops[4].next_m).toBeNull();
    // A platform is known by its station's name.
    expect(result.stops[0].name).toBe("Main Station");
    expect(result.of_date).toBe(true);
    // Both trips leave at 08:00 and 08:10: AM peak, nothing at Midday.
    expect(result.peak_min).toBe(8);
    expect(result.offpeak_min).toBeNull();
  });

  it("marks where the short turn ends and the other routes at each stop", async () => {
    const { result } = await line("2026-10-14");
    expect(result.stops[2].short_turns).toEqual([{ destination: "Third", trips: 1 }]);
    expect(result.stops.filter((s) => s.short_turns.length)).toHaveLength(1);
    const ids = new Map([...routes.values()].map((r) => [r.route_idx, r.route_id]));
    const others = result.stops.map((s) => s.transfers.map((i) => ids.get(i)).sort());
    expect(others).toEqual([["R3"], ["R2", "R3"], ["R3"], ["R4"], ["R4"]]);
  });

  it("falls back to all the pattern's trips on a day it does not run", async () => {
    const { result } = await line("2026-10-17");
    expect(result.of_date).toBe(false);
    expect(result.stops.map((s) => s.minutes)).toEqual([0, 2, 4, 6, 8]);
  });

  it("measures as the crow flies where the feed gives no distance", async () => {
    const r = route("R1");
    const { directions } = await routeDirections(db, r);
    const back = directions.find((d) => label(d) !== "To Fifth") as Direction;
    const result = await stopsLine(db, r, back, back.key, "2026-10-14", "km");
    expect(Math.round(result.stops[0].next_m ?? 0)).toBe(677);
  });
});

describe("route calendar", () => {
  // The feed runs 5 Jan – 31 Dec 2026. WK runs Mon–Fri but not on Easter
  // Monday (6 Apr); XMAS runs on 25 December only, beside WK.
  const window: [string, string] = ["2026-01-05", "2026-12-31"];

  it("names a route's weekday service and the holiday it skips", async () => {
    const cal = await routeCalendar(db, route("R1"), window);
    expect(cal.types).toHaveLength(1);
    const [weekdays] = cal.types;
    expect(weekdays.weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(weekdays.except).toEqual(["2026-04-06"]);
    expect(weekdays.adds).toEqual([]);
    expect(weekdays.trips).toBe(4);
    expect(cal.days.find((d) => d.date === "2026-04-06")).toMatchObject({ services: [], key: null });
    expect(cal.days.find((d) => d.date === "2026-10-17")?.trips).toBe(0);
  });

  it("gives a day with an extra service its own day type", async () => {
    const cal = await routeCalendar(db, route("R4"), window);
    // 259 weekdays from 5 Jan to 31 Dec, less Easter Monday and Christmas.
    expect(cal.types.map((t) => t.days.length)).toEqual([257, 1]);
    const [weekdays, christmas] = cal.types;
    expect(weekdays.except).toEqual(["2026-04-06", "2026-12-25"]);
    expect(christmas.days).toEqual(["2026-12-25"]);
    // One Friday is no weekly rule: it reads as an individual date.
    expect(christmas.weekdays).toEqual([]);
  });

  it("names a Saturday service by its weekday", async () => {
    const cal = await routeCalendar(db, route("R3"), window);
    expect(cal.types.map((t) => t.weekdays)).toEqual([[6]]);
  });

  it("finds the weekday of a date", () => {
    expect(isoWeekday("2026-10-14")).toBe(3);
    expect(isoWeekday("2026-10-18")).toBe(7);
  });

  it("joins dates into spans across the days a pattern does not run", () => {
    // Mon 26 Oct – Fri 6 Nov skipped by a Mon–Fri pattern: one span over the weekend.
    const fortnight = ["26", "27", "28", "29", "30"].map((d) => `2026-10-${d}`);
    fortnight.push(...["02", "03", "04", "05", "06"].map((d) => `2026-11-${d}`));
    expect(dateRuns([...fortnight, "2026-12-25"], [1, 2, 3, 4, 5])).toEqual([
      ["2026-10-26", "2026-11-06"],
      ["2026-12-25", "2026-12-25"],
    ]);
    // Without weekdays only consecutive days join.
    expect(dateRuns(["2026-12-24", "2026-12-25", "2026-12-31"])).toEqual([
      ["2026-12-24", "2026-12-25"],
      ["2026-12-31", "2026-12-31"],
    ]);
    // A weekday the pattern runs on, missing between two dates, splits them.
    expect(dateRuns(["2026-10-26", "2026-10-28"], [1, 2, 3, 4, 5])).toHaveLength(2);
  });

  it("names no weekday after a pattern that runs on a single date of it", () => {
    const day = (date: string, key: string | null): CalendarDay => ({
      date,
      services: [],
      trips: key ? 1 : 0,
      key,
    });
    // Thu 22 Oct alone, then two Saturdays.
    const days = [day("2026-10-22", "thu"), day("2026-10-24", "sat"), day("2026-10-31", "sat")];
    const types = dayTypes(days);
    expect(types.find((ty) => ty.key === "thu")?.weekdays).toEqual([]);
    expect(types.find((ty) => ty.key === "sat")?.weekdays).toEqual([6]);
  });

  it("marks service added and removed against the patterns' usual weeks", () => {
    const weekdays: DayType = {
      key: "wk",
      days: ["2026-12-27"],
      trips: 1,
      weekdays: [1, 2, 3, 4, 5],
      except: ["2026-12-24", "2026-12-25"],
      adds: ["2026-12-27"],
    };
    // Thu 24 Dec runs a pattern of its own in the weekdays' place; Fri 25
    // Dec has no service; Sun 27 Dec the weekdays' pattern runs off its week.
    const odd = {
      ...weekdays,
      key: "xmas",
      days: ["2026-12-24"],
      weekdays: [],
      except: [],
      adds: ["2026-12-24"],
    };
    expect(Object.fromEntries(exceptionMarks([weekdays, odd]))).toEqual({
      "2026-12-24": "+",
      "2026-12-25": "-",
      "2026-12-27": "+",
    });
  });
});

describe("running times", () => {
  it("takes the busiest pattern's median per period, leaving short turns out", async () => {
    const r = route("R1");
    const { directions } = await routeDirections(db, r);
    const toFifth = directions.find((d) => label(d) === "To Fifth") as Direction;
    const own = new Set(toFifth.patterns.map((p) => p.pattern_idx));
    const runs = (await routeRuns(db, r, "2026-10-14")).filter((x) => own.has(x.pattern_idx));
    const times = runningTimes(runs);
    // T1 and T2 leave at 08:00 and 08:10 and take 8 min; T4, the short turn, 4.
    expect(times.get("am_peak")).toBe(8);
    expect(times.get("midday")).toBeNull();
  });
});

describe("route calendar with frequencies", () => {
  it("counts every run of a frequency-based trip", async () => {
    // F1 runs every 10 min from 06:00 to 09:00: 18 trips, as the Overview counts them.
    const cal = await routeCalendar(db, route("R4"), ["2026-01-05", "2026-12-31"]);
    const wednesday = cal.days.find((d) => d.date === "2026-10-14");
    expect(wednesday?.trips).toBe(18);
    expect(wednesday?.trips).toBe((await routeRuns(db, route("R4"), "2026-10-14")).length);
  });
});

describe("settings in the figures", () => {
  it("counts peak vehicles with the layover set", async () => {
    // R1's weekday runs, 08:00–08:34, 2 minutes apart at the ends: with no
    // layover one vehicle can follow another sooner.
    const runs = await routeRuns(db, route("R1"), "2026-10-14");
    expect(operations(runs, 0).peak_vehicles).toBeLessThanOrEqual(operations(runs, 6 * 60).peak_vehicles);
  });
});

describe("vehicles", () => {
  // Stops lie 0.01° of longitude apart along 52.5° N: S1 13.40 … S6 13.45.
  const at = async (date: string, t: number) => {
    await prepareDay(db, date);
    const frame = positionsAt(await vehicleWindow(db, date, t - 600, t + 600), t);
    return Array.from({ length: frame.n }, (_, i) => vehicleAt(frame, i));
  };
  const hm = (h: number, m: number) => h * 3600 + m * 60;

  it("places a vehicle between the stops it runs between", async () => {
    // T1 leaves S2 at 08:02 and reaches S3 at 08:04: at 08:03 it is halfway.
    const r1 = route("R1");
    const vehicles = (await at("2026-10-14", hm(8, 3))).filter((v) => v.route_idx === r1.route_idx);
    expect(vehicles).toHaveLength(1);
    expect(vehicles[0].lon).toBeCloseTo(13.415, 6);
    expect(vehicles[0].lat).toBeCloseTo(52.5, 6);
  });

  it("runs a vehicle past stops the feed leaves untimed", async () => {
    // Only timepoints timed, as GTFS allows: T1 without its time at S2 runs
    // on from S1 (08:00) to S3 (08:04) rather than vanishing at S1.
    const where = `trip_idx = (SELECT trip_idx FROM trips WHERE trip_id = 'T1')
                   AND stop_idx = (SELECT stop_idx FROM stops WHERE stop_id = 'S2')`;
    const [kept] = await db.all<{ arrival_s: number; departure_s: number }>(
      `SELECT arrival_s, departure_s FROM stop_times WHERE ${where}`
    );
    await db.all(`UPDATE stop_times SET arrival_s = NULL, departure_s = NULL WHERE ${where}`);
    try {
      const r1 = route("R1");
      const [t1] = (await at("2026-10-14", hm(8, 3))).filter((v) => v.route_idx === r1.route_idx);
      expect(t1).toBeDefined();
      // Past S2 (13.41), short of S3 (13.42).
      expect(t1.lon).toBeGreaterThan(13.405);
      expect(t1.lon).toBeLessThan(13.42);
    } finally {
      await db.all(
        `UPDATE stop_times SET arrival_s = ${kept.arrival_s}, departure_s = ${kept.departure_s} WHERE ${where}`
      );
    }
  });

  it("follows the trip's shape, not the straight line between stops", async () => {
    // SH1 leaves S1 for 52.505° N and comes back down at S2: T1, halfway
    // from S1 (08:00) to S2 (08:02), is at the top of the detour.
    const r1 = route("R1");
    const [t1] = (await at("2026-10-14", hm(8, 1))).filter((v) => v.route_idx === r1.route_idx);
    expect(t1.lon).toBeCloseTo(13.405, 4);
    expect(t1.lat).toBeCloseTo(52.505, 4);
  });

  it("goes in a straight line where a trip has no shape", async () => {
    // T3 (no shape) runs S5 → S1 from 08:20; at 08:21 it is halfway to S4.
    const r1 = route("R1");
    const vehicles = (await at("2026-10-14", hm(8, 21))).filter((v) => v.route_idx === r1.route_idx);
    expect(vehicles).toHaveLength(1);
    expect(vehicles[0].lon).toBeCloseTo(13.435, 6);
    expect(vehicles[0].lat).toBeCloseTo(52.5, 6);
  });

  it("walks a shape by distance", () => {
    const shape = {
      d: Float32Array.from([0, 100, 300]),
      lon: Float32Array.from([0, 1, 1]),
      lat: Float32Array.from([0, 0, 2]),
    };
    expect(alongShape(shape, 50)).toEqual([0.5, 0]);
    expect(alongShape(shape, 200)).toEqual([1, 1]);
    expect(alongShape(shape, 999)).toEqual([1, 2]);
  });

  it("runs every run of a frequency-based trip", async () => {
    // F1 leaves every 10 min from 06:00 and takes 8 (S4 → S5 in 4, S5 → S6
    // in 4): at 06:15 only the 06:10 run is out, a quarter of the way from
    // S5 (06:14) to S6 (06:18).
    const r4 = route("R4");
    const at0615 = (await at("2026-10-14", hm(6, 15))).filter((v) => v.route_idx === r4.route_idx);
    expect(at0615).toHaveLength(1);
    expect(at0615[0].lon).toBeCloseTo(13.44 + 0.01 * (1 / 4), 6);
    const at0607 = (await at("2026-10-14", hm(6, 7))).filter((v) => v.route_idx === r4.route_idx);
    expect(at0607).toHaveLength(1);
  });

  it("follows service past midnight", async () => {
    // U2 runs 24:20–24:50; its middle stop has no position, so it goes
    // straight from S6 to S2 between 24:20 and 24:50.
    await prepareDay(db, "2026-10-14");
    const span = await serviceSpan(db);
    expect(span?.last_s).toBe(hm(24, 50));
    expect(await runningAt(db, hm(24, 30))).toBe(1);
    const r2 = route("R2");
    const [u2] = (await at("2026-10-14", hm(24, 35))).filter((v) => v.route_idx === r2.route_idx);
    expect(u2.lon).toBeCloseTo(13.45 - 0.04 * 0.5, 6);
  });

  it("holds a vehicle at its stop while it waits there", () => {
    // One run: waiting at (1, 1) from 10 to 20, then on to (2, 1) by 30.
    const window: VehicleWindow = {
      date: "2026-10-14",
      from_s: 0,
      to_s: 100,
      runs: 1,
      first: Int32Array.from([0, 2]),
      run: Int32Array.from([1, 1]),
      route_idx: Int32Array.from([0, 0]),
      trip_idx: Int32Array.from([0, 0]),
      run_dep_s: Float64Array.from([10, 10]),
      t0: Float64Array.from([10, 20]),
      t1: Float64Array.from([20, 30]),
      ax: Float64Array.from([1, 1]),
      ay: Float64Array.from([1, 1]),
      bx: Float64Array.from([1, 2]),
      by: Float64Array.from([1, 1]),
      shape: Int32Array.from([-1, -1]),
      d0: new Float64Array(2),
      d1: new Float64Array(2),
      shapes: new Map(),
    };
    const frame = positionsAt(window, 15);
    expect(frame.n).toBe(1);
    expect(vehicleAt(frame, 0)).toEqual({ run: 1, route_idx: 0, trip_idx: 0, run_dep_s: 10, lon: 1, lat: 1 });
    // The same frame, filled again in place.
    expect(positionsAt(window, 25, frame).lon[0]).toBe(1.5);
    expect(positionsAt(window, 40, frame).n).toBe(0);
  });
});

describe("stop timetable", () => {
  // Stop indexes: 0 Main Station (a station), 1 its platform S1, 2 S2 … 5 S5.
  const departures = async (stop_idx: number, date = "2026-10-14") =>
    (await stopDepartures(db, stop_idx, date)).map((d) => hm(d.dep_s));

  it("lists each run leaving the stop, but not trips ending there", async () => {
    // T1, T2 towards Fifth and T3 towards Main Station; T4 turns at S3.
    expect(await departures(3)).toEqual(["08:04", "08:14", "08:24"]);
  });

  it("runs every run of a frequency-based trip", async () => {
    // R4 every 10 min 06:00–08:50 leaves S4 as it starts; R1 passes three times.
    const times = await departures(4);
    expect(times).toHaveLength(18 + 3);
    expect(times.slice(0, 2)).toEqual(["06:00", "06:10"]);
  });

  it("covers a station's platforms, and lets a loop leave where it ends", async () => {
    expect(await departures(0)).toEqual(["08:00", "08:10", "08:30"]);
    // Each from the platform it leaves: S1.
    expect(new Set((await stopDepartures(db, 0, "2026-10-14")).map((d) => d.stop_idx))).toEqual(new Set([1]));
    // Saturday: the loop leaves S1 at 10:00 and ends back there.
    expect(await departures(1, "2026-10-17")).toEqual(["10:00"]);
  });

  it("groups by direction and marks short turns", async () => {
    const r1 = route("R1");
    const { directions } = await routeDirections(db, r1);
    const deps = (await stopDepartures(db, 1, "2026-10-14")).filter((d) => d.route_idx === r1.route_idx);
    const groups = byDirection(deps, directions);
    expect(
      groups.map((g) => [label({ name: g.name } as Direction), g.departures.map((e) => e.short)])
    ).toEqual([["To Fifth", [false, false, true]]]);
    expect(byHour(groups[0].departures).map((h) => [h.hour, h.entries.length])).toEqual([[8, 3]]);
  });

  it("describes the stop and the routes calling there", async () => {
    const ids = new Map([...routes.values()].map((r) => [r.route_idx, r.route_id]));
    const station = await stopDetail(db, 0);
    expect(station?.is_station).toBe(true);
    expect(station?.routes.map((i) => ids.get(i)).sort()).toEqual(["R1", "R3"]);
    expect(station?.n_stops).toBe(1);
    const platform = await stopDetail(db, 1);
    expect(platform?.station).toBe("Main Station");
    // A stop's own lines: S4 is R1's and R4's, not its neighbours'.
    expect((await stopDetail(db, 4))?.routes.map((i) => ids.get(i)).sort()).toEqual(["R1", "R4"]);
  });
});

describe("trip", () => {
  it("times a run's stops, with its neighbours and the transfers at each stop", async () => {
    const t2 = (await db.all<{ trip_idx: number }>("SELECT trip_idx FROM trips WHERE trip_id = 'T2'"))[0];
    const trip = await tripDetail(db, t2.trip_idx, 8 * 3600 + 600, "2026-10-14");
    expect(trip?.stops.map((s) => hm(s.dep_s ?? 0))).toEqual(["08:10", "08:12", "08:14", "08:16", "08:18"]);
    expect(trip?.stops[0].name).toBe("Main Station");
    expect(trip?.destination).toBe("Fifth");
    const ids = new Map([...routes.values()].map((r) => [r.route_idx, r.route_id]));
    expect(trip?.stops.map((s) => s.transfers.map((i) => ids.get(i)).sort())).toEqual([
      ["R3"],
      ["R2", "R3"],
      ["R3"],
      ["R4"],
      ["R4"],
    ]);
    // Towards Fifth: T1 at 08:00 before, the short turn T4 at 08:30 after.
    expect(trip?.prev && hm(trip.prev.run_dep_s)).toBe("08:00");
    expect(trip?.next && hm(trip.next.run_dep_s)).toBe("08:30");
  });

  it("moves a frequency run's times by its start", async () => {
    const f1 = (await db.all<{ trip_idx: number }>("SELECT trip_idx FROM trips WHERE trip_id = 'F1'"))[0];
    const trip = await tripDetail(db, f1.trip_idx, 6 * 3600 + 600, "2026-10-14");
    expect(trip?.stops.map((s) => hm(s.dep_s ?? 0))).toEqual(["06:10", "06:14", "06:18"]);
    expect(trip?.prev && hm(trip.prev.run_dep_s)).toBe("06:00");
    expect(trip?.next && hm(trip.next.run_dep_s)).toBe("06:20");
  });
});

describe("network shapes", () => {
  it("draws every route, through its stops where the feed has no shape", async () => {
    const { shapes, routes } = await networkShapes(db);
    // R1 has SH1 and a line through the stops for its return; R2, R3 and R4
    // have no shape in the feed. RX runs no trip that could be drawn.
    const drawn = new Set([...shapes.values()].flatMap((s) => s.route_ids));
    expect([...drawn].sort()).toEqual(["R1", "R2", "R3", "R4"]);
    expect(shapes.get("SH1")?.route_ids).toEqual(["R1"]);
    const chains = [...shapes.keys()].filter((id) => id.startsWith("stops-"));
    expect(chains.length).toBeGreaterThanOrEqual(4);
    for (const id of chains) expect(shapes.get(id)?.color).toMatch(/^#[0-9A-F]{6}$/i);
    // Every route is known, for the filter and the line chooser.
    expect([...routes.keys()].sort()).toEqual(["R1", "R2", "R3", "R4"]);
  });
});

describe("network stops", () => {
  it("draws every stop vehicles call at, by its station's name, and no others", async () => {
    const names = (await networkStops(db)).features.map((f) => f.properties.name);
    expect(names.sort()).toEqual(["Fifth", "Fourth", "Main Station", "Second", "Sixth", "Third"]);
  });
});

describe("station areas", () => {
  it("takes the outermost points, counter-clockwise", () => {
    const hull = convexHull([
      [0, 0],
      [2, 0],
      [1, 1],
      [2, 2],
      [0, 2],
    ]);
    expect(hull).toEqual([
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
    ]);
  });

  it("rounds one stop into a circle the margin wide", () => {
    const ring = stationArea([[13.4, 52.5]], 12);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    // Every corner point 12 m from the stop, give or take the rounding.
    const kx = 111320 * Math.cos((52.5 * Math.PI) / 180);
    for (const [lon, lat] of ring.slice(0, -1))
      expect(Math.hypot((lon - 13.4) * kx, (lat - 52.5) * 110540)).toBeCloseTo(12, 0);
  });

  it("draws a station round the stops some route calls at", async () => {
    const stations = (await networkStations(db)).features;
    expect(stations.map((f) => f.properties.name)).toEqual(["Main Station"]);
  });
});

describe("shape colours", () => {
  it("are one match on shape_id, shapes of a colour sharing a branch", () => {
    const shapes = new Map([
      ["a", { color: "#FF0000", route_ids: ["R1"] }],
      ["b", { color: "#00FF00", route_ids: ["R2"] }],
      ["c", { color: "#FF0000", route_ids: ["R1"] }],
    ]);
    expect(shapeColorExpression(shapes, "#999")).toEqual([
      "match",
      ["to-string", ["get", "shape_id"]],
      ["a", "c"],
      "#FF0000",
      ["b"],
      "#00FF00",
      "#999",
    ]);
    expect(shapeColorExpression(new Map(), "#999")).toBe("#999");
  });
});

describe("a run's length", () => {
  it("says where it is from: a shape, or straight lines between stops", async () => {
    // 1 the feed's distances, 2 the shape's, 3 straight lines between stops;
    // a trip without a shape can only have the last, an estimate.
    const trips = await db.all<{ shape_idx: number | null; length_src: number }>(
      "SELECT shape_idx, length_src FROM trips"
    );
    // The fixture has an estimated one: T3, whose stops are all it has.
    expect(trips.some((t) => t.length_src === 3)).toBe(true);
    for (const t of trips) {
      expect([1, 2, 3]).toContain(t.length_src);
      if (t.shape_idx === null) expect(t.length_src).toBe(3);
    }
    // Runs carry it, for the trip list to mark an estimate.
    for (const r of await routeRuns(db, route("R1"), "2026-10-14")) expect([1, 2, 3]).toContain(r.length_src);
  });
});

describe("a stop the feed leaves untimed", () => {
  it("lists its calls with the window between the timed stops either side", async () => {
    // T1 again as a new trip, its call at Third (S3) left without times:
    // it leaves Second at 08:02 and reaches Fourth at 08:06.
    const [{ id }] = await db.all<{ id: number }>("SELECT max(trip_idx) + 1 AS id FROM trips");
    const [{ t1 }] = await db.all<{ t1: number }>("SELECT trip_idx AS t1 FROM trips WHERE trip_id = 'T1'");
    const [{ s3 }] = await db.all<{ s3: number }>("SELECT stop_idx AS s3 FROM stops WHERE stop_id = 'S3'");
    await db.exec(`
      INSERT INTO trips SELECT * REPLACE (${id} AS trip_idx, 'T1-untimed' AS trip_id) FROM trips WHERE trip_idx = ${t1};
      INSERT INTO stop_times SELECT * REPLACE (
        ${id} AS trip_idx,
        CASE WHEN stop_idx = ${s3} THEN NULL ELSE arrival_s END AS arrival_s,
        CASE WHEN stop_idx = ${s3} THEN NULL ELSE departure_s END AS departure_s
      ) FROM stop_times WHERE trip_idx = ${t1};`);
    try {
      const deps = await stopDepartures(db, s3, "2026-10-14");
      const untimed = deps.filter((d) => d.trip_idx === id);
      expect(untimed).toHaveLength(1);
      expect(untimed[0]).toMatchObject({ untimed: true, from_stop: "Second", until_stop: "Fourth" });
      expect(hm(untimed[0].dep_s)).toBe("08:02");
      expect(hm(untimed[0].until_s as number)).toBe("08:06");
      // A timed call keeps its own time and no window.
      const timed = deps.find((d) => d.trip_idx === t1);
      expect(timed).toMatchObject({ untimed: false, until_s: null, from_stop: null });
      expect(hm((timed as { dep_s: number }).dep_s)).toBe("08:04");
    } finally {
      await db.exec(
        `DELETE FROM stop_times WHERE trip_idx = ${id}; DELETE FROM trips WHERE trip_idx = ${id};`
      );
    }
  });
});
