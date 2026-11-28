// @vitest-environment node

/**
 * Paths between two stops, on the mini feed: T1 runs First → Fifth along
 * SH1, stops 0.01° (about 677 m) apart at 52.5° N; T3 runs back on the line
 * through its stops (it has no shape).
 */
import { beforeAll, describe, expect, it } from "vitest";

import { openFixtureDb } from "@/lib/explorer/__tests__/fixtureDb";
import type { SqlRunner } from "@/lib/explorer/db/types";
import { type PatternLine, patternLine, stretchAt } from "@/lib/explorer/derive/path";

let db: SqlRunner;
const lineOf = async (trip_id: string) => {
  const [{ pattern_idx }] = await db.all<{ pattern_idx: number }>(
    `SELECT pattern_idx FROM trips WHERE trip_id = '${trip_id}'`
  );
  return (await patternLine(db, pattern_idx)) as PatternLine;
};

beforeAll(async () => {
  db = await openFixtureDb();
});

describe("a path between two stops", () => {
  it("is the stretch around the click", async () => {
    const p = stretchAt(await lineOf("T1"), 13.416, 52.5004);
    // Between Second (13.41) and Third (13.42); stops count from 0.
    expect(p).toMatchObject({ from_i: 1, to_i: 2, from_name: "Second", to_name: "Third" });
    // Its line runs from the one stop to the other.
    expect(p.line[0][0]).toBeCloseTo(13.41, 3);
    expect(p.line.at(-1)?.[0]).toBeCloseTo(13.42, 3);
  });

  it("places the click on the line, and says how far off it was in metres", async () => {
    const p = stretchAt(await lineOf("T1"), 13.416, 52.5004);
    // The line runs along 52.5° N: the nearest point is straight south.
    expect(p.at[0]).toBeCloseTo(13.416, 6);
    expect(p.at[1]).toBeCloseTo(52.5, 6);
    // 0.0004° of latitude is about 44.5 m.
    expect(p.off).toBeCloseTo(0.0004 * 111_195, 1);
    // A click on the line is no distance off it.
    expect(stretchAt(await lineOf("T1"), 13.416, 52.5).off).toBeCloseTo(0, 6);
  });

  it("is the first or last stretch for a click beyond the ends", async () => {
    const line = await lineOf("T1");
    const first = stretchAt(line, 13.3, 52.5);
    expect(first).toMatchObject({ from_i: 0, to_i: 1 });
    // Placed at the line's start, 0.1° of longitude short of it.
    expect(first.at[0]).toBeCloseTo(13.4, 5);
    expect(first.off).toBeCloseTo(0.1 * 111_195 * Math.cos((52.5 * Math.PI) / 180), -1);
    expect(stretchAt(line, 13.6, 52.5)).toMatchObject({ from_i: 3, to_i: 4, to_name: "Fifth" });
  });

  it("follows a trip without a shape along the line through its stops", async () => {
    const p = stretchAt(await lineOf("T3"), 13.435, 52.5);
    expect(p).toMatchObject({ from_name: "Fifth", to_name: "Fourth" });
  });
});
