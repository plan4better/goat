import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import { DateCalendar } from "@mui/x-date-pickers/DateCalendar";
import { LocalizationProvider } from "@mui/x-date-pickers/LocalizationProvider";
import dayjs, { type Dayjs } from "dayjs";
import "dayjs/locale/de";
import "dayjs/locale/en-gb";
import utc from "dayjs/plugin/utc";

import { TEMPORAL_DATE_FORMAT, type TemporalLocale } from "./temporalFormats";

dayjs.extend(utc);

// As TemporalPicker: `YYYY-MM-DD` read as a UTC day, so no timezone moves it.
const parseDay = (value?: string): Dayjs | null => {
  if (!value) return null;
  const parsed = dayjs.utc(value);
  return parsed.isValid() ? parsed : null;
};

type TemporalCalendarProps = {
  /** `YYYY-MM-DD`. */
  value?: string;
  onChange: (value: string) => void;
  /** `YYYY-MM-DD` bounds. */
  min?: string;
  max?: string;
  /** Locale to display in. Defaults to day-first English. */
  locale?: TemporalLocale;
};

/**
 * A month calendar to pick a day from, with no field above it: for a control
 * that already shows the date and opens this on a click, where TemporalPicker
 * would show the date a second time and open its calendar on another click.
 * Values are as TemporalPicker's date kind: bare `YYYY-MM-DD`.
 */
export default function TemporalCalendar(props: TemporalCalendarProps) {
  return (
    <LocalizationProvider dateAdapter={AdapterDayjs} adapterLocale={props.locale ?? "en-gb"}>
      <DateCalendar
        value={parseDay(props.value)}
        onChange={(next: Dayjs | null) => {
          if (next && next.isValid()) props.onChange(next.format(TEMPORAL_DATE_FORMAT));
        }}
        minDate={parseDay(props.min) ?? undefined}
        maxDate={parseDay(props.max) ?? undefined}
        // Days only: the months either side page with the header's arrows.
        views={["day"]}
      />
    </LocalizationProvider>
  );
}
