// A fill pattern (spec 3.1) is an image MapLibre repeats over the polygon. The compiler names the image after what it
// shows: `goat-pattern:<kind>|<spacing>|<width>|<color>`; the renderer draws each name once
// (lib/style/render/patternImages.ts), the legend and the panel draw the same tile as SVG.

export const PATTERN_IMAGE = "goat-pattern:";

export type PatternKind = "hatch_45" | "hatch_135" | "vertical" | "horizontal" | "cross" | "grid" | "dots";

const KINDS = new Set<string>(["hatch_45", "hatch_135", "vertical", "horizontal", "cross", "grid", "dots"]);

export interface PatternImage {
  kind: PatternKind;
  /** The distance between lines, or between dots, in px. */
  spacing: number;
  /** A line's width, or a dot's diameter, in px. */
  width: number;
  color: string;
}

export const isPatternImage = (name: string): boolean => name.startsWith(PATTERN_IMAGE);

/** The parts of a pattern image name; null for any other image or a name with parts missing. */
export function parsePatternImage(name: string): PatternImage | null {
  if (!isPatternImage(name)) return null;
  const parts = name.slice(PATTERN_IMAGE.length).split("|");
  if (parts.length !== 4) return null;
  const [kind, spacing, width, color] = parts;
  const s = Number(spacing);
  const w = Number(width);
  if (!KINDS.has(kind) || !(s > 0) || !(w > 0) || !color) return null;
  return { kind: kind as PatternKind, spacing: s, width: w, color };
}

export interface PatternTile {
  /** The square tile's side in px; the pattern repeats it seamlessly. */
  size: number;
  /** SVG path data in tile coordinates: lines to stroke `width` wide, or dots to fill. */
  path: string;
  dots: boolean;
}

/** The tile of a pattern. Lines run through the tile's edges so they meet the next tile's; a diagonal's tile is
 * √2 × spacing wide, so its lines lie `spacing` apart. */
export function patternTile(kind: PatternKind, spacing: number, width: number): PatternTile {
  const gap = Math.max(spacing, width + 1, 2);
  if (kind === "dots") {
    const size = Math.round(gap);
    const h = size / 2;
    const r = Math.min(width, size - 1) / 2;
    return {
      size,
      path: `M${h - r} ${h}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`,
      dots: true,
    };
  }
  if (kind === "vertical" || kind === "horizontal" || kind === "grid") {
    const size = Math.round(gap);
    const h = size / 2;
    const vertical = `M${h} 0V${size}`;
    const horizontal = `M0 ${h}H${size}`;
    const path =
      kind === "vertical" ? vertical : kind === "horizontal" ? horizontal : `${vertical}${horizontal}`;
    return { size, path, dots: false };
  }
  const d = Math.round(gap * Math.SQRT2);
  const h = d / 2;
  const rising = `M0 ${d}L${d} 0M${-h} ${h}L${h} ${-h}M${h} ${d + h}L${d + h} ${h}`;
  const falling = `M0 0L${d} ${d}M${-h} ${h}L${h} ${d + h}M${h} ${-h}L${d + h} ${h}`;
  const path = kind === "hatch_45" ? rising : kind === "hatch_135" ? falling : `${rising}${falling}`;
  return { size: d, path, dots: false };
}
