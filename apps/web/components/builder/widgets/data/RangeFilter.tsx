import { Box, Skeleton, Slider, Stack, TextField, Typography, useTheme } from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bar, BarChart, Cell, ResponsiveContainer, XAxis, YAxis } from "recharts";

import { useProjectLayerHistogramStats } from "@/lib/api/projects";
import { DEFAULT_WIDGET_COLOR } from "@/lib/constants/ui";
import { formatNumber } from "@/lib/utils/format-number";
import type { HistogramStatsQueryParams } from "@/lib/validations/project";

interface RangeFilterProps {
  layerId: string;
  fieldName: string;
  selectedRange: [number, number] | null;
  onSelectedRangeChange: (range: [number, number] | null) => void;
  showHistogram?: boolean;
  steps?: number;
  showSlider?: boolean;
  cqlFilter?: object;
  color?: string;
}

const RangeFilter = ({
  layerId,
  fieldName,
  selectedRange,
  onSelectedRangeChange,
  showHistogram = true,
  steps = 50,
  showSlider = true,
  cqlFilter,
  color = DEFAULT_WIDGET_COLOR,
}: RangeFilterProps) => {
  const theme = useTheme();
  const { t, i18n } = useTranslation("common");

  // Local state for input fields (to allow typing without immediate updates)
  const [localMin, setLocalMin] = useState<string>("");
  const [localMax, setLocalMax] = useState<string>("");
  // Local state for slider (to allow dragging without immediate API calls)
  const [localSliderValue, setLocalSliderValue] = useState<[number, number] | null>(null);

  // Stringify cqlFilter for stable comparison in useMemo dependency
  const cqlFilterString = cqlFilter ? JSON.stringify(cqlFilter) : undefined;

  // Build query params for histogram
  const queryParams = useMemo<HistogramStatsQueryParams | undefined>(() => {
    if (!fieldName) return undefined;
    return {
      column_name: fieldName,
      num_bins: steps,
      method: "equal_interval",
      query: cqlFilterString,
    };
  }, [fieldName, steps, cqlFilterString]);

  const { histogramStats, isLoading, isError } = useProjectLayerHistogramStats(layerId, queryParams);

  // Calculate min/max from histogram data
  const dataRange = useMemo<{ min: number; max: number } | null>(() => {
    if (!histogramStats?.bins?.length) return null;
    const allRanges = histogramStats.bins.flatMap((bin) => bin.range);
    return {
      min: Math.min(...allRanges),
      max: Math.max(...allRanges),
    };
  }, [histogramStats]);

  // Chart data for histogram
  const chartData = useMemo(() => {
    if (!histogramStats?.bins) return [];
    return histogramStats.bins.map((bin) => ({
      rangeStart: Number(bin.range[0]),
      rangeEnd: Number(bin.range[1]),
      count: bin.count,
      midpoint: (Number(bin.range[0]) + Number(bin.range[1])) / 2,
    }));
  }, [histogramStats]);

  // Initialize local state when data loads
  useEffect(() => {
    if (dataRange && !selectedRange) {
      setLocalMin(formatNumber(dataRange.min));
      setLocalMax(formatNumber(dataRange.max));
    }
  }, [dataRange, selectedRange]);

  // Sync local state with selected range
  useEffect(() => {
    if (selectedRange) {
      setLocalMin(formatNumber(selectedRange[0]));
      setLocalMax(formatNumber(selectedRange[1]));
    } else if (dataRange) {
      setLocalMin(formatNumber(dataRange.min));
      setLocalMax(formatNumber(dataRange.max));
    }
  }, [selectedRange, dataRange]);

  // Current effective range (selected or full range)
  const effectiveRange = useMemo<[number, number] | null>(() => {
    if (selectedRange) return selectedRange;
    if (dataRange) return [dataRange.min, dataRange.max];
    return null;
  }, [selectedRange, dataRange]);

  // Handle slider change (visual only, during drag)
  const handleSliderChange = (_event: Event, newValue: number | number[]) => {
    setLocalSliderValue(newValue as [number, number]);
  };

  // Handle slider change committed (when user releases slider)
  const handleSliderChangeCommitted = (_event: React.SyntheticEvent | Event, newValue: number | number[]) => {
    const [min, max] = newValue as [number, number];
    setLocalSliderValue(null); // Clear local state
    if (dataRange && min === dataRange.min && max === dataRange.max) {
      // If range matches full data range, clear filter
      onSelectedRangeChange(null);
    } else {
      onSelectedRangeChange([min, max]);
    }
  };

  // Handle input field blur (commit changes)
  const handleMinBlur = () => {
    const value = parseFloat(localMin.replace(/,/g, ""));
    if (!isNaN(value) && dataRange && effectiveRange) {
      const newMin = Math.max(dataRange.min, Math.min(value, effectiveRange[1]));
      if (newMin === dataRange.min && effectiveRange[1] === dataRange.max) {
        onSelectedRangeChange(null);
      } else {
        onSelectedRangeChange([newMin, effectiveRange[1]]);
      }
    }
  };

  const handleMaxBlur = () => {
    const value = parseFloat(localMax.replace(/,/g, ""));
    if (!isNaN(value) && dataRange && effectiveRange) {
      const newMax = Math.min(dataRange.max, Math.max(value, effectiveRange[0]));
      if (effectiveRange[0] === dataRange.min && newMax === dataRange.max) {
        onSelectedRangeChange(null);
      } else {
        onSelectedRangeChange([effectiveRange[0], newMax]);
      }
    }
  };

  // Check if a bar is within the selected range (use local slider value during drag for visual feedback)
  const isBarInRange = (bar: { rangeStart: number; rangeEnd: number }) => {
    const rangeToCheck = localSliderValue || effectiveRange;
    if (!rangeToCheck) return true;
    const [min, max] = rangeToCheck;
    // Bar is in range if it overlaps with the selected range
    return bar.rangeEnd >= min && bar.rangeStart <= max;
  };

  if (isLoading) {
    return (
      <Stack spacing={2}>
        {showHistogram && <Skeleton variant="rounded" height={100} />}
        <Stack direction="row" spacing={2}>
          <Skeleton variant="rounded" width="100%" height={40} />
          <Skeleton variant="rounded" width="100%" height={40} />
        </Stack>
        {showSlider && <Skeleton variant="rounded" height={40} />}
      </Stack>
    );
  }

  if (isError || !dataRange) {
    return (
      <Typography variant="body2" color="text.secondary">
        {t("no_values_found")}
      </Typography>
    );
  }

  return (
    <Box>
      {/* Histogram */}
      {showHistogram && chartData.length > 0 && (
        <Box sx={{ mb: 2 }}>
          <ResponsiveContainer width="100%" height={100}>
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

      {/* Slider */}
      {showSlider && (
        <Box sx={{ px: 1, mb: 2 }}>
          <Slider
            value={localSliderValue || effectiveRange || [dataRange.min, dataRange.max]}
            onChange={handleSliderChange}
            onChangeCommitted={handleSliderChangeCommitted}
            min={dataRange.min}
            max={dataRange.max}
            step={(dataRange.max - dataRange.min) / 100}
            valueLabelDisplay="auto"
            valueLabelFormat={(value) => formatNumber(value, undefined, i18n.language)}
            sx={{
              color: color,
              "& .MuiSlider-thumb": {
                width: 16,
                height: 16,
              },
            }}
          />
        </Box>
      )}

      {/* Min/Max input fields */}
      <Stack direction="row" spacing={2}>
        <TextField
          label={t("min")}
          size="small"
          value={localMin}
          onChange={(e) => setLocalMin(e.target.value)}
          onBlur={handleMinBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleMinBlur();
          }}
          InputProps={{
            inputProps: {
              style: { textAlign: "center" },
            },
          }}
          sx={{ flex: 1 }}
        />
        <TextField
          label={t("max")}
          size="small"
          value={localMax}
          onChange={(e) => setLocalMax(e.target.value)}
          onBlur={handleMaxBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleMaxBlur();
          }}
          InputProps={{
            inputProps: {
              style: { textAlign: "center" },
            },
          }}
          sx={{ flex: 1 }}
        />
      </Stack>
    </Box>
  );
};

export default RangeFilter;
