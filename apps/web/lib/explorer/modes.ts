/**
 * A GTFS route type as the Explorer names and draws it: the basic types and
 * the extended (Hierarchical Vehicle Type) ranges.
 */
export type ModeKey =
  | "tram"
  | "metro"
  | "rail"
  | "bus"
  | "ferry"
  | "cable_tram"
  | "aerial_lift"
  | "funicular"
  | "trolleybus"
  | "monorail"
  | "other";

const BASIC: Record<number, ModeKey> = {
  0: "tram",
  1: "metro",
  2: "rail",
  3: "bus",
  4: "ferry",
  5: "cable_tram",
  6: "aerial_lift",
  7: "funicular",
  11: "trolleybus",
  12: "monorail",
};

export function modeOf(routeType: number | null): ModeKey {
  if (routeType === null) return "other";
  if (routeType in BASIC) return BASIC[routeType];
  const range = Math.floor(routeType / 100);
  if (range === 1 || range === 3) return "rail";
  if (range === 2 || range === 7 || range === 8) return range === 8 ? "trolleybus" : "bus";
  if (range === 4 || range === 5 || range === 6) return "metro"; // urban rail, metro, underground
  if (range === 9) return "tram";
  if (range === 10 || range === 12) return "ferry";
  if (range === 13) return "aerial_lift";
  if (range === 14) return "funicular";
  return "other";
}

/** The colour a route is drawn in: its own, else one per mode. */
export function routeColor(color: string | null, mode: ModeKey): string {
  if (color && /^[0-9A-Fa-f]{6}$/.test(color)) return `#${color}`;
  const fallback: Partial<Record<ModeKey, string>> = {
    tram: "#C62828",
    metro: "#1565C0",
    rail: "#424242",
    bus: "#2E7D32",
    ferry: "#00838F",
  };
  return fallback[mode] ?? "#6A1B9A";
}

/** `color` (`#RRGGBB`) mixed with `toward` (white unless said), `share` of
 * it kept: a faded line that stays opaque, so lines drawn over each other do
 * not add up. */
export function tint(color: string, share: number, toward = "#FFFFFF"): string {
  const [hex, to] = [color, toward].map((c) => c.replace("#", ""));
  return `#${[0, 2, 4]
    .map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16);
      const t = parseInt(to.slice(i, i + 2), 16);
      return Math.round(t - (t - c) * share)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}

/** The WCAG relative luminance of `color` (`#RRGGBB`), 0 for black to 1. */
export function luminance(color: string): number {
  const hex = color.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Text that reads on `background`. */
export function textOn(background: string): string {
  return luminance(background) > 0.4 ? "#000000" : "#FFFFFF";
}

/** The colour of a route's number on its badge: the feed's text colour, else
 * whichever of black and white reads on the route's colour. */
export function routeTextColor(textColor: string | null, background: string): string {
  return textColor && /^[0-9A-Fa-f]{6}$/.test(textColor) ? `#${textColor}` : textOn(background);
}
