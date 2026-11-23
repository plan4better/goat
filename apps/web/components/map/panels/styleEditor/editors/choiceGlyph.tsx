// Small pictures of a choice for its dropdown: dash patterns, fill patterns, line ends and corners, anchor positions
// and the sides of a point's label.
import type { ReactNode } from "react";

import type { Geometry } from "@/lib/style/compile/types";

import { PatternPicture } from "@/components/map/panels/styleEditor/pickers/PatternTiles";

/** SVG dash arrays of the dash choices, for pictures of a dash. */
export const DASH_ARRAYS: Record<string, string | undefined> = {
  solid: undefined,
  dashed: "6 3",
  dotted: "0.1 3",
  dash_dot: "6 2.5 0.1 2.5",
};

function Svg({ width, children }: { width: number; children: ReactNode }) {
  return (
    <svg width={width} height="14" viewBox={`0 0 ${width} 14`} aria-hidden="true" style={{ flex: "none" }}>
      {children}
    </svg>
  );
}

/** The anchor positions as a 3 x 3 grid, row by row. */
const ANCHOR_GRID = [
  "top_left",
  "top",
  "top_right",
  "left",
  "center",
  "right",
  "bottom_left",
  "bottom",
  "bottom_right",
];

/** Nine dots, the `on` ones filled and larger (`size` their radius). */
function AnchorGrid({ on, size = 1.9 }: { on: readonly string[]; size?: number }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ flex: "none" }}>
      {ANCHOR_GRID.map((position, i) => {
        const lit = on.includes(position);
        return (
          <circle
            key={position}
            cx={2 + (i % 3) * 4}
            cy={2 + Math.floor(i / 3) * 4}
            r={lit ? size : 0.9}
            fill="currentColor"
            opacity={lit ? 1 : 0.45}
          />
        );
      })}
    </svg>
  );
}

/** The picture of `value` for the choice property `key` on `geometry`, or undefined when it has none. */
export function choiceGlyph(key: string, value: string, geometry?: Geometry): ReactNode | undefined {
  // An anchor: the anchor's dot of the nine.
  if (key === "marker.anchor") return <AnchorGrid on={[value]} />;
  // A label around its marker: the dot of the side it sits on, the middle one for the middle (`center`, an area's
  // `inside`); automatic, the four sides MapLibre picks from. Along a line, none.
  if (key === "label.placement" && geometry) {
    if (value === "line") return undefined;
    if (value === "auto") return <AnchorGrid on={["top", "left", "right", "bottom"]} size={1.4} />;
    if (value === "inside") return <AnchorGrid on={["center"]} />;
    return <AnchorGrid on={[value.replace("above", "top").replace("below", "bottom")]} />;
  }
  if (key === "line.dash" || key === "outline.dash")
    return (
      <Svg width={24}>
        <line
          x1="2"
          y1="7"
          x2="22"
          y2="7"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap={value === "solid" || value === "dashed" ? "butt" : "round"}
          strokeDasharray={DASH_ARRAYS[value]}
        />
      </Svg>
    );
  // The pattern's own picture, as the pattern editor and the map draw it.
  if (key === "fill.pattern") return value === "none" ? undefined : <PatternPicture kind={value} size={14} />;
  if (key === "line.cap")
    return (
      <Svg width={24}>
        <line
          x1="6"
          y1="7"
          x2="16"
          y2="7"
          stroke="currentColor"
          strokeWidth="6"
          strokeLinecap={value as "butt"}
        />
        <line
          x1="16"
          y1="2"
          x2="16"
          y2="12"
          stroke="currentColor"
          strokeWidth="0.75"
          strokeDasharray="1.5 1.5"
        />
      </Svg>
    );
  if (key === "line.join")
    return (
      <Svg width={24}>
        <polyline
          points="4,12 12,3 20,12"
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinejoin={value as "miter"}
        />
      </Svg>
    );
  return undefined;
}
