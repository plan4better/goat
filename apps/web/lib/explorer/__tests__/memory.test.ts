// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";

import { openFixtureDb } from "@/lib/explorer/__tests__/fixtureDb";
import type { SqlRunner } from "@/lib/explorer/db/types";
import { checkMemory, judge, parseBytes } from "@/lib/explorer/memory";

let db: SqlRunner;
beforeAll(async () => {
  db = await openFixtureDb();
});

const GB = 1e9;

describe("playback's memory check", () => {
  it("reads what DuckDB reports about its memory", async () => {
    const [row] = await db.all<{ used: unknown; limit: string }>(
      "SELECT (SELECT sum(memory_usage_bytes) FROM duckdb_memory()) AS used, current_setting('memory_limit') AS limit"
    );
    expect(parseBytes(row.limit)).toBeGreaterThan(0);
    expect(await checkMemory(db)).toEqual({ ok: true });
  });

  it("refuses playback where the database, the page or the device is short", () => {
    const room = { dbUsed: 1 * GB, dbLimit: 2.5 * GB, heapUsed: 1 * GB, heapLimit: 4 * GB, deviceGb: 8 };
    expect(judge(room)).toEqual({ ok: true });
    expect(judge({ ...room, dbUsed: 1.6 * GB })).toMatchObject({ ok: false, reason: "database" });
    expect(judge({ ...room, heapUsed: 3 * GB })).toMatchObject({ ok: false, reason: "page" });
    expect(judge({ ...room, deviceGb: 2 })).toMatchObject({ ok: false, reason: "device" });
    // What a browser does not report is not held against it.
    expect(judge({ dbUsed: null, dbLimit: null, heapUsed: null, heapLimit: null, deviceGb: null })).toEqual({
      ok: true,
    });
  });

  it("reads byte sizes as DuckDB writes them", () => {
    expect(parseBytes("2.5 GiB")).toBe(2.5 * 1024 ** 3);
    expect(parseBytes("2560MB")).toBe(2560e6);
    expect(parseBytes("1.0 GB")).toBe(1e9);
    expect(parseBytes("lots")).toBeNull();
  });
});
