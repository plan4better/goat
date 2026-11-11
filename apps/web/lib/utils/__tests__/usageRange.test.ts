import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import { commonT } from "@/i18n/__tests__/commonI18n";

import {
  customRange,
  presetsFor,
  rangeLabel,
  rangeSpan,
  rangeWindow,
  requestWindow,
} from "@/lib/utils/usageRange";

const balance = {
  period_start: "2026-10-31T00:00:00",
  credits_reset_at: "2026-11-30T00:00:00",
  on_trial: false,
};
const now = new Date("2026-11-21T12:00:00Z");
const t = ((key: string) => `t:${key}`) as unknown as TFunction;
const en = commonT("en");
const de = commonT("de");

describe("rangeWindow", () => {
  it("reads this period from its start, open ended", () => {
    expect(rangeWindow({ preset: "period" }, balance, now)).toEqual({
      since: "2026-10-31T00:00:00.000Z",
      until: undefined,
      perMonth: false,
    });
  });

  it("ends the last period where this one starts", () => {
    expect(rangeWindow({ preset: "last" }, balance, now)).toEqual({
      since: "2026-09-30T00:00:00.000Z",
      until: "2026-10-31T00:00:00.000Z",
      perMonth: false,
    });
  });

  it("keeps the time of day a period starts at, as the balance counts from it", () => {
    const started = { ...balance, period_start: "2026-10-31T14:30:00" };
    expect(rangeWindow({ preset: "period" }, started, now).since).toBe("2026-10-31T14:30:00.000Z");
    expect(rangeWindow({ preset: "last" }, started, now)).toEqual({
      since: "2026-09-30T14:30:00.000Z",
      until: "2026-10-31T14:30:00.000Z",
      perMonth: false,
    });
  });

  it("reads the whole ledger per month when no period is known", () => {
    const none = { ...balance, period_start: null };
    expect(rangeWindow({ preset: "period" }, none, now)).toEqual({
      since: undefined,
      until: undefined,
      perMonth: true,
    });
    expect(rangeWindow({ preset: "last" }, none, now)).toEqual({
      since: undefined,
      until: undefined,
      perMonth: true,
    });
  });

  it("counts the last 7 days up to and with today", () => {
    expect(rangeWindow({ preset: "d7" }, balance, now)).toEqual({
      since: "2026-11-15T00:00:00.000Z",
      until: "2026-11-22T00:00:00.000Z",
      perMonth: false,
    });
  });

  it("counts the last 30 days across a month end", () => {
    expect(rangeWindow({ preset: "d30" }, balance, now)).toEqual({
      since: "2026-10-23T00:00:00.000Z",
      until: "2026-11-22T00:00:00.000Z",
      perMonth: false,
    });
  });

  it("includes the custom To day and swaps a reversed range", () => {
    expect(rangeWindow({ preset: "custom", from: "2026-11-14", to: "2026-11-03" }, balance, now)).toEqual({
      since: "2026-11-03T00:00:00.000Z",
      until: "2026-11-15T00:00:00.000Z",
      perMonth: false,
    });
  });

  it("ends a custom range that runs to today after today", () => {
    expect(rangeWindow({ preset: "custom", from: "2026-11-01", to: "2026-11-21" }, balance, now)).toEqual({
      since: "2026-11-01T00:00:00.000Z",
      until: "2026-11-22T00:00:00.000Z",
      perMonth: false,
    });
  });

  it("leaves a custom bound open while its date is not set", () => {
    expect(rangeWindow({ preset: "custom", from: "2026-11-03" }, balance, now)).toEqual({
      since: "2026-11-03T00:00:00.000Z",
      until: undefined,
      perMonth: false,
    });
    // Without a first day the window has no start: per month, as the whole ledger.
    expect(rangeWindow({ preset: "custom", from: "", to: "not a day" }, balance, now)).toEqual({
      since: undefined,
      until: undefined,
      perMonth: true,
    });
  });

  it("keeps a custom range between 2020 and today", () => {
    // A year typed short ("0226") and one typed long ("2062").
    expect(rangeWindow({ preset: "custom", from: "0226-01-01", to: "2062-05-01" }, balance, now)).toEqual({
      since: "2020-01-01T00:00:00.000Z",
      until: "2026-11-22T00:00:00.000Z",
      perMonth: true,
    });
    // A range wholly before 2020 or wholly after today reads no day at all.
    expect(rangeWindow({ preset: "custom", from: "2019-03-01", to: "2019-03-31" }, balance, now)).toEqual({
      since: "2020-01-01T00:00:00.000Z",
      until: "2020-01-01T00:00:00.000Z",
      perMonth: false,
    });
    expect(rangeWindow({ preset: "custom", from: "2027-01-01", to: "2027-01-31" }, balance, now)).toEqual({
      since: "2026-11-22T00:00:00.000Z",
      until: "2026-11-22T00:00:00.000Z",
      perMonth: false,
    });
  });

  it("goes per month for a window of more than 400 days", () => {
    // 18 Oct 2025 up to and with 21 Nov 2026: 400 days.
    expect(
      rangeWindow({ preset: "custom", from: "2025-10-18", to: "2026-11-21" }, balance, now).perMonth
    ).toBe(false);
    expect(rangeWindow({ preset: "custom", from: "2025-10-17", to: "2026-11-21" }, balance, now)).toEqual({
      since: "2025-10-17T00:00:00.000Z",
      until: "2026-11-22T00:00:00.000Z",
      perMonth: true,
    });
    // An open window counts up to today.
    expect(rangeWindow({ preset: "custom", from: "2025-10-17" }, balance, now).perMonth).toBe(true);
  });

  it("goes per month over the last 12 months", () => {
    expect(rangeWindow({ preset: "m12" }, balance, now)).toEqual({
      since: "2025-12-01T00:00:00.000Z",
      until: undefined,
      perMonth: true,
    });
  });

  it("takes today as the UTC day, late in the evening west of UTC", () => {
    // 21 Nov, 23:30 UTC: the ledger's day is still the 21st.
    const late = new Date("2026-11-21T23:30:00Z");
    expect(rangeWindow({ preset: "d7" }, balance, late).until).toBe("2026-11-22T00:00:00.000Z");
    expect(rangeWindow({ preset: "m12" }, balance, new Date("2026-01-15T12:00:00Z")).since).toBe(
      "2025-02-01T00:00:00.000Z"
    );
  });
});

