/**
 * Date Input Component
 *
 * Renders a date field for an ISO `YYYY-MM-DD` string input, bounded by the
 * service window of the bundle another input names.
 *
 * The bounds are the point of it. A timetable is built for the window its feed
 * declares, and outside that window every journey comes back "no service" — so
 * an unbounded date turns a wrong answer into an empty result with nothing
 * explaining it. `widget_options.bounds_from` names the input holding the
 * bundle, and `bounds_artifact` the artifact kind whose recorded properties
 * carry the window.
 */
import { Stack } from "@mui/material";
import { useEffect, useMemo } from "react";

import TemporalPicker from "@p4b/ui/components/TemporalPicker";

import type { ProcessedInput } from "@/types/map/ogc-processes";

import { useBundle } from "@/lib/api/bundles";

import FormLabelHelper from "@/components/common/FormLabelHelper";

interface DateInputProps {
  input: ProcessedInput;
  value: string | undefined;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** The other inputs' current values, for resolving `bounds_from`. */
  formValues?: Record<string, unknown>;
}

/** `YYYY-MM-DD`, which is what the field reads and writes. */
const asIsoDate = (date: Date): string => date.toISOString().slice(0, 10);

/** Today on the viewer's own calendar — a date offered as "today" has to be
 * the one they would call today, which UTC is not east or west of Greenwich. */
const isoToday = (): string => {
  const now = new Date();
  return asIsoDate(new Date(now.getTime() - now.getTimezoneOffset() * 60_000));
};

export default function DateInput({
  input,
  value,
  onChange,
  disabled,
  formValues,
}: DateInputProps) {
  const options = input.uiMeta?.widget_options ?? {};
  const boundsFrom = options.bounds_from as string | undefined;
  const boundsArtifact = options.bounds_artifact as string | undefined;

  const bundleId = boundsFrom ? (formValues?.[boundsFrom] as string | undefined) : undefined;
  const { bundle } = useBundle(bundleId ?? null);

  /**
   * The window the named artifact was built for.
   *
   * Absent whenever anything is missing — no bundle chosen, an artifact built
   * before the window was recorded, a shape this release does not recognise.
   * The field then takes any date rather than refusing every one of them.
   */
  const serviceWindow = useMemo(() => {
    if (!boundsArtifact) return undefined;
    const artifact = bundle?.artifacts?.find((a) => a.kind === boundsArtifact);
    const start = artifact?.properties?.service_start;
    const days = artifact?.properties?.service_days;
    if (typeof start !== "string" || typeof days !== "number" || days < 1) return undefined;
    const from = new Date(`${start}T00:00:00Z`);
    if (Number.isNaN(from.getTime())) return undefined;
    // `service_days` counts the first day, so the last served date is one less.
    const to = new Date(from.getTime() + (days - 1) * 86_400_000);
    return { min: asIsoDate(from), max: asIsoDate(to) };
  }, [bundle, boundsArtifact]);

  /**
   * Keep the value inside the window.
   *
   * An empty date is not neutral: the engine falls back to the default
   * network's weekday anchor, which the chosen feed's timetable does not
   * contain, and the run comes back empty with nothing saying why. So a date
   * stands in until the user picks another, and one left over from a
   * previously chosen bundle is replaced rather than carried into a window it
   * falls outside of.
   *
   * Today when the timetable still covers it — that is the day a user asking
   * about a service means — and otherwise the first day it does cover, which
   * is the nearest thing to today the feed can answer for.
   */
  useEffect(() => {
    if (!serviceWindow) return;
    const inWindow = (date: string) => date >= serviceWindow.min && date <= serviceWindow.max;
    if (inWindow(value ?? "")) return;
    const today = isoToday();
    onChange(inWindow(today) ? today : serviceWindow.min);
  }, [serviceWindow, value, onChange]);

  return (
    <Stack>
      <FormLabelHelper label={input.title} tooltip={input.description} color="inherit" />
      <TemporalPicker
        kind="date"
        bold
        value={value ?? (input.defaultValue as string) ?? ""}
        onChange={onChange}
        disabled={disabled}
        min={serviceWindow?.min}
        max={serviceWindow?.max}
      />
    </Stack>
  );
}
