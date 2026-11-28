// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";

import { openFixtureDb } from "@/lib/explorer/__tests__/fixtureDb";
import type { SqlRunner } from "@/lib/explorer/db/types";
import { editRouteDetails, routeFieldProblems, routeRecord } from "@/lib/explorer/edit/ops/routes";
import { EditSession } from "@/lib/explorer/edit/session";

const r1 = async (db: SqlRunner) =>
  (await db.all<{ route_idx: number }>("SELECT route_idx FROM routes WHERE route_id = 'R1'"))[0].route_idx;

describe("a line's own fields", () => {
  let db: SqlRunner;
  beforeEach(async () => {
    db = await openFixtureDb();
  });

  it("are edited, only those changed saved, and undo puts them back", async () => {
    const idx = await r1(db);
    const before = await routeRecord(db, idx);
    if (!before) throw new Error();
    expect(before).toMatchObject({ short_name: "1", long_name: "Main Line", color: "1E88E5", route_type: 3 });
    const built = await editRouteDetails(db, idx, {
      ...before,
      long_name: " Main Line East ",
      color: "#00aa55",
      description: "Via the centre",
    });
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.facts.changed).toEqual(["long_name", "description", "color"]);
    expect(built.rows.gtfs).toEqual([
      {
        role: "routes",
        op: "update",
        key: { route_id: "R1" },
        values: {
          route_long_name: "Main Line East",
          route_desc: "Via the centre",
          route_color: "00AA55",
        },
      },
    ]);
    const session = new EditSession(db);
    await session.apply({ id: "r", label: "Edited", ...built.rows });
    expect(await routeRecord(db, idx)).toMatchObject({ long_name: "Main Line East", color: "00AA55" });
    await session.undo();
    expect(await routeRecord(db, idx)).toEqual(before);
  });

  it("refuses a line left without a name, on its field", async () => {
    const idx = await r1(db);
    const before = await routeRecord(db, idx);
    if (!before) throw new Error();
    const built = await editRouteDetails(db, idx, { ...before, short_name: "", long_name: " " });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.refused).toMatchObject({ code: "route_both_short_and_long_name_missing" });
  });

  it("checks colours as GTFS has them", () => {
    const v = {
      short_name: "1",
      long_name: "",
      description: "",
      route_type: 3,
      agency_idx: 0,
      color: "12345",
      text_color: "#ffffff",
    };
    expect(routeFieldProblems(v)).toEqual({
      color: "invalid_color",
    });
  });
});
