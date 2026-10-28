"use client";

// A time-enabled layer's slider under its row in the layer tree (spec 7.3): it moves over the field's steps and starts
// at the latest one. While dragging it hands its value on at a limited rate (`committed` false: shown, not written);
// letting go hands on the value to keep.
import { Box, Slider, Typography } from "@mui/material";
import { useEffect, useRef, useState } from "react";

import type { Time } from "@/lib/style/generated/types";
import type { TimeStep } from "@/lib/style/time";

import { useTimeSteps } from "@/hooks/map/useTimeSteps";

/** The least time between two values handed on while dragging, in ms. */
const DRAG_INTERVAL = 150;

export interface LayerTimeSliderProps {
  datasetId: string;
  time: Time;
  /** The stored slider value; without one the slider stands at the latest step. */
  value?: TimeStep | null;
  /** When the dataset's data last changed: its steps are asked again. */
  version?: string | null;
  onChange: (value: TimeStep, committed: boolean) => void;
}

export function LayerTimeSlider({ datasetId, time, value, version, onChange }: LayerTimeSliderProps) {
  const steps = useTimeSteps(datasetId, time, version);
  const stored = steps ? steps.findIndex((step) => step === value) : -1;
  const [index, setIndex] = useState<number | null>(null);
  const lastSent = useRef(0);
  // The stored value moved (another tab, a revalidation): follow it.
  useEffect(() => setIndex(null), [value]);
  if (!steps?.length) return null;
  const current = index ?? (stored >= 0 ? stored : steps.length - 1);

  return (
    <Box
      sx={{ display: "flex", alignItems: "center", gap: 1.5, pr: 1 }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}>
      <Slider
        size="small"
        min={0}
        max={steps.length - 1}
        step={1}
        value={current}
        disabled={steps.length < 2}
        getAriaValueText={(i) => String(steps[i])}
        onChange={(_, next) => {
          const i = next as number;
          setIndex(i);
          const now = Date.now();
          if (now - lastSent.current >= DRAG_INTERVAL) {
            lastSent.current = now;
            onChange(steps[i], false);
          }
        }}
        onChangeCommitted={(_, next) => {
          lastSent.current = 0;
          onChange(steps[next as number], true);
        }}
        sx={{ flex: 1, minWidth: 0 }}
      />
      <Typography variant="caption" sx={{ flex: "none", fontVariantNumeric: "tabular-nums" }}>
        {String(steps[current])}
      </Typography>
    </Box>
  );
}
