import { afterEach, describe, expect, it, vi } from "vitest";

import { commonT } from "@/i18n/__tests__/commonI18n";

import { fullTime, messageTime, relativeTime, resetArrivals, storedTime } from "@/lib/assistant/messageTimes";
import type { AssistantMessage } from "@/lib/assistant/types";

import { enTranslate } from "./enTranslate";

const de = commonT("de") as unknown as Parameters<typeof relativeTime>[2];

/** 19 October 2026, 10:08 in the zone the tests run in, as the dock reads dates. */
const NOW = new Date(2026, 9, 19, 10, 8).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("relative message times", () => {
  it("say Just now under a minute, also for a server clock a little ahead", () => {
    expect(relativeTime(NOW - 59_000, NOW, enTranslate, "en")).toBe("Just now");
    expect(relativeTime(NOW + 5_000, NOW, enTranslate, "en")).toBe("Just now");
    expect(relativeTime(NOW - 30_000, NOW, de, "de")).toBe("Gerade eben");
  });

  it("count minutes within the hour and hours within the day", () => {
    expect(relativeTime(NOW - MINUTE, NOW, enTranslate, "en")).toBe("1 minute ago");
    expect(relativeTime(NOW - 2 * MINUTE - 10_000, NOW, enTranslate, "en")).toBe("2 minutes ago");
    expect(relativeTime(NOW - 59 * MINUTE, NOW, enTranslate, "en")).toBe("59 minutes ago");
    expect(relativeTime(NOW - 3 * HOUR - 20 * MINUTE, NOW, enTranslate, "en")).toBe("3 hours ago");
    expect(relativeTime(NOW - 2 * MINUTE, NOW, de, "de")).toBe("vor 2 Minuten");
    expect(relativeTime(NOW - 3 * HOUR, NOW, de, "de")).toBe("vor 3 Stunden");
  });

  it("say Yesterday for the day before, even a few hours ago, then the date", () => {
    const yesterday = new Date(2026, 9, 18, 9, 0).getTime();
    expect(relativeTime(yesterday, NOW, enTranslate, "en")).toBe("Yesterday");
    expect(relativeTime(yesterday, NOW, de, "de")).toBe("Gestern");
    // Two hours ago, on the day before.
    const lateLastNight = new Date(2026, 9, 18, 23, 0).getTime();
    const earlyMorning = new Date(2026, 9, 19, 1, 0).getTime();
    expect(relativeTime(lateLastNight, earlyMorning, enTranslate, "en")).toBe("Yesterday");
    const older = new Date(2026, 9, 17, 18, 30).getTime();
    expect(relativeTime(older, NOW, enTranslate, "en")).toBe("17 Oct");
    expect(relativeTime(older, NOW, de, "de")).toBe("17. Okt.");
    // Another year names it.
    const lastYear = new Date(2025, 11, 30, 12, 0).getTime();
    expect(relativeTime(lastYear, NOW, enTranslate, "en")).toBe("30 Dec 2025");
    expect(relativeTime(lastYear, NOW, de, "de")).toBe("30. Dez. 2025");
  });

  it("give the full date and time in the user's language", () => {
    expect(fullTime(NOW, "en")).toBe("19 Oct 2026, 10:08");
    expect(fullTime(NOW, "de")).toBe("19. Okt. 2026, 10:08");
  });

  it("build each formatter once per language, however many times are shown", () => {
    const dates = vi.spyOn(Intl, "DateTimeFormat");
    const relatives = vi.spyOn(Intl, "RelativeTimeFormat");
    try {
      for (const language of ["en", "de", "en", "de"]) {
        fullTime(NOW, language);
        relativeTime(NOW - 2 * MINUTE, NOW, enTranslate, language);
        relativeTime(NOW - 5 * 24 * HOUR, NOW, enTranslate, language);
      }
      // Built on first use (a run before this one may have built some already), never again.
      const built = dates.mock.calls.length + relatives.mock.calls.length;
      for (const language of ["en", "de"]) {
        fullTime(NOW, language);
        relativeTime(NOW - 2 * MINUTE, NOW, enTranslate, language);
        relativeTime(NOW - 5 * 24 * HOUR, NOW, enTranslate, language);
      }
      expect(dates.mock.calls.length + relatives.mock.calls.length).toBe(built);
      expect(built).toBeLessThanOrEqual(6);
    } finally {
      dates.mockRestore();
      relatives.mockRestore();
    }
  });
});

describe("message times", () => {
  afterEach(resetArrivals);

  const message = (metadata?: AssistantMessage["metadata"]): AssistantMessage => ({
    id: "m1",
    role: "assistant",
    parts: [],
    metadata,
  });

  it("read the stored time from the metadata, in the shape the server sends it", () => {
    expect(storedTime(message({ created_at: "2026-10-19T08:08:30.123+00:00" }))).toBe(
      Date.UTC(2026, 9, 19, 8, 8, 30, 123)
    );
    expect(storedTime(message())).toBeNull();
    expect(storedTime(message({ created_at: "not a date" }))).toBeNull();
  });

  it("prefer the stored time", () => {
    const stored = message({ created_at: "2026-10-19T08:08:30.123+00:00" });
    expect(messageTime(stored, { mounted: false, running: false }, NOW)).toBe(
      Date.UTC(2026, 9, 19, 8, 8, 30, 123)
    );
  });

  it("give no time to a message shown at mount without one: when it was written is not known", () => {
    expect(messageTime(message(), { mounted: true, running: false }, NOW)).toBeNull();
  });

  it("date a message that came later when it is first shown, and keep that time", () => {
    const live = { ...message(), id: "u-live", role: "user" as const };
    expect(messageTime(live, { mounted: false, running: false }, NOW)).toBe(NOW);
    expect(messageTime(live, { mounted: true, running: false }, NOW + HOUR)).toBe(NOW);
    resetArrivals();
    expect(messageTime(live, { mounted: true, running: false }, NOW + HOUR)).toBeNull();
  });

  it("date an answer when it stops running, also one that was running when the list mounted", () => {
    const answer = { ...message(), id: "a-live" };
    expect(messageTime(answer, { mounted: false, running: true }, NOW)).toBeNull();
    expect(messageTime(answer, { mounted: false, running: false }, NOW + 3 * MINUTE)).toBe(NOW + 3 * MINUTE);
    // The dock mounted again while the answer ran: it was seen running, so it is dated when it ends.
    const remounted = { ...message(), id: "a-remount" };
    expect(messageTime(remounted, { mounted: true, running: true }, NOW)).toBeNull();
    expect(messageTime(remounted, { mounted: true, running: false }, NOW + MINUTE)).toBe(NOW + MINUTE);
  });

  it("date an answer again when it runs on after a reconnect", () => {
    // A dropped connection ends the stream, not the run: the answer looks done,
    // then runs again under the same id once the stream is resumed.
    const answer = { ...message(), id: "a-reconnect" };
    expect(messageTime(answer, { mounted: false, running: true }, NOW)).toBeNull();
    expect(messageTime(answer, { mounted: false, running: false }, NOW + MINUTE)).toBe(NOW + MINUTE);
    expect(messageTime(answer, { mounted: true, running: true }, NOW + MINUTE + 10_000)).toBeNull();
    expect(messageTime(answer, { mounted: true, running: false }, NOW + 3 * MINUTE)).toBe(NOW + 3 * MINUTE);
  });
});
