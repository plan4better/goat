import type { TFunction } from "i18next";

import { hostedPlace } from "@/lib/assistant/aiCredits";
import { type AssistantSettings, providerName } from "@/lib/validations/assistant";

/**
 * GOAT AI as admins see it on the AI settings page: its model, provider and
 * where it is hosted ("eu.anthropic.claude-sonnet-4-5 · Amazon Bedrock · hosted
 * in the EU"), from the assistant's settings; answers only ever say "GOAT AI".
 * Parts the instance does not name are left out; null without a model.
 */
export function goatAiDescription(
  goatAi: AssistantSettings["instance"]["goat_ai"],
  t: TFunction
): string | null {
  if (!goatAi.available || !goatAi.model) return null;
  const parts = [goatAi.model];
  if (goatAi.provider) parts.push(providerName(goatAi.provider, t("ai_settings_provider_openai_compatible")));
  if (goatAi.hosted_in?.trim())
    parts.push(t("ai_settings_goat_ai_hosted_in", { place: hostedPlace(goatAi.hosted_in, t) }));
  return parts.join(" · ");
}
