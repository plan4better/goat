import { useEffect, useRef } from "react";

import { useAssistantStatus } from "@/lib/api/assistant";
import { type AiCreditTier, type CreditBalance, useCreditBalance } from "@/lib/api/usage";
import { useFeatures } from "@/lib/api/users";
import { setDockState, useDockState } from "@/lib/assistant/store";
import { aiCreditsLevel, aiCreditsPercent } from "@/lib/utils/credits";

/** The organization's AI-credit pool, as the ring shows it. */
export interface AiCreditsPool {
  used: number;
  total: number;
  left: number;
  percent: number;
  level: "ok" | "low" | "empty";
  /** When the pool is refilled, or the trial ends (`onTrial`), as the API sends it. */
  resetsOn: string | null;
  onTrial: boolean;
  tiers: AiCreditTier[];
}

export interface AiCredits {
  /** null where billing is off, an own connection answers, or the organization has no limit. */
  pool: AiCreditsPool | null;
  /** Answers wait for the pool: the balance says so, or the assistant refused one (402). */
  usedUp: { resetsOn: string | null; onTrial: boolean } | null;
  /** May open the Usage page (the organization's owners and admins). */
  isAdmin: boolean;
}

const dateOf = (balance: CreditBalance | undefined, onTrial: boolean): string | null =>
  (onTrial ? balance?.plan_renewal_date : balance?.credits_reset_at) ?? null;

const creditsLeft = (balance: CreditBalance): boolean =>
  balance.total_ai_credits === null || balance.used_ai_credits < balance.total_ai_credits;

/**
 * The AI credits the dock shows, from core's balance (read only where billing
 * is on and GOAT AI answers) and the assistant's status (whether GOAT AI
 * answers, whether the user is an admin; the request the dock makes anyway).
 * A refusal the assistant sent holds until a balance read after it shows
 * credits left.
 */
export function useAiCredits(): AiCredits {
  const { features } = useFeatures();
  const { status } = useAssistantStatus();
  const billing = features?.billing === true;
  const goatAi = status?.goat_ai === true;
  // Only GOAT AI's answers draw on the pool: an own connection's dock never reads it.
  const { balance } = useCreditBalance(billing && goatAi);
  const refusal = useDockState().aiCreditsUsedUp;

  // The balance at hand when the refusal came may predate it: only a newer one clears it.
  const seen = useRef(balance);
  useEffect(() => {
    if (balance === seen.current) return;
    seen.current = balance;
    if (refusal && balance && creditsLeft(balance)) setDockState({ aiCreditsUsedUp: null });
  }, [balance, refusal]);

  const total = balance?.total_ai_credits ?? null;
  let pool: AiCreditsPool | null = null;
  if (billing && goatAi && balance && total !== null) {
    const used = balance.used_ai_credits;
    const level = aiCreditsLevel(used, total);
    pool = {
      used,
      total,
      left: Math.max(0, total - used),
      percent: aiCreditsPercent(used, total),
      level: level === "unlimited" ? "ok" : level,
      resetsOn: dateOf(balance, balance.on_trial),
      onTrial: balance.on_trial,
      tiers: balance.ai_credit_tiers,
    };
  }
  // A refusal holds only while GOAT AI answers: an own connection is never refused.
  const usedUp =
    refusal && goatAi
      ? { resetsOn: refusal.resetsOn ?? dateOf(balance, refusal.onTrial), onTrial: refusal.onTrial }
      : pool?.level === "empty"
        ? { resetsOn: pool.resetsOn, onTrial: pool.onTrial }
        : null;
  return { pool, usedUp, isAdmin: status?.is_admin === true };
}
