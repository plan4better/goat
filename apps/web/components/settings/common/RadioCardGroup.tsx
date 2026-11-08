"use client";

import { Box, ButtonBase, Typography, alpha, useTheme } from "@mui/material";
import { type KeyboardEvent, type ReactNode, useRef } from "react";

export interface RadioCardOption<V extends string> {
  value: V;
  label: ReactNode;
  line?: ReactNode;
  /** Right of the label: "3 von 10 frei". */
  figure?: ReactNode;
  /** Before the label: a badge or a mark. */
  lead?: ReactNode;
  disabled?: boolean;
  /** Replaces the line while disabled. */
  disabledReason?: string;
  lang?: string;
  /** In the card but outside the radio, at the right: buttons, a ⋮ menu. */
  actions?: ReactNode;
  /** In the card below the radio: a switch that belongs to this option. */
  extra?: ReactNode;
}

/**
 * Options as bordered cards with a radio dot (Sprache, Erscheinungsbild, the
 * invite dialog's roles, KI's connections and data policy). One tab stop; the
 * arrow keys move to the next enabled card and pick it, as native radios do.
 */
export default function RadioCardGroup<V extends string>({
  label,
  value,
  options,
  onChange,
  onDisabledClick,
  columns = { xs: 1 },
}: {
  label: string;
  value: V | null;
  options: RadioCardOption<V>[];
  // NoInfer: V comes from `value` and `options`. A `useState` setter passed as
  // `onChange` would otherwise widen V to string.
  onChange: (value: NoInfer<V>) => void;
  onDisabledClick?: (value: NoInfer<V>) => void;
  columns?: { xs?: number; md?: number };
}) {
  const theme = useTheme();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.flatMap((option, index) => (option.disabled ? [] : [index]));
  const checkedIndex = options.findIndex((option) => option.value === value);
  const tabStop = checkedIndex >= 0 && !options[checkedIndex].disabled ? checkedIndex : (enabled[0] ?? -1);

  // The next enabled card after (or before) `from`, wrapping round. `from`
  // may be a disabled card: a click focuses it to say why it is disabled.
  const move = (from: number, step: 1 | -1) => {
    if (enabled.length === 0) return;
    const next =
      step === 1
        ? (enabled.find((index) => index > from) ?? enabled[0])
        : (enabled.findLast((index) => index < from) ?? enabled[enabled.length - 1]);
    refs.current[next]?.focus();
    onChange(options[next].value);
  };

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      move(index, 1);
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      move(index, -1);
    }
  };

  const track = (n: number | undefined) => `repeat(${n ?? 1}, minmax(0, 1fr))`;

  return (
    <Box
      role="radiogroup"
      aria-label={label}
      sx={{
        display: "grid",
        gap: 3,
        gridTemplateColumns: { xs: track(columns.xs), md: track(columns.md ?? columns.xs) },
      }}>
      {options.map((option, index) => {
        const checked = option.value === value;
        const line = option.disabled && option.disabledReason ? option.disabledReason : option.line;
        return (
          <Box
            key={option.value}
            sx={{
              border: `1.5px solid ${checked ? theme.palette.primary.main : theme.palette.divider}`,
              borderRadius: "12px",
              backgroundColor: checked ? alpha(theme.palette.primary.main, 0.06) : "transparent",
            }}>
            <Box sx={{ display: "flex", alignItems: "flex-start", gap: 2, p: 3 }}>
              <ButtonBase
                ref={(node: HTMLButtonElement | null) => {
                  refs.current[index] = node;
                }}
                role="radio"
                aria-checked={checked}
                aria-disabled={option.disabled || undefined}
                tabIndex={index === tabStop ? 0 : -1}
                lang={option.lang}
                onClick={() => (option.disabled ? onDisabledClick?.(option.value) : onChange(option.value))}
                onKeyDown={(event) => onKeyDown(event, index)}
                sx={{
                  flex: 1,
                  minWidth: 0,
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "flex-start",
                  gap: 3,
                  textAlign: "left",
                  // The app's font: a bare button would fall back to the browser's.
                  fontFamily: "inherit",
                  borderRadius: "8px",
                  opacity: option.disabled ? 0.6 : 1,
                  cursor: option.disabled ? "default" : "pointer",
                  // ButtonBase drops the outline; keyboard focus needs a visible mark.
                  "&.Mui-focusVisible": {
                    outline: `2px solid ${theme.palette.primary.main}`,
                    outlineOffset: 2,
                  },
                }}>
                <Box
                  component="span"
                  aria-hidden
                  sx={{
                    mt: "3px",
                    width: 16,
                    height: 16,
                    flexShrink: 0,
                    borderRadius: "50%",
                    border: `2px solid ${checked ? theme.palette.primary.main : theme.palette.text.secondary}`,
                    display: "grid",
                    placeItems: "center",
                  }}>
                  {checked && (
                    <Box
                      component="span"
                      sx={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: "primary.main" }}
                    />
                  )}
                </Box>
                {option.lead}
                <Box component="span" sx={{ flex: 1, minWidth: 0 }}>
                  <Typography component="span" sx={{ display: "block", fontSize: 14, fontWeight: 700 }}>
                    {option.label}
                  </Typography>
                  {line && (
                    <Typography
                      component="span"
                      sx={{ display: "block", fontSize: 13, color: "text.secondary" }}>
                      {line}
                    </Typography>
                  )}
                </Box>
                {option.figure && (
                  <Box component="span" sx={{ flexShrink: 0, fontSize: 13 }}>
                    {option.figure}
                  </Box>
                )}
              </ButtonBase>
              {option.actions && (
                <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexShrink: 0 }}>
                  {option.actions}
                </Box>
              )}
            </Box>
            {option.extra && <Box sx={{ px: 3, pb: 3 }}>{option.extra}</Box>}
          </Box>
        );
      })}
    </Box>
  );
}
