/**
 * An edit's change in annual operating cost, as the change list and the
 * Apply bar say it: ≈, signed, in the settings' currency, a year.
 */
import { money } from "@/lib/explorer/format";

/** Below this, in the settings' currency, an edit changes nothing worth saying. */
const NO_CHANGE = 0.5;

export function costChange(
  value: number,
  lang: string,
  currency: string,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  if (Math.abs(value) < NO_CHANGE) return t("explorer_change_no_cost");
  const sign = value > 0 ? "+" : "−";
  return `≈ ${sign}${money(Math.abs(value), lang, currency)} ${t("explorer_a_year_short")}`;
}
