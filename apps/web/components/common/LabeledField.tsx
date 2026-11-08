"use client";

import { Box, TextField, type TextFieldProps, Typography } from "@mui/material";
import { type ReactNode, forwardRef } from "react";
import { useTranslation } from "react-i18next";

export type LabeledFieldProps = Omit<
  TextFieldProps,
  "label" | "size" | "fullWidth" | "helperText" | "error" | "id" | "required"
> & {
  id: string;
  label: string;
  required?: boolean;
  help?: ReactNode;
  /** In place of the help, in error ink. */
  error?: string;
  /** "12/50" at the right end of the help line. */
  counter?: { value: number; max: number };
};

/**
 * Add Layer's field (decision 7): a real label in bold above a small field,
 * the help or the error below, an optional counter. `required` marks the
 * label and sets `aria-required`; it never turns on the browser's own
 * validation, which would stop the submit before the form's rules run.
 */
const LabeledField = forwardRef<HTMLInputElement, LabeledFieldProps>(function LabeledField(
  { id, label, required, help, error, counter, inputProps, select, SelectProps, ...rest },
  ref
) {
  const { t } = useTranslation("common");
  const labelId = `${id}-label`;
  const ariaRequired = required ? { "aria-required": true } : {};
  const helper =
    error || help || counter ? (
      <Box component="span" sx={{ display: "flex", gap: 2 }}>
        <Box component="span" sx={{ flex: 1, minWidth: 0 }}>
          {error ?? help}
        </Box>
        {counter && (
          <Box component="span" sx={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
            {t("settings_counter", { value: counter.value, max: counter.max })}
          </Box>
        )}
      </Box>
    ) : undefined;

  return (
    <Box>
      <Typography
        component="label"
        id={labelId}
        // A select's id lands on MUI's hidden native input: the label names
        // the combobox through `labelId` instead, which also focuses it on a
        // click.
        htmlFor={select ? undefined : id}
        variant="body2"
        sx={{ display: "block", fontWeight: 700, mb: 1.5 }}>
        {label}
        {required && (
          <Box component="span" aria-hidden sx={{ color: "text.secondary" }}>
            {" *"}
          </Box>
        )}
      </Typography>
      <TextField
        {...rest}
        id={id}
        inputRef={ref}
        size="small"
        fullWidth
        error={!!error}
        helperText={helper}
        select={select}
        inputProps={select ? inputProps : { ...inputProps, ...ariaRequired }}
        SelectProps={
          select
            ? {
                ...SelectProps,
                labelId,
                // Required and invalid belong on the combobox, not on the
                // aria-hidden native input that gets `inputProps`.
                SelectDisplayProps: {
                  ...SelectProps?.SelectDisplayProps,
                  ...ariaRequired,
                  ...(error ? { "aria-invalid": true } : {}),
                },
              }
            : SelectProps
        }
      />
    </Box>
  );
});

export default LabeledField;
