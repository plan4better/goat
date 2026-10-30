import { Box, Chip, Divider, Skeleton, Stack, Typography, useTheme } from "@mui/material";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { MAX_FILTER_VALUES, useFilterValues } from "./useFilterValues";
import { DEFAULT_WIDGET_COLOR } from "@/lib/constants/ui";

import { selectableChipSx } from "@/components/builder/widgets/common/selectableChipSx";

interface ChipsFilterProps {
  layerId: string;
  fieldName: string;
  selectedValues: string[];
  onSelectedValuesChange: (values: string[]) => void;
  minVisibleOptions?: number;
  multiple?: boolean;
  wrap?: boolean;
  showAllOption?: boolean;
  customOrder?: string[];
  cqlFilter?: object;
  color?: string;
  labelMap?: [string, string][];
}

const ChipsFilter = ({
  layerId,
  fieldName,
  selectedValues,
  onSelectedValuesChange,
  minVisibleOptions = 5,
  multiple = false,
  wrap = true,
  showAllOption = true,
  customOrder,
  cqlFilter,
  color = DEFAULT_WIDGET_COLOR,
  labelMap,
}: ChipsFilterProps) => {
  const theme = useTheme();
  const { t } = useTranslation("common");
  const [showAll, setShowAll] = useState(false);

  const { allValues, isLoading, totalValuesCount, hasMoreThanLimit } = useFilterValues({
    layerId,
    fieldName,
    customOrder,
    cqlFilter,
  });

  const visibleValues = useMemo(() => {
    if (showAll) return allValues;
    return allValues.slice(0, minVisibleOptions);
  }, [allValues, showAll, minVisibleOptions]);

  const hiddenCount = allValues.length - minVisibleOptions;

  const labelMapLookup = useMemo(() => {
    const lookup = new Map<string, string>();
    labelMap?.forEach(([value, label]) => {
      lookup.set(value, label);
    });
    return lookup;
  }, [labelMap]);

  const allSelected = allValues.length > 0 && allValues.every((v) => selectedValues.includes(v));

  const handleAllClick = () => {
    if (allSelected) {
      onSelectedValuesChange([]);
    } else {
      onSelectedValuesChange([...allValues]);
    }
  };

  const handleChipClick = (value: string) => {
    const isSelected = selectedValues.includes(value);

    if (multiple) {
      // Multi-select: toggle on/off
      if (isSelected) {
        onSelectedValuesChange(selectedValues.filter((v) => v !== value));
      } else {
        onSelectedValuesChange([...selectedValues, value]);
      }
    } else {
      // Single-select: clicking selected chip deselects, clicking other selects only that one
      if (isSelected) {
        onSelectedValuesChange([]);
      } else {
        onSelectedValuesChange([value]);
      }
    }
  };

  if (isLoading) {
    return (
      <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
        {Array.from({ length: Math.min(minVisibleOptions, 5) }).map((_, index) => (
          <Skeleton key={index} variant="rounded" width={80} height={32} sx={{ borderRadius: 4 }} />
        ))}
      </Stack>
    );
  }

  if (allValues.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        {t("no_values_found")}
      </Typography>
    );
  }

  return (
    <Box>
      <Stack
        direction="row"
        spacing={2}
        flexWrap={wrap ? "wrap" : "nowrap"}
        useFlexGap
        sx={{
          overflowX: wrap ? "visible" : "auto",
          pb: wrap ? 0 : 1,
          "&::-webkit-scrollbar": {
            height: 4,
          },
          "&::-webkit-scrollbar-thumb": {
            backgroundColor: theme.palette.divider,
            borderRadius: 2,
          },
        }}>
        {multiple && showAllOption && (
          <>
            <Chip
              label={t("all")}
              size="small"
              clickable
              onClick={handleAllClick}
              sx={selectableChipSx(theme, allSelected, color)}
            />
            <Divider orientation="vertical" flexItem sx={{ mx: 0.5, borderColor: theme.palette.text.disabled }} />
          </>
        )}
        {visibleValues.map((value) => {
          const isSelected = selectedValues.includes(value);
          return (
            <Chip
              key={value}
              label={labelMapLookup.get(value) || value}
              size="small"
              clickable
              onClick={() => handleChipClick(value)}
              sx={selectableChipSx(theme, isSelected, color)}
            />
          );
        })}
        {!showAll && hiddenCount > 0 && (
          <Chip
            label={`+${hiddenCount}`}
            size="small"
            clickable
            onClick={() => setShowAll(true)}
            variant="outlined"
            sx={{
              borderRadius: 4,
              borderStyle: "dashed",
              color: theme.palette.text.secondary,
              "&:hover": {
                backgroundColor: theme.palette.action.hover,
              },
            }}
          />
        )}
        {showAll && hiddenCount > 0 && (
          <Chip
            label={t("show_less")}
            size="small"
            clickable
            onClick={() => setShowAll(false)}
            variant="outlined"
            sx={{
              borderRadius: 4,
              borderStyle: "dashed",
              color: theme.palette.text.secondary,
              "&:hover": {
                backgroundColor: theme.palette.action.hover,
              },
            }}
          />
        )}
      </Stack>
      {hasMoreThanLimit && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: "block" }}>
          {t("filter_limit_warning", { count: MAX_FILTER_VALUES, total: totalValuesCount })}
        </Typography>
      )}
    </Box>
  );
};

export default ChipsFilter;
