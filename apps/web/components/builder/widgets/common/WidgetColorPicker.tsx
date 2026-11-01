import { Paper, Stack, useTheme } from "@mui/material";
import { styled } from "@mui/material/styles";
import { useState } from "react";

import { pickerBorderColor, pickerBorderHoverColor } from "@/lib/constants/ui";
import { rgbToHex } from "@/lib/utils/helpers";

import type { RGBColor } from "@/types/map/color";

import { ArrowPopper } from "@/components/ArrowPoper";
import FormLabelHelper from "@/components/common/FormLabelHelper";
import SingleColorSelector from "@/components/map/panels/style/color/SingleColorSelector";

interface WidgetColorPickerProps {
  color: string;
  onChange: (color: string) => void;
  label?: string;
  /** Compact mode: show only a small color swatch instead of full bar */
  compact?: boolean;
}

// Styled color block - horizontal bar
const ColorBlock = styled("div")<{ bgcolor: string }>(({ theme, bgcolor }) => ({
  width: "100%",
  height: "18px",
  borderRadius: theme.spacing(1),
  backgroundColor: bgcolor,
  border: `1px solid ${theme.palette.divider}`,
}));

// Styled color swatch - small square for compact mode
const ColorSwatch = styled("div")<{ bgcolor: string }>(({ theme, bgcolor }) => ({
  width: "24px",
  height: "24px",
  borderRadius: theme.spacing(0.5),
  backgroundColor: bgcolor,
  border: `1px solid ${theme.palette.divider}`,
  cursor: "pointer",
  flexShrink: 0,
  "&:hover": {
    borderColor: theme.palette.primary.main,
  },
}));

/**
 * Color picker component for widget configuration panels.
 * Shows a horizontal color bar that opens a color picker popover on click.
 * In compact mode, shows only a small color swatch.
 */
const WidgetColorPicker: React.FC<WidgetColorPickerProps> = ({ color, onChange, label, compact = false }) => {
  const theme = useTheme();
  const [open, setOpen] = useState(false);

  const handleColorSelect = (rgbColor: RGBColor) => {
    onChange(rgbToHex(rgbColor));
  };

  if (compact) {
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
        <ColorSwatch bgcolor={color} onClick={() => setOpen(!open)} />
      </ArrowPopper>
    );
  }

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

export default WidgetColorPicker;
