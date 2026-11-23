"use client";

// The slider of a number comparison (greater than, less than, at least, at most, between, not between) in the
// condition's editor, over the histogram of the whole layer, as the value list counts the whole layer's values. It
// shows once the histogram is there and the field has a range; the boxes under it stay for exact values. The editor
// mounts only when its row is opened, so a closed row asks the server for nothing.
import { memo, useMemo } from "react";

import { useProjectLayerHistogramStats } from "@/lib/api/projects";
import type { FilterOp } from "@/lib/filter/model";

import { HistogramSlider, type HistogramSliderMode } from "@/components/common/HistogramSlider";

/** The histogram's bins: the style editor's, so both read one answer. */
const BINS = 28;

/** What each comparison with a slider keeps of the range. */
export const SLIDER_MODES: Partial<Record<FilterOp, HistogramSliderMode>> = {
  is_greater_than: "above",
  is_at_least: "above",
  is_less_than: "below",
  is_at_most: "below",
  is_between: "between",
  is_not_between: "outside",
};

const numberOf = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export const NumberSlider = memo(function NumberSlider({
  layerId,
  field,
  op,
  integer,
  value,
  value2,
  onChange,
}: {
  layerId: string;
  field: string;
  op: FilterOp;
  integer: boolean;
  value: unknown;
  value2: unknown;
  onChange: (value: number, value2: number | undefined) => void;
}) {
  const params = useMemo(
    () => ({ column_name: field, num_bins: BINS, method: "equal_interval" as const }),
    [field]
  );
  const { histogramStats } = useProjectLayerHistogramStats(layerId, params);
  const mode = SLIDER_MODES[op];
  if (!histogramStats || !mode) return null;
  return (
    <HistogramSlider
      bins={histogramStats.bins}
      mode={mode}
      value={numberOf(value)}
      value2={numberOf(value2)}
      integer={integer}
      onChange={onChange}
      sx={{ px: 3, pt: 1 }}
    />
  );
});
