import { parseApiDate } from "@/lib/utils/credits";

/** Core sends an invitation's mail at most once in this time (B6, `RESEND_AFTER`). */
export const RESEND_AFTER_MS = 10 * 60 * 1000;

/** Whether an invitation can be sent again at `now`, and from when: 10 minutes
 * after its last send (`last_sent_at`, naive UTC; core counts from the
 * invitation's creation when it has none). Without a date, or with one that
 * does not parse: at once, and core's 429 says if it was too soon. */
export const resendState = (
  lastSentAt: string | null | undefined,
  now: Date
): { allowed: boolean; from: Date | null } => {
  const sent = lastSentAt ? parseApiDate(lastSentAt).getTime() : NaN;
  if (Number.isNaN(sent)) return { allowed: true, from: null };
  const from = new Date(sent + RESEND_AFTER_MS);
  return { allowed: now.getTime() >= from.getTime(), from };
};
