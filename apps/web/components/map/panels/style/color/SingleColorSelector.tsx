import { Box, ToggleButton, ToggleButtonGroup } from "@mui/material";
import { styled } from "@mui/material/styles";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { SingleColorSelectorProps } from "@/types/map/color";

import CustomColorPicker from "@/components/map/panels/style/color/CustomColorPicker";
import PresetColorPicker from "@/components/map/panels/style/color/PresetColorPicker";

enum SingleColorType {
  Picker = "picker",
  Preset = "preset",
}

const CustomStyledSingleColorSelector = styled("div")(({ theme }) => ({
  paddingLeft: `${theme.spacing(3)}`,
  paddingRight: `${theme.spacing(3)}`,
  ".side-panel-section-group": {
    marginBottom: `${theme.spacing(3)}`,
  },
  ".color-box": {
    position: "relative",
    borderRadius: "4px",
  },
}));

const SingleColorSelector = (props: SingleColorSelectorProps) => {
  const { t } = useTranslation("common");
  const containerRef = useRef(null);
  const [colorSelectionType, setColorSelectionType] = useState(SingleColorType.Picker);
  const isPickerSelected = colorSelectionType === SingleColorType.Picker;

  const handleSelectionTypeChange = () => {
    setColorSelectionType(
      colorSelectionType === SingleColorType.Picker ? SingleColorType.Preset : SingleColorType.Picker
    );
  };

  useEffect(() => {
    if (containerRef?.current) {
      const el: Element = containerRef.current;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [containerRef]);

  return (
    <CustomStyledSingleColorSelector ref={containerRef}>
      <ToggleButtonGroup
        fullWidth
        size="small"
        exclusive
        value={colorSelectionType}
        onChange={handleSelectionTypeChange}>
        <ToggleButton value={SingleColorType.Picker} sx={{ overflow: "hidden" }}>
          {t("color_picker")}
        </ToggleButton>
        <ToggleButton value={SingleColorType.Preset} sx={{ overflow: "hidden" }}>
          {t("preset_colors")}
        </ToggleButton>
      </ToggleButtonGroup>

      <Box className="color-box" style={{ backgroundColor: "transparent" }}>
        {isPickerSelected ? (
          <CustomColorPicker {...props} />
        ) : (
          <Box mt={1}>
            <PresetColorPicker {...props} />
          </Box>
        )}
      </Box>
    </CustomStyledSingleColorSelector>
  );
};

export default SingleColorSelector;
