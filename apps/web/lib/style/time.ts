// The time slider's steps (spec 7.3): an integer field's distinct values, or the years, months or days a date field's
// values fall in, in order. A step names a date period; without one the field holds integers (the compiler reads the
// slider value the same way).
import type { Time } from "@/lib/style/generated/types";

export type TimeStep = string | number;

const PERIOD = { year: 4, month: 7, day: 10 } as const;

/** The slider's steps from a field's distinct values (as text, the way the unique values answer them). */
export function timeStepsOf(values: string[], time: Time): TimeStep[] {
  const length = typeof time.step === "string" ? PERIOD[time.step] : undefined;
  if (length) {
    const periods = new Set(values.filter((v) => v.length >= length).map((v) => v.slice(0, length)));
    return [...periods].sort();
  }
  const numbers = new Set(values.map(Number).filter(Number.isFinite));
  return [...numbers].sort((a, b) => a - b);
}
