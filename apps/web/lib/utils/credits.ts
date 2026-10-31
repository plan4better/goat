/** Credits as customers see them: whole numbers from 10 up, one decimal below
 * (a 3-second run costs half a credit, and "0" would hide it), in the reader's
 * locale. The ledger keeps exact values, so rounding happens only for display,
 * never per charge. */
export const formatCredits = (value: number | null | undefined, locale?: string): string => {
  const credits = value ?? 0;
  // Round to one decimal first, so 9.96 reads "10", not "10.0".
  const rounded = Math.round(credits * 10) / 10;
  const small = Math.abs(rounded) < 10;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: small ? 1 : 0 }).format(
    small ? rounded : Math.round(credits)
  );
};

/** A price (credits per unit) as the server states it: never rounded, so 0.5
 * stays 0.5 (and 0.25 stays 0.25). */
export const formatRate = (value: number | null | undefined, locale?: string): string =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(value ?? 0);

/** A run refused because the organization has used up its credits (HTTP 402). */
export class OutOfCreditsError extends Error {
  constructor() {
    super("Out of credits");
    this.name = "OutOfCreditsError";
  }
}

/** Whether an error is the "out of credits" refusal: the typed error, or any
 * error that carries the HTTP status 402 (fetcher, process execution). */
export const isOutOfCreditsError = (error: unknown): boolean =>
  error instanceof OutOfCreditsError ||
  (typeof error === "object" && error !== null && (error as { status?: unknown }).status === 402);

/** The one place that words an out-of-credits refusal for the user: the
 * translated message for a 402/OutOfCreditsError, `fallback` for any other
 * error (callers keep their own text for those). */
export const creditsErrorMessage = <T = null>(
  error: unknown,
  t: (key: string) => string,
  fallback: T = null as T
): string | T => (isOutOfCreditsError(error) ? t("out_of_credits_tool") : fallback);

/** Naive datetimes (no zone or offset) from the API are UTC; `new Date()` would
 * read them as local time. Appends "Z" when the string has no zone. */
export const parseApiDate = (value: string): Date => {
  const hasZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(value.trim());
  // A date-only string has no time part and is not a datetime to shift.
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
  return new Date(hasZone || isDateOnly ? value : `${value.trim().replace(" ", "T")}Z`);
};
