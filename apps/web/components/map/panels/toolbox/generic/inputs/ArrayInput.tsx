/**
 * Generic Array Input Component
 *
 * Renders an input for array values (e.g., list of numbers for buffer distances).
 * Uses comma-separated text input for simplicity.
 */
import { Stack, TextField } from "@mui/material";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { getEffectiveSchema } from "@/lib/utils/ogc-utils";

import type { ProcessedInput } from "@/types/map/ogc-processes";

import FormLabelHelper from "@/components/common/FormLabelHelper";

interface ArrayInputProps {
  input: ProcessedInput;
  value: unknown[] | undefined;
  onChange: (value: unknown[] | undefined) => void;
  disabled?: boolean;
}

export default function ArrayInput({ input, value, onChange, disabled }: ArrayInputProps) {
  const { t } = useTranslation("common");
  const effectiveSchema = getEffectiveSchema(input.schema);
  const itemSchema = effectiveSchema.items;
  const itemType = itemSchema?.type || "string";
  const isNumeric = itemType === "number" || itemType === "integer";

  // Keep raw text in local state to allow free typing
  const [textValue, setTextValue] = useState(() => value?.join(", ") ?? "");

  // Sync from parent when value changes externally
  useEffect(() => {
    const newText = value?.join(", ") ?? "";
    if (newText !== textValue) {
      setTextValue(newText);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const parseValues = (text: string): unknown[] | undefined => {
    if (!text.trim()) {
      return undefined;
    }

    // Split by comma and process each value
    const parts = text
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p);
    const newValues: unknown[] = [];

    for (const part of parts) {
      if (isNumeric) {
        const num = Number(part);
        if (!isNaN(num)) {
          newValues.push(num);
        }
      } else {
        newValues.push(part);
      }
    }

    return newValues.length > 0 ? newValues : undefined;
  };

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const text = event.target.value;
    setTextValue(text);
  };

  // Parse and update parent on blur
  const handleBlur = () => {
    const parsed = parseValues(textValue);
    onChange(parsed);
  };

  return (
    <Stack>
      <FormLabelHelper label={input.title} tooltip={input.description} color="inherit" required={input.required} />
      <TextField
        size="small"
        value={textValue}
        onChange={handleChange}
        onBlur={handleBlur}
        disabled={disabled}
        placeholder={isNumeric ? t("array_input_placeholder_numeric") : t("array_input_placeholder")}
        fullWidth
        InputProps={{
          sx: { fontSize: "0.875rem" },
        }}
      />
    </Stack>
  );
}
