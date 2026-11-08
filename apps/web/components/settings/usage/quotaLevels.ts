import type { Theme } from "@mui/material";

import type { CreditBalance } from "@/lib/api/usage";
import { type AiCreditsLevel, aiCreditsLevelColors } from "@/lib/utils/credits";

export type QuotaKey = "credits" | "ai" | "storage" | "projects" | "editors";

export const QUOTA_KEYS: QuotaKey[] = ["credits", "ai", "storage", "projects", "editors"];

/** Within the limit, at 90 % of it or more, or over it. */
export type QuotaLevel = "ok" | "full" | "over";

/** What a quota uses and its limit; null: no limit. */
export const amountsOf = (balance: CreditBalance): Record<QuotaKey, [number, number | null]> => ({
  credits: [balance.used_credits, balance.total_credits],
  ai: [balance.used_ai_credits, balance.total_ai_credits],
  storage: [balance.used_storage, balance.total_storage],
  projects: [balance.used_projects, balance.total_projects],
  editors: [balance.used_editors, balance.total_editors],
});

/** Exactly at the limit is full, not over: every seat taken is not one too many. */
export const levelOf = (used: number, limit: number | null): QuotaLevel => {
  if (limit === null) return "ok";
  // A pool of nothing that nothing used (AI switched off by the deal) needs
  // no attention; any use of it is over.
  if (limit <= 0 && used <= 0) return "ok";
  if (used > limit) return "over";
  return used >= limit * 0.9 ? "full" : "ok";
};

/** A tile's level in the credit levels' colours: green, orange, red. */
export const LEVEL_COLORS: Record<QuotaLevel, AiCreditsLevel> = { ok: "ok", full: "low", over: "empty" };

export const levelColors = (theme: Theme, level: QuotaLevel) => {
  const { bar, text } = aiCreditsLevelColors(theme, LEVEL_COLORS[level]);
  return {
    bar,
    text: level === "ok" ? theme.palette.text.primary : text,
    note: level === "ok" ? undefined : text,
  };
};

/** A quota over its limit or at 90 % or more: the dot of its tile, and of Nutzung in the settings nav. */
export const quotaNeedsAttention = (balance: CreditBalance | undefined): boolean => {
  if (!balance) return false;
  const amounts = amountsOf(balance);
  return QUOTA_KEYS.some((key) => levelOf(...amounts[key]) !== "ok");
};
