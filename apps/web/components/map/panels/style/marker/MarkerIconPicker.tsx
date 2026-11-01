import ClearIcon from "@mui/icons-material/Clear";
import { IconButton, Stack, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { useMemo, useState } from "react";

import { MAKI_ICONS_BASE_URL, MAKI_ICON_SIZE, NO_ICON_ICON } from "@/lib/constants/icons";
import { pickerBorderColor, pickerBorderHoverColor } from "@/lib/constants/ui";
import type { Marker } from "@/lib/validations/layer";

import FormLabelHelper from "@/components/common/FormLabelHelper";
import MarkerPopper from "@/components/map/panels/style/marker/MarkerPopper";
import { MaskedImageIcon } from "@/components/map/panels/style/other/MaskedImageIcon";

type MarkerIconPickerProps = {
  label?: string;
  tooltip?: string;
  selectedMarker?: Marker;
  onSelectMarker: (marker: Marker) => void;
};

const MarkerIconPicker = (props: MarkerIconPickerProps) => {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  const imgColor = useMemo(() => {
    if (open) {
      return theme.palette.primary.main;
    } else if (!!props.selectedMarker?.url) {
      return "";
    } else {
      return pickerBorderHoverColor(theme);
    }
  }, [open, props.selectedMarker?.url, theme]);

  return (
    <>
      {/* anchor element */}
      <Stack spacing={1}>
        {props.label && (
          <FormLabelHelper
            color={open ? theme.palette.primary.main : "inherit"}
            label={props.label}
            tooltip={props.tooltip}
          />
        )}
        <Stack
          onClick={(e) => {
            setAnchorEl(e.currentTarget);
            setOpen((prev) => !prev);
          }}
          direction="row"
          spacing={2}
          alignItems="center"
          justifyContent="space-between"
          sx={{
            borderRadius: theme.spacing(1.2),
            border: "1px solid",
            outline: "2px solid transparent",
            borderColor: pickerBorderColor(theme),
            ...(open && {
              outline: `2px solid ${theme.palette.primary.main}`,
            }),
            cursor: "pointer",
            p: 1.7,
            py: 0.5,
            minHeight: "40px",
            "&:hover": {
              ...(!open && {
                borderColor: pickerBorderHoverColor(theme),
              }),
            },
          }}>
          <Stack direction="row" spacing={2} sx={{ p: 0, m: 0 }} alignItems="center">
            <MaskedImageIcon
              imageUrl={props.selectedMarker?.url || `${MAKI_ICONS_BASE_URL}/${NO_ICON_ICON}.svg`}
              dimension={`${MAKI_ICON_SIZE}px`}
              applyMask={props.selectedMarker?.source === "custom" ? false : true}
              imgColor={imgColor}
            />

            <Typography variant="body2" fontWeight={props.selectedMarker?.url ? "bold" : "normal"}>
              {props.selectedMarker?.name}
            </Typography>
          </Stack>
          {props.selectedMarker?.url && (
            <IconButton
              size="small"
              sx={{ visibility: props.selectedMarker ? "visible" : "hidden" }}
              onClick={(e) => {
                e.stopPropagation();
                props.onSelectMarker({ name: "", url: "", category: "", source: "library" });
              }}>
              <ClearIcon />
            </IconButton>
          )}
        </Stack>
      </Stack>
      <MarkerPopper
        open={open}
        anchorEl={anchorEl}
        onClose={() => setOpen(false)}
        selectedMarker={props.selectedMarker}
        onSelectMarker={(marker) => {
          props.onSelectMarker(marker);
        }}
      />
    </>
  );
};

export default MarkerIconPicker;
