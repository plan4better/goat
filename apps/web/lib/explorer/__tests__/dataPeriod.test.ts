// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";

import { openFixtureDb } from "@/lib/explorer/__tests__/fixtureDb";
import type { SqlRunner } from "@/lib/explorer/db/types";
import { type DailyTrips, dailyTripCounts } from "@/lib/explorer/derive/calendar";
import { fullServiceRange, optimumPeriod } from "@/lib/explorer/derive/cost";
import { DEFAULT_SETTINGS, settingsProblems } from "@/lib/explorer/settings";

let db: SqlRunner;
beforeAll(async () => {
  db = await openFixtureDb();
});

/** `n` days from `start`, `trips(i)` trips on day `i`. */
function days(start: string, n: number, trips: (i: number) => number): DailyTrips[] {
  const t0 = Date.parse(`${start}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(t0 + i * 86_400_000).toISOString().slice(0, 10),
    trips: trips(i),
  }));
}

describe("the data period", () => {
  it("counts the trips running each day, a frequency's runs each once", async () => {
    // Saturday, Sunday, Easter Monday (weekday service removed), two weekdays.
    expect(await dailyTripCounts(db, "2026-04-04", "2026-04-08")).toEqual([
      { date: "2026-04-04", trips: 1 },
      { date: "2026-04-05", trips: 0 },
      { date: "2026-04-06", trips: 0 },
      { date: "2026-04-07", trips: 24 },
      { date: "2026-04-08", trips: 24 },
    ]);
  });

  it("finds the stretch the timetable fully covers, not the months it runs on thin", () => {
    // MVG's shape: full service for 66 days, then an eighth of it.
    const feed = days("2026-10-08", 271, (i) => (i < 66 ? 20_000 : 2_800));
    expect(fullServiceRange(feed)).toEqual(["2026-10-08", "2026-12-12"]);
    // Counted over that, scaled to a year (costYear on it).
    expect(optimumPeriod(["2026-10-08", "2027-07-05"], feed)).toEqual(["2026-10-08", "2026-12-12"]);
  });

  it("keeps weekends and a holiday week inside the stretch", () => {
    // Weekends at a third, a Christmas week at 60 %: all still the timetable.
    const feed = days("2026-11-02", 70, (i) => (i >= 50 && i < 57 ? 600 : i % 7 >= 5 ? 330 : 1000));
    expect(fullServiceRange(feed)).toEqual(["2026-11-02", "2027-01-10"]);
  });

  it("falls back to the window for a feed with no trips", () => {
    expect(fullServiceRange(days("2026-01-01", 10, () => 0))).toBeNull();
    expect(optimumPeriod(["2026-03-01", "2026-03-10"], [])).toEqual(["2026-03-01", "2026-03-10"]);
  });

  it("takes a data period of any length, but not one backwards", () => {
    const set = (data_period: [string, string]) => settingsProblems({ ...DEFAULT_SETTINGS, data_period });
    expect(set(["2026-01-01", "2026-12-31"])).toEqual([]);
    // A whole feed of several years: counted over all of it, scaled to one.
    expect(set(["2025-01-01", "2027-06-30"])).toEqual([]);
    expect(set(["2026-05-01", "2026-04-01"])).toEqual(["explorer_settings_data_period"]);
  });
});
