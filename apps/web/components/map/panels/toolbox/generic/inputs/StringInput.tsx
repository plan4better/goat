/**
 * Generic String Input Component
 *
 * Renders a text input for string values.
 */
import { Stack, TextField } from "@mui/material";

import { getEffectiveSchema } from "@/lib/utils/ogc-utils";

import type { ProcessedInput } from "@/types/map/ogc-processes";

import FormLabelHelper from "@/components/common/FormLabelHelper";

interface StringInputProps {
  input: ProcessedInput;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  disabled?: boolean;
  formValues?: Record<string, unknown>;
}

export default function StringInput({ input, value, onChange, disabled, formValues }: StringInputProps) {
  const effectiveSchema = getEffectiveSchema(input.schema);

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = event.target.value === "" ? undefined : event.target.value;
    onChange(newValue);
  };

  const placeholder = (() => {
    const template = input.uiMeta?.widget_options?.placeholder_template;
    if (typeof template === "string" && formValues) {
      let missing = false;
      const rendered = template.replace(/\{([^}]+)\}/g, (_, key: string) => {
        const v = formValues[key];
        if (v === undefined || v === null || v === "") {
          missing = true;
          return "";
        }
        return String(v);
      });
      return missing ? undefined : rendered;
    }
    return input.defaultValue !== undefined ? String(input.defaultValue) : undefined;
  })();

  return (
    <Stack>
      <FormLabelHelper label={input.title} tooltip={input.description} color="inherit" required={input.required} />
      <TextField
        size="small"
        value={value ?? ""}
        onChange={handleChange}
        disabled={disabled}
        inputProps={{
          minLength: effectiveSchema.minLength,
          maxLength: effectiveSchema.maxLength,
          pattern: effectiveSchema.pattern,
        }}
        placeholder={placeholder}
        fullWidth
      />
    </Stack>
  );
}
