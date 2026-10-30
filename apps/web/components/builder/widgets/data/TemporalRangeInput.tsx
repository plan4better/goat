import { Box, Slider, Stack, Typography, useTheme } from "@mui/material";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bar, BarChart, Cell, ResponsiveContainer, XAxis, YAxis } from "recharts";

import TemporalPicker from "@p4b/ui/components/TemporalPicker";
import { TEMPORAL_VALUE_FORMAT } from "@p4b/ui/components/temporalFormats";

import { useDayjsLocale } from "@/i18n/utils";

import { useDatasetCollectionItems } from "@/lib/api/layers";
import { useProjectLayerHistogramStats } from "@/lib/api/projects";
import { DEFAULT_WIDGET_COLOR } from "@/lib/constants/ui";
import type { HistogramStatsQueryParams } from "@/lib/validations/project";

dayjs.extend(utc);

type Granularity = "minute" | "hour" | "day" | "week" | "month";

const LABEL_FORMAT: Record<Granularity, string> = {
  minute: "YYYY-MM-DD HH:mm",
  hour: "YYYY-MM-DD HH:00",
  day: "YYYY-MM-DD",
  week: "YYYY-MM-DD",
  month: "MMM YYYY",
};

const ISO = TEMPORAL_VALUE_FORMAT;

interface TemporalRangeInputProps {
  /** "range" = data-driven slider, "picker" = free From/To pickers */
  inputStyle: "range" | "picker";
  granularity?: Granularity;
  layerId: string;
  fieldName: string;
  showHistogram?: boolean;
  color?: string;
  selectedRange: [string, string] | null;
  onSelectedRangeChange: (range: [string, string] | null) => void;
}

