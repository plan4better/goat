import type { DragEndEvent } from "@dnd-kit/core";
import { DndContext, closestCenter } from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import SortIcon from "@mui/icons-material/SwapVert";
import {
  Box,
  Button,
  Chip,
  IconButton,
  Paper,
  Popover,
  Skeleton,
  Stack,
  TextField,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import chroma from "chroma-js";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { pickerBorderColor, pickerBorderHoverColor } from "@/lib/constants/ui";
import { useLayerUniqueValues } from "@/lib/api/layers";
import { COLOR_RANGES, DEFAULT_COLOR_RANGE } from "@/lib/constants/color";
import type { ColorRange } from "@/lib/validations/layer";

import type { SelectorItem } from "@/types/map/common";

import { ArrowPopper } from "@/components/ArrowPoper";
import type { PopperMenuItem } from "@/components/common/PopperMenu";
import WidgetColorPicker from "@/components/builder/widgets/common/WidgetColorPicker";
import MoreMenu from "@/components/common/PopperMenu";
import FormLabelHelper from "@/components/common/FormLabelHelper";
import Selector from "@/components/map/panels/common/Selector";
import ColorPalette from "@/components/map/panels/style/color/ColorPalette";
import ColorRangeSelector from "@/components/map/panels/style/color/ColorRangeSelector";

import { MAX_FILTER_VALUES } from "./useFilterValues";

// Default color palette for categories
const DEFAULT_PALETTE = ["#5A1846", "#900C3F", "#C70039", "#E3611C", "#F1920E", "#FFC300"];

interface ColorMapEntry {
  value: string;
  color: string;
  label: string;
}

interface SortableColorItemProps {
  item: ColorMapEntry;
  onRemove: (value: string) => void;
  onColorChange: (value: string, color: string) => void;
  onLabelChange: (value: string, label: string) => void;
  showColorPicker?: boolean;
}

const SortableColorItem = ({
  item,
  onRemove,
  onColorChange,
  onLabelChange,
  showColorPicker = true,
}: SortableColorItemProps) => {
  const theme = useTheme();
  const { t } = useTranslation("common");
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: item.value });
  const [renameAnchorEl, setRenameAnchorEl] = useState<HTMLElement | null>(null);
  const actionButtonRef = useRef<HTMLButtonElement | null>(null);
  const [draftLabel, setDraftLabel] = useState(item.label);

  const renameOpen = Boolean(renameAnchorEl);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const handleRemove = () => {
    onRemove(item.value);
  };

  const handleStartRename = () => {
    setDraftLabel(item.label);
    setRenameAnchorEl(actionButtonRef.current);
  };

  const handleRenameClose = () => {
    setRenameAnchorEl(null);
  };

  const handleRenameSave = () => {
    const nextLabel = draftLabel.trim() || item.value;
    onLabelChange(item.value, nextLabel);
    handleRenameClose();
  };

  const handleRenameCancel = () => {
    setDraftLabel(item.label);
    handleRenameClose();
  };

  const menuItems = useMemo<PopperMenuItem[]>(
    () => [
      { id: "rename", label: t("rename"), icon: ICON_NAME.EDIT },
      {
        id: "remove",
        label: t("remove"),
        icon: ICON_NAME.TRASH,
        color: theme.palette.error.main,
      },
    ],
    [t, theme.palette.error.main]
  );

  return (
    <Stack
      ref={setNodeRef}
      style={style}
      direction="row"
      alignItems="center"
      spacing={1}
      sx={{
        py: 0.5,
        px: 1,
        backgroundColor: theme.palette.background.paper,
        borderRadius: 1,
        border: `1px solid ${theme.palette.divider}`,
      }}>
      <Box {...attributes} {...listeners} sx={{ cursor: "grab", display: "flex", alignItems: "center" }}>
        <DragIndicatorIcon fontSize="small" sx={{ color: theme.palette.text.secondary }} />
      </Box>
      {showColorPicker ? (
        <WidgetColorPicker compact color={item.color} onChange={(color) => onColorChange(item.value, color)} />
      ) : null}
      <Stack sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          variant="body2"
          sx={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
          {item.label}
        </Typography>
      </Stack>
      <MoreMenu
        disablePortal={false}
        menuItems={menuItems}
        menuButton={
          <Tooltip title={t("more_options")} placement="top">
            <IconButton size="small" sx={{ px: 0.5 }} ref={actionButtonRef}>
              <Icon iconName={ICON_NAME.MORE_VERT} style={{ fontSize: "15px" }} />
            </IconButton>
          </Tooltip>
        }
        onSelect={(menuItem: PopperMenuItem) => {
          if (menuItem.id === "rename") {
            handleStartRename();
          } else if (menuItem.id === "remove") {
            handleRemove();
          }
        }}
      />
      <Popover
        open={renameOpen}
        anchorEl={renameAnchorEl}
        onClose={handleRenameCancel}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}>
        <Stack spacing={1.5} sx={{ p: 1.5, width: 280 }}>
          <Typography variant="caption" color="text.secondary">
            {`${t("value")}: ${item.value}`}
          </Typography>
          <TextField
            size="small"
            value={draftLabel}
            onChange={(event) => setDraftLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                handleRenameSave();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                handleRenameCancel();
              }
            }}
            autoFocus
            fullWidth
          />
          <Stack direction="row" spacing={1} justifyContent="flex-end">
            <Button size="small" onClick={handleRenameCancel} variant="text" sx={{ borderRadius: 0 }}>
              <Typography variant="body2" fontWeight="bold">
                {t("cancel")}
              </Typography>
            </Button>
            <Button
              size="small"
              variant="text"
              color="primary"
              onClick={handleRenameSave}
              sx={{ borderRadius: 0 }}>
              <Typography variant="body2" fontWeight="bold" color="inherit">
                {t("rename")}
              </Typography>
            </Button>
          </Stack>
        </Stack>
      </Popover>
    </Stack>
  );
};

