// What the data view's right side holds and how far from the map's right edge each part sits.
// The feature editor and the layer settings / toolbox panel run the whole height at the right edge, so the map
// controls move left of them. The measure card is a short card at the top of the controls' column: it sits above
// the controls instead of pushing them aside, so opening Measure leaves them in place.
import type { MeasureToolType } from "@/components/map/controls/measure/Measure";

const EDGE = 10;
const GAP = 16;
const MEASURE_CARD_WIDTH = 320;
const FEATURE_EDIT_PANEL_WIDTH = 320;
/** The right panel's width (layer settings, the style editor); the style editor's popovers are as wide. */
export const RIGHT_PANEL_WIDTH = 300;

/** The measure card renders once a tool is picked or something is measured, not for the tool menu alone. */
export function isMeasureCardShown({
  measureOpen,
  activeTool,
  measurementCount,
}: {
  measureOpen: boolean;
  activeTool: MeasureToolType | undefined;
  measurementCount: number;
}): boolean {
  return measurementCount > 0 || (measureOpen && activeTool !== undefined);
}

const stackWidth = (widths: number[]) =>
  widths.length ? widths.reduce((a, b) => a + b, 0) + GAP * (widths.length - 1) : 0;

export interface RightStackInsets {
  /** Width of the full-height panels at the right edge, 0 when none is open. */
  panelsWidth: number;
  /** `right` of the map controls' column (and the measure card above them). */
  controlsRight: number;
  /** `right` of the fixed-popup host: clear of every panel and card on the right. */
  popupRight: number;
}

export function rightStackInsets({
  measureCard,
  featureEdit,
  rightPanel,
  explorerActive,
  explorerRightRoom,
}: {
  measureCard: boolean;
  featureEdit: boolean;
  rightPanel: boolean;
  explorerActive: boolean;
  /** The Explorer's right panel plus its gap, 0 when it is closed. */
  explorerRightRoom: number;
}): RightStackInsets {
  // The right-hand panels belong to the data view, not the Explorer.
  const panels: number[] = [];
  if (featureEdit && !explorerActive) panels.push(FEATURE_EDIT_PANEL_WIDTH);
  if (rightPanel && !explorerActive) panels.push(RIGHT_PANEL_WIDTH);
  const panelsWidth = stackWidth(panels);
  const all = stackWidth(measureCard ? [MEASURE_CARD_WIDTH, ...panels] : panels);
  return {
    panelsWidth,
    controlsRight: (panelsWidth ? panelsWidth + GAP : 0) + EDGE + (explorerActive ? explorerRightRoom : 0),
    popupRight: (all ? all + GAP : 0) + EDGE,
  };
}
