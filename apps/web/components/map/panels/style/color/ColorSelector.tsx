import { Paper, Stack } from "@mui/material";
import { styled, useTheme } from "@mui/material/styles";
import { useCallback, useState } from "react";

import { pickerBorderColor, pickerBorderHoverColor } from "@/lib/constants/ui";
import { rgbToHex } from "@/lib/utils/helpers";
import type { ColorRange } from "@/lib/validations/layer";

import type { ColorSet, RGBColor } from "@/types/map/color";

import { ArrowPopper } from "@/components/ArrowPoper";
import FormLabelHelper from "@/components/common/FormLabelHelper";
import ColorPalette from "@/components/map/panels/style/color/ColorPalette";
import ColorRangeSelector from "@/components/map/panels/style/color/ColorRangeSelector";
import SingleColorSelector from "@/components/map/panels/style/color/SingleColorSelector";

type ColorSelectorProps = {
  scaleType?: string;
  colorSet: ColorSet;
  label?: string;
  tooltip?: string;
};

const ColorBlock = styled("div")<{ theme; backgroundcolor: RGBColor }>(({ theme, backgroundcolor }) => ({
  width: "100%",
  height: "18px",
  borderRadius: theme.spacing(1),
  backgroundColor: Array.isArray(backgroundcolor)
    ? `rgb(${backgroundcolor.slice(0, 3).join(",")})`
    : "transparent",
}));

const ColorSelector = (props: ColorSelectorProps) => {
  const theme = useTheme();
  const { colorSet } = props;
  const [open, setOpen] = useState(false);
  const [isClickAwayEnabled, setIsClickAwayEnabled] = useState(true);
  const onSelectColor = useCallback(
    (color: RGBColor | ColorRange) => {
      colorSet.setColor(color);
    },
    [colorSet]
  );

  return (
    <>
      <ArrowPopper
        open={open}
        placement="bottom"
        arrow={false}
        isClickAwayEnabled={isClickAwayEnabled}
        onClose={() => setOpen(false)}
        content={
          <>
            <Paper
              sx={{
                py: 3,
                boxShadow: "rgba(0, 0, 0, 0.16) 0px 6px 12px 0px",
                width: "235px",
                maxHeight: "500px",
              }}>
              {colorSet.isRange ? (
                <ColorRangeSelector
                  scaleType={props.scaleType}
                  selectedColorRange={colorSet.selectedColor as ColorRange}
                  onSelectColorRange={onSelectColor}
                  setIsBusy={(busy) => setIsClickAwayEnabled(!busy)}
                  setIsOpen={setOpen}
                />
              ) : (
                <SingleColorSelector
                  selectedColor={rgbToHex(colorSet.selectedColor as RGBColor)}
                  onSelectColor={onSelectColor}
                />
              )}
            </Paper>
          </>
        }>
        {/* {INPUT} */}
        <Stack spacing={1}>
          {props.label && (
            <FormLabelHelper
              color={open ? theme.palette.primary.main : "inherit"}
              label={props.label}
              tooltip={props.tooltip}
            />
          )}
          <Stack
            role="button"
            tabIndex={0}
            aria-label={props.label}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setOpen(!open);
              }
            }}
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
            {colorSet.isRange ? (
              <ColorPalette colors={(colorSet.selectedColor as ColorRange).colors} />
            ) : (
              <ColorBlock theme={theme} backgroundcolor={colorSet.selectedColor as RGBColor} />
            )}
            {colorSet.label ? <div>{colorSet.label}</div> : null}
          </Stack>
        </Stack>
      </ArrowPopper>
    </>
  );
};

export default ColorSelector;
