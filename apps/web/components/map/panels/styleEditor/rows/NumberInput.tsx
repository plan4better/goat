// A number box that keeps what is typed as a draft until it reads as a number; percent boxes show 0 to 100 and
// report 0 to 1. A box grows with its value, so long numbers are never cut; `plain` draws the number as text beside a
// slider, as wide as its digits, a field on hover and focus.
import { Box, InputBase, Typography } from "@mui/material";
import { type MouseEvent, memo, useEffect, useRef, useState } from "react";

import TextFieldInput from "@/components/map/panels/common/TextFieldInput";

const NUMBER = /^-?\d+(\.\d+)?$/;
/** A plain number's text: the number fields' size and weight (TextFieldInput), digits of one width, so the slider's
 * value does not shift while it changes. */
const NUMBER_FONT = { fontSize: "0.875rem", fontWeight: 400, fontVariantNumeric: "tabular-nums" } as const;

export interface NumberInputProps {
  value: number | undefined;
  unit?: string;
  pct?: boolean;
  min?: number;
  max?: number;
  width?: number;
  ariaLabel?: string;
  /** The number as text, a field on hover and focus (beside a slider). */
  plain?: boolean;
  /** Characters a plain number keeps room for, so its width holds while a slider moves it. */
  reserve?: number;
  /** Shown while the box is empty: the value that applies then. */
  placeholder?: string;
  onChange: (value: number) => void;
  onBlur?: () => void;
}

/** A press on the box around the field (its unit, its paddings) focuses the field with its number selected, ready to
 * be typed over; a press in the digits places the caret as usual. */
function focusField(event: MouseEvent<HTMLElement>) {
  const input = event.currentTarget.querySelector("input");
  if (!input || event.target === input) return;
  event.preventDefault();
  input.focus();
  input.select();
}

const shown = (value: number | undefined, pct?: boolean) =>
  value === undefined || !Number.isFinite(value)
    ? ""
    : String(Number((pct ? value * 100 : value).toFixed(2)));

export const NumberInput = memo(function NumberInput({
  value,
  unit,
  pct,
  min,
  max,
  width = 68,
  ariaLabel,
  plain,
  reserve = 2,
  placeholder,
  onChange,
  onBlur,
}: NumberInputProps) {
  const [draft, setDraft] = useState(() => shown(value, pct));
  const sent = useRef(value);
  useEffect(() => {
    if (value !== sent.current) {
      sent.current = value;
      setDraft(shown(value, pct));
    }
  }, [value, pct]);

  const type = (text: string) => {
    setDraft(text);
    if (!NUMBER.test(text)) return;
    const next = pct ? Number(text) / 100 : Number(text);
    sent.current = next;
    onChange(next);
  };
  const leave = () => {
    setDraft(shown(value, pct));
    onBlur?.();
  };
  const unitText = pct ? "%" : unit;

  if (plain)
    return (
      // The room of the longest value of its range is kept (the slider holds still and the sliders of a panel line
      // up); the number starts right after the slider, its unit behind it, the free room after both.
      <Box
        data-reserve={reserve}
        data-number
        onMouseDown={focusField}
        sx={{
          flex: "none",
          display: "flex",
          fontSize: "0.875rem",
          // The digits, the unit in its smaller text (12 of 14 px) and the field's paddings and gap.
          minWidth: `calc(${reserve + (unitText?.length ?? 0) * 0.86}ch + 11px)`,
        }}>
        <Box
          sx={{
            display: "inline-flex",
            alignItems: "center",
            gap: 0.75,
            height: 30,
            px: 1,
            border: 1,
            borderColor: "transparent",
            borderRadius: 1.5,
            "&:hover": { borderColor: "divider" },
            "&:focus-within": { borderColor: "primary.main" },
          }}>
          {/* As wide as its text: a hidden copy of the number sizes the field (a point is narrower than a digit). */}
          {/* As wide as its text: a hidden copy of the number sizes the box (a point is narrower than a digit), and the
              field lies over it, adding no width of its own. */}
          <Box sx={{ position: "relative", display: "inline-block" }}>
            <Box
              component="span"
              aria-hidden="true"
              data-sizer
              sx={{ ...NUMBER_FONT, display: "block", visibility: "hidden", whiteSpace: "pre" }}>
              {draft || placeholder || " "}
            </Box>
            <InputBase
              value={draft}
              placeholder={placeholder}
              onChange={(event) => type(event.target.value)}
              onBlur={leave}
              inputProps={{
                inputMode: "decimal",
                "aria-label": ariaLabel,
                min,
                max,
                style: { width: "100%", padding: 0 },
              }}
              sx={{ ...NUMBER_FONT, position: "absolute", inset: 0, minWidth: 0 }}
            />
          </Box>
          {unitText && (
            <Typography component="span" sx={{ fontSize: 12, color: "text.secondary" }}>
              {unitText}
            </Typography>
          )}
        </Box>
      </Box>
    );

  // Wider than asked when the value needs it: about a digit's width a character, the unit and the paddings besides.
  const fits = 30 + draft.length * 8 + (unitText ? unitText.length * 8 + 8 : 0);
  return (
    // The tool forms' number field: TextFieldInput with the unit after the digits.
    <Box data-number onMouseDown={focusField} sx={{ width: Math.max(width, fits), flex: "none" }}>
      <TextFieldInput
        value={draft}
        unit={unitText}
        clearable={false}
        inputProps={{
          inputMode: "decimal",
          "aria-label": ariaLabel,
          min,
          max,
          style: { textAlign: "right" },
        }}
        onChange={type}
        onBlur={leave}
      />
    </Box>
  );
});
