import { Paper, Stack, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { pickerBorderColor, pickerBorderHoverColor } from "@/lib/constants/ui";

import type { ColorScaleSelectorProps } from "@/types/map/color";

import { ArrowPopper } from "@/components/ArrowPoper";
import FormLabelHelper from "@/components/common/FormLabelHelper";
import CustomColorScale from "@/components/map/panels/style/classification/CustomColorScale";
import NumericColorScale from "@/components/map/panels/style/classification/NumericColorScale";

const ColorScaleSelector = (props: ColorScaleSelectorProps) => {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const { t } = useTranslation("common");
  const [isClickAwayEnabled, setIsClickAwayEnabled] = useState(true);

  return (
    <>
      <ArrowPopper
        open={open}
        placement="bottom"
        arrow={false}
        disablePortal={false}
        isClickAwayEnabled={isClickAwayEnabled}
        onClose={() => setOpen(false)}
        content={
          <>
            <Paper
              sx={{
                boxShadow: "rgba(0, 0, 0, 0.16) 0px 6px 12px 0px",
                width: "235px",
                maxHeight: "500px",
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
              }}>
              {props.activeLayerField.type === "number" &&
                props.selectedColorScaleMethod !== "ordinal" &&
                props.selectedColorScaleMethod !== "custom_breaks" && (
                  <NumericColorScale
                    {...props}
                    onCancel={() => setOpen(false)}
                    setIsClickAwayEnabled={setIsClickAwayEnabled}
                  />
                )}
              {(props.selectedColorScaleMethod === "ordinal" ||
                props.selectedColorScaleMethod === "custom_breaks") && (
                <CustomColorScale
                  {...props}
                  onCancel={() => setOpen(false)}
                  onApply={(colorMaps, colorLegends) => {
                    props.onCustomApply && props.onCustomApply(colorMaps, colorLegends);
                    setOpen(false);
                  }}
                  setIsClickAwayEnabled={setIsClickAwayEnabled}
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
              p: 1.7,
              "&:hover": {
                ...(!open && {
                  borderColor: pickerBorderHoverColor(theme),
                }),
              },
            }}>
            <Typography variant="body2" fontWeight="bold">
              {t(`${props.selectedColorScaleMethod}`)}
            </Typography>
          </Stack>
        </Stack>
      </ArrowPopper>
    </>
  );
};

export default ColorScaleSelector;
