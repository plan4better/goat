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

/** The color's alpha, 0 to 255: its last two digits, 255 without them; undefined for anything but a six- or
 * eight-digit hex color. */
export function alphaOf(color: unknown): number | undefined {
  if (!isHex(color)) return undefined;
  return color.length === 9 ? parseInt(color.slice(7), 16) : 255;
}

/** Whether the color is "None" (spec 4.6): a hex color at alpha 0, which draws nothing and keeps its hue. */
export const isNone = (color: unknown): boolean => alphaOf(color) === 0;

/** The color without its alpha, `#rrggbb` as written: the hue a color that is not set takes from the color it follows
 * (spec 3.1 to 3.3). Anything but a six- or eight-digit hex color is returned as it is. */
export const opaque = (color: string): string => (isHex(color) ? color.slice(0, 7) : color);

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

/** A label's text and halo where no color can be read for them (spec 18.10): GOAT's dark text in a light halo on a
 * light basemap, white text in a dark halo on a dark one. */
export const LABEL_FALLBACK = {
  light: { text: DARK, halo: LIGHT },
  dark: { text: LIGHT, halo: DARK },
} as const;

/** A label's text and halo chosen together for the basemap's tone (spec 18.10), from the color of the feature the
 * label belongs to, its alpha ignored. On a light basemap the text is the color's readable shade against white in a
 * white halo; on a dark one (any tone but "dark" counts as light) the text is white in a halo of that shade. For
 * anything but a hex color, `LABEL_FALLBACK`. */
export function labelPair(color: string, tone?: string): { text: string; halo: string } {
  const dark = tone === "dark";
  if (!isHex(color)) return { ...LABEL_FALLBACK[dark ? "dark" : "light"] };
  const tinted = readableShade(color, LIGHT);
  return dark ? { text: LIGHT, halo: tinted } : { text: tinted, halo: LIGHT };
}

/** The halo of a set text color (spec 18.10): the one of white and GOAT's dark text color that contrasts more with
 * it, black where neither reaches the contrast floor (a mid-tone text), so the floor always holds; white for anything
 * but a hex color. */
export function haloAgainst(text: string): string {
  if (!isHex(text)) return LIGHT;
  const [light, dark] = [contrastRatio(text, LIGHT), contrastRatio(text, DARK)];
  if (Math.max(light, dark) < CONTRAST_FLOOR) return "#000000";
  return light >= dark ? LIGHT : DARK;
}

/** The text `"auto"` draws beside the halo the map draws (spec 18.10: a color the style sets, or the reference
 * `#ffffff` where none is set), read without its alpha: `text` (by default the label pair's text for the tone) where
 * it contrasts with the halo by at least the contrast floor; else the color's readable shade against the halo where
 * it reaches the floor; else `haloAgainst` of the halo. A halo that is not a hex color or is "None" is no halo:
 * `text`. For a color that is not a hex color the step of the readable shade is left out. */
export function textAgainst(color: string, halo: string, tone?: string, text?: string): string {
  const first = text ?? labelPair(color, tone).text;
  if (!isHex(halo) || isNone(halo)) return first;
  const on = opaque(halo);
  if (contrastRatio(first, on) >= CONTRAST_FLOOR) return first;
  const tinted = readableShade(color, on);
  if (contrastRatio(tinted, on) >= CONTRAST_FLOOR) return tinted;
  return haloAgainst(on);
}

/** White where the color underneath has a relative luminance below 0.5, else GOAT's dark text color; white for
 * anything but a hex color. */
export function onColor(color: string): string {
  if (!isHex(color)) return LIGHT;
  return luminance(color) < ON_COLOR_LUMINANCE ? LIGHT : DARK;
}
