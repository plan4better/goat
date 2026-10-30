/** How the Explorer writes its figures: times as on a timetable, money and
 * counts in the reader's language, estimates rounded. */

/** Seconds since the start of the service day as `HH:MM`; past midnight keeps
 * counting (`24:48`), as a timetable does. */
export function clock(seconds: number | null | undefined): string {
  if (seconds == null) return "–";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function count(value: number, locale: string, digits = 0): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
}

/** A large figure in a few digits, `54.7M`: totals a year are estimates. */
export function compact(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumSignificantDigits: 3 }).format(value);
}

/** An estimate in a currency, rounded to what it can claim: `€1.58M`, `€40k`. */
export function money(value: number, locale: string, currency = "EUR"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    notation: "compact",
    maximumSignificantDigits: 3,
  }).format(value);
}

/** A currency as it is written before or after an amount: €, $, CHF. */
export function currencySymbol(currency: string, locale: string): string {
  try {
    const parts = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
    }).formatToParts(0);
    return parts.find((p) => p.type === "currency")?.value ?? currency;
  } catch {
    return currency;
  }
}

export function rate(value: number, locale: string, currency = "EUR"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(value);
}

/** The locale dates are written in: English as written in Europe, the day
 * before the month ("Wed 21 Oct", not "Wed, Oct 21"), as GOAT's date
 * pickers write it (en-gb); other languages as they are. */
export function dateLocale(locale: string): string {
  return locale === "en" || locale.startsWith("en-") ? "en-GB" : locale;
}

/** `[from, to]` (`YYYY-MM-DD`) as the locale writes a span of days:
 * "21 Oct 2026 – 20 Oct 2027", "6 Oct – 12 Dec 2026". */
export function dateSpan(from: string, to: string, locale: string): string {
  return new Intl.DateTimeFormat(dateLocale(locale), {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).formatRange(new Date(`${from}T00:00:00Z`), new Date(`${to}T00:00:00Z`));
}

/** `Oct 2026` (`Okt. 2026` in German). */
export function monthYear(date: string, locale: string): string {
  return new Intl.DateTimeFormat(dateLocale(locale), {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

/** `Tue 6 Oct`. */
export function shortDate(date: string, locale: string): string {
  return new Intl.DateTimeFormat(dateLocale(locale), {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

/** `26 Nov`. */
export function dayMonth(date: string, locale: string): string {
  return new Intl.DateTimeFormat(dateLocale(locale), {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

/** A weekday's short name, ISO numbered (1 = Monday). */
export function weekdayName(isoDay: number, locale: string, width: "short" | "narrow" = "short"): string {
  // 2024-01-01 was a Monday.
  return new Intl.DateTimeFormat(dateLocale(locale), { weekday: width, timeZone: "UTC" }).format(
    new Date(Date.UTC(2024, 0, isoDay))
  );
}

/** Weekdays as a reader says them: a run as a range ("Mon–Fri"), others
 * listed ("Mon, Wed"); null for all seven, which the caller words itself. */
export function weekdayList(days: number[], locale: string): string | null {
  if (days.length === 7) return null;
  const run = days.length >= 3 && days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  if (run) return `${weekdayName(days[0], locale)}–${weekdayName(days[days.length - 1], locale)}`;
  return days.map((d) => weekdayName(d, locale)).join(", ");
}

/** A distance as a reader says it: metres to the nearest 10 under a
 * kilometre, kilometres to one decimal above. */
export function distance(m: number | null, locale: string): string | null {
  if (m === null) return null;
  return m < 1000
    ? `${count(Math.round(m / 10) * 10, locale)} m`
    : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(m / 1000)} km`;
}
