import { describe, expect, it } from "vitest";

import { commonT } from "@/i18n/__tests__/commonI18n";

import {
  OutOfCreditsError,
  aiCreditTiersText,
  aiCreditsLevel,
  aiCreditsText,
  creditsErrorMessage,
  formatCredits,
  formatCreditsDay,
  formatMegabytes,
  formatRate,
  isOutOfCreditsError,
  parseApiDate,
  roundCredits,
  toolTitle,
} from "@/lib/utils/credits";

const t = (key: string) => `t:${key}`;

describe("formatCredits", () => {
  it("shows one decimal below 10 and whole numbers from there", () => {
    expect(formatCredits(0.4, "en")).toBe("0.4");
    expect(formatCredits(2.5, "en")).toBe("2.5");
    expect(formatCredits(2, "en")).toBe("2");
    expect(formatCredits(9.96, "en")).toBe("10");
    expect(formatCredits(10.4, "en")).toBe("10");
    expect(formatCredits(3030.4, "en")).toBe("3,030");
    expect(formatCredits(null, "en")).toBe("0");
  });

  it("follows the locale", () => {
    expect(formatCredits(2.5, "de")).toBe("2,5");
    expect(formatCredits(3030.4, "de")).toBe("3.030");
  });
});

describe("formatMegabytes", () => {
  it("writes MB below a GB and GB from there, one decimal at most", () => {
    expect(formatMegabytes(512, "en")).toBe("512 MB");
    expect(formatMegabytes(59187, "en")).toBe("57.8 GB");
    expect(formatMegabytes(51200, "de")).toBe("50 GB");
    expect(formatMegabytes(1536, "de")).toBe("1,5 GB");
  });
});

describe("formatRate", () => {
  it("does not round prices", () => {
    expect(formatRate(0.5, "en")).toBe("0.5");
    expect(formatRate(0.25, "en")).toBe("0.25");
    expect(formatRate(20, "en")).toBe("20");
    expect(formatRate(0.5, "de")).toBe("0,5");
  });
});

describe("out of credits", () => {
  it("recognises the typed error and any 402", () => {
    expect(isOutOfCreditsError(new OutOfCreditsError())).toBe(true);
    expect(isOutOfCreditsError(Object.assign(new Error("x"), { status: 402 }))).toBe(true);
    expect(isOutOfCreditsError(Object.assign(new Error("x"), { status: 500 }))).toBe(false);
    expect(isOutOfCreditsError(new Error("x"))).toBe(false);
    expect(isOutOfCreditsError(null)).toBe(false);
  });

  it("maps a 402 to the translated message and leaves other errors alone", () => {
    expect(creditsErrorMessage(new OutOfCreditsError(), t)).toBe("t:out_of_credits_tool");
    expect(creditsErrorMessage(Object.assign(new Error("Failed"), { status: 402 }), t)).toBe(
      "t:out_of_credits_tool"
    );
    expect(creditsErrorMessage(new Error("boom"), t)).toBeNull();
    expect(creditsErrorMessage(new Error("boom"), t, "fallback")).toBe("fallback");
  });
});

describe("parseApiDate", () => {
  it("reads a naive datetime as UTC", () => {
    expect(parseApiDate("2026-07-01T10:00:00").toISOString()).toBe("2026-07-01T10:00:00.000Z");
    expect(parseApiDate("2026-07-01 10:00:00.250").toISOString()).toBe("2026-07-01T10:00:00.250Z");
  });

  it("keeps an explicit zone or offset", () => {
    expect(parseApiDate("2026-07-01T10:00:00Z").toISOString()).toBe("2026-07-01T10:00:00.000Z");
    expect(parseApiDate("2026-07-01T12:00:00+02:00").toISOString()).toBe("2026-07-01T10:00:00.000Z");
    expect(parseApiDate("2026-07-01T05:00:00-05:00").toISOString()).toBe("2026-07-01T10:00:00.000Z");
  });
});

describe("roundCredits", () => {
  it("rounds as formatCredits shows: one decimal below 10, whole numbers from there", () => {
    expect(roundCredits(2.54)).toBe(2.5);
    expect(roundCredits(9.96)).toBe(10);
    expect(roundCredits(3030.4)).toBe(3030);
    expect(roundCredits(null)).toBe(0);
  });
});

