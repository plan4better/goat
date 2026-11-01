import { type Theme, darken, getContrastRatio, lighten } from "@mui/material/styles";

import type { AiCreditTier } from "@/lib/api/usage";

/** The value {@link formatCredits} shows: whole numbers from 10 up, one decimal
 * below. Also the count that picks a text's plural form. */
export const roundCredits = (value: number | null | undefined): number => {
  const credits = value ?? 0;
  // Round to one decimal first, so 9.96 reads "10", not "10.0".
  const rounded = Math.round(credits * 10) / 10;
  return Math.abs(rounded) < 10 ? rounded : Math.round(credits);
};

/** Credits as customers see them: whole numbers from 10 up, one decimal below
 * (a 3-second run costs half a credit, and "0" would hide it), in the reader's
 * locale. The ledger keeps exact values, so rounding happens only for display,
 * never per charge. */
export const formatCredits = (value: number | null | undefined, locale?: string): string => {
  const rounded = roundCredits(value);
  return new Intl.NumberFormat(locale, { maximumFractionDigits: Math.abs(rounded) < 10 ? 1 : 0 }).format(
    rounded
  );
};

/** Storage quotas are kept in MB: MB below a GB, GB above, one decimal at most. */
export const formatMegabytes = (mb: number, locale?: string): string => {
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  return mb >= 1024 ? `${number.format(mb / 1024)} GB` : `${number.format(mb)} MB`;
};

/** A price (credits per unit) as the server states it: never rounded, so 0.5
 * stays 0.5 (and 0.25 stays 0.25). */
export const formatRate = (value: number | null | undefined, locale?: string): string =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(value ?? 0);

/** Where an AI-credit pool stands: `low` under a tenth left, `empty` when
 * nothing is left, `unlimited` without an allowance. */
export type AiCreditsLevel = "unlimited" | "ok" | "low" | "empty";

export const aiCreditsLevel = (used: number, total: number | null): AiCreditsLevel => {
  if (total === null) return "unlimited";
  const left = total - used;
  if (left <= 0) return "empty";
  return left < total / 10 ? "low" : "ok";
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The used share of an AI-credit pool in whole percent: 0 only while nothing
 * is used, 100 only once nothing is left (a pool of nothing is used up), so the
 * figure never contradicts what is left. */
export const aiCreditsPercent = (used: number, total: number): number => {
  if (total <= 0 || used >= total) return 100;
  if (used <= 0) return 0;
  return Math.min(99, Math.max(1, Math.round((used / total) * 100)));
};

const LEVEL_COLOR = { unlimited: "primary", ok: "primary", low: "warning", empty: "error" } as const;

/** Normal text needs 4.5:1 against its background (WCAG AA). */
const TEXT_CONTRAST = 4.5;

/** `color` as text on the theme's paper: darkened on a light surface or
 * lightened on a dark one in 5 % steps until it reads (bright palette colours
 * such as `primary.main` or `warning.main` fail as text). */
export const readableText = (theme: Theme, color: string): string => {
  const background = theme.palette.background.paper;
  for (let step = 0; step <= 20; step += 1) {
    const shade = theme.palette.mode === "light" ? darken(color, step / 20) : lighten(color, step / 20);
    if (getContrastRatio(shade, background) >= TEXT_CONTRAST) return step === 0 ? color : shade;
  }
  return theme.palette.mode === "light" ? "#000" : "#FFF";
};

/** The colours of an AI-credit level: `bar` is the theme's colour (green,
 * orange under a tenth left, red when used up), `text` the nearest shade of it
 * that reads on paper, for amounts written in the level's colour. */
export const aiCreditsLevelColors = (theme: Theme, level: AiCreditsLevel): { text: string; bar: string } => {
  const bar = theme.palette[LEVEL_COLOR[level]].main;
  return { bar, text: readableText(theme, bar) };
};

/** "1 Dec" / "1. Dez." ("1 Dec 2026" / "1. Dez. 2026" with `year`): the day a
 * pool is refilled or a trial ends, on the reader's clock, which is the day
 * the credits are there for them. With `utc`, a day of the ledger
 * ("2026-11-03"), which is a UTC day and read on the UTC calendar: on the
 * reader's clock west of UTC it would be the evening before. Dates read
 * day-first in English, as everywhere in GOAT. */
export const formatCreditsDay = (
  value: string | null | undefined,
  language?: string,
  { year = false, utc = false }: { year?: boolean; utc?: boolean } = {}
): string | null => {
  if (!value) return null;
  const date = parseApiDate(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(language?.startsWith("de") ? "de-DE" : "en-GB", {
    day: "numeric",
    month: "short",
    ...(year ? { year: "numeric" } : {}),
    ...(utc ? { timeZone: "UTC" } : {}),
  }).format(date);
};

/** A tool by the name the workflow toolbox gives it: its translation, else
 * the processes service's title, else its key as it is. */
export const toolTitle = (
  key: string | null,
  processes: { id: string; title: string }[],
  t: Translate
): string =>
  key
    ? t(key, { defaultValue: processes.find((process) => process.id === key)?.title ?? key })
    : t("unknown");

/** "412 AI credits": rounded as {@link formatCredits} shows it, the plural
 * following the figure shown. */
export const aiCreditsText = (value: number | null | undefined, t: Translate, locale?: string): string =>
  t("usage_ai_credits_count", { count: roundCredits(value), credits: formatCredits(value, locale) });

/** What an AI answer costs by its steps, from the tiers core sends: "1 AI
 * credit up to 10 steps, 2 up to 20 steps, 3 above"; one tier reads as its
 * price alone. null without tiers. */
export const aiCreditTiersText = (
  tiers: AiCreditTier[] | null | undefined,
  t: Translate,
  locale?: string
): string | null => {
  if (!tiers?.length) return null;
  const amount = (value: number) => formatRate(value, locale);
  if (tiers.length === 1 && tiers[0].max_steps === null) {
    return t("usage_ai_credits_count", { count: tiers[0].credits, credits: amount(tiers[0].credits) });
  }
  return tiers
    .map((tier, index) => {
      const credits = amount(tier.credits);
      if (tier.max_steps === null) return t("usage_ai_tier_above", { credits });
      const steps = t("usage_ai_tier_steps", { count: tier.max_steps, steps: amount(tier.max_steps) });
      // The first tier names the unit; the others read on from it.
      return index === 0
        ? t("usage_ai_tier_first", { count: tier.credits, credits, steps })
        : t("usage_ai_tier_next", { credits, steps });
    })
    .join(", ");
};

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
