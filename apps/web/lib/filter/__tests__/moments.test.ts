import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { inputMoment, momentText, storedMoment } from "@/lib/filter/moments";

// A date and time is picked in the browser's zone; Berlin is an hour ahead of UTC in winter and two in summer.
beforeAll(() => {
  vi.stubEnv("TZ", "Europe/Berlin");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

describe("a picked date and time", () => {
  it("is stored as the instant it names in the browser's zone", () => {
    expect(storedMoment("2026-11-16T10:00")).toBe("2026-11-16T09:00:00Z");
    expect(storedMoment("2026-07-01T10:00")).toBe("2026-07-01T08:00:00Z");
    expect(storedMoment("2026-11-16T10:00:30")).toBe("2026-11-16T09:00:30Z");
  });

  it("stores the browser's midnight as that instant, not as the day", () => {
    expect(storedMoment("2026-11-16T00:00")).toBe("2026-11-15T23:00:00Z");
  });

  it("stores nothing for a text that is no date and time", () => {
    expect(storedMoment("")).toBeUndefined();
    expect(storedMoment("soon")).toBeUndefined();
    expect(storedMoment("2026-13-40T10:00")).toBeUndefined();
  });
});

describe("a stored instant", () => {
  it("shows in the box in the browser's zone", () => {
    expect(inputMoment("2026-11-16T09:00:00Z")).toBe("2026-11-16T10:00");
    expect(inputMoment("2026-07-01T08:00:00Z")).toBe("2026-07-01T10:00");
    expect(inputMoment("2026-11-16T09:00:00+00:00")).toBe("2026-11-16T10:00");
  });

  it("shows a day (the start of the day in UTC) as that instant", () => {
    expect(inputMoment("2026-11-16")).toBe("2026-11-16T01:00");
  });

  it("reads a time saved without its zone as UTC, as the services do", () => {
    expect(inputMoment("2026-11-16T09:00:00")).toBe("2026-11-16T10:00");
  });

  it("round trips through the box", () => {
    for (const stored of ["2026-11-16T09:00:00Z", "2026-03-29T00:30:00Z", "2026-10-25T03:30:00Z"])
      expect(storedMoment(inputMoment(stored))).toBe(stored);
  });

  it("reads in a sentence in the browser's zone", () => {
    expect(momentText("2026-11-16T09:00:00Z")).toBe("2026-11-16 10:00");
    expect(momentText("2026-11-16T09:00:30Z")).toBe("2026-11-16 10:00:30");
    // A day, text and numbers stay as they are.
    expect(momentText("2026-11-16")).toBe("2026-11-16");
    expect(momentText("open")).toBe("open");
    expect(momentText(5)).toBe("5");
  });
});
