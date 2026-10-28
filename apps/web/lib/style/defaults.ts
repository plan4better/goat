// The document a layer gets when it has none (goatlib's `default_style`, spec 18): a marker, a line or a fill in
// GOAT's green. The web needs it only where a result arrives without its style; goatlib picks the color
// from a palette by layer id, which only matters for stored layers.
import type { Geometry } from "@/lib/style/compile/types";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import type { LayerStyle } from "@/lib/style/generated/types";

const COLOR = DEFAULTS["fill.color"] as string;

export function defaultStyle(geometry: Geometry | undefined): LayerStyle {
  const symbol =
    geometry === "point"
      ? { marker: { shape: "circle", color: COLOR, size: 10 } }
      : geometry === "line"
        ? { line: { color: COLOR, width: 2 } }
        : { fill: { color: COLOR, opacity: 0.8 }, outline: false };
  return { version: 1, kind: "vector", symbol } as LayerStyle;
}
