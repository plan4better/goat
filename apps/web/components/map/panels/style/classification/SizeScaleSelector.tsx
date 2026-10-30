import { Paper, Stack, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { pickerBorderColor, pickerBorderHoverColor } from "@/lib/constants/ui";
import type { ClassBreaks, FeatureLayerProperties, LayerClassBreaks, SizeOrdinalMap } from "@/lib/validations/layer";

import { ArrowPopper } from "@/components/ArrowPoper";
import FormLabelHelper from "@/components/common/FormLabelHelper";
import NumericSizeScale from "@/components/map/panels/style/classification/NumericSizeScale";

type Props = {
  type: "stroke_width" | "radius" | "marker_size";
  layerStyle: FeatureLayerProperties;
  classBreaksValues: LayerClassBreaks | undefined;
  label?: string;
  onStyleChange: (newStyle: FeatureLayerProperties) => void;
};

const SizeScaleSelector = ({ type, layerStyle, classBreaksValues, label, onStyleChange }: Props) => {
  const theme = useTheme();
  const { t } = useTranslation("common");
  const [open, setOpen] = useState(false);
  const [isClickAwayEnabled, setIsClickAwayEnabled] = useState(true);

  const selectedMethod = (layerStyle[`${type}_scale`] as ClassBreaks) ?? "quantile";
  const numSteps = (layerStyle[`${type}_num_steps`] as number) ?? 5;
  const sizeRange = (layerStyle[`${type}_range`] as [number, number]) ?? [0, 10];
  const ordinalMap = layerStyle[`${type}_ordinal_map`] as SizeOrdinalMap | undefined;

  return (
    <ArrowPopper
      open={open}
      placement="bottom"
      arrow={false}
      disablePortal={false}
      isClickAwayEnabled={isClickAwayEnabled}
      onClose={() => setOpen(false)}
      content={
        <Paper
          sx={{
            boxShadow: "rgba(0, 0, 0, 0.16) 0px 6px 12px 0px",
            width: "265px",
            maxHeight: "500px",
            display: "flex",
            flexDirection: "column",
            overflow: "auto",
          }}>
          <NumericSizeScale
            type={type}
            selectedScaleMethod={selectedMethod}
            classBreaksValues={classBreaksValues}
            numSteps={numSteps}
            sizeRange={sizeRange}
            ordinalMap={ordinalMap}
            setIsClickAwayEnabled={setIsClickAwayEnabled}
            onScaleMethodChange={(method) => {
              const newStyle = JSON.parse(JSON.stringify(layerStyle));
              newStyle[`${type}_scale`] = method;
              onStyleChange(newStyle);
            }}
            onNumStepsChange={(steps) => {
              const newStyle = JSON.parse(JSON.stringify(layerStyle));
              newStyle[`${type}_num_steps`] = steps;
              onStyleChange(newStyle);
            }}
            onBreaksChange={(breaks) => {
              const newStyle = JSON.parse(JSON.stringify(layerStyle));
              const existing = newStyle[`${type}_scale_breaks`];
              newStyle[`${type}_scale_breaks`] = existing
                ? { ...existing, breaks }
                : { min: 0, max: 0, mean: 0, breaks };
              onStyleChange(newStyle);
            }}
            onOrdinalMapChange={(map) => {
              const newStyle = JSON.parse(JSON.stringify(layerStyle));
              newStyle[`${type}_ordinal_map`] = map;
              onStyleChange(newStyle);
            }}
          />
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
            ...(open && { outline: `2px solid ${theme.palette.primary.main}` }),
            cursor: "pointer",
            p: 1.7,
            "&:hover": {
              ...(!open && {
                borderColor: pickerBorderHoverColor(theme),
              }),
            },
          }}>
          <Typography variant="body2" fontWeight="bold">
            {t(selectedMethod)}
          </Typography>
        </Stack>
      </Stack>
    </ArrowPopper>
  );
};

export default SizeScaleSelector;
