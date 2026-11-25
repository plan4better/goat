// The document a layer gets when it has none (goatlib's `default_style`, spec 18): a marker, a line or a fill with a
// thin outline in a darker shade of it, in GOAT's green. The web needs it only where a result arrives without its
// style; goatlib picks the color from a palette by layer id, which only matters for stored layers.
import type { Geometry } from "@/lib/style/compile/types";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import type { LayerStyle } from "@/lib/style/generated/types";
import { STYLE_VERSION } from "@/lib/style/version";

const COLOR = DEFAULTS["fill.color"] as string;

/** A new polygon layer's outline, a darker shade of its fill at 1 px; also what the panel's Outline switch starts
 * with. */
export const DEFAULT_OUTLINE: Readonly<{ color: string; width: number }> = { color: "auto", width: 1 };

export function defaultStyle(geometry: Geometry | undefined): LayerStyle {
  const symbol =
    geometry === "point"
      ? { marker: { shape: "circle", color: COLOR, size: 10 } }
      : geometry === "line"
        ? { line: { color: COLOR, width: 2 } }
        : { fill: { color: COLOR, opacity: 0.8 }, outline: { ...DEFAULT_OUTLINE } };
  return { version: STYLE_VERSION, kind: "vector", symbol } as LayerStyle;
}
