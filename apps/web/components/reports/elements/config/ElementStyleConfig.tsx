"use client";

import { Box, Checkbox, Collapse, Paper, Slider, Stack, Typography, useTheme } from "@mui/material";
import { styled } from "@mui/material/styles";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { pickerBorderColor, pickerBorderHoverColor } from "@/lib/constants/ui";
import { rgbToHex } from "@/lib/utils/helpers";
import type { ReportElement } from "@/lib/validations/reportLayout";

import type { RGBColor } from "@/types/map/color";
import type { SelectorItem } from "@/types/map/common";

import { ArrowPopper } from "@/components/ArrowPoper";
import FormLabelHelper from "@/components/common/FormLabelHelper";
import SectionHeader from "@/components/map/panels/common/SectionHeader";
import SectionOptions from "@/components/map/panels/common/SectionOptions";
import Selector from "@/components/map/panels/common/Selector";
import SingleColorSelector from "@/components/map/panels/style/color/SingleColorSelector";

// Border width options in mm
const BORDER_WIDTH_OPTIONS: SelectorItem[] = [
  { label: "0.1 mm", value: 0.1 },
  { label: "0.25 mm", value: 0.25 },
  { label: "0.5 mm", value: 0.5 },
  { label: "0.75 mm", value: 0.75 },
  { label: "1 mm", value: 1 },
  { label: "1.5 mm", value: 1.5 },
  { label: "2 mm", value: 2 },
  { label: "3 mm", value: 3 },
  { label: "4 mm", value: 4 },
  { label: "5 mm", value: 5 },
];

interface ColorPickerButtonProps {
  color: string;
  onChange: (color: string) => void;
  label?: string;
}

// Styled color block - horizontal bar like in layer style
const ColorBlock = styled("div")<{ bgcolor: string }>(({ theme, bgcolor }) => ({
  width: "100%",
  height: "18px",
  borderRadius: theme.spacing(1),
  backgroundColor: bgcolor,
  border: `1px solid ${theme.palette.divider}`,
}));

/**
 * Color picker with horizontal color bar and popper (like layer style ColorSelector)
 */
const ColorPickerButton: React.FC<ColorPickerButtonProps> = ({ color, onChange, label }) => {
  const theme = useTheme();
  const [open, setOpen] = useState(false);

  const handleColorSelect = (rgbColor: RGBColor) => {
    onChange(rgbToHex(rgbColor));
  };

  return (
    <ArrowPopper
      open={open}
      placement="bottom"
      arrow={false}
      onClose={() => setOpen(false)}
      content={
        <Paper
          sx={{
            py: 3,
            boxShadow: "rgba(0, 0, 0, 0.16) 0px 6px 12px 0px",
            width: "235px",
            maxHeight: "500px",
          }}>
          <SingleColorSelector selectedColor={color} onSelectColor={handleColorSelect} />
        </Paper>
      }>
      <Stack spacing={1}>
        {label && <FormLabelHelper color={open ? theme.palette.primary.main : "inherit"} label={label} />}
        <Stack
          onClick={() => setOpen(!open)}
          direction="row"
          alignItems="center"
          sx={{
            borderRadius: theme.spacing(1.2),
            border: "1px solid",
            outline: "2px solid transparent",
            minHeight: "40px",
            borderColor: pickerBorderColor(theme),
            ...(open && {
              outline: `2px solid ${theme.palette.primary.main}`,
            }),
            cursor: "pointer",
            p: 2,
            "&:hover": {
              ...(!open && {
                borderColor: pickerBorderHoverColor(theme),
              }),
            },
          }}>
          <ColorBlock bgcolor={color} />
        </Stack>
      </Stack>
    </ArrowPopper>
  );
};

// Style configuration types matching the schema
interface BorderStyle {
  enabled?: boolean;
  color?: string;
  width?: number;
}

interface BackgroundStyle {
  enabled?: boolean;
  color?: string;
  opacity?: number;
}

interface ElementStyle {
  border?: BorderStyle;
  background?: BackgroundStyle;
  padding?: number;
  opacity?: number;
}

interface ElementStyleConfigProps {
  element: ReportElement;
  onChange: (updates: Partial<ReportElement>) => void;
}

/**
 * Element Style Configuration Panel
 *
 * Provides controls for:
 * - Border: enable/disable, color, width (mm)
 * - Background: enable/disable, color, opacity
 */
