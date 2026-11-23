// A number field's value as category classes spell it (spec 5.1): goatlib writes a top value of such a field as
// `as_text(float(value))` (`goatlib/filter/cql.py`), which is Python's shortest text of the number with whole numbers
// written out without a fraction. The unique values arrive as the database prints them ("1.0", "2.50"), so the panel
// spells them the same way before it holds them against the classes.

const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** `value` as goatlib's `as_text` writes the float it reads as; a text that is no decimal number stays as it is. */
export function numberText(value: string | number): string {
  if (typeof value === "string" && !DECIMAL.test(value.trim())) return value;
  const n = Number(value);
  if (Number.isNaN(n)) return "nan";
  if (!Number.isFinite(n)) return n > 0 ? "inf" : "-inf";
  // Whole numbers with every digit, as Python's `str(int(value))`.
  if (Number.isInteger(n)) return BigInt(n).toString();
  // Python writes an exponent below 1e-4 (a fraction never reaches the upper limit, 1e16), with a sign and at least
  // two digits; the digits are the shortest that read back as the same number, here and there.
  const [digits, exponent] = n.toExponential().split("e");
  const power = Number(exponent);
  if (power >= -4) return String(n);
  return `${digits}e-${String(-power).padStart(2, "0")}`;
}

/** A field value as the classes of a categories classification on a field of `type` spell it: a number field's in
 * goatlib's spelling, any other as its text. */
export function categoryText(value: unknown, type?: string): string {
  return type === "number" && (typeof value === "string" || typeof value === "number")
    ? numberText(value)
    : String(value);
}
