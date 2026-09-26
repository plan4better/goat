import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { claimJobAnnouncement } from "@/lib/utils/jobAnnouncement";

// Every open tab shares one localStorage, so two claims in this test stand for
// two tabs that each saw the same job finish.

describe("claimJobAnnouncement", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("lets only the first tab announce a job", async () => {
    expect(await claimJobAnnouncement("job-1")).toBe(true);
    expect(await claimJobAnnouncement("job-1")).toBe(false);
  });

  it("keeps separate jobs independent", async () => {
    expect(await claimJobAnnouncement("job-1")).toBe(true);
    expect(await claimJobAnnouncement("job-2")).toBe(true);
  });

  it("forgets a job after a week so the marks do not pile up", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
    await claimJobAnnouncement("job-1");

    vi.setSystemTime(new Date("2026-09-09T00:00:00Z"));
    expect(await claimJobAnnouncement("job-1")).toBe(true);
  });

  it("announces when storage cannot be read, as every tab did before", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(await claimJobAnnouncement("job-1")).toBe(true);
    expect(await claimJobAnnouncement("job-1")).toBe(true);
  });

  it("recovers from a corrupt stored value", async () => {
    localStorage.setItem("goat:announced-jobs", "{not json");
    expect(await claimJobAnnouncement("job-1")).toBe(true);
    expect(await claimJobAnnouncement("job-1")).toBe(false);
  });

  it("checks and marks while holding the cross-tab lock", async () => {
    let held = false;
    const writesWhileHeld: boolean[] = [];
    vi.stubGlobal("navigator", {
      ...navigator,
      locks: {
        request: async (_name: string, callback: () => unknown) => {
          held = true;
          try {
            return await callback();
          } finally {
            held = false;
          }
        },
      },
    });
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      writesWhileHeld.push(held);
      setItem.call(this, key, value);
    });

    expect(await claimJobAnnouncement("job-1")).toBe(true);
    expect(await claimJobAnnouncement("job-1")).toBe(false);
    expect(writesWhileHeld).toEqual([true]);
  });
});
