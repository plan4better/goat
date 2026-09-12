import { FormControl, FormHelperText, Stack, useTheme } from "@mui/material";
import { DatePicker } from "@mui/x-date-pickers/DatePicker";
import { DateTimePicker } from "@mui/x-date-pickers/DateTimePicker";
import { LocalizationProvider } from "@mui/x-date-pickers/LocalizationProvider";
import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import dayjs, { type Dayjs } from "dayjs";
import utc from "dayjs/plugin/utc";
import { useState } from "react";

import {
  TEMPORAL_DATE_FORMAT,
  TEMPORAL_DISPLAY_FORMAT,
  TEMPORAL_VALUE_FORMAT,
} from "./temporalFormats";

dayjs.extend(utc);

// Values are UTC instants (or naive wall times, which the platform treats as
// UTC). Parse in UTC so offset-suffixed values show their UTC wall time
// instead of shifting to the browser's timezone; the emitted literal is the
// wall time as picked, never converted.
const parseValue = (value?: string): Dayjs | null => {
  if (!value) return null;
  const parsed = dayjs.utc(value);
  return parsed.isValid() ? parsed : null;
};

type TemporalPickerProps = {
  /** "date" emits and displays a bare `YYYY-MM-DD` with no time part. */
  kind?: "datetime" | "date";
  value?: string;
  onChange: (value: string) => void;
  label?: string;
  disabled?: boolean;
  /** Bold field text, as `TimePicker` renders it — for a picker sitting
   * alongside one in the same panel. */
  bold?: boolean;
  /** `YYYY-MM-DD` bounds, for a field whose valid dates are a known range. */
  min?: string;
  max?: string;
};

export default function TemporalPicker(props: TemporalPickerProps) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);

  const dateOnly = props.kind === "date";
  const valueFormat = dateOnly ? TEMPORAL_DATE_FORMAT : TEMPORAL_VALUE_FORMAT;

  const handleChange = (next: Dayjs | null) => {
    props.onChange(next && next.isValid() ? next.format(valueFormat) : "");
  };

  // Shared between the two pickers: identical field chrome either way, so the
  // only difference a caller gets from `kind` is whether a time is asked for.
  const commonProps = {
    value: parseValue(props.value),
    onChange: handleChange,
    disabled: props.disabled,
    minDate: parseValue(props.min) ?? undefined,
    maxDate: parseValue(props.max) ?? undefined,
    slotProps: {
      textField: {
        size: "small" as const,
        fullWidth: true,
        onFocus: () => setFocused(true),
        onBlur: () => setFocused(false),
      },
      actionBar: { actions: [] as never[] },
    },
    sx: {
      "& .MuiInputBase-root": {
        height: "40px",
        fontWeight: props.bold ? theme.typography.fontWeightBold : undefined,
        fontSize: theme.typography.body2.fontSize,
        color: theme.palette.text.secondary,
      },
    },
  };

  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <FormControl size="small" fullWidth>
        {/* Label above the input, matching the platform's panel inputs
            (FormLabelHelper pattern) instead of MUI's floating label. */}
        {!!props.label && (
          <Stack
            direction="row"
            alignItems="center"
            sx={{
              color: focused ? theme.palette.primary.main : theme.palette.text.secondary,
              mb: 1,
            }}>
            <FormHelperText sx={{ color: "inherit", ml: 0, mt: 0, mr: 1 }}>{props.label}</FormHelperText>
          </Stack>
        )}
        {dateOnly ? (
          <DatePicker {...commonProps} format={TEMPORAL_DATE_FORMAT} />
        ) : (
          <DateTimePicker {...commonProps} format={TEMPORAL_DISPLAY_FORMAT} ampm={false} />
        )}
      </FormControl>
    </LocalizationProvider>
  );
}
