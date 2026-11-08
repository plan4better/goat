import { startOfMonth, subMonths } from "date-fns";
import type { TFunction } from "i18next";

import type { CreditBalance } from "@/lib/api/usage";
import { parseApiDate } from "@/lib/utils/credits";

/** The date ranges the usage page offers: this credit period, the one before,
 * the last 7 or 30 days, the last 12 months (per month), or two days picked. */
export type RangePreset = "period" | "last" | "d7" | "d30" | "m12" | "custom";

/** `from`/`to`: the custom range's first and last day, `YYYY-MM-DD`. */
export interface UsageRange {
  preset: RangePreset;
  from?: string;
  to?: string;
}

/** A range as the usage routes take it: ISO instants, `since` inclusive,
 * `until` exclusive, either open when unset. `perMonth`: the chart and the
 * list group by month instead of by day. */
export interface RangeWindow {
  since?: string;
  until?: string;
  perMonth: boolean;
}

/** A trial is one period from its start: it has no last period, and the
 * longer ranges would only repeat the whole trial. */
export const presetsFor = (onTrial: boolean): RangePreset[] =>
  onTrial ? ["period", "d7"] : ["period", "last", "d7", "d30", "m12"];

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The first day a custom range may start on: GOAT holds no usage before
 * it, and an earlier year is a typing slip ("0226" for "2026"). */
export const FIRST_USAGE_DAY = "2020-01-01";

/** The most days a window shows one by one; a longer one goes per month, as
 * a bar per day would be too thin to read. */
const MAX_DAILY_WINDOW = 400;

/** The UTC midnight of a `YYYY-MM-DD` day; null when it is not one. */
const parseDay = (value: string | undefined): Date | null => {
  if (!value || !DAY.test(value)) return null;
  const day = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(day.getTime()) ? null : day;
};

/** The UTC midnight `days` days after the UTC day of `date`. */
const utcDay = (date: Date, days = 0): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));

/** Today as a UTC day, `YYYY-MM-DD`: the last day a custom range may end on. */
export const utcToday = (now: Date = new Date()): string => utcDay(now).toISOString().slice(0, 10);

/**
 * Month arithmetic on the UTC calendar: the ledger's days are UTC days, while
 * date-fns works on local fields. `shift` runs on a local noon holding the UTC
 * day (noon, so no daylight-saving change moves it to another day), and the
 * day it returns gets the UTC time of `date` back.
 */
const shiftUtcMonths = (date: Date, shift: (local: Date) => Date): Date => {
  const local = shift(new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12));
  return new Date(
    Date.UTC(
      local.getFullYear(),
      local.getMonth(),
      local.getDate(),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds()
    )
  );
};

/** Whether day `a` comes before day `b`, both `YYYY-MM-DD` with a year of
 * four or more digits, as a date field gives them: the longer year is the
 * later one. */
const dayBefore = (a: string, b: string): boolean => (a.length === b.length ? a < b : a.length < b.length);

/**
 * The custom range the date pill applies from two typed days: each moved to
 * the nearest day from 2020 up to today (UTC), and in order. A year typed
 * past the date fields' bounds would otherwise name days the window does not
 * read, and a range wholly after today would read none.
 */
export const customRange = (from: string, to: string, now: Date = new Date()): UsageRange => {
  const last = utcToday(now);
  const within = (day: string) =>
    dayBefore(day, FIRST_USAGE_DAY) ? FIRST_USAGE_DAY : dayBefore(last, day) ? last : day;
  const [first, second] = [within(from), within(to)];
  return dayBefore(second, first)
    ? { preset: "custom", from: second, to: first }
    : { preset: "custom", from: first, to: second };
};

/** The custom range's days in order: a To day before the From day swaps them. */
const customDays = (range: UsageRange): [Date | null, Date | null] => {
  const from = parseDay(range.from);
  const to = parseDay(range.to);
  return from && to && from > to ? [to, from] : [from, to];
};

const iso = (date: Date | null | undefined): string | undefined => date?.toISOString();

/** A range's bounds; null where it is open. */
const boundsOf = (range: UsageRange, start: Date | null, now: Date): [Date | null, Date | null] => {
  switch (range.preset) {
    case "period":
      return [start, null];
    case "last":
      return [start && shiftUtcMonths(start, (local) => subMonths(local, 1)), start];
    case "d7":
    case "d30": {
      const until = utcDay(now, 1);
      return [utcDay(until, range.preset === "d7" ? -7 : -30), until];
    }
    case "m12":
      return [shiftUtcMonths(utcDay(now), (local) => startOfMonth(subMonths(local, 11))), null];
    case "custom": {
      // Both bounds stay between the first usage day and the end of today, so
      // a mistyped year neither reaches back centuries nor into the future,
      // and the window never turns inside out.
      const first = new Date(`${FIRST_USAGE_DAY}T00:00:00Z`).getTime();
      const end = utcDay(now, 1).getTime();
      const within = (day: Date) => new Date(Math.min(Math.max(day.getTime(), first), end));
      const [from, to] = customDays(range);
      return [from && within(from), to && within(utcDay(to, 1))];
    }
  }
};

