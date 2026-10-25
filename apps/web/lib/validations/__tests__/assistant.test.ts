import { describe, expect, it } from "vitest";

import { connectionFormSchema, emptyConnectionForm, toConnectionPayload } from "@/lib/validations/assistant";

const compatible = {
  ...emptyConnectionForm("openai_compatible"),
  name: "Own vLLM",
  model: "qwen3",
  base_url: "https://llm.example.org/v1",
};

describe("connection form", () => {
  it("requires https unless the instance allows private endpoints", () => {
    const strict = connectionFormSchema({ mode: "create", allowHttp: false });
    expect(strict.safeParse(compatible).success).toBe(true);
    const http = { ...compatible, base_url: "http://ollama:11434/v1" };
    const refused = strict.safeParse(http);
    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error.issues[0]).toMatchObject({
        path: ["base_url"],
        message: "ai_settings_error_https",
      });
    }
    expect(connectionFormSchema({ mode: "create", allowHttp: true }).safeParse(http).success).toBe(true);
  });

  it("requires the provider's key when creating or switching providers, not when editing", () => {
    const openai = { ...emptyConnectionForm("openai"), name: "OpenAI", model: "gpt-4.1" };
    expect(connectionFormSchema({ mode: "create", allowHttp: false }).safeParse(openai).success).toBe(false);
    expect(
      connectionFormSchema({ mode: "edit", allowHttp: false, originalProvider: "openai" }).safeParse(openai)
        .success
    ).toBe(true);
    expect(
      connectionFormSchema({ mode: "edit", allowHttp: false, originalProvider: "anthropic" }).safeParse(
        openai
      ).success
    ).toBe(false);
  });

  it("accepts only Claude models on Bedrock and Vertex AI", () => {
    const bedrock = {
      ...emptyConnectionForm("bedrock"),
      name: "Bedrock",
      region: "eu-central-1",
      access_key_id: "AKIAEXAMPLE1234",
      secret_access_key: "secret",
    };
    const schema = connectionFormSchema({ mode: "create", allowHttp: false });
    expect(schema.safeParse({ ...bedrock, model: "eu.anthropic.claude-sonnet-4-5" }).success).toBe(true);
    expect(schema.safeParse({ ...bedrock, model: "amazon.nova-pro-v1:0" }).success).toBe(false);
    const profile = "arn:aws:bedrock:eu-central-1:123456789012:inference-profile/eu.team-profile";
    expect(schema.safeParse({ ...bedrock, model: profile }).success).toBe(true);
  });

  it("sends credentials only when one was entered while editing", () => {
    expect(toConnectionPayload({ ...compatible, api_key: "" }, "edit")).not.toHaveProperty("credentials");
    expect(toConnectionPayload({ ...compatible, api_key: " sk-new " }, "edit").credentials).toEqual({
      api_key: "sk-new",
    });
    expect(toConnectionPayload(compatible, "create").credentials).toEqual({});
  });

  it("names one model: the one that answers also writes the titles", () => {
    expect(toConnectionPayload(compatible, "create")).not.toHaveProperty("background_model");
    expect(Object.keys(emptyConnectionForm("openai_compatible"))).not.toContain("background_model");
  });

  it("sends a provider order only for OpenRouter, as a list", () => {
    const openrouter = { ...compatible, base_url: "https://openrouter.ai/api/v1" };
    const payload = toConnectionPayload(
      { ...openrouter, provider_order: " DeepInfra, ,Together ", allow_fallbacks: false },
      "create"
    );
    expect(payload).toMatchObject({ provider_order: ["DeepInfra", "Together"], allow_fallbacks: false });
    const schema = connectionFormSchema({ mode: "create", allowHttp: false });
    expect(schema.safeParse({ ...openrouter, provider_order: "DeepInfra" }).success).toBe(true);
    const elsewhere = schema.safeParse({ ...compatible, provider_order: "DeepInfra" });
    expect(elsewhere.success).toBe(false);
    expect(elsewhere.error?.issues[0]).toMatchObject({
      path: ["provider_order"],
      message: "ai_settings_error_openrouter_only",
    });
    expect(toConnectionPayload({ ...compatible, provider_order: "" }, "create").provider_order).toEqual([]);
  });

  it("drops fields the provider does not take", () => {
    const payload = toConnectionPayload(
      { ...compatible, provider: "openai", region: "eu-central-1", api_key: "sk-org", access_key_id: "x" },
      "create"
    );
    expect(payload).toMatchObject({ base_url: null, region: null, credentials: { api_key: "sk-org" } });
  });
});
