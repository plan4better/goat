"use client";

import { Paper, Stack, useTheme } from "@mui/material";
import { styled } from "@mui/material/styles";
import React, { useState } from "react";
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

interface DividerElementConfigProps {
  element: ReportElement;
  onChange: (updates: Partial<ReportElement>) => void;
}

export type DividerOrientation = "horizontal" | "vertical";

export interface DividerConfig {
  orientation?: DividerOrientation;
  color?: string;
  thickness?: number;
}

// Orientation options for dropdown (labels are translation keys)
const ORIENTATION_OPTIONS: SelectorItem[] = [
  { label: "horizontal", value: "horizontal" },
  { label: "vertical", value: "vertical" },
];

// Thickness options in mm (same as border width)
const THICKNESS_OPTIONS: SelectorItem[] = [
  { label: "0.25 mm", value: 0.25 },
  { label: "0.5 mm", value: 0.5 },
  { label: "0.75 mm", value: 0.75 },
  { label: "1 mm", value: 1 },
  { label: "1.5 mm", value: 1.5 },
  { label: "2 mm", value: 2 },
  { label: "3 mm", value: 3 },
];

// Styled color block - horizontal bar like in layer style
const ColorBlock = styled("div")<{ bgcolor: string }>(({ theme, bgcolor }) => ({
  width: "100%",
  height: "18px",
  borderRadius: theme.spacing(1),
  backgroundColor: bgcolor,
  border: `1px solid ${theme.palette.divider}`,
}));

interface ColorPickerButtonProps {
  color: string;
  onChange: (color: string) => void;
  label?: string;
}

/**
 * Color picker with horizontal color bar and popper
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
        {label && (
          <FormLabelHelper
            color={open ? theme.palette.primary.main : theme.palette.text.secondary}
            label={label}
          />
        )}
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

const DividerElementConfig: React.FC<DividerElementConfigProps> = ({ element, onChange }) => {
  const { t } = useTranslation("common");
  const [optionsCollapsed, setOptionsCollapsed] = useState(false);
  const [styleCollapsed, setStyleCollapsed] = useState(false);

  const setup = ((element.config ?? {}) as { setup?: DividerConfig }).setup ?? {};
  const orientation = setup.orientation ?? "horizontal";
  const color = setup.color ?? "#000000";
  const thickness = setup.thickness ?? 1;

  // Selected items for dropdowns
  const orientationOptions = ORIENTATION_OPTIONS.map((item) => ({ ...item, label: t(item.label) }));
  const selectedOrientationItem = orientationOptions.find((item) => item.value === orientation);
  const selectedThicknessItem = THICKNESS_OPTIONS.find((item) => item.value === thickness);

  const handleOrientationChange = (item: SelectorItem[] | SelectorItem | undefined) => {
    if (!item || Array.isArray(item)) return;
    const newOrientation = item.value as DividerOrientation;

    // Swap width and height when changing orientation to preserve the line length
    const currentWidth = element.position?.width ?? 150;
    const currentHeight = element.position?.height ?? 2;

    // When switching orientation, swap width and height
    const newWidth = newOrientation !== orientation ? currentHeight : currentWidth;
    const newHeight = newOrientation !== orientation ? currentWidth : currentHeight;

    onChange({
      position: {
        ...element.position,
        width: newWidth,
        height: newHeight,
      },
      config: {
        ...element.config,
        setup: {
          ...setup,
          orientation: newOrientation,
        },
      },
    });
  };

  const handleColorChange = (newColor: string) => {
    onChange({
      config: {
        ...element.config,
        setup: {
          ...setup,
          color: newColor,
        },
      },
    });
  };

  const handleThicknessChange = (item: SelectorItem[] | SelectorItem | undefined) => {
    if (!item || Array.isArray(item)) return;
    onChange({
      config: {
        ...element.config,
        setup: {
          ...setup,
          thickness: item.value as number,
        },
      },
    });
  };

  return (
    <Stack spacing={2}>
      {/* Options Section */}
      <SectionHeader
        label={t("options")}
        icon={ICON_NAME.SLIDERS}
        active={true}
        alwaysActive
        collapsed={optionsCollapsed}
        setCollapsed={setOptionsCollapsed}
        disableAdvanceOptions
      />
      <SectionOptions
        active={true}
        collapsed={optionsCollapsed}
        baseOptions={
          <Stack spacing={3}>
            <Selector
              selectedItems={selectedOrientationItem}
              setSelectedItems={handleOrientationChange}
              items={orientationOptions}
              label={t("orientation")}
            />
          </Stack>
        }
      />

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
            <ColorPickerButton color={color} onChange={handleColorChange} label={t("color")} />
            <Selector
              selectedItems={selectedThicknessItem}
              setSelectedItems={handleThicknessChange}
              items={THICKNESS_OPTIONS}
              label={t("thickness")}
            />
          </Stack>
        }
      />
    </Stack>
  );
};

export default DividerElementConfig;
