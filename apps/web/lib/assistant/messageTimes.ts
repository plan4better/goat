import type { Translate } from "@/lib/assistant/chips";
import type { AssistantMessage } from "@/lib/assistant/types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Day-first English, as the app's date-fns locale (`useDateFnsLocale`). */
const intlLocale = (language: string | undefined): string => (language?.startsWith("de") ? "de-DE" : "en-GB");

/** One formatter per locale and kind, built on first use: a transcript shows many times on every render. */
const formatters = new Map<string, Intl.DateTimeFormat | Intl.RelativeTimeFormat>();

function formatter<T extends Intl.DateTimeFormat | Intl.RelativeTimeFormat>(
  key: string,
  locale: string,
  build: (locale: string) => T
): T {
  const id = `${key}:${locale}`;
  let known = formatters.get(id) as T | undefined;
  if (!known) {
    known = build(locale);
    formatters.set(id, known);
  }
  return known;
}

const relativeFormat = (locale: string) =>
  formatter("relative", locale, (l) => new Intl.RelativeTimeFormat(l));
const dayFormat = (locale: string, withYear: boolean) =>
  formatter(
    withYear ? "day-year" : "day",
    locale,
    (l) =>
      new Intl.DateTimeFormat(l, { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) })
  );
const fullFormat = (locale: string) =>
  formatter(
    "full",
    locale,
    (l) =>
      new Intl.DateTimeFormat(l, {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
  );

const startOfDay = (time: number): number => {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};

/** The time the server stored for a message (`metadata.created_at`), in epoch milliseconds. */
export function storedTime(message: AssistantMessage): number | null {
  const value = message.metadata?.created_at;
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/**
 * When a message of the live stream reached this page, by message id, and the
 * answers seen running. Both are kept for the page's lifetime, so a chat that
 * mounts again (the dock expanded or collapsed) keeps them; a reload shows the
 * stored times instead.
 */
const arrivals = new Map<string, number>();
const seenRunning = new Set<string>();

export function resetArrivals(): void {
  arrivals.clear();
  seenRunning.clear();
}

/**
 * The time a message shows: the stored one, else when it reached this page.
 * A message that came after the list mounted (`mounted` false) is dated when
 * it is first shown; an answer when it stops running, so its time is when it
 * was given. A message already shown at mount without a stored time is not
 * dated, unless it was seen running: that answer is dated when it ends.
 */
export function messageTime(
  message: AssistantMessage,
  { mounted, running }: { mounted: boolean; running: boolean },
  now: number = Date.now()
): number | null {
  const stored = storedTime(message);
  if (stored !== null) return stored;
  if (running) {
    // An answer can run again under the same id when its stream is resumed
    // after a dropped connection: the time noted at the drop is not when it
    // was given.
    arrivals.delete(message.id);
    seenRunning.add(message.id);
    return null;
  }
  const known = arrivals.get(message.id);
  if (known !== undefined) return known;
  if (mounted && !seenRunning.has(message.id)) return null;
  arrivals.set(message.id, now);
  return now;
}

/**
 * How long ago `time` was: "Just now" under a minute (also for a server clock
 * a little ahead), minutes within the hour, hours within the same day,
 * "Yesterday" for the day before, then the date (with its year when it is not
 * this year's).
 */
export function relativeTime(time: number, now: number, t: Translate, language: string): string {
  const elapsed = now - time;
  if (elapsed < MINUTE) return t("assistant_time_just_now");
  const locale = intlLocale(language);
  if (elapsed < HOUR) return relativeFormat(locale).format(-Math.floor(elapsed / MINUTE), "minute");
  const today = startOfDay(now);
  if (time >= today) return relativeFormat(locale).format(-Math.floor(elapsed / HOUR), "hour");
  // The last millisecond of yesterday lies in yesterday, also on a day with a clock change.
  if (time >= startOfDay(today - 1)) return t("assistant_time_yesterday");
  const sameYear = new Date(time).getFullYear() === new Date(now).getFullYear();
  return dayFormat(locale, !sameYear).format(time);
}

/** The date and time in full: "19 Oct 2026, 10:08", "19. Okt. 2026, 10:08". */
export function fullTime(time: number, language: string): string {
  return fullFormat(intlLocale(language)).format(time);
}
