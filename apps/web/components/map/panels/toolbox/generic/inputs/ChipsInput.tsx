/**
 * Chips Input Component
 *
 * Renders an array of numbers as removable MUI Chips with a text input
 * for adding new values (type + Enter). Auto-computes default values
 * from related form fields (steps + limit) only when those fields change
 * via user action, not on every render.
 */
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import { Autocomplete, Chip, InputAdornment, Stack, TextField, Tooltip } from "@mui/material";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ProcessedInput } from "@/types/map/ogc-processes";

import FormLabelHelper from "@/components/common/FormLabelHelper";

interface ChipsInputProps {
  input: ProcessedInput;
  value: number[] | undefined;
  onChange: (value: number[] | undefined) => void;
  disabled?: boolean;
  formValues?: Record<string, unknown>;
  onValidationChange?: (hasError: boolean) => void;
}

export default function ChipsInput({ input, value, onChange, disabled, formValues = {}, onValidationChange }: ChipsInputProps) {
  const { t } = useTranslation("common");
  const [inputValue, setInputValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const computeFrom = input.uiMeta?.widget_options?.compute_from as
    | { steps_field: string; limit_fields: (string | { field: string; when?: Record<string, string> })[] }
    | undefined;

  // Resolve active limit from the first matching limit field
  const activeLimit = useMemo(() => {
    if (!computeFrom) return undefined;
    for (const entry of computeFrom.limit_fields) {
      const fieldName = typeof entry === "string" ? entry : entry.field;
      const when = typeof entry === "string" ? undefined : entry.when;

      // Check condition if present
      if (when) {
        const match = Object.entries(when).every(
          ([k, v]) => formValues[k] === v
        );
        if (!match) continue;
      }

      const val = formValues[fieldName];
      if (val !== undefined && val !== null) {
        return Number(val);
      }
    }
    return undefined;
  }, [computeFrom, formValues]);

  const steps = computeFrom ? (formValues[computeFrom.steps_field] as number | undefined) : undefined;
  const maxChips = steps ?? Infinity;

  // Compute default step sizes from steps + limit
  const computedKey = useMemo(() => {
    if (!steps || steps <= 0 || steps > 9 || !activeLimit || activeLimit <= 0) return undefined;
    if (steps > activeLimit) return undefined;
    const interval = activeLimit / steps;
    const vals = Array.from({ length: steps }, (_, i) => Math.round(interval * (i + 1)));
    return vals.join(",");
  }, [steps, activeLimit]);

  // Regenerate chips when the computed result changes (steps or limit changed),
  // or when the form empties them from outside — a reset to defaults that
  // leaves steps and limit as they were changes no computed result.
  const prevComputedKeyRef = useRef<string | undefined>(
    value && value.length > 0 ? computedKey : undefined
  );
  const isEmpty = !value || value.length === 0;
  const wasEmptyRef = useRef(isEmpty);
  const clearedByUserRef = useRef(false);
  const emitChange = useCallback(
    (next: number[] | undefined) => {
      clearedByUserRef.current = !next || next.length === 0;
      onChange(next);
    },
    [onChange]
  );
  useEffect(() => {
    const clearedFromOutside = isEmpty && !wasEmptyRef.current && !clearedByUserRef.current;
    wasEmptyRef.current = isEmpty;
    if (computedKey === undefined) return;
    if (prevComputedKeyRef.current === computedKey && !clearedFromOutside) return;
    prevComputedKeyRef.current = computedKey;
    emitChange(computedKey.split(",").map(Number));
  }, [computedKey, isEmpty, emitChange]);

  const chips = value ?? [];

  // Validate: last chip must equal the limit
  const validate = useCallback((vals: number[]): string | null => {
    if (vals.length === 0 || activeLimit === undefined) return null;
    const lastChip = vals[vals.length - 1];
    if (lastChip !== activeLimit) {
      return t("last_step_must_equal_limit", { limit: activeLimit });
    }
    return null;
  }, [activeLimit, t]);

  // Clear error when chips become valid (e.g. after regeneration)
  useEffect(() => {
    if (error && validate(chips) === null) {
      setError(null);
      onValidationChange?.(false);
    }
  }, [chips, error, validate, onValidationChange]);

  const updateError = (vals: number[]) => {
    const err = validate(vals);
    setError(err);
    onValidationChange?.(err !== null);
  };

  const addValue = (raw: string) => {
    const num = Number(raw.trim());
    if (!Number.isFinite(num) || num <= 0) return;
    if (activeLimit !== undefined && num > activeLimit) return;
    if (chips.length >= maxChips) return;
    const next = [...new Set([...chips, num])].sort((a, b) => a - b);
    emitChange(next);
    updateError(next);
  };

  const handleChange = (_event: unknown, nextValues: string[]) => {
    const parsed = nextValues
      .flatMap((v) => v.split(/[\s,;]+/))
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isFinite(v) && v > 0 && (activeLimit === undefined || v <= activeLimit));

    const unique = [...new Set(parsed)].sort((a, b) => a - b);
    const limited = unique.slice(0, maxChips);
    const result = limited.length > 0 ? limited : undefined;
    emitChange(result);
    updateError(result ?? []);
    setInputValue("");
  };

  const handleInputBlur = () => {
    if (inputValue.trim()) {
      addValue(inputValue);
    } else {
      updateError(chips);
    }
    setInputValue("");
  };

  const label = input.uiMeta?.label || input.title;

  return (
    <Stack>
      <FormLabelHelper label={label} tooltip={input.description} color="inherit" required={input.required} />
      <Autocomplete
        multiple
        freeSolo
        size="small"
        disabled={disabled}
        options={[]}
        value={chips.map(String)}
        inputValue={inputValue}
        onInputChange={(_event, next) => setInputValue(next)}
        onChange={handleChange}
        renderTags={(tagValues, getTagProps) =>
          tagValues.map((option, index) => (
            <Chip
              {...getTagProps({ index })}
              key={`${option}-${index}`}
              label={option}
              size="small"
            />
          ))
        }
        renderInput={(params) => (
          <TextField
            {...params}
            error={!!error}
            placeholder={chips.length >= maxChips ? "" : t("type_value_enter")}
            InputProps={{
              ...params.InputProps,
              ...(error
                ? {
                    endAdornment: (
                      <>
                        {params.InputProps.endAdornment}
                        <InputAdornment position="end">
                          <Tooltip title={error} arrow>
                            <ErrorOutlineIcon color="error" fontSize="small" />
                          </Tooltip>
                        </InputAdornment>
                      </>
                    ),
                  }
                : {}),
            }}
          />
        )}
        onBlur={handleInputBlur}
      />
    </Stack>
  );
}