export interface CategoryColorConfigProps {
  layerId: string | undefined;
  fieldName: string | undefined;
  /** Custom order of categories */
  customOrder: string[] | undefined;
  /** Color map: array of [category_value, hex_color] tuples */
  colorMap: [string, string][] | undefined;
  /** Label map: array of [category_value, display_label] tuples */
  labelMap?: [string, string][];
  /** Full color range object for palette selection */
  colorRange?: ColorRange;
  /** Color palette for generating default colors (extracted from colorRange.colors) */
  colorPalette?: string[];
  /** Combined callback for updating order, color_map and label_map atomically */
  onChange: (order: string[], colorMap: [string, string][], labelMap: [string, string][]) => void;
  /** Callback when palette changes - receives new colorRange and regenerated mappings */
  onPaletteChange?: (
    colorRange: ColorRange,
    order: string[],
    colorMap: [string, string][],
    labelMap: [string, string][]
  ) => void;
  cqlFilter?: object;
  showColorPicker?: boolean;
}

/**
 * Configuration panel for ordering categories with custom colors.
 * Similar to layer styling ordinal color picker - combines ordering with color assignment.
 */
const CategoryColorConfig = ({
  layerId,
  fieldName,
  customOrder,
  colorMap,
  labelMap,
  colorRange,
  colorPalette = DEFAULT_PALETTE,
  onChange,
  onPaletteChange,
  cqlFilter,
  showColorPicker = true,
}: CategoryColorConfigProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [isClickAwayEnabled, setIsClickAwayEnabled] = useState(true);

  const queryParams = useMemo(
    () => ({
      size: 100,
      page: 1,
      order: "descendent" as const,
      ...(cqlFilter ? { query: JSON.stringify(cqlFilter) } : {}),
    }),
    [cqlFilter]
  );

  const { data, isLoading } = useLayerUniqueValues(
    layerId || "",
    fieldName || "",
    layerId && fieldName ? queryParams : undefined
  );

  const totalValuesCount = data?.items?.length || 0;
  const hasMoreThanLimit = totalValuesCount > MAX_FILTER_VALUES;

  // All available values from the data
  const allValues = useMemo(() => {
    const values = data?.items?.map((item) => item.value) || [];
    return values.slice(0, MAX_FILTER_VALUES);
  }, [data?.items]);

  // Generate colors for values using the palette
  const generateColor = useCallback(
    (index: number, totalCount: number): string => {
      if (totalCount <= colorPalette.length) {
        return colorPalette[index % colorPalette.length];
      }
      // Generate interpolated colors for more items
      const colors = chroma.scale(colorPalette).mode("lch").colors(totalCount);
      return colors[index];
    },
    [colorPalette]
  );

  // Build color map lookup
  const colorMapLookup = useMemo(() => {
    const lookup = new Map<string, string>();
    colorMap?.forEach(([value, color]) => {
      lookup.set(value, color);
    });
    return lookup;
  }, [colorMap]);

  // Build label map lookup
  const labelMapLookup = useMemo(() => {
    const lookup = new Map<string, string>();
    labelMap?.forEach(([value, label]) => {
      lookup.set(value, label);
    });
    return lookup;
  }, [labelMap]);

  // Currently visible items with their colors
  const currentItems = useMemo((): ColorMapEntry[] => {
    const order = customOrder === undefined ? allValues : customOrder;
    const validOrder = order.filter((v) => allValues.includes(v));

    return validOrder.map((value, index) => ({
      value,
      color: colorMapLookup.get(value) || generateColor(index, validOrder.length),
      label: labelMapLookup.get(value) || value,
    }));
  }, [customOrder, allValues, colorMapLookup, labelMapLookup, generateColor]);

  // Items that can be added (not currently visible)
  const availableToAdd = useMemo(() => {
    const currentValues = currentItems.map((item) => item.value);
    return allValues.filter((v) => !currentValues.includes(v));
  }, [allValues, currentItems]);

  // Options for the selector dropdown
  const itemOptions = useMemo(() => {
    return availableToAdd.map((value) => ({
      value,
      label: value,
    }));
  }, [availableToAdd]);

  const updateBoth = (newItems: ColorMapEntry[]) => {
    const newOrder = newItems.map((item) => item.value);
    const newColorMap: [string, string][] = newItems.map((item) => [item.value, item.color]);
    const newLabelMap: [string, string][] = newItems.reduce<[string, string][]>((acc, item) => {
      const trimmedLabel = item.label.trim();
      if (trimmedLabel && trimmedLabel !== item.value) {
        acc.push([item.value, trimmedLabel]);
      }
      return acc;
    }, []);
    onChange(newOrder, newColorMap, newLabelMap);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = currentItems.findIndex((v) => v.value === active.id);
      const newIndex = currentItems.findIndex((v) => v.value === over.id);
      const newOrder = [...currentItems];
      const [removed] = newOrder.splice(oldIndex, 1);
      newOrder.splice(newIndex, 0, removed);
      updateBoth(newOrder);
    }
  };

  const handleRemoveItem = (value: string) => {
    const newItems = currentItems.filter((v) => v.value !== value);
    updateBoth(newItems);
  };

  const handleColorChange = (value: string, color: string) => {
    const newItems = currentItems.map((item) => (item.value === value ? { ...item, color } : item));
    updateBoth(newItems);
  };

  const handleLabelChange = (value: string, label: string) => {
    const newItems = currentItems.map((item) => (item.value === value ? { ...item, label } : item));
    updateBoth(newItems);
  };

  const handleAddItem = (item: SelectorItem | SelectorItem[] | undefined) => {
    if (item && !Array.isArray(item) && item.value) {
      const value = item.value as string;
      if (!currentItems.find((i) => i.value === value)) {
        const newColor = generateColor(currentItems.length, currentItems.length + 1);
        const newItems = [...currentItems, { value, color: newColor, label: value }];
        updateBoth(newItems);
      }
    }
  };

  const handleAddAll = () => {
    const newItems = allValues.map((value, index) => ({
      value,
      color: colorMapLookup.get(value) || generateColor(index, allValues.length),
      label: labelMapLookup.get(value) || value,
    }));
    updateBoth(newItems);
  };

  const handleRemoveAll = () => {
    updateBoth([]);
  };

  // Smart sort: handles numbers numerically and strings alphabetically
  const handleSort = () => {
    const sorted = [...currentItems].sort((a, b) => {
      const numA = parseFloat(a.value);
      const numB = parseFloat(b.value);
      if (!isNaN(numA) && !isNaN(numB)) {
        return numA - numB;
      }
      return a.value.localeCompare(b.value);
    });
    updateBoth(sorted);
  };

  // Calculate the actual category count for palette selection
  const categoryCount = useMemo(() => {
    return currentItems.length || allValues.length || 6;
  }, [currentItems.length, allValues.length]);

  // Generate display colors matching the number of categories
  // Must be defined before early returns to maintain consistent hook order
  const displayColors = useMemo(() => {
    if (currentItems.length > 0) {
      return currentItems.map((item) => item.color);
    }

    if (categoryCount <= colorPalette.length) {
      return colorPalette.slice(0, categoryCount);
    }
    return chroma.scale(colorPalette).mode("lch").colors(categoryCount);
  }, [currentItems, colorPalette, categoryCount]);

  // Create an adjusted color range for the ColorRangeSelector with the correct number of steps
  // This ensures the palette picker shows palettes with the right number of colors
  const adjustedColorRange = useMemo((): ColorRange => {
    const baseRange = colorRange || DEFAULT_COLOR_RANGE;
    const currentItemColors = currentItems.map((item) => item.color);

    if (currentItemColors.length > 0) {
      return {
        ...baseRange,
        colors: currentItemColors,
      };
    }

    // If current palette already has the right number of colors, use it
    if (baseRange.colors.length === categoryCount) {
      return baseRange;
    }

    // Find a palette with the exact number of colors needed
    // First, look for a palette with the same type/category but correct step count
    let matchingPalette = COLOR_RANGES.find(
      (range) =>
        range.colors.length === categoryCount &&
        (range.category === baseRange.category || range.type === baseRange.type)
    );

    // If no matching palette found, find any palette with the correct number of colors
    if (!matchingPalette) {
      matchingPalette = COLOR_RANGES.find((range) => range.colors.length === categoryCount);
    }

    // If still no match (e.g., 11 colors not available), use closest available
    if (!matchingPalette) {
      // Find closest step count
      const availableSteps = [...new Set(COLOR_RANGES.map((r) => r.colors.length))].sort((a, b) => a - b);
      const closestStep = availableSteps.reduce((prev, curr) =>
        Math.abs(curr - categoryCount) < Math.abs(prev - categoryCount) ? curr : prev
      );
      matchingPalette =
        COLOR_RANGES.find(
          (range) =>
            range.colors.length === closestStep &&
            (range.category === baseRange.category || range.type === baseRange.type)
        ) || COLOR_RANGES.find((range) => range.colors.length === closestStep);
    }

    if (matchingPalette) {
      return {
        ...matchingPalette,
        reversed: baseRange.reversed,
      };
    }

    // Fallback: return base range with interpolated colors
    return {
      ...baseRange,
      colors: chroma.scale(baseRange.colors).mode("lch").colors(categoryCount),
    };
  }, [colorRange, categoryCount, currentItems]);

  const handlePaletteSelect = useCallback(
    (newColorRange: ColorRange) => {
      // When palette changes, regenerate all colors from the new palette
      const newPalette = newColorRange.colors;
      const count = categoryCount;
      const newColors =
        count <= newPalette.length
          ? newPalette.slice(0, count)
          : chroma.scale(newPalette).mode("lch").colors(count);

      // Update all items with new colors from the palette
      const newItems = currentItems.map((item, index) => ({
        ...item,
        color: newColors[index % newColors.length],
      }));

      // Build the new order and colorMap
      const newOrder = newItems.map((item) => item.value);
      const newColorMap: [string, string][] = newItems.map((item) => [item.value, item.color]);
      const newLabelMap: [string, string][] = newItems.reduce<[string, string][]>((acc, item) => {
        const trimmedLabel = item.label.trim();
        if (trimmedLabel && trimmedLabel !== item.value) {
          acc.push([item.value, trimmedLabel]);
        }
        return acc;
      }, []);

      // Call the combined callback with all data for atomic update
      if (onPaletteChange) {
        onPaletteChange(newColorRange, newOrder, newColorMap, newLabelMap);
      }
      setPaletteOpen(false);
    },
    [currentItems, categoryCount, onPaletteChange]
  );

  if (!layerId || !fieldName) {
    return (
      <Typography variant="caption" color="text.secondary" sx={{ fontStyle: "italic" }}>
        {t("select_dataset_and_field_first")}
      </Typography>
    );
  }

  if (isLoading) {
    return (
      <Stack spacing={1}>
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} variant="rounded" height={40} />
        ))}
      </Stack>
    );
  }

  if (allValues.length === 0) {
    return (
      <Typography variant="caption" color="text.secondary" sx={{ fontStyle: "italic" }}>
        {t("no_values_found")}
      </Typography>
    );
  }

  return (
    <Box>
      {/* Palette selector */}
      {onPaletteChange && (
        <ArrowPopper
          open={paletteOpen}
          placement="bottom"
          arrow={false}
          isClickAwayEnabled={isClickAwayEnabled}
          onClose={() => setPaletteOpen(false)}
          content={
            <Paper
              sx={{
                py: 3,
                boxShadow: "rgba(0, 0, 0, 0.16) 0px 6px 12px 0px",
                width: "235px",
                maxHeight: "500px",
              }}>
              <ColorRangeSelector
                scaleType="ordinal"
                selectedColorRange={adjustedColorRange}
                onSelectColorRange={handlePaletteSelect}
                setIsBusy={(busy) => setIsClickAwayEnabled(!busy)}
                setIsOpen={setPaletteOpen}
              />
            </Paper>
          }>
          <Stack spacing={1} sx={{ mb: 2 }}>
            <FormLabelHelper
              color={paletteOpen ? theme.palette.primary.main : "inherit"}
              label={t("palette")}
            />
            <Stack
              onClick={() => setPaletteOpen(!paletteOpen)}
              direction="row"
              alignItems="center"
              sx={{
                borderRadius: theme.spacing(1.2),
                border: "1px solid",
                outline: "2px solid transparent",
                minHeight: "40px",
                borderColor: pickerBorderColor(theme),
                ...(paletteOpen && {
                  outline: `2px solid ${theme.palette.primary.main}`,
                }),
                cursor: "pointer",
                p: 2,
                "&:hover": {
                  ...(!paletteOpen && {
                    borderColor: pickerBorderHoverColor(theme),
                  }),
                },
              }}>
              <ColorPalette colors={displayColors} />
            </Stack>
          </Stack>
        </ArrowPopper>
      )}

      {/* Header with title and actions */}
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
        <Typography variant="body2" fontWeight="medium">
          {t("order")} ({currentItems.length}/{allValues.length})
        </Typography>
        <Stack direction="row" spacing={0.5}>
          <Tooltip title={t("sort_ascending")}>
            <span>
              <IconButton size="small" onClick={handleSort} disabled={currentItems.length < 2}>
                <SortIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
      </Stack>

      {hasMoreThanLimit && (
        <Typography variant="caption" color="warning.main" sx={{ mb: 1, display: "block" }}>
          {t("filter_limit_warning", { count: MAX_FILTER_VALUES, total: totalValuesCount })}
        </Typography>
      )}

      {/* Add item dropdown */}
      {itemOptions.length > 0 ? (
        <Box sx={{ mb: 1 }}>
          <Selector
            selectedItems={undefined}
            setSelectedItems={handleAddItem}
            items={itemOptions}
            label={t("add_category")}
            placeholder={t("select_category")}
          />
        </Box>
      ) : null}

      {/* Quick actions */}
      <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
        <Chip
          label={t("add_all")}
          size="small"
          variant="outlined"
          onClick={handleAddAll}
          disabled={availableToAdd.length === 0}
          sx={{ fontSize: "0.75rem" }}
        />
        <Chip
          label={t("remove_all")}
          size="small"
          variant="outlined"
          onClick={handleRemoveAll}
          disabled={currentItems.length === 0}
          sx={{ fontSize: "0.75rem" }}
        />
      </Stack>

      {/* Visible items list with colors */}
      {currentItems.length > 0 && (
        <DndContext
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={handleDragEnd}>
          <SortableContext items={currentItems.map((i) => i.value)} strategy={verticalListSortingStrategy}>
            <Stack spacing={1}>
              {currentItems.map((item) => (
                <SortableColorItem
                  key={item.value}
                  item={item}
                  onRemove={handleRemoveItem}
                  onColorChange={handleColorChange}
                  onLabelChange={handleLabelChange}
                  showColorPicker={showColorPicker}
                />
              ))}
            </Stack>
          </SortableContext>
        </DndContext>
      )}
    </Box>
  );
};

export default CategoryColorConfig;
