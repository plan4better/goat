import type { TFunction } from "i18next";

import { hostedPlace } from "@/lib/assistant/aiCredits";
import { type AssistantSettings } from "@/lib/validations/assistant";

/**
 * GOAT AI as admins see it on the AI settings page: where it is hosted
 * ("Hosted in the EU"), from the assistant's settings. Its model and provider
 * are the operator's to choose and change, so they are not shown; an
 * organization's own connections show theirs. Null when the instance names no
 * hosting place.
 */
export function goatAiDescription(
  goatAi: AssistantSettings["instance"]["goat_ai"],
  t: TFunction
): string | null {
  if (!goatAi.available || !goatAi.hosted_in?.trim()) return null;
  return t("ai_settings_goat_ai_hosted_in", { place: hostedPlace(goatAi.hosted_in, t) });
}
