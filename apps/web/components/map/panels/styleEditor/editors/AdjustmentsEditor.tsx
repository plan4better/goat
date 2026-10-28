"use client";

// Image adjustments (prototype 3.6, spec 9.1): brightness, contrast and saturation from -1 to 1 (shown as percent),
// hue in degrees; 0 is the file as stored and stays out of the style.
import { Box, Button } from "@mui/material";
import { useTranslation } from "react-i18next";

import { setIn } from "@/lib/style/editor/store";

import { useEditor, useStyleValue } from "@/components/map/panels/styleEditor/context";
import { SliderRow } from "@/components/map/panels/styleEditor/rows";
import { ADJUSTMENTS } from "@/components/map/panels/styleEditor/sections/RasterGeneralSection";

type Adjustment = (typeof ADJUSTMENTS)[number];

const RANGES: Record<Adjustment, { min: number; max: number; step: number; unit?: string; pct?: boolean }> = {
  brightness: { min: -1, max: 1, step: 0.05, pct: true },
  contrast: { min: -1, max: 1, step: 0.05, pct: true },
  saturation: { min: -1, max: 1, step: 0.05, pct: true },
  hue: { min: 0, max: 359, step: 1, unit: "°" },
};

function AdjustmentRow({ name }: { name: Adjustment }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const value = useStyleValue<number | undefined>(name);
  const range = RANGES[name];
  return (
    <SliderRow
      label={t(`style_editor.${name}`)}
      min={range.min}
      max={range.max}
      step={range.step}
      unit={range.unit}
      pct={range.pct}
      value={value ?? 0}
      onChange={(next) => store.update((doc) => setIn(doc, name, next === 0 ? undefined : next), name)}
    />
  );
}

/** "Brightness +10%, Saturation +20%", or null for the file as stored. */
export function adjustmentsSummary(values: Partial<Record<Adjustment, unknown>>, t: (key: string) => string) {
  const parts = ADJUSTMENTS.flatMap((name) => {
    const v = values[name];
    if (typeof v !== "number" || v === 0) return [];
    const text = name === "hue" ? `${v}°` : `${v > 0 ? "+" : ""}${Math.round(v * 100)}%`;
    return [`${t(`style_editor.${name}`)} ${text}`];
  });
  return parts.length ? parts.join(", ") : null;
}

export function AdjustmentsEditor() {
  const { t } = useTranslation("common");
  const store = useEditor();
  return (
    <>
      {ADJUSTMENTS.map((name) => (
        <AdjustmentRow key={name} name={name} />
      ))}
      <Box sx={{ px: 3, pt: 2 }}>
        <Button
          size="small"
          color="inherit"
          onClick={() =>
            store.update((doc) => ADJUSTMENTS.reduce((out, name) => setIn(out, name, undefined), doc))
          }>
          {t("style_editor.reset_adjustments")}
        </Button>
      </Box>
    </>
  );
}
