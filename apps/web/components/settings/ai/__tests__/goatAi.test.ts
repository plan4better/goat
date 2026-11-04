import { describe, expect, it } from "vitest";

import { commonT } from "@/i18n/__tests__/commonI18n";

import { goatAiDescription } from "@/components/settings/ai/goatAi";

const GOAT_AI = {
  available: true,
  provider: "bedrock",
  model: "eu.anthropic.claude-sonnet-4-5",
  hosted_in: "EU",
};

describe("goatAiDescription", () => {
  it("says where GOAT AI is hosted, not its model or provider", () => {
    expect(goatAiDescription(GOAT_AI, commonT("en"))).toBe("Hosted in the EU");
    expect(goatAiDescription(GOAT_AI, commonT("de"))).toBe("Gehostet in der EU");
    expect(goatAiDescription({ ...GOAT_AI, hosted_in: "Germany" }, commonT("en"))).toBe("Hosted in Germany");
    expect(goatAiDescription({ ...GOAT_AI, model: null, provider: null }, commonT("en"))).toBe(
      "Hosted in the EU"
    );
  });

  it("says nothing when the instance names no hosting place", () => {
    expect(goatAiDescription({ ...GOAT_AI, hosted_in: null }, commonT("en"))).toBeNull();
    expect(goatAiDescription({ ...GOAT_AI, hosted_in: " " }, commonT("en"))).toBeNull();
    // An instance before the setting existed sends no hosting place at all.
    const { hosted_in: _, ...older } = GOAT_AI;
    expect(goatAiDescription(older, commonT("en"))).toBeNull();
    expect(goatAiDescription({ ...GOAT_AI, available: false }, commonT("en"))).toBeNull();
  });
});