describe("requestWindow", () => {
  it("sends no bounds for this period: core counts from the period start the balance reports", () => {
    expect(requestWindow({ preset: "period" }, balance, now)).toEqual({});
    expect(requestWindow({ preset: "period" }, undefined, now)).toEqual({});
  });

  it("needs the balance for the last period only", () => {
    expect(requestWindow({ preset: "last" }, undefined, now)).toBeNull();
    expect(requestWindow({ preset: "last" }, balance, now)).toEqual({
      since: "2026-09-30T00:00:00.000Z",
      until: "2026-10-31T00:00:00.000Z",
    });
    expect(requestWindow({ preset: "d7" }, undefined, now)).toEqual({
      since: "2026-11-15T00:00:00.000Z",
      until: "2026-11-22T00:00:00.000Z",
    });
  });
});

describe("customRange", () => {
  it("keeps the typed days between 2020 and today, in order", () => {
    expect(customRange("2026-11-03", "2026-11-14", now)).toEqual({
      preset: "custom",
      from: "2026-11-03",
      to: "2026-11-14",
    });
    expect(customRange("2026-11-14", "2026-11-03", now)).toEqual({
      preset: "custom",
      from: "2026-11-03",
      to: "2026-11-14",
    });
    // A year typed short ("0226") and one typed long ("20262").
    expect(customRange("0226-01-01", "20262-05-01", now)).toEqual({
      preset: "custom",
      from: "2020-01-01",
      to: "2026-11-21",
    });
  });

  it("turns a range wholly after today or before 2020 into one day that reads", () => {
    const future = customRange("2027-01-01", "2027-01-31", now);
    expect(future).toEqual({ preset: "custom", from: "2026-11-21", to: "2026-11-21" });
    expect(rangeWindow(future, balance, now)).toEqual({
      since: "2026-11-21T00:00:00.000Z",
      until: "2026-11-22T00:00:00.000Z",
      perMonth: false,
    });
    expect(customRange("2019-03-31", "2019-03-01", now)).toEqual({
      preset: "custom",
      from: "2020-01-01",
      to: "2020-01-01",
    });
  });

  it("ends on today's UTC day, late in the evening west of UTC", () => {
    expect(customRange("2026-11-20", "2026-11-23", new Date("2026-11-21T23:30:00Z")).to).toBe("2026-11-21");
  });
});

