"use client";

// A circle's radius under its row in the area's list, laid out as the style editor's slider rows are: a slider over the
// radii a circle is mostly given, and the radius as a number, in meters below a kilometer and in kilometers from one.
// A number typed may lie beyond the slider's ends (a drawn circle can be any size), and keeps the unit it is typed in
// until the field is left, so typing "1200" in meters does not turn into kilometers halfway. A radius between the
// slider's steps (a circle drawn on the map) sits on the slider as it is; the slider moves it to a step.
import { Box, Slider } from "@mui/material";
import { memo, useState } from "react";
import { useTranslation } from "react-i18next";

import { BUFFER_STEP_KM, MAX_BUFFER_KM, MIN_BUFFER_KM } from "@/lib/catalog/spatial";

import { NumberInput, Row } from "@/components/map/panels/styleEditor/rows";

type Unit = "m" | "km";

const unitOf = (km: number): Unit => (km < 1 ? "m" : "km");

/** The slider's next radius from `km`: a step, the next one the way the slider went. A drag already comes as a step;
 * a key moves the slider's input by the browser's own amount, as the input takes any value. */
function sliderStep(next: number, km: number): number {
  const steps = (next - MIN_BUFFER_KM) / BUFFER_STEP_KM;
  if (Number.isInteger(steps)) return next;
  return MIN_BUFFER_KM + (next > km ? Math.ceil(steps) : Math.floor(steps)) * BUFFER_STEP_KM;
}

/** Room for the longest number shown: "999" meters, "25.5" kilometers. */
const RESERVE = 4;

export const RadiusRow = memo(function RadiusRow({
  km,
  disabled,
  onChange,
}: {
  km: number;
  /** The circle is being edited on the map, which has the say until it is done. */
  disabled?: boolean;
  onChange: (km: number) => void;
}) {
  const { t } = useTranslation("common");
  const label = t("filter_panel.area_radius");
  // The unit the number is being typed in, while the field has the focus.
  const [typing, setTyping] = useState<Unit | null>(null);
  const unit = typing ?? unitOf(km);
  return (
    <Row label={label} off={disabled}>
      <Slider
        size="small"
        min={MIN_BUFFER_KM}
        max={MAX_BUFFER_KM}
        step={BUFFER_STEP_KM}
        value={Math.min(Math.max(km, MIN_BUFFER_KM), MAX_BUFFER_KM)}
        disabled={disabled}
        aria-label={label}
        // A browser rounds a range input's value to the input's step: without one, it holds the radius as it is.
        slotProps={{ input: { step: "any" } }}
        onChange={(_, next) => onChange(sliderStep(next as number, km))}
        // The thumb is centred on the track's ends: the margins keep it clear of the label and the number.
        sx={{ flex: 1, minWidth: 0, ml: 1, mr: 1 }}
      />
      <Box sx={{ display: "contents" }} onFocus={() => setTyping(unit)} onBlur={() => setTyping(null)}>
        <NumberInput
          value={unit === "m" ? Math.round(km * 1000) : km}
          unit={unit}
          plain
          reserve={RESERVE}
          disabled={disabled}
          ariaLabel={label}
          onChange={(typed) => {
            if (typed > 0) onChange(unit === "m" ? typed / 1000 : typed);
          }}
        />
      </Box>
    </Row>
  );
});
