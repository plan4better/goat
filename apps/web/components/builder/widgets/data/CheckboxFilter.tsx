import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { Box, Checkbox, FormControlLabel, Link, Skeleton, Stack, Typography, useTheme } from "@mui/material";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { DEFAULT_WIDGET_COLOR } from "@/lib/constants/ui";

import { MAX_FILTER_VALUES, useFilterValues } from "./useFilterValues";

interface CheckboxFilterProps {
  layerId: string;
  fieldName: string;
  selectedValues: string[];
  onSelectedValuesChange: (values: string[]) => void;
  minVisibleOptions?: number;
  multiple?: boolean;
  customOrder?: string[];
  cqlFilter?: object;
  color?: string;
  labelMap?: [string, string][];
}

const CheckboxFilter = ({
  layerId,
  fieldName,
  selectedValues,
  onSelectedValuesChange,
  minVisibleOptions = 5,
  multiple = false,
  customOrder,
  cqlFilter,
  color = DEFAULT_WIDGET_COLOR,
  labelMap,
}: CheckboxFilterProps) => {
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

  const handleCheckboxChange = (value: string, checked: boolean) => {
    if (multiple) {
      // Multi-select: toggle on/off
      if (checked) {
        onSelectedValuesChange([...selectedValues, value]);
      } else {
        onSelectedValuesChange(selectedValues.filter((v) => v !== value));
      }
    } else {
      // Single-select: only one can be selected at a time
      if (checked) {
        onSelectedValuesChange([value]);
      } else {
        onSelectedValuesChange([]);
      }
    }
  };

  const handleSelectAll = () => {
    onSelectedValuesChange([...allValues]);
  };

  const handleClearAll = () => {
    onSelectedValuesChange([]);
  };

  if (isLoading) {
    return (
      <Stack spacing={1}>
        {Array.from({ length: Math.min(minVisibleOptions, 5) }).map((_, index) => (
          <Skeleton key={index} variant="rounded" height={24} />
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

  const allSelected = allValues.every((v) => selectedValues.includes(v));
  const noneSelected = selectedValues.length === 0;

  return (
    <Box>
      {/* Select All / Clear All links - only show in multi-select mode */}
      {multiple && (
        <Stack direction="row" spacing={2} sx={{ mb: 1 }}>
          <Link
            component="button"
            variant="caption"
            underline="hover"
            disabled={allSelected}
            onClick={handleSelectAll}
            sx={{
              color: allSelected ? theme.palette.text.disabled : theme.palette.primary.main,
              cursor: allSelected ? "default" : "pointer",
            }}>
            {t("select_all")}
          </Link>
          <Typography variant="caption" color="text.secondary">
            |
          </Typography>
          <Link
            component="button"
            variant="caption"
            underline="hover"
            disabled={noneSelected}
            onClick={handleClearAll}
            sx={{
              color: noneSelected ? theme.palette.text.disabled : theme.palette.primary.main,
              cursor: noneSelected ? "default" : "pointer",
            }}>
            {t("clear_all")}
          </Link>
        </Stack>
      )}

      {/* Checkbox list */}
      <Stack spacing={0}>
        {visibleValues.map((value) => {
          const isSelected = selectedValues.includes(value);
          return (
            <FormControlLabel
              key={value}
              control={
                <Checkbox
                  size="small"
                  checked={isSelected}
                  onChange={(e) => handleCheckboxChange(value, e.target.checked)}
                  sx={{
                    py: 0.5,
                    color: theme.palette.action.active,
                    "&.Mui-checked": {
                      color: color,
                    },
                  }}
                />
              }
              label={
                <Typography variant="body2" noWrap sx={{ maxWidth: 200 }}>
                  {labelMapLookup.get(value) || value}
                </Typography>
              }
              sx={{
                mx: 0,
                "&:hover": {
                  backgroundColor: theme.palette.action.hover,
                  borderRadius: 1,
                },
              }}
            />
          );
        })}
      </Stack>

      {/* Show more/less toggle */}
      {hiddenCount > 0 && (
        <Link
          component="button"
          variant="caption"
          underline="hover"
          onClick={() => setShowAll(!showAll)}
          sx={{
            display: "flex",
            alignItems: "center",
            mt: 1,
            color: theme.palette.primary.main,
            cursor: "pointer",
          }}>
          {showAll ? (
            <>
              <ExpandLessIcon fontSize="small" sx={{ mr: 0.5 }} />
              {t("show_less")}
            </>
          ) : (
            <>
              <ExpandMoreIcon fontSize="small" sx={{ mr: 0.5 }} />
              {t("show_more_count", { count: hiddenCount })}
            </>
          )}
        </Link>
      )}

      {/* Limit warning */}
      {hasMoreThanLimit && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: "block" }}>
          {t("filter_limit_warning", { count: MAX_FILTER_VALUES, total: totalValuesCount })}
        </Typography>
      )}
    </Box>
  );
};

export default CheckboxFilter;
