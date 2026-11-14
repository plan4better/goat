"use client";

// A number condition over the field's distribution: the field's histogram with the bars the comparison keeps in the
// primary color, a slider under it (one thumb for above or below a value, two for between or outside a range) and the
// field's minimum and maximum under the track. A drag moves the thumbs and the bars' colors only; the value counts once
// the thumb is let go or a key steps it. A value outside the field's range stays as it is, its thumb at the end.
import { Box, Slider, type SxProps, type Theme, Typography, alpha, useTheme } from "@mui/material";
import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Histogram, type HistogramBin } from "@/components/map/panels/styleEditor/editors/Histogram";

/** What a condition keeps of the range: above or below one value, between or outside two. */
export type HistogramSliderMode = "above" | "below" | "between" | "outside";

const NO_BREAKS: number[] = [];

/** The step over a range `span` wide: a hundredth of it, rounded to 1, 2 or 5 times a power of ten. */
export function niceStep(span: number): number {
  const raw = span / 100;
  const power = 10 ** Math.floor(Math.log10(raw));
  const m = raw / power;
  return Number(((m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * power).toPrecision(1));
}

/** The field's range, the step and the slider's ends (the range widened to whole steps); null without a range. */
function scaleOf(bins: HistogramBin[], integer: boolean | undefined) {
  if (!bins.length) return null;
  const min = bins[0].range[0];
  const max = bins[bins.length - 1].range[1];
  if (!(min < max)) return null;
  const step = integer ? Math.max(1, niceStep(max - min)) : niceStep(max - min);
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const round = (v: number) => Number(v.toFixed(decimals));
  const lo = round(Math.floor(min / step + 1e-9) * step);
  const hi = round(Math.ceil(max / step - 1e-9) * step);
  return { min, max, step, round, lo, hi, mid: round(lo + Math.round((hi - lo) / 2 / step) * step) };
}

export interface HistogramSliderProps {
  bins: HistogramBin[];
  mode: HistogramSliderMode;
  value: number | undefined;
  /** The upper end of a range (between, outside). */
  value2?: number;
  /** Whole numbers: the slider never steps by less than 1. */
  integer?: boolean;
  /** A value changed, on release or a key's step; `value2` only for a range. */
  onChange: (value: number, value2: number | undefined) => void;
  disabled?: boolean;
  /** The block's own spacing; none is drawn without a range. */
  sx?: SxProps<Theme>;
}

export const HistogramSlider = memo(function HistogramSlider({
  bins,
  mode,
  value,
  value2,
  integer,
  onChange,
  disabled,
  sx,
}: HistogramSliderProps) {
  const theme = useTheme();
  const { t, i18n } = useTranslation("common");
  const scale = useMemo(() => scaleOf(bins, integer), [bins, integer]);
  // The thumbs while one is dragged; null while they show the row's values.
  const [moving, setMoving] = useState<number[] | null>(null);
  if (!scale) return null;
  const { min, max, step, round, lo, hi, mid } = scale;
  const range = mode === "between" || mode === "outside";
  // Where the thumbs rest: at the row's values, held to the slider's ends; a missing one mid-range (one thumb) or at
  // its end (two).
  const original = range ? [value, value2] : [value];
  const resting = original.map((v, i) =>
    v === undefined ? (range ? [lo, hi][i] : mid) : Math.min(Math.max(v, lo), hi)
  );
  const [a, b] = moving ?? resting;
  const keeps = (v: number) =>
    mode === "above"
      ? v >= a
      : mode === "below"
        ? v <= a
        : mode === "between"
          ? v >= a && v <= b
          : v < a || v > b;
  const on = theme.palette.primary.main;
  const off = alpha(theme.palette.text.primary, 0.22);

  const commit = (next: number | number[]) => {
    setMoving(null);
    // A thumb left where it rests keeps the row's value, also one outside the field's range. A shift step adds without
    // rounding: the sum is rounded to the step's decimals.
    const kept = (typeof next === "number" ? [next] : next).map((v, i) =>
      v === resting[i] && original[i] !== undefined ? (original[i] as number) : round(v)
    );
    if (kept.every((v, i) => v === original[i])) return;
    onChange(kept[0], range ? kept[1] : undefined);
  };

  const pct = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const number = (n: number) => n.toLocaleString(i18n.language);
  return (
    <Box sx={sx}>
      {/* Room for the thumbs at the track's ends; the bars span the field's range on the slider's scale. */}
      <Box sx={{ mx: 1.5 }}>
        <Box style={{ marginLeft: `${pct(min)}%`, marginRight: `${100 - pct(max)}%` }}>
          <Histogram bins={bins} breaks={NO_BREAKS} colorAt={(v) => (keeps(v) ? on : off)} />
        </Box>
        <Slider
          size="small"
          min={lo}
          max={hi}
          step={step}
          shiftStep={step * 10}
          value={range ? [a, b] : a}
          // The filled part is what the condition keeps.
          track={mode === "above" || mode === "outside" ? "inverted" : "normal"}
          disableSwap
          disabled={disabled}
          aria-label={range ? undefined : t("style_editor.condition_value")}
          getAriaLabel={
            range
              ? (index) => t(index === 0 ? "style_editor.condition_value" : "style_editor.condition_value_to")
              : undefined
          }
          onChange={(_, next) => setMoving(typeof next === "number" ? [next] : next)}
          onChangeCommitted={(_, next) => commit(next)}
          sx={{ display: "block", py: 2.5 }}
        />
      </Box>
      <Box sx={{ display: "flex", justifyContent: "space-between", gap: 2 }}>
        <Typography variant="caption" color="text.secondary">
          {number(min)}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {number(max)}
        </Typography>
      </Box>
    </Box>
  );
});
