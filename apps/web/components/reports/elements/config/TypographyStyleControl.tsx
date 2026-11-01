"use client";

import { MenuItem, Paper, Select, Stack, TextField, useTheme } from "@mui/material";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  DEFAULT_FONT_FAMILY,
  FONT_FAMILIES,
  FONT_SIZE_UNITS,
  formatFontSize,
  parseFontSize,
} from "@/lib/constants/typography";
import { pickerBorderColor, pickerBorderHoverColor } from "@/lib/constants/ui";
import type { TypographyStyle } from "@/lib/constants/typography";
import { rgbToHex } from "@/lib/utils/helpers";

import type { RGBColor } from "@/types/map/color";
import type { SelectorItem } from "@/types/map/common";

import { ArrowPopper } from "@/components/ArrowPoper";
import FormLabelHelper from "@/components/common/FormLabelHelper";
import Selector from "@/components/map/panels/common/Selector";
import SingleColorSelector from "@/components/map/panels/style/color/SingleColorSelector";

// Styled color block for inline color display
const ColorBlock = ({ color, onClick }: { color: string; onClick: () => void }) => {
  const theme = useTheme();
  return (
    <Stack
      onClick={onClick}
      direction="row"
      alignItems="center"
      sx={{
        borderRadius: theme.spacing(1.2),
        border: "1px solid",
        minHeight: "40px",
        borderColor: pickerBorderColor(theme),
        cursor: "pointer",
        p: 2,
        "&:hover": {
          borderColor: pickerBorderHoverColor(theme),
        },
      }}>
      <div
        style={{
          width: "100%",
          height: "18px",
          borderRadius: theme.spacing(1),
          backgroundColor: color,
          border: `1px solid ${theme.palette.divider}`,
        }}
      />
    </Stack>
  );
};

// Font family selector items
const FONT_FAMILY_ITEMS: SelectorItem[] = FONT_FAMILIES.map((f) => ({
  label: f.label,
  value: f.value,
}));

// Font weight selector items (labels are translation keys)
const FONT_WEIGHT_ITEMS: SelectorItem[] = [
  { label: "normal", value: "normal" },
  { label: "bold", value: "bold" },
];

interface TypographyStyleControlProps {
  value: TypographyStyle;
  onChange: (style: TypographyStyle) => void;
}

/**
 * Reusable typography style control for report element config panels.
 * Renders font family, font size + unit, font weight, and font color.
 */
const TypographyStyleControl: React.FC<TypographyStyleControlProps> = ({ value, onChange }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const [colorOpen, setColorOpen] = useState(false);

  const parsed = parseFontSize(value.fontSize);
  const currentFamily = value.fontFamily || DEFAULT_FONT_FAMILY;
  const currentWeight = value.fontWeight || "normal";
  const currentColor = value.fontColor || "#000000";

  const selectedFamilyItem = FONT_FAMILY_ITEMS.find((item) => item.value === currentFamily) || FONT_FAMILY_ITEMS[0];
  const fontWeightItems = FONT_WEIGHT_ITEMS.map((item) => ({ ...item, label: t(item.label) }));
  const selectedWeightItem = fontWeightItems.find((item) => item.value === currentWeight) || fontWeightItems[0];

  const handleFamilyChange = (item: SelectorItem | SelectorItem[] | undefined) => {
    if (!item || Array.isArray(item)) return;
    onChange({ ...value, fontFamily: item.value as string });
  };

  const handleWeightChange = (item: SelectorItem | SelectorItem[] | undefined) => {
    if (!item || Array.isArray(item)) return;
    onChange({ ...value, fontWeight: item.value as "normal" | "bold" });
  };

  const handleSizeChange = (newSize: string) => {
    const num = parseFloat(newSize);
    if (isNaN(num) || num <= 0) return;
    onChange({ ...value, fontSize: formatFontSize(num, parsed.unit) });
  };

  const handleUnitChange = (newUnit: string) => {
    onChange({ ...value, fontSize: formatFontSize(parsed.size, newUnit) });
  };

  const handleColorSelect = (rgb: RGBColor) => {
    onChange({ ...value, fontColor: rgbToHex(rgb) });
  };

  return (
    <Stack spacing={2}>
      {/* Font Family */}
      <Selector
        selectedItems={selectedFamilyItem}
        setSelectedItems={handleFamilyChange}
        items={FONT_FAMILY_ITEMS}
        label={t("font_family")}
      />

      {/* Font Size + Unit */}
      <Stack spacing={1}>
        <FormLabelHelper label={t("font_size")} color={theme.palette.text.secondary} />
        <Stack direction="row" spacing={1}>
          <TextField
            type="number"
            size="small"
            value={parsed.size}
            onChange={(e) => handleSizeChange(e.target.value)}
            inputProps={{ min: 1, max: parsed.unit === "pt" ? 200 : 70, step: 1 }}
            sx={{ flex: 1 }}
          />
          <Select
            size="small"
            value={parsed.unit}
            onChange={(e) => handleUnitChange(e.target.value)}
            sx={{ minWidth: 65 }}>
            {FONT_SIZE_UNITS.map((u) => (
              <MenuItem key={u.value} value={u.value} dense>
                {u.label}
              </MenuItem>
            ))}
          </Select>
        </Stack>
      </Stack>

      {/* Font Weight */}
      <Selector
        selectedItems={selectedWeightItem}
        setSelectedItems={handleWeightChange}
        items={fontWeightItems}
        label={t("font_weight")}
      />

      {/* Font Color */}
      <ArrowPopper
        open={colorOpen}
        placement="bottom"
        arrow={false}
        onClose={() => setColorOpen(false)}
        content={
          <Paper
            sx={{
              py: 3,
              boxShadow: "rgba(0, 0, 0, 0.16) 0px 6px 12px 0px",
              width: "235px",
              maxHeight: "500px",
            }}>
            <SingleColorSelector selectedColor={currentColor} onSelectColor={handleColorSelect} />
          </Paper>
        }>
        <Stack spacing={1}>
          <FormLabelHelper
            color={colorOpen ? theme.palette.primary.main : theme.palette.text.secondary}
            label={t("text_color")}
          />
          <ColorBlock color={currentColor} onClick={() => setColorOpen(!colorOpen)} />
        </Stack>
      </ArrowPopper>
    </Stack>
  );
};

export default TypographyStyleControl;
