// A color as people type it: a hex code, red, green and blue (0 to 255), or hue (0 to 360), saturation and
// lightness (percent). Colors are stored as lower-case hex.

export type ColorFormat = "hex" | "rgb" | "hsl";

const HEX = /^#?([0-9a-f]{6})$/i;

function channels(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (rgb: number[]) =>
  `#${rgb
    .map((c) =>
      Math.round(Math.min(255, Math.max(0, c)))
        .toString(16)
        .padStart(2, "0")
    )
    .join("")}`;

function rgbToHsl([r, g, b]: number[]): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l * 100];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === rn ? ((gn - bn) / d) % 6 : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return [(h * 60 + 360) % 360, s * 100, l * 100];
}

function hslToRgb(h: number, s: number, l: number): number[] {
  const sn = s / 100;
  const ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = ln - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** `hex` as text in `format`: "#833B21", "131, 59, 33" or "16, 60%, 32%". */
export function formatColor(hex: string, format: ColorFormat): string {
  if (format === "hex") return hex.toUpperCase();
  const rgb = channels(hex);
  if (format === "rgb") return rgb.join(", ");
  const [h, s, l] = rgbToHsl(rgb).map(Math.round);
  return `${h}, ${s}%, ${l}%`;
}

/** The color typed in `format` (a hex code reads in any format), as lower-case hex; null while it is no color. */
export function parseColor(text: string, format: ColorFormat): string | null {
  const trimmed = text.trim();
  const hex = trimmed.match(HEX);
  if (hex) return `#${hex[1].toLowerCase()}`;
  if (format === "hex") return null;
  const numbers = trimmed
    .replace(/^(rgb|hsl)a?\(|\)$/gi, "")
    .split(/[\s,%]+/)
    .filter(Boolean)
    .map(Number);
  if (numbers.length !== 3 || numbers.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (format === "rgb") return numbers.some((n) => n > 255) ? null : toHex(numbers);
  const [h, s, l] = numbers;
  if (h > 360 || s > 100 || l > 100) return null;
  return toHex(hslToRgb(h % 360, s, l));
}
