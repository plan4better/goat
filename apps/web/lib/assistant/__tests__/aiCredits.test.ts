import { describe, expect, it } from "vitest";

import { commonT } from "@/i18n/__tests__/commonI18n";

import { aiCreditsRuleText, hostedPlace } from "@/lib/assistant/aiCredits";

const DEFAULT_TIERS = [
  { max_steps: 10, credits: 1 },
  { max_steps: 20, credits: 2 },
  { max_steps: null, credits: 3 },
];

describe("AI credits in the dock", () => {
  it("states the counting rule from the tiers core sends", () => {
    expect(aiCreditsRuleText(DEFAULT_TIERS, commonT("en"), "en")).toBe(
      "An answer costs 1 AI credit, 2 if it takes more than 10 steps, 3 if more than 20."
    );
    expect(aiCreditsRuleText(DEFAULT_TIERS, commonT("de"), "de")).toBe(
      "Eine Antwort kostet 1 KI-Credit, 2 bei mehr als 10 Schritten, 3 bei mehr als 20."
    );
  });

  it("follows other tiers, never the default numbers", () => {
    const tiers = [
      { max_steps: 1, credits: 0.5 },
      { max_steps: 5, credits: 2 },
      { max_steps: 8, credits: 4 },
      { max_steps: null, credits: 6 },
    ];
    expect(aiCreditsRuleText(tiers, commonT("en"), "en")).toBe(
      "An answer costs 0.5 AI credits, 2 if it takes more than 1 step, 4 if more than 5, 6 if more than 8."
    );
    expect(aiCreditsRuleText(tiers, commonT("de"), "de")).toBe(
      "Eine Antwort kostet 0,5 KI-Credits, 2 bei mehr als 1 Schritt, 4 bei mehr als 5, 6 bei mehr als 8."
    );
    // One price for every answer.
    expect(aiCreditsRuleText([{ max_steps: null, credits: 2 }], commonT("en"), "en")).toBe(
      "An answer costs 2 AI credits."
    );
    expect(aiCreditsRuleText([], commonT("en"), "en")).toBeNull();
    expect(aiCreditsRuleText(undefined, commonT("en"), "en")).toBeNull();
  });

  it("names the EU with its article and any other place as the setting says", () => {
    expect(hostedPlace("EU", commonT("en"))).toBe("the EU");
    expect(hostedPlace("eu", commonT("de"))).toBe("der EU");
    expect(hostedPlace(" Germany ", commonT("en"))).toBe("Germany");
    expect(commonT("en")("assistant_details_hosted_in", { place: hostedPlace("EU", commonT("en")) })).toBe(
      "Runs on a model hosted in the EU."
    );
    expect(commonT("de")("assistant_details_hosted_in", { place: hostedPlace("EU", commonT("de")) })).toBe(
      "Läuft auf einem Modell, das in der EU gehostet wird."
    );
  });
});
