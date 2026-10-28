// A number as a slider and its value as text that turns into a field (room kept for the longest value of the range,
// so the slider holds still). `onChange` fires on every tick (the map follows the drag), `onCommit` once on release.
import { Slider } from "@mui/material";
import { type ReactNode, memo } from "react";

import { NumberInput } from "@/components/map/panels/styleEditor/rows/NumberInput";
import { Row } from "@/components/map/panels/styleEditor/rows/Row";

/** Every slider row keeps at least this much room for its value ("100", "60.5", "2000"), so the sliders of a panel
 * line up; a longer range ("-10.0") keeps its own. */
const VALUE_CHARS = 4;

/** The characters of the longest value a slider shows: its ends at the step's decimals ("60.5" for 0 to 60 by 0.5). */
export function valueChars(min: number, max: number, step: number, pct?: boolean): number {
  const scale = pct ? 100 : 1;
  const decimals = (String(Number((step * scale).toFixed(6))).split(".")[1] ?? "").length;
  return Math.max(...[min, max].map((end) => (end * scale).toFixed(decimals).length));
}

export interface SliderRowProps {
  label: ReactNode;
  min: number;
  max: number;
  step: number;
  value: number;
  unit?: string;
  pct?: boolean;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  mode?: ReactNode;
  note?: ReactNode;
  off?: boolean;
}

export const SliderRow = memo(function SliderRow({
  label,
  min,
  max,
  step,
  value,
  unit,
  pct,
  onChange,
  onCommit,
  mode,
  note,
  off,
}: SliderRowProps) {
  return (
    <Row label={label} actions={mode} note={note} off={off}>
      <Slider
        size="small"
        min={min}
        max={max}
        step={step}
        value={Math.min(Math.max(value, min), max)}
        aria-label={typeof label === "string" ? label : undefined}
        onChange={(_, next) => onChange(next as number)}
        onChangeCommitted={(_, next) => onCommit?.(next as number)}
        // The thumb is centred on the track's ends: the margins keep it clear of the label and the number.
        sx={{ flex: 1, minWidth: 0, ml: 1, mr: 1 }}
      />
      <NumberInput
        value={value}
        unit={unit}
        pct={pct}
        plain
        reserve={Math.max(VALUE_CHARS, valueChars(min, max, step, pct))}
        ariaLabel={typeof label === "string" ? label : undefined}
        onChange={(next) => {
          onChange(next);
          onCommit?.(next);
        }}
      />
    </Row>
  );
});
