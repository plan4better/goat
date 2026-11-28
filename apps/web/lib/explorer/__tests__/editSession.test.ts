// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";

import { openFixtureDb } from "@/lib/explorer/__tests__/fixtureDb";
import { remembered } from "@/lib/explorer/answers";
import type { SqlRunner } from "@/lib/explorer/db/types";
import { EditSession } from "@/lib/explorer/edit/session";
import type { EditChange } from "@/lib/explorer/edit/types";

/** The rows of a table, in a stable order, as text: what "exactly as before"
 * is compared on. */
async function rows(db: SqlRunner, table: string, order: string): Promise<string> {
  return JSON.stringify(await db.all(`SELECT * FROM ${table} ORDER BY ${order}`));
}

function rename(id: string, stop_idx: number, name: string): EditChange {
  return {
    id,
    kind: "stop_rename",
    label: `Rename to ${name}`,
    touches: [{ table: "stops", where: `stop_idx = ${stop_idx}` }],
    sql: [`UPDATE stops SET name = '${name}' WHERE stop_idx = ${stop_idx}`],
    gtfs: [{ role: "stops", op: "update", key: { stop_id: "S2" }, values: { stop_name: name } }],
  };
}

/** A trip and its stop times gone: a change touching two tables. */
const deleteT1: EditChange = {
  id: "d1",
  kind: "trip_delete",
  label: "Delete T1",
  touches: [
    { table: "stop_times", where: "trip_idx = (SELECT trip_idx FROM trips WHERE trip_id = 'T1')" },
    { table: "trips", where: "trip_id = 'T1'" },
  ],
  sql: [
    "DELETE FROM stop_times WHERE trip_idx = (SELECT trip_idx FROM trips WHERE trip_id = 'T1')",
    "DELETE FROM trips WHERE trip_id = 'T1'",
  ],
  gtfs: [{ role: "trips", op: "delete", key: { trip_id: "T1" } }],
};

describe("an editing session", () => {
  let db: SqlRunner;
  let session: EditSession;
  beforeEach(async () => {
    db = await openFixtureDb();
    session = new EditSession(db);
  });

  it("applies a change, and undo puts back exactly the rows it found", async () => {
    const stops = await rows(db, "stops", "stop_idx");
    const before = { stops, times: await rows(db, "stop_times", "trip_idx, stop_sequence") };
    await session.apply(rename("c1", 2, "Second Street"));
    await session.apply(deleteT1);
    expect((await db.all<{ name: string }>("SELECT name FROM stops WHERE stop_idx = 2"))[0].name).toBe(
      "Second Street"
    );
    expect(await db.all("SELECT * FROM trips WHERE trip_id = 'T1'")).toEqual([]);

    await session.undo();
    await session.undo();
    expect(await rows(db, "stops", "stop_idx")).toBe(before.stops);
    expect(await rows(db, "stop_times", "trip_idx, stop_sequence")).toBe(before.times);
    expect(session.changes).toEqual([]);
    expect(session.canRedo).toBe(true);
  });

  it("redoes what was undone, and a new change forgets it", async () => {
    await session.apply(rename("c1", 2, "Second Street"));
    const after = await rows(db, "stops", "stop_idx");
    await session.undo();
    await session.redo();
    expect(await rows(db, "stops", "stop_idx")).toBe(after);
    await session.undo();
    await session.apply(rename("c2", 3, "Third Street"));
    expect(session.canRedo).toBe(false);
    expect(session.changes.map((c) => c.id)).toEqual(["c2"]);
  });

  it("applies all of a change or none of it", async () => {
    const before = await rows(db, "stops", "stop_idx");
    const broken: EditChange = {
      ...rename("c1", 2, "Second Street"),
      sql: ["UPDATE stops SET name = 'Half done' WHERE stop_idx = 2", "UPDATE no_such_table SET x = 1"],
    };
    await expect(session.apply(broken)).rejects.toThrow();
    expect(await rows(db, "stops", "stop_idx")).toBe(before);
    expect(session.changes).toEqual([]);
  });

  it("composes the bundle rows of every applied change, in order", async () => {
    await session.apply(rename("c1", 2, "Second Street"));
    await session.apply(deleteT1);
    expect(session.changeset()).toEqual([...rename("c1", 2, "Second Street").gtfs, ...deleteT1.gtfs]);
    await session.undo();
    expect(session.changeset()).toEqual(rename("c1", 2, "Second Street").gtfs);
  });

  it("moves its edition on and forgets what the panels asked", async () => {
    const seen: number[] = [];
    session.subscribe(() => seen.push(session.edition));
    let asked = 0;
    const ask = () => remembered(db, "network-test", async () => ++asked);
    await ask();
    await session.apply(rename("c1", 2, "Second Street"));
    await ask();
    await session.undo();
    await session.redo();
    expect(seen).toEqual([1, 2, 3]);
    expect(asked).toBe(2);
  });

  it("takes one operation at a time, however fast they come", async () => {
    await session.apply(rename("c1", 2, "Second Street"));
    await session.apply(rename("c2", 3, "Third Street"));
    const before = await rows(db, "stops", "stop_idx");
    // Two undos and a redo pressed at once.
    await Promise.all([session.undo(), session.undo(), session.redo()]);
    expect(session.changes.map((c) => c.id)).toEqual(["c1"]);
    expect(before).not.toBe(await rows(db, "stops", "stop_idx"));
    expect((await db.all<{ name: string }>("SELECT name FROM stops WHERE stop_idx = 2"))[0].name).toBe(
      "Second Street"
    );
  });

  it("leaves nothing behind once cleared", async () => {
    await session.apply(rename("c1", 2, "Second Street"));
    await session.apply(deleteT1);
    await session.undo();
    await session.clear();
    expect(
      await db.all(
        "SELECT table_name FROM duckdb_tables() WHERE temporary AND starts_with(table_name, '_edit_')"
      )
    ).toEqual([]);
    expect(session.canUndo || session.canRedo).toBe(false);
  });
});
