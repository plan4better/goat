// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";

import { openFixtureDb } from "@/lib/explorer/__tests__/fixtureDb";
import type { SqlRunner } from "@/lib/explorer/db/types";
import { NO_STOP_VALUES, type StopValues } from "@/lib/explorer/edit/drafts";
import { cleanStopValues, parseLatLon } from "@/lib/explorer/edit/ops/stopRules";
import {
  createStop,
  editStopDetails,
  newStopId,
  sameStopValues,
  stopRecord,
} from "@/lib/explorer/edit/ops/stops";
import { EditSession } from "@/lib/explorer/edit/session";

const v = (values: Partial<StopValues>): StopValues => ({ ...NO_STOP_VALUES, ...values });

const idx = async (db: SqlRunner, stop_id: string) =>
  (await db.all<{ stop_idx: number }>(`SELECT stop_idx FROM stops WHERE stop_id = '${stop_id}'`))[0].stop_idx;

describe("2.4 edit stop attributes", () => {
  let db: SqlRunner;
  beforeEach(async () => {
    db = await openFixtureDb();
  });

  it("reads a stop's details", async () => {
    expect(await stopRecord(db, await idx(db, "S2"))).toMatchObject({
      stop_id: "S2",
      name: "Second",
      wheelchair: 0,
    });
  });

  it("writes only what changed, in the snapshot and as the bundle's row", async () => {
    const s2 = await idx(db, "S2");
    const built = await editStopDetails(db, s2, v({ name: " Second Street ", wheelchair: 1 }));
    if (!built.ok) throw new Error("refused");
    expect(built.facts.changed).toEqual(["name", "wheelchair"]);
    expect(built.rows.gtfs).toEqual([
      {
        role: "stops",
        op: "update",
        key: { stop_id: "S2" },
        values: { stop_name: "Second Street", wheelchair_boarding: 1 },
      },
    ]);
    const session = new EditSession(db);
    await session.apply({ id: "c1", label: "Edited", ...built.rows });
    expect(await stopRecord(db, s2)).toMatchObject({ name: "Second Street", wheelchair: 1 });
    await session.undo();
    expect(await stopRecord(db, s2)).toMatchObject({ name: "Second", wheelchair: 0 });
  });

  it("clears an accessibility as GTFS's empty", async () => {
    const s2 = await idx(db, "S2");
    await db.exec(`UPDATE stops SET wheelchair = 1 WHERE stop_idx = ${s2}`);
    const built = await editStopDetails(db, s2, v({ name: "Second", wheelchair: 0 }));
    if (!built.ok) throw new Error("refused");
    expect(built.rows.gtfs[0]).toMatchObject({ values: { wheelchair_boarding: null } });
    expect(built.rows.sql).toEqual([`UPDATE stops SET wheelchair = NULL WHERE stop_idx = ${s2}`]);
  });

  it("keeps a quote in a name a name", async () => {
    const s3 = await idx(db, "S3");
    const built = await editStopDetails(db, s3, v({ name: "O'Connell St", wheelchair: 0 }));
    if (!built.ok) throw new Error("refused");
    await new EditSession(db).apply({ id: "c1", label: "Renamed", ...built.rows });
    expect((await stopRecord(db, s3))?.name).toBe("O'Connell St");
    expect(built.rows.kind).toBe("stop_rename");
  });

  it("refuses a stop without a name", async () => {
    const built = await editStopDetails(db, await idx(db, "S2"), v({ name: "  ", wheelchair: 0 }));
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.refused.code).toBe("missing_stop_name");
  });

  it("compares values as they are kept", () => {
    expect(sameStopValues(v({ name: "A ", wheelchair: 0 }), v({ name: "A", wheelchair: 0 }))).toBe(true);
    expect(sameStopValues(v({ name: "A", wheelchair: 0 }), v({ name: "A", wheelchair: 2 }))).toBe(false);
  });
});

describe("2.4 a stop's GTFS fields, by its location type", () => {
  let db: SqlRunner;
  beforeEach(async () => {
    db = await openFixtureDb();
  });

  it("reads the station a platform belongs to", async () => {
    expect(await stopRecord(db, await idx(db, "S1"))).toMatchObject({
      location_type: 0,
      parent_idx: await idx(db, "P"),
    });
    expect((await stopRecord(db, await idx(db, "P")))?.location_type).toBe(1);
  });

  it("puts a stop in a station, its platform with it, as the bundle's parent_station", async () => {
    const s3 = await idx(db, "S3");
    const p = await idx(db, "P");
    const built = await editStopDetails(
      db,
      s3,
      v({ ...(await stopRecord(db, s3)), parent_idx: p, platform_code: "2" })
    );
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.facts.changed).toEqual(["parent_idx", "platform_code"]);
    expect(built.rows.gtfs[0]).toEqual(
      expect.objectContaining({
        values: { parent_station: "P", platform_code: "2" },
      })
    );
    await new EditSession(db).apply({ id: "c1", label: "Edited", ...built.rows });
    expect(await stopRecord(db, s3)).toMatchObject({ parent_idx: p, platform_code: "2" });
  });

  it("keeps a saved location's type: another type is another location", async () => {
    for (const [stop, type] of [
      ["X", 1],
      ["S4", 2],
      ["P", 0],
    ] as const) {
      const at = await idx(db, stop);
      const built = await editStopDetails(db, at, v({ ...(await stopRecord(db, at)), location_type: type }));
      expect(built.ok ? null : built.refused).toMatchObject({
        code: "goat_type_fixed",
        field: "location_type",
      });
    }
  });

  it("wants a station for a parent", async () => {
    const x = await idx(db, "X");
    const record = v({ ...(await stopRecord(db, x)) });
    const wrong = await editStopDetails(db, x, { ...record, parent_idx: await idx(db, "S2") });
    expect(wrong.ok ? null : wrong.refused).toMatchObject({
      code: "wrong_parent_location_type",
      field: "parent_idx",
    });
    expect((await editStopDetails(db, x, { ...record, parent_idx: await idx(db, "P") })).ok).toBe(true);
  });
});

