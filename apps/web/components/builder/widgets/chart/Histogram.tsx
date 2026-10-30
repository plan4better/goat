import { Stack, Typography, useTheme } from "@mui/material";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Trans } from "react-i18next";
import type { TooltipProps } from "recharts";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";

import { DEFAULT_WIDGET_COLOR } from "@/lib/constants/ui";
import { useProjectLayerHistogramStats } from "@/lib/api/projects";
import { formatNumber } from "@/lib/utils/format-number";
import type { HistogramStatsQueryParams } from "@/lib/validations/project";
import { histogramStatsQueryParams } from "@/lib/validations/project";
import type { HistogramChartSchema } from "@/lib/validations/widget";
import { histogramChartConfigSchema } from "@/lib/validations/widget";

import { useChartWidget } from "@/hooks/map/DashboardBuilderHooks";

import { StaleDataLoader } from "@/components/builder/widgets/common/StaleDataLoader";
import { WidgetStatusContainer } from "@/components/builder/widgets/common/WidgetStatusContainer";

const DEFAULT_HOVER_COLOR = "#f5b704";
const DEFAULT_SELECTED_COLOR = "#9333EA";

interface CustomTooltipProps extends TooltipProps<ValueType, NameType> {
  isHighlightMode?: boolean;
}

const CustomTooltip = ({ active, payload, isHighlightMode }: CustomTooltipProps) => {
  const { t, i18n } = useTranslation("common");
  if (active && payload?.length) {
    const { rangeStart, rangeEnd, count, selectedCount } = payload[0].payload;
    return (
      <Stack>
        <Typography variant="caption" fontWeight="bold">
          [{formatNumber(rangeStart, undefined, i18n.language)} -{" "}
          {formatNumber(rangeEnd, undefined, i18n.language)}]
        </Typography>
        <Typography variant="body2" fontWeight="bold">
          {`${t("count")}: ${count}`}
        </Typography>
        {isHighlightMode && selectedCount !== undefined && (
          <Typography variant="body2" fontWeight="bold" color="warning.main">
            {`${t("selected")}: ${selectedCount}`}
          </Typography>
        )}
      </Stack>
    );
  }
  return null;
};

