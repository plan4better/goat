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
  it("names GOAT AI's model, provider and where it is hosted", () => {
    expect(goatAiDescription(GOAT_AI, commonT("en"))).toBe(
      "eu.anthropic.claude-sonnet-4-5 · Amazon Bedrock · hosted in the EU"
    );
    expect(goatAiDescription(GOAT_AI, commonT("de"))).toBe(
      "eu.anthropic.claude-sonnet-4-5 · Amazon Bedrock · gehostet in der EU"
    );
  });

  it("leaves out what the instance does not say", () => {
    expect(goatAiDescription({ ...GOAT_AI, hosted_in: null }, commonT("en"))).toBe(
      "eu.anthropic.claude-sonnet-4-5 · Amazon Bedrock"
    );
    // An instance before the setting existed sends no hosting place at all.
    const { hosted_in: _, ...older } = GOAT_AI;
    expect(goatAiDescription(older, commonT("en"))).toBe("eu.anthropic.claude-sonnet-4-5 · Amazon Bedrock");
    expect(goatAiDescription({ ...GOAT_AI, provider: null }, commonT("en"))).toBe(
      "eu.anthropic.claude-sonnet-4-5 · hosted in the EU"
    );
    expect(
      goatAiDescription({ ...GOAT_AI, provider: "openai_compatible", hosted_in: "Germany" }, commonT("en"))
    ).toBe("eu.anthropic.claude-sonnet-4-5 · OpenAI-compatible endpoint · hosted in Germany");
    // An id the web does not know (the test model) stays as it is.
    expect(goatAiDescription({ ...GOAT_AI, provider: "test", hosted_in: null }, commonT("en"))).toBe(
      "eu.anthropic.claude-sonnet-4-5 · test"
    );
    expect(goatAiDescription({ ...GOAT_AI, model: null }, commonT("en"))).toBeNull();
    expect(goatAiDescription({ ...GOAT_AI, available: false }, commonT("en"))).toBeNull();
  });
});
