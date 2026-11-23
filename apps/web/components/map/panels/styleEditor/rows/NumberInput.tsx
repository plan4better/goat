// A number box that keeps what is typed as a draft until it reads as a number; percent boxes show 0 to 100 and
// report 0 to 1. Numbers show in the panel's language, as the summaries do ("1,5" in German), and a box takes the
// language's decimal separator or a point. A box grows with its value, so long numbers are never cut; `plain` draws the number as text beside a
// slider, as wide as its digits, a field on hover and focus. An optional number (`onClear`) may be emptied, its
// placeholder saying what applies then. A box whose number takes effect only as a whole (`commitOnLeave`) reports it
// when it is left or Enter is pressed, not while it is typed.
import { Box, InputBase, Typography } from "@mui/material";
import { type KeyboardEvent, type MouseEvent, memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { plainNumber } from "@/lib/style/editor/summaries";

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
  /** The number is shown and cannot be typed. */
  disabled?: boolean;
  onChange: (value: number) => void;
  /** The number is optional: an emptied box reports this. */
  onClear?: () => void;
  onBlur?: () => void;
  /** Report the number only when the box is left or Enter is pressed: a digit typed on the way is never sent. */
  commitOnLeave?: boolean;
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

const shown = (value: number | undefined, language: string, pct?: boolean) =>
  value === undefined || !Number.isFinite(value) ? "" : plainNumber(pct ? value * 100 : value, language);

/** The decimal separator of a language: "," in German. */
const decimals = new Map<string, string>();
function decimalOf(language: string): string {
  let decimal = decimals.get(language);
  if (decimal === undefined) {
    decimal =
      new Intl.NumberFormat(language).formatToParts(1.5).find((part) => part.type === "decimal")?.value ??
      ".";
    decimals.set(language, decimal);
  }
  return decimal;
}

/** What is typed as a number: the language's decimal separator or a point; undefined while it is not one yet. */
export function parseNumber(text: string, language: string): number | undefined {
  const decimal = decimalOf(language);
  const normalized = decimal === "." ? text : text.split(decimal).join(".");
  return NUMBER.test(normalized) ? Number(normalized) : undefined;
}

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
  disabled,
  onChange,
  onClear,
  onBlur,
  commitOnLeave,
}: NumberInputProps) {
  const { i18n } = useTranslation();
  const language = i18n.language;
  const [draft, setDraft] = useState(() => shown(value, language, pct));
  const sent = useRef(value);
  const shownIn = useRef(language);
  useEffect(() => {
    if (value !== sent.current || language !== shownIn.current) {
      sent.current = value;
      shownIn.current = language;
      setDraft(shown(value, language, pct));
    }
  }, [value, pct, language]);

  const type = (text: string) => {
    setDraft(text);
    if (commitOnLeave) return;
    if (text === "" && onClear) {
      sent.current = undefined;
      onClear();
      return;
    }
    const number = parseNumber(text, language);
    if (number === undefined) return;
    const next = pct ? number / 100 : number;
    sent.current = next;
    onChange(next);
  };
  const leave = () => {
    if (commitOnLeave) {
      // The number as a whole; the box shows the value there is until the answer brings the new one (a refused number
      // leaves it as it was).
      const number = parseNumber(draft, language);
      const next = number === undefined ? undefined : pct ? number / 100 : number;
      if (next !== undefined && next !== value) onChange(next);
    }
    setDraft(shown(value, language, pct));
    onBlur?.();
  };
  // Enter takes the number as leaving the box does.
  const enter = commitOnLeave
    ? (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }
    : undefined;
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
            "&:hover": { borderColor: disabled ? "transparent" : "divider" },
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
              disabled={disabled}
              onChange={(event) => type(event.target.value)}
              onBlur={leave}
              inputProps={{
                inputMode: "decimal",
                "aria-label": ariaLabel,
                onKeyDown: enter,
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
        placeholder={placeholder}
        disabled={disabled}
        clearable={false}
        inputProps={{
          inputMode: "decimal",
          "aria-label": ariaLabel,
          onKeyDown: enter,
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