/**
 * The window a range reads. This and the last period follow the balance's
 * `period_start` to the instant, as the credit pools count from it; both stay
 * open without a known period. Day ranges end after today (UTC), and a custom
 * range after its To day, between 2020 and today. Per month: the last 12
 * months, a window of more than {@link MAX_DAILY_WINDOW} days, and one
 * without a start (the whole ledger, from its first usage).
 */
export const rangeWindow = (
  range: UsageRange,
  balance: Pick<CreditBalance, "period_start" | "credits_reset_at" | "on_trial">,
  now: Date = new Date()
): RangeWindow => {
  const periodStart = balance.period_start ? parseApiDate(balance.period_start) : null;
  const start = periodStart && !Number.isNaN(periodStart.getTime()) ? periodStart : null;
  const [since, until] = boundsOf(range, start, now);
  const long = !!since && (until ?? utcDay(now, 1)).getTime() - since.getTime() > MAX_DAILY_WINDOW * DAY_MS;
  return { since: iso(since), until: iso(until), perMonth: range.preset === "m12" || !since || long };
};

/** A balance not read yet: no period known. */
export const NO_PERIOD = { period_start: null, credits_reset_at: null, on_trial: false } as const;

/**
 * The bounds a breakdown request sends. This period sends none: core's
 * `/credits/breakdown` counts from the period start `/credits/balance`
 * reports, so the open tile's breakdowns start with the balance instead of
 * after it (Settings load, L4). The last period needs the balance's start
 * (null until it is there); the other ranges count from today. Exports keep
 * the exact window from `rangeWindow`.
 */
export const requestWindow = (
  range: UsageRange,
  balance: Pick<CreditBalance, "period_start" | "credits_reset_at" | "on_trial"> | undefined,
  now: Date = new Date()
): { since?: string; until?: string } | null => {
  if (range.preset === "period") return {};
  if (range.preset === "last" && !balance) return null;
  const { since, until } = rangeWindow(range, balance ?? NO_PERIOD, now);
  return { since, until };
};

const dateFormat = (language: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat(language?.startsWith("de") ? "de-DE" : "en-GB", {
    ...options,
    // The days are UTC days: read on any other clock they could move by one.
    timeZone: "UTC",
  });

/**
 * Two UTC days as a span without a dash, day first in English as everywhere
 * in GOAT: the first day names only what differs from the last ("3 to 14 Nov
 * 2026", "3 Oct to 14 Nov 2026", "20 Dec 2025 to 14 Nov 2026"); one day reads
 * as itself.
 */
export const daySpanLabel = (from: Date, to: Date, t: TFunction, language: string): string => {
  const full = dateFormat(language, { day: "numeric", month: "short", year: "numeric" });
  const last = full.format(to);
  if (full.format(from) === last) return last;
  let first = full.format(from);
  if (from.getUTCFullYear() === to.getUTCFullYear()) {
    const dayMonth = dateFormat(language, { day: "numeric", month: "short" });
    if (from.getUTCMonth() === to.getUTCMonth()) {
      // The day with what follows it ("3." in German), without its month.
      const parts = dayMonth.formatToParts(from);
      const month = parts.findIndex((part) => part.type === "month");
      first = parts
        .slice(0, month)
        .map((part) => part.value)
        .join("")
        .trim();
    } else {
      first = dayMonth.format(from);
    }
  }
  return t("usage_range_span", { from: first, to: last });
};

/**
 * The days a range covers, as {@link daySpanLabel} writes them: from its first
 * day to the day before `until`, or to today while it is open. null for a
 * range without a start (a period while none is known).
 */
export const rangeSpan = (
  range: UsageRange,
  balance: Pick<CreditBalance, "period_start" | "credits_reset_at" | "on_trial">,
  t: TFunction,
  language: string,
  now: Date = new Date()
): string | null => {
  const { since, until } = rangeWindow(range, balance, now);
  if (!since) return null;
  const last = until ? utcDay(new Date(until), -1) : utcDay(now);
  return daySpanLabel(utcDay(new Date(since)), last, t, language);
};

/**
 * The range as the date pill names it: the preset's name (a trial's period is
 * the whole trial), or a custom range's days ("3 to 14 Nov 2026").
 */
export const rangeLabel = (range: UsageRange, t: TFunction, language: string, onTrial: boolean): string => {
  if (range.preset === "custom") {
    const [from, to] = customDays(range);
    if (!from || !to) return t("usage_range_custom");
    return daySpanLabel(from, to, t, language);
  }
  if (range.preset === "period" && onTrial) return t("usage_range_trial");
  return t(`usage_range_${range.preset}`);
};