const ElementStyleConfig: React.FC<ElementStyleConfigProps> = ({ element, onChange }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();

  // Section collapsed states
  const [styleCollapsed, setStyleCollapsed] = useState(false);

  // Extract current style
  const style = (element.style ?? {}) as ElementStyle;
  const borderStyle = style.border ?? { enabled: false, color: "#000000", width: 0.5 };
  const backgroundStyle = style.background ?? { enabled: false, color: "#ffffff", opacity: 1 };

  // Find selected border width item
  const selectedBorderWidthItem = useMemo(
    () =>
      BORDER_WIDTH_OPTIONS.find((item) => item.value === (borderStyle.width ?? 0.5)) ??
      BORDER_WIDTH_OPTIONS[2],
    [borderStyle.width]
  );

  // Handle style updates - use type assertion to work around zod's inferred types
  const updateStyle = (updates: Partial<ElementStyle>) => {
    const newStyle = {
      ...style,
      ...updates,
    };
    // Cast to unknown first, then to the expected type to bypass strict type checking
    onChange({
      style: newStyle as unknown as ReportElement["style"],
    });
  };

  // Handle border toggle
  const handleBorderToggle = (enabled: boolean) => {
    updateStyle({
      border: {
        ...borderStyle,
        enabled,
      },
    });
  };

  // Handle border color change
  const handleBorderColorChange = (color: string) => {
    updateStyle({
      border: {
        ...borderStyle,
        color,
      },
    });
  };

  // Handle border width change
  const handleBorderWidthChange = (item: SelectorItem | SelectorItem[] | undefined) => {
    if (!item || Array.isArray(item)) return;
    updateStyle({
      border: {
        ...borderStyle,
        width: item.value as number,
      },
    });
  };

  // Handle background toggle
  const handleBackgroundToggle = (enabled: boolean) => {
    updateStyle({
      background: {
        ...backgroundStyle,
        enabled,
      },
    });
  };

  // Handle background color change
  const handleBackgroundColorChange = (color: string) => {
    updateStyle({
      background: {
        ...backgroundStyle,
        color,
      },
    });
  };

  // Handle background opacity change
  const handleBackgroundOpacityChange = (_event: Event, value: number | number[]) => {
    const opacity = Array.isArray(value) ? value[0] : value;
    updateStyle({
      background: {
        ...backgroundStyle,
        opacity,
      },
    });
  };

  return (
    <Stack spacing={2}>
      {/* Style Section */}
      <SectionHeader
        label={t("style")}
        icon={ICON_NAME.STYLE}
        active={true}
        alwaysActive
        collapsed={styleCollapsed}
        setCollapsed={setStyleCollapsed}
        disableAdvanceOptions
      />
      <SectionOptions
        active={true}
        collapsed={styleCollapsed}
        baseOptions={
          <Stack spacing={3}>
            {/* Border checkbox and options */}
            <Box>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                <Checkbox
                  size="small"
                  color="primary"
                  checked={borderStyle.enabled ?? false}
                  onChange={(e) => handleBorderToggle(e.target.checked)}
                  sx={{ p: 0 }}
                />
                <Typography variant="body2">{t("border")}</Typography>
              </Stack>
              <Collapse in={borderStyle.enabled ?? false}>
                <Stack spacing={2} sx={{ pl: 3 }}>
                  <ColorPickerButton
                    color={borderStyle.color ?? "#000000"}
                    onChange={handleBorderColorChange}
                    label={t("color")}
                  />
                  <Selector
                    selectedItems={selectedBorderWidthItem}
                    setSelectedItems={handleBorderWidthChange}
                    items={BORDER_WIDTH_OPTIONS}
                    label={t("width")}
                  />
                </Stack>
              </Collapse>
            </Box>

            {/* Background checkbox and options */}
            <Box>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                <Checkbox
                  size="small"
                  color="primary"
                  checked={backgroundStyle.enabled ?? false}
                  onChange={(e) => handleBackgroundToggle(e.target.checked)}
                  sx={{ p: 0 }}
                />
                <Typography variant="body2">{t("background")}</Typography>
              </Stack>
              <Collapse in={backgroundStyle.enabled ?? false}>
                <Stack spacing={2} sx={{ pl: 3 }}>
                  <ColorPickerButton
                    color={backgroundStyle.color ?? "#ffffff"}
                    onChange={handleBackgroundColorChange}
                    label={t("color")}
                  />
                  <Stack spacing={1}>
                    <FormLabelHelper
                      label={`${t("opacity")} (${Math.round((backgroundStyle.opacity ?? 1) * 100)}%)`}
                      color={theme.palette.text.secondary}
                    />
                    <Slider
                      size="small"
                      value={backgroundStyle.opacity ?? 1}
                      onChange={handleBackgroundOpacityChange}
                      min={0}
                      max={1}
                      step={0.05}
                      sx={{ mx: 1 }}
                    />
                  </Stack>
                </Stack>
              </Collapse>
            </Box>
          </Stack>
        }
      />
    </Stack>
  );
};

export default ElementStyleConfig;