describe("2.1 create stop", () => {
  let db: SqlRunner;
  beforeEach(async () => {
    db = await openFixtureDb();
  });

  it("makes a stop where it was placed, and undo takes it away", async () => {
    const built = await createStop(db, 13.47, 52.52, v({ name: "Depot", wheelchair: 1 }), "goat_00000001");
    if (!built.ok) throw new Error("refused");
    expect(built.checks).toEqual([]);
    expect(built.rows.gtfs).toEqual([
      {
        role: "stops",
        op: "insert",
        key: { stop_id: "goat_00000001" },
        values: {
          stop_name: "Depot",
          stop_lat: 52.52,
          stop_lon: 13.47,
          location_type: 0,
          wheelchair_boarding: 1,
        },
      },
    ]);
    const before = await db.all("SELECT * FROM stops ORDER BY stop_idx");
    const session = new EditSession(db);
    await session.apply({ id: "c1", label: "Created", ...built.rows });
    expect(await stopRecord(db, built.facts.stop_idx)).toMatchObject({
      stop_id: "goat_00000001",
      name: "Depot",
      wheelchair: 1,
      lat: 52.52,
      lon: 13.47,
    });
    await session.undo();
    expect(await db.all("SELECT * FROM stops ORDER BY stop_idx")).toEqual(before);
  });

  it("renames a platform whose parent the feed got wrong: the problem is the feed's", async () => {
    // S1's parent made another platform, as a malformed feed may have it.
    await db.exec(`UPDATE stops SET parent_idx = (SELECT stop_idx FROM stops WHERE stop_id = 'S2')
                   WHERE stop_id = 'S1'`);
    const s1 = (await db.all<{ stop_idx: number }>("SELECT stop_idx FROM stops WHERE stop_id = 'S1'"))[0]
      .stop_idx;
    const record = await stopRecord(db, s1);
    if (!record) throw new Error("no S1");
    const built = await editStopDetails(db, s1, { ...cleanStopValues(record), name: "Renamed" });
    expect(built.ok).toBe(true);
  });

  it("waits for a name", async () => {
    const built = await createStop(db, 13.47, 52.52, v({ name: "", wheelchair: 0 }), "goat_x");
    expect(built.ok).toBe(false);
  });

  it("takes the id typed, if the feed does not use it already", async () => {
    const taken = await createStop(db, 13.47, 52.52, v({ name: "Depot" }), "S2");
    expect(taken.ok ? null : taken.refused).toMatchObject({ code: "duplicate_key", field: "stop_id" });
    const spaced = await createStop(db, 13.47, 52.52, v({ name: "Depot" }), "depot one");
    expect(spaced.ok ? null : spaced.refused.code).toBe("invalid_stop_id");
    const station = await createStop(db, 13.47, 52.52, v({ name: "Depot", location_type: 1 }), "DEPOT");
    if (!station.ok) throw new Error(station.refused.code);
    expect(station.rows.gtfs[0]).toMatchObject({ key: { stop_id: "DEPOT" }, values: { location_type: 1 } });
  });

  it("wants an entrance's station", async () => {
    const entrance = v({ name: "North exit", location_type: 2 });
    const none = await createStop(db, 13.4, 52.5, entrance, "E1");
    expect(none.ok ? null : none.refused).toMatchObject({
      code: "location_without_parent_station",
      field: "parent_idx",
    });
    const built = await createStop(db, 13.4, 52.5, { ...entrance, parent_idx: await idx(db, "P") }, "E1");
    if (!built.ok) throw new Error(built.refused.code);
    expect(built.rows.gtfs[0]).toMatchObject({ values: { location_type: 2, parent_station: "P" } });
  });

  it("picks an id the feed does not use", async () => {
    await db.exec("UPDATE stops SET stop_id = 'goat_00000000' WHERE stop_id = 'X'");
    const draws = [0, 0.5];
    expect(await newStopId(db, () => draws.shift() as number)).toBe("goat_80000000");
  });
});

describe("a position typed or pasted", () => {
  it("reads latitude, then longitude, as maps copy them", () => {
    expect(parseLatLon("52.52, 13.405")).toEqual({ lat: 52.52, lon: 13.405 });
    expect(parseLatLon(" 52.52;13.405 ")).toEqual({ lat: 52.52, lon: 13.405 });
    expect(parseLatLon("-33.9 151.2")).toEqual({ lat: -33.9, lon: 151.2 });
  });

  it("takes no half position, and none off the globe", () => {
    expect(parseLatLon("52.52")).toBeNull();
    expect(parseLatLon("52.52, ")).toBeNull();
    expect(parseLatLon("95, 13")).toBeNull();
    expect(parseLatLon("52, 190")).toBeNull();
    expect(parseLatLon("52,52, 13,40")).toBeNull();
  });
});
