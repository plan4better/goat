// The color rules derived colors are made of (spec 3.1), as goatlib's `style/colors.py` defines them; both read one
// fixture of inputs and outputs (goatlib tests/unit/style/fixtures/color_rules.json).

/** The contrast a readable shade reaches (WCAG's 4.5 to 1), the relative luminance from which an on-color is dark,
 * and the light and dark colors it picks from. */
export const CONTRAST_FLOOR = 4.5;
export const ON_COLOR_LUMINANCE = 0.5;
export const LIGHT = "#ffffff";
export const DARK = "#3a3541";

const HEX_COLOR = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Whether `value` is a `#rrggbb` or `#rrggbbaa` color. */
const isHex = (value: unknown): value is string => typeof value === "string" && HEX_COLOR.test(value);

const channels = (color: string) => [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));

/** The darker shade `"auto"` draws: red, green and blue each times 0.7, rounded half up in whole numbers, opaque
 * whatever the color's alpha; lowercase. Anything but a six- or eight-digit hex color is returned as it is. */
export function shade(color: string): string {
  if (!isHex(color)) return color;
  return `#${channels(color)
    .map((c) =>
      Math.floor((7 * c + 5) / 10)
        .toString(16)
        .padStart(2, "0")
    )
    .join("")}`;
}

/** WCAG's relative luminance of the color's red, green and blue. */
function luminance(color: string): number {
  const [r, g, b] = channels(color).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG's contrast ratio of two hex colors, 1 to 21, alpha ignored; NaN where either is not a six- or eight-digit hex
 * color. */
export function contrastRatio(a: string, b: string): number {
  if (!isHex(a) || !isHex(b)) return NaN;
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The shade of the color, shaded again until it contrasts with `against` by at least `floor`; where shading stops
 * changing it (near black) first, that last shade. Against anything but a hex color, the shade alone; anything but a
 * hex color is returned as it is. */
export function readableShade(color: string, against: string, floor = CONTRAST_FLOOR): string {
  if (!isHex(color)) return color;
  let out = shade(color);
  // A NaN ratio (`against` no hex color) compares as false: the shade alone.
  while (contrastRatio(out, against) < floor) {
    const darker = shade(out);
    if (darker === out) break;
    out = darker;
  }
  return out;
}

/** White where the color underneath has a relative luminance below 0.5, else GOAT's dark text color; white for
 * anything but a hex color. */
export function onColor(color: string): string {
  if (!isHex(color)) return LIGHT;
  return luminance(color) < ON_COLOR_LUMINANCE ? LIGHT : DARK;
}
