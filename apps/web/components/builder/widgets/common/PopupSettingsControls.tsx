import { Stack } from "@mui/material";
import { useTranslation } from "react-i18next";

import type { PopupPlacement, PopupSize, PopupType } from "@/lib/validations/widget";

import SegmentedControl from "@/components/map/panels/common/SegmentedControl";

export type PopupTypeValue = PopupType;
export type PopupPlacementValue = PopupPlacement;
export type PopupSizeValue = PopupSize;

interface PopupSettingsControlsProps {
  popupType: PopupType;
  placement: PopupPlacement;
  size: PopupSize;
  onPopupTypeChange: (value: PopupType) => void;
  onPlacementChange: (value: PopupPlacement) => void;
  onSizeChange: (value: PopupSize) => void;
}

/**
 * Shared popup-display controls (type / placement / size) used by every
 * popup editor (InfoChip, Links, Project info). Keeps the dialogs visually
 * identical and makes adding/changing options a single edit.
 */
const PopupSettingsControls = ({
  popupType,
  placement,
  size,
  onPopupTypeChange,
  onPlacementChange,
  onSizeChange,
}: PopupSettingsControlsProps) => {
  const { t } = useTranslation("common");
  const showPlacement = popupType !== "dialog";

  return (
    <Stack spacing={2}>
      <SegmentedControl
        label={t("popup_type")}
        value={popupType}
        onChange={(v) => onPopupTypeChange(v as PopupTypeValue)}
        items={[
          { value: "tooltip", label: t("tooltip") },
          { value: "popover", label: t("popup") },
          { value: "dialog", label: t("popup_dialog") },
        ]}
      />
      {showPlacement && (
        <SegmentedControl
          label={t("popup_placement")}
          value={placement}
          onChange={(v) => onPlacementChange(v as PopupPlacementValue)}
          items={[
            { value: "auto", label: t("placement_auto") },
            { value: "top", label: t("placement_top") },
            { value: "bottom", label: t("placement_bottom") },
            { value: "left", label: t("placement_left") },
            { value: "right", label: t("placement_right") },
          ]}
        />
      )}
      <SegmentedControl
        label={t("popup_size")}
        value={size}
        onChange={(v) => onSizeChange(v as PopupSizeValue)}
        items={[
          { value: "sm", label: t("size_small") },
          { value: "md", label: t("size_medium") },
          { value: "lg", label: t("size_large") },
        ]}
      />
    </Stack>
  );
};

export default PopupSettingsControls;