export default function TemporalRangeInput({
  inputStyle,
  granularity,
  layerId,
  fieldName,
  showHistogram = true,
  color = DEFAULT_WIDGET_COLOR,
  selectedRange,
  onSelectedRangeChange,
}: TemporalRangeInputProps) {
  const theme = useTheme();
  const { t } = useTranslation("common");
  const dayjsLocale = useDayjsLocale();
  const isPicker = inputStyle === "picker";
  const unit: Granularity = granularity ?? "day";

  const { data: minData } = useDatasetCollectionItems(
    isPicker ? "" : layerId,
    isPicker ? undefined : { sortby: fieldName, limit: 1 }
  );
  const { data: maxData } = useDatasetCollectionItems(
    isPicker ? "" : layerId,
    isPicker ? undefined : { sortby: `-${fieldName}`, limit: 1 }
  );
  const domain = useMemo(() => {
    if (isPicker) return null;
    const minVal = minData?.features?.[0]?.properties?.[fieldName];
    const maxVal = maxData?.features?.[0]?.properties?.[fieldName];
    if (minVal == null || maxVal == null) return null;
    // All slider math happens in UTC: serialized values are UTC instants and
    // the emitted literals are interpreted as UTC by the backend.
    const base = dayjs.utc(String(minVal)).startOf(unit);
    const end = dayjs.utc(String(maxVal));
    if (!base.isValid() || !end.isValid()) return null;
    return {
      steps: Math.max(0, end.startOf(unit).diff(base, unit)),
      label: (v: number) => base.add(v, unit).locale(dayjsLocale).format(LABEL_FORMAT[unit]),
      literal: (v: number, isEnd: boolean) =>
        (isEnd ? base.add(v, unit).endOf(unit) : base.add(v, unit).startOf(unit)).format(ISO),
    };
  }, [isPicker, minData, maxData, fieldName, unit, dayjsLocale]);

  const enableHistogram = !isPicker && showHistogram;
  const histogramBins = Math.min(Math.max((domain?.steps ?? 19) + 1, 1), 60);
  const histogramParams = useMemo<HistogramStatsQueryParams | undefined>(
    () =>
      enableHistogram && fieldName
        ? { column_name: fieldName, num_bins: histogramBins, method: "equal_interval" }
        : undefined,
    [enableHistogram, fieldName, histogramBins]
  );
  const { histogramStats } = useProjectLayerHistogramStats(layerId, histogramParams);
  const chartData = useMemo(
    () =>
      (histogramStats?.bins ?? []).map((bin) => ({
        rangeStart: Number(bin.range[0]),
        rangeEnd: Number(bin.range[1]),
        count: bin.count,
        midpoint: (Number(bin.range[0]) + Number(bin.range[1])) / 2,
      })),
    [histogramStats]
  );

  const [sliderValue, setSliderValue] = useState<[number, number]>([0, 0]);
  useEffect(() => {
    if (!isPicker && domain) setSliderValue([0, domain.steps]);
  }, [isPicker, domain]);

  const sliderMax = domain?.steps ?? 0;
  const disabled = !domain || domain.steps === 0;

  const formatLabel = (v: number): string => (domain ? domain.label(v) : "");

  const sliderToLiterals = (value: [number, number]): [string, string] =>
    domain ? [domain.literal(value[0], false), domain.literal(value[1], true)] : ["", ""];

  const literalToEpoch = (lit: string): number => (lit ? dayjs.utc(lit).unix() : NaN);

  const activeLiterals: [string, string] = isPicker
    ? (selectedRange ?? ["", ""])
    : sliderToLiterals(sliderValue);
  const selectionEpoch: [number, number] =
    activeLiterals[0] && activeLiterals[1]
      ? [literalToEpoch(activeLiterals[0]), literalToEpoch(activeLiterals[1])]
      : [-Infinity, Infinity];
  const isBarInRange = (bar: { rangeStart: number; rangeEnd: number }) =>
    bar.rangeEnd >= selectionEpoch[0] && bar.rangeStart <= selectionEpoch[1];

  const [from, to] = selectedRange ?? ["", ""];
  const updatePicker = (index: 0 | 1, value: string) => {
    const next: [string, string] = [from, to];
    next[index] = value;
    onSelectedRangeChange(next[0] || next[1] ? next : null);
  };

  if (isPicker) {
    return (
      <Stack direction="column" spacing={2} sx={{ pt: 1 }}>
        <TemporalPicker
          locale={dayjsLocale}
          kind="datetime"
          label={t("from")}
          value={from}
          onChange={(v) => updatePicker(0, v)}
        />
        <TemporalPicker
          locale={dayjsLocale}
          kind="datetime"
          label={t("to")}
          value={to}
          onChange={(v) => updatePicker(1, v)}
        />
      </Stack>
    );
  }

  return (
    <Stack direction="column" spacing={1} sx={{ pt: 2, px: 1 }}>
      {enableHistogram && chartData.length > 0 && (
        <Box sx={{ mb: 1 }}>
          <ResponsiveContainer width="100%" height={80}>
            <BarChart data={chartData} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
              <XAxis dataKey="midpoint" type="number" domain={["dataMin", "dataMax"]} hide />
              <YAxis hide />
              <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                {chartData.map((entry, index) => (
                  <Cell
                    key={`cell-${index}`}
                    fill={isBarInRange(entry) ? color : theme.palette.action.disabled}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Box>
      )}
      <Slider
        value={sliderValue}
        min={0}
        max={sliderMax}
        step={1}
        disabled={disabled}
        valueLabelDisplay="auto"
        valueLabelFormat={formatLabel}
        onChange={(_, value) => setSliderValue(value as [number, number])}
        onChangeCommitted={(_, value) => onSelectedRangeChange(sliderToLiterals(value as [number, number]))}
        sx={{ color }}
      />
      <Stack direction="row" justifyContent="space-between">
        <Typography variant="caption" color="text.secondary">
          {formatLabel(sliderValue[0])}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {formatLabel(sliderValue[1])}
        </Typography>
      </Stack>
    </Stack>
  );
}