export const HistogramChartWidget = ({ config: rawConfig }: { config: HistogramChartSchema }) => {
  const theme = useTheme();
  const { t, i18n } = useTranslation("common");
  const { config, queryParams, baseQueryParams, layerId, isLayerLocked } = useChartWidget(
    rawConfig,
    histogramChartConfigSchema,
    histogramStatsQueryParams
  );

  // Determine if we're in highlight mode
  const isHighlightMode = config?.options?.selection_response === "highlight";

  // In highlight mode: always fetch full data for main display
  // In filter mode: use filtered data
  const mainQueryParams = isHighlightMode ? baseQueryParams : queryParams;
  const mainHistogramQueryParams = useMemo(() => {
    if (!mainQueryParams) return undefined;
    const { custom_breaks: _customBreaks, method: _method, ...restQueryParams } =
      mainQueryParams as HistogramStatsQueryParams;
    return {
      ...restQueryParams,
      method: "equal_interval",
    } as HistogramStatsQueryParams;
  }, [mainQueryParams]);

  const selectedHistogramQueryParams = useMemo(() => {
    if (!queryParams) return undefined;
    const { custom_breaks: _customBreaks, method: _method, ...restQueryParams } =
      queryParams as HistogramStatsQueryParams;
    return {
      ...restQueryParams,
      method: "equal_interval",
    } as HistogramStatsQueryParams;
  }, [queryParams]);

  const { histogramStats, isLoading, isError } = useProjectLayerHistogramStats(
    layerId,
    mainHistogramQueryParams
  );

  // Fetch selected/filtered data (only in highlight mode)
  // The selected stats may have different bin boundaries, we'll match by range overlap
  const { histogramStats: selectedStats, isLoading: isSelectedLoading } = useProjectLayerHistogramStats(
    isHighlightMode ? layerId : undefined,
    selectedHistogramQueryParams
  );

  // Only show highlight visualization when there's actually filtered data
  // (i.e., selectedStats has fewer rows than full histogram)
  const showHighlight =
    isHighlightMode &&
    selectedStats !== undefined &&
    histogramStats !== undefined &&
    selectedStats.total_rows < histogramStats.total_rows;

  // Transform API data into chart data, merging selected counts when in highlight mode
  const chartData = useMemo(() => {
    if (!histogramStats?.bins) return [];

    // For each main histogram bin, find selected data that falls within its range
    // We need to handle cases where selected stats have different bin boundaries
    const getSelectedCountForBin = (binStart: number, binEnd: number, maxCount: number): number => {
      if (!showHighlight || !selectedStats?.bins) return 0;

      let count = 0;

      selectedStats.bins.forEach((selectedBin) => {
        const selectedStart = Number(selectedBin.range[0]);
        const selectedEnd = Number(selectedBin.range[1]);

        // Check if selected bin overlaps with this histogram bin
        if (selectedStart < binEnd && selectedEnd >= binStart) {
          // Calculate the overlap portion
          const overlapStart = Math.max(binStart, selectedStart);
          const overlapEnd = Math.min(binEnd, selectedEnd);
          const overlapWidth = overlapEnd - overlapStart;
          const selectedWidth = selectedEnd - selectedStart;

          // If selected bin is very small (single value), add full count if it falls in this bin
          if (selectedWidth < 0.0001) {
            count += selectedBin.count;
          } else {
            // Proportionally distribute the count based on overlap
            const proportion = Math.min(1, overlapWidth / selectedWidth);
            count += Math.round(selectedBin.count * proportion);
          }
        }
      });

      // Never exceed the bin's total count
      return Math.min(count, maxCount);
    };

    return histogramStats.bins.map((bin) => {
      const binStart = Number(bin.range[0]);
      const binEnd = Number(bin.range[1]);
      const selectedCount = getSelectedCountForBin(binStart, binEnd, bin.count);
      return {
        rangeStart: binStart,
        rangeEnd: binEnd,
        count: bin.count,
        selectedCount: showHighlight ? selectedCount : undefined,
        // For stacked bar: base is the non-selected portion
        baseCount: showHighlight ? bin.count - selectedCount : bin.count,
      };
    });
  }, [histogramStats, selectedStats, showHighlight]);

  const isChartConfigured = useMemo(() => {
    return layerId && queryParams;
  }, [layerId, queryParams]);

  // Colors
  const baseColor = config?.options?.color || DEFAULT_WIDGET_COLOR;
  const rawHoverColor = config?.options?.highlight_color;
  const hoverColor =
    rawHoverColor && rawHoverColor.toLowerCase() !== "#3b82f6"
      ? rawHoverColor
      : DEFAULT_HOVER_COLOR;
  const selectedColor = config?.options?.selected_color || DEFAULT_SELECTED_COLOR;
  const strokeColor = theme.palette.divider;

  const displayFieldLabel = config?.options?.display_field_label || config?.setup?.column_name;

  const xAxisTicks = useMemo(() => {
    const configuredTicks = config?.options?.x_axis_ticks;
    if (!Array.isArray(configuredTicks) || !chartData.length) return undefined;

    const min = chartData[0]?.rangeStart;
    const max = chartData[chartData.length - 1]?.rangeEnd;

    return configuredTicks
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value >= min && value <= max)
      .sort((a, b) => a - b);
  }, [config?.options?.x_axis_ticks, chartData]);

  return (
    <>
      <WidgetStatusContainer
        isLoading={(isLoading || isSelectedLoading) && !histogramStats && !isError}
        isNotConfigured={!isChartConfigured}
        isError={isError}
        height={150}
        isNotConfiguredMessage={isLayerLocked ? t("layer_locked_hint") : t("please_configure_chart")}
        errorMessage={t("cannot_render_chart_error")}
      />

      {config && histogramStats && !isError && isChartConfigured && (
        <ResponsiveContainer width="100%" aspect={1.2}>
          <BarChart
            data={chartData}
            margin={{ top: 10, right: 20, bottom: 10 }}
            stackOffset="none"
            barCategoryGap={0}
            barGap={0}>
            <XAxis
              dataKey="rangeStart"
              type="number"
              domain={["dataMin", "dataMax"]}
              ticks={xAxisTicks}
              tickFormatter={(value) => formatNumber(value, config.options?.format, i18n.language)}
              tick={{ fontSize: 10, fill: theme.palette.text.secondary }}
              tickMargin={5}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              cursor={{ fill: "transparent" }}
              wrapperStyle={{
                backgroundColor: theme.palette.background.paper,
                borderColor: theme.palette.divider,
                borderRadius: theme.shape.borderRadius,
                borderStyle: "ridge",
                padding: "5px",
              }}
              content={<CustomTooltip isHighlightMode={showHighlight} />}
            />
            <YAxis
              width={40}
              label={{ position: "left" }}
              axisLine={false}
              tickLine={false}
              tickMargin={10}
              tickFormatter={(value) =>
                new Intl.NumberFormat(i18n.language, {
                  notation: "compact",
                  compactDisplay: "short",
                }).format(value)
              }
              tick={{
                fontSize: 10,
                fontFamily: theme.typography.caption.fontFamily,
                fill: theme.palette.text.secondary,
              }}
            />
            {showHighlight ? (
              <>
                {/* Stacked bars: base (non-selected) on bottom, selected on top */}
                <Bar
                  dataKey="baseCount"
                  stackId="histogram"
                  fill={baseColor}
                  fillOpacity={0.6}
                  stroke={strokeColor}
                  strokeWidth={1}
                  radius={[0, 0, 0, 0]}
                  cursor="pointer"
                  activeBar={{ fill: hoverColor, fillOpacity: 0.75 }}
                />
                {/* Selected portion on top with selection color */}
                <Bar
                  dataKey="selectedCount"
                  stackId="histogram"
                  radius={[0, 0, 0, 0]}
                  cursor="pointer">
                  {chartData.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={entry.selectedCount && entry.selectedCount > 0 ? selectedColor : "transparent"}
                      fillOpacity={entry.selectedCount && entry.selectedCount > 0 ? 0.9 : 0}
                      stroke={entry.selectedCount && entry.selectedCount > 0 ? strokeColor : "none"}
                      strokeWidth={entry.selectedCount && entry.selectedCount > 0 ? 1 : 0}
                    />
                  ))}
                </Bar>
              </>
            ) : (
              /* Normal single bar when not highlighting */
              <Bar
                dataKey="count"
                fill={baseColor}
                fillOpacity={0.6}
                stroke={strokeColor}
                strokeWidth={1}
                radius={[0, 0, 0, 0]}
                cursor="pointer"
                activeBar={{ fill: hoverColor, fillOpacity: 0.75 }}
              />
            )}
          </BarChart>
        </ResponsiveContainer>
      )}

      <StaleDataLoader isLoading={isLoading || isSelectedLoading} hasData={!!histogramStats?.bins?.length} />

      {config && histogramStats && histogramStats.total_rows > 0 && !isError && (
        <Typography variant="caption" align="left" gutterBottom>
          <Trans
            i18nKey="common:all_features_have_column"
            values={{
              nr_features: histogramStats.total_rows,
              column_name: displayFieldLabel,
            }}
            components={{ b: <b /> }}
          />
        </Typography>
      )}

      {config && histogramStats?.total_rows === 0 && config?.options?.filter_by_viewport && !isError && (
        <Typography variant="caption" align="left" gutterBottom>
          {t("no_features_in_viewport")}
        </Typography>
      )}

      {config && histogramStats?.total_rows === 0 && !config?.options?.filter_by_viewport && !isError && (
        <Typography variant="caption" align="left" gutterBottom>
          {t("no_features_in_layer")}
        </Typography>
      )}
    </>
  );
};