describe("rangeSpan", () => {
  it("writes the days a range covers, up to today while it is open", () => {
    expect(rangeSpan({ preset: "d7" }, balance, en, "en", now)).toBe("15 to 21 Nov 2026");
    expect(rangeSpan({ preset: "d30" }, balance, de, "de", now)).toBe("23. Okt. bis 21. Nov. 2026");
    expect(rangeSpan({ preset: "m12" }, balance, en, "en", now)).toBe("1 Dec 2025 to 21 Nov 2026");
    expect(rangeSpan({ preset: "period" }, balance, en, "en", now)).toBe("31 Oct to 21 Nov 2026");
    // ICU writes September "Sep" or "Sept" in British English, by version.
    expect(rangeSpan({ preset: "last" }, balance, en, "en", now)).toMatch(/^30 Sept? to 30 Oct 2026$/);
  });

  it("has nothing to write for a period while none is known", () => {
    const unknown = { ...balance, period_start: null };
    expect(rangeSpan({ preset: "period" }, unknown, en, "en", now)).toBeNull();
    expect(rangeSpan({ preset: "last" }, unknown, en, "en", now)).toBeNull();
  });
});

describe("presetsFor", () => {
  it("offers a trial only its whole trial and the last 7 days", () => {
    expect(presetsFor(true)).toEqual(["period", "d7"]);
  });

  it("offers a subscription every preset", () => {
    expect(presetsFor(false)).toEqual(["period", "last", "d7", "d30", "m12"]);
  });
});

describe("rangeLabel", () => {
  it("names the presets, the period of a trial as the whole trial", () => {
    expect(rangeLabel({ preset: "period" }, t, "en", false)).toBe("t:usage_range_period");
    expect(rangeLabel({ preset: "period" }, t, "en", true)).toBe("t:usage_range_trial");
    expect(rangeLabel({ preset: "last" }, t, "en", false)).toBe("t:usage_range_last");
    expect(rangeLabel({ preset: "d7" }, t, "en", false)).toBe("t:usage_range_d7");
    expect(rangeLabel({ preset: "d30" }, t, "en", false)).toBe("t:usage_range_d30");
    expect(rangeLabel({ preset: "m12" }, t, "en", false)).toBe("t:usage_range_m12");
  });

  it("shows a custom range as its days, in order, day first, without a dash", () => {
    const range = { preset: "custom" as const, from: "2026-11-14", to: "2026-11-03" };
    expect(rangeLabel(range, en, "en", false)).toBe("3 to 14 Nov 2026");
    expect(rangeLabel(range, de, "de", false)).toBe("3. bis 14. Nov. 2026");
    expect(rangeLabel({ preset: "custom", from: "2026-11-03", to: "2026-11-03" }, en, "en", false)).toBe(
      "3 Nov 2026"
    );
  });

  it("names the month of the first day only where it differs, the year only where it differs", () => {
    const sameYear = { preset: "custom" as const, from: "2026-10-03", to: "2026-11-14" };
    expect(rangeLabel(sameYear, en, "en", false)).toBe("3 Oct to 14 Nov 2026");
    expect(rangeLabel(sameYear, de, "de", false)).toBe("3. Okt. bis 14. Nov. 2026");
    const acrossYears = { preset: "custom" as const, from: "2025-12-20", to: "2026-11-14" };
    expect(rangeLabel(acrossYears, en, "en", false)).toBe("20 Dec 2025 to 14 Nov 2026");
    expect(rangeLabel(acrossYears, de, "de", false)).toBe("20. Dez. 2025 bis 14. Nov. 2026");
  });

  it("reads the days on the UTC calendar on any clock", () => {
    // The first of a month is still the first west of UTC.
    const range = { preset: "custom" as const, from: "2026-11-01", to: "2026-11-30" };
    expect(rangeLabel(range, en, "en", false)).toBe("1 to 30 Nov 2026");
  });

  it("names a custom range without both days by the preset", () => {
    expect(rangeLabel({ preset: "custom", from: "2026-11-03" }, t, "en", false)).toBe("t:usage_range_custom");
  });
});
