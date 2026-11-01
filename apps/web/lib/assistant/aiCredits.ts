import type { AiCreditTier } from "@/lib/api/usage";
import { formatRate } from "@/lib/utils/credits";

/**
 * The organization's AI credits as the dock words them. The numbers (allowance,
 * tiers, dates) come from core's balance and the assistant's refusal; nothing
 * here knows a price.
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * The counting rule in one sentence, from the tiers core sends: "An answer
 * costs 1 AI credit, 2 if it takes more than 10 steps, 3 if more than 20." Each
 * tier after the first starts above the previous tier's steps. null without tiers.
 */
export function aiCreditsRuleText(
  tiers: AiCreditTier[] | null | undefined,
  t: Translate,
  locale?: string
): string | null {
  if (!tiers?.length) return null;
  const amount = (value: number) => formatRate(value, locale);
  const parts = [t("usage_ai_credits_count", { count: tiers[0].credits, credits: amount(tiers[0].credits) })];
  tiers.slice(1).forEach((tier, index) => {
    // Only the last tier is open-ended, so every earlier one has its steps.
    const above = tiers[index].max_steps;
    if (above === null) return;
    const credits = amount(tier.credits);
    parts.push(
      index === 0
        ? t("assistant_credits_rule_second", { count: above, credits, steps: amount(above) })
        : t("assistant_credits_rule_more", { credits, steps: amount(above) })
    );
  });
  return t("assistant_credits_rule", { tiers: parts.join(", ") });
}

/**
 * Where GOAT AI's model runs, as `ASSISTANT_DEFAULT_HOSTED_IN` says, ready for
 * "hosted in …": the EU takes its article ("the EU", "der EU"), any other
 * place stays as the operator wrote it.
 */
export function hostedPlace(value: string, t: Translate): string {
  const place = value.trim();
  return place.toUpperCase() === "EU" ? t("assistant_hosted_place_eu") : place;
}
