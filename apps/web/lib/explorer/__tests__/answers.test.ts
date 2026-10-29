import { describe, expect, it, vi } from "vitest";

import { PER_ITEM_KEPT, remembered } from "@/lib/explorer/answers";
import type { SqlRunner } from "@/lib/explorer/db/types";

const db = {} as SqlRunner;

describe("kept answers", () => {
  it("keep the bundle's for good, and only the latest lines' and stops'", async () => {
    const asked = vi.fn(async () => 1);
    await remembered(db, "routes", asked);
    for (let i = 0; i < PER_ITEM_KEPT + 5; i++) await remembered(db, `route-trips:${i}:2026-10-23`, asked);
    expect(asked).toHaveBeenCalledTimes(PER_ITEM_KEPT + 6);
    // The bundle's answer and the latest line's are kept; the first line's went.
    await remembered(db, "routes", asked);
    await remembered(db, `route-trips:${PER_ITEM_KEPT + 4}:2026-10-23`, asked);
    expect(asked).toHaveBeenCalledTimes(PER_ITEM_KEPT + 6);
    await remembered(db, "route-trips:0:2026-10-23", asked);
    expect(asked).toHaveBeenCalledTimes(PER_ITEM_KEPT + 7);
  });

  it("keep a line asked for again as the most recent", async () => {
    const other = {} as SqlRunner;
    const asked = vi.fn(async () => 1);
    await remembered(other, "line:0", asked);
    for (let i = 1; i < PER_ITEM_KEPT; i++) await remembered(other, `line:${i}`, asked);
    await remembered(other, "line:0", asked); // again: now the newest
    await remembered(other, `line:${PER_ITEM_KEPT}`, asked); // one too many: line:1 goes
    const calls = asked.mock.calls.length;
    await remembered(other, "line:0", asked);
    expect(asked.mock.calls.length).toBe(calls);
    await remembered(other, "line:1", asked);
    expect(asked.mock.calls.length).toBe(calls + 1);
  });
});