describe("aiCreditsText", () => {
  it("gives the AI credits text of the reader's language", () => {
    expect(aiCreditsText(412, commonT("en"), "en")).toBe("412 AI credits");
    expect(aiCreditsText(1, commonT("en"), "en")).toBe("1 AI credit");
    // The plural follows the figure shown: 1.04 reads "1".
    expect(aiCreditsText(1.04, commonT("en"), "en")).toBe("1 AI credit");
    expect(aiCreditsText(1000, commonT("de"), "de")).toBe("1.000 KI-Credits");
    expect(aiCreditsText(null, commonT("en"), "en")).toBe("0 AI credits");
  });
});

describe("aiCreditsLevel", () => {
  it("is unlimited without an allowance", () => {
    expect(aiCreditsLevel(0, null)).toBe("unlimited");
    expect(aiCreditsLevel(5000, null)).toBe("unlimited");
  });

  it("is low under 10 % left and empty when nothing is left", () => {
    expect(aiCreditsLevel(412, 1000)).toBe("ok");
    expect(aiCreditsLevel(900, 1000)).toBe("ok");
    expect(aiCreditsLevel(901, 1000)).toBe("low");
    expect(aiCreditsLevel(1000, 1000)).toBe("empty");
    expect(aiCreditsLevel(1003, 1000)).toBe("empty");
    expect(aiCreditsLevel(0, 0)).toBe("empty");
  });
});

describe("aiCreditTiersText", () => {
  const DEFAULT_TIERS = [
    { max_steps: 10, credits: 1 },
    { max_steps: 20, credits: 2 },
    { max_steps: null, credits: 3 },
  ];

  it("states the tiers in force in English and German", () => {
    expect(aiCreditTiersText(DEFAULT_TIERS, commonT("en"), "en")).toBe(
      "1 AI credit up to 10 steps, 2 up to 20 steps, 3 above"
    );
    expect(aiCreditTiersText(DEFAULT_TIERS, commonT("de"), "de")).toBe(
      "1 KI-Credit bis zu 10 Schritten, 2 bis zu 20 Schritten, 3 darüber"
    );
  });

  it("follows whatever tiers core sends, never a fixed three", () => {
    const t = commonT("en");
    expect(
      aiCreditTiersText(
        [
          { max_steps: 5, credits: 1 },
          { max_steps: null, credits: 4 },
        ],
        t,
        "en"
      )
    ).toBe("1 AI credit up to 5 steps, 4 above");
    expect(
      aiCreditTiersText(
        [
          { max_steps: 3, credits: 0.5 },
          { max_steps: 6, credits: 1 },
          { max_steps: 9, credits: 2 },
          { max_steps: null, credits: 2.5 },
        ],
        t,
        "en"
      )
    ).toBe("0.5 AI credits up to 3 steps, 1 up to 6 steps, 2 up to 9 steps, 2.5 above");
    expect(
      aiCreditTiersText(
        [
          { max_steps: 1, credits: 2 },
          { max_steps: null, credits: 3 },
        ],
        t,
        "en"
      )
    ).toBe("2 AI credits up to 1 step, 3 above");
  });

  it("names one price when there is one tier, and nothing without tiers", () => {
    expect(aiCreditTiersText([{ max_steps: null, credits: 2 }], commonT("en"), "en")).toBe("2 AI credits");
    expect(aiCreditTiersText([{ max_steps: null, credits: 1 }], commonT("de"), "de")).toBe("1 KI-Credit");
    expect(aiCreditTiersText([], commonT("en"), "en")).toBeNull();
    expect(aiCreditTiersText(undefined, commonT("en"), "en")).toBeNull();
  });
});

describe("formatCreditsDay on the UTC calendar", () => {
  it("reads a ledger day as that day on any clock", () => {
    // A day key of the ledger is a UTC day: west of UTC its midnight is the
    // evening before, so it is read on the UTC calendar.
    expect(formatCreditsDay("2026-11-03", "en", { utc: true })).toBe("3 Nov");
    expect(formatCreditsDay("2026-11-03", "de", { utc: true, year: true })).toBe("3. Nov. 2026");
  });
});

describe("toolTitle", () => {
  const processes = [{ id: "buffer", title: "Buffer" }];
  const tr = ((key: string, options?: { defaultValue?: string }) =>
    key === "catchment_area" ? "Catchment area" : (options?.defaultValue ?? key)) as never;

  it("names a tool as the toolbox does, else by the processes' title, else by its key", () => {
    expect(toolTitle("catchment_area", processes, tr)).toBe("Catchment area");
    expect(toolTitle("buffer", processes, tr)).toBe("Buffer");
    expect(toolTitle("clip", processes, tr)).toBe("clip");
    expect(toolTitle(null, processes, tr)).toBe("unknown");
  });
});
