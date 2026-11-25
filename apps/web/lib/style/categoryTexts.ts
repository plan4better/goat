// The texts the classes of a categories classification match where the field's type is not known as text or whole
// numbers (spec 5.1): the map compiles without field types and compares the feature value's text, as MapLibre's
// `to-string` writes it, with these. A class value that writes a number in another spelling than that ("3.0", "0.50",
// goatlib's "1e-05"; converted styles hold a number field's values as text) also matches the number's own spelling,
// so a number field's features fall in it, unless a class lists that spelling itself. A text field holding "3.0" still
// matches "3.0". The compiler, the legend's classifier (the popup's class, the presence counts) read classes with it.

/** A number as a database or goatlib writes one: no `+`, no leading zero before the whole part (a code such as the
 * postcode "01067" stays text), digits on both sides of a point. */
const DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?(e[+-]?\d+)?$/i;

/** The text MapLibre's `to-string` gives the number `text` writes (JavaScript's text of a number: an exponent from
 * 1e21 up and below 1e-6); nothing for a text that writes no finite number in the spelling of `DECIMAL`. */
export function mapNumberText(text: string): string | undefined {
  if (!DECIMAL.test(text)) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? String(n) : undefined;
}

/**
 * Per class, the texts it matches: first its values' own texts (a text two classes list stays with the first), then
 * the number spelling of each value no class lists as it is (one two classes would add goes to the first).
 */
export function classTexts(classes: ReadonlyArray<{ values?: unknown }>): string[][] {
  const taken = new Set<string>();
  const values = classes.map((k) => (Array.isArray(k.values) ? (k.values as unknown[]) : []));
  const texts = values.map((vs) =>
    vs.flatMap((v) => {
      const text = String(v);
      if (taken.has(text)) return [];
      taken.add(text);
      return [text];
    })
  );
  values.forEach((vs, i) => {
    for (const v of vs) {
      const spelled = typeof v === "string" ? mapNumberText(v) : undefined;
      if (spelled === undefined || taken.has(spelled)) continue;
      taken.add(spelled);
      texts[i].push(spelled);
    }
  });
  return texts;
}
