// A date and time a condition compares with, as people pick and read it: in the browser's zone. The filter stores the
// instant in UTC (`2026-11-16T09:00:00Z`); the value box (a datetime-local input, which has no zone) and the row's
// sentence show it in the browser's zone (`2026-11-16T10:00` in Berlin). A stored day stands for the start of that day in
// UTC, and a time stored without its zone for that time in UTC: as the services read them. Date-only values are days
// and stay as they are.

/** What a datetime-local input gives: a date and a time, to the minute or the second, with no zone. */
const PICKED = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const ZONED = /(Z|[+-]\d{2}:?\d{2})$/;

const pad = (n: number) => String(n).padStart(2, "0");

/** A stored day or date and time as the instant it stands for, or null for anything else. */
function instantOf(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  let text = value;
  if (DAY.test(text)) text = `${text}T00:00:00Z`;
  else if (!STAMP.test(text)) return null;
  else if (!ZONED.test(text)) text = `${text}Z`;
  const instant = new Date(text);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/** The instant's date and time in the browser's zone, the seconds only when there are some. */
function wallTime(instant: Date, between: string): string {
  const day = `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}`;
  const seconds = instant.getSeconds() ? `:${pad(instant.getSeconds())}` : "";
  return `${day}${between}${pad(instant.getHours())}:${pad(instant.getMinutes())}${seconds}`;
}

/** A stored day or instant as the value box shows it, in the browser's zone; other text as it is. */
export function inputMoment(value: string): string {
  const instant = instantOf(value);
  return instant ? wallTime(instant, "T") : value;
}

/** A picked date and time, read in the browser's zone, as the UTC instant the filter stores; undefined for a text that
 * names none. */
export function storedMoment(text: string): string | undefined {
  const parts = PICKED.exec(text.trim());
  if (!parts) return undefined;
  const [year, month, day, hours, minutes, seconds] = parts.slice(1).map((part) => Number(part ?? 0));
  const instant = new Date(year, month - 1, day, hours, minutes, seconds);
  // A day or an hour the calendar does not have rolls over into the next one: not what was typed.
  if (
    instant.getMonth() !== month - 1 ||
    instant.getDate() !== day ||
    hours > 23 ||
    minutes > 59 ||
    seconds > 59
  )
    return undefined;
  return instant.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** A value as a row's sentence names it: a stored date and time in the browser's zone (`2026-11-16 10:00`), anything
 * else (a day, text, a number) as it is. */
export function momentText(value: unknown): string {
  const instant = typeof value === "string" && !DAY.test(value) ? instantOf(value) : null;
  return instant ? wallTime(instant, " ") : String(value);
}
