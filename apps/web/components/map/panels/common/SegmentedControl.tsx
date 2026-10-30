import { FormControl, ToggleButton, ToggleButtonGroup, useTheme } from "@mui/material";

import { Icon } from "@p4b/ui/components/Icon";

import type { SelectorItem } from "@/types/map/common";

import FormLabelHelper from "@/components/common/FormLabelHelper";

type SegmentedControlProps = {
  value: SelectorItem["value"] | undefined;
  onChange: (value: SelectorItem["value"]) => void;
  items: SelectorItem[];
  label?: string;
  tooltip?: string;
  disabled?: boolean;
};

/**
 * One choice out of a few (two to five) short options, all visible at once.
 *
 * Takes the same items and label as `Selector`, so a settings panel can swap a
 * dropdown for this wherever the options fit on one row. Longer or open-ended
 * lists stay a `Selector`.
 */
const SegmentedControl = ({ value, onChange, items, label, tooltip, disabled }: SegmentedControlProps) => {
  const theme = useTheme();

  return (
    <FormControl size="small" fullWidth disabled={disabled}>
      {label && (
        <FormLabelHelper
          label={label}
          color={disabled ? theme.palette.secondary.main : theme.palette.text.secondary}
          tooltip={tooltip}
        />
      )}
      <ToggleButtonGroup
        exclusive
        size="small"
        color="primary"
        fullWidth
        disabled={disabled}
        value={value ?? null}
        aria-label={label}
        // A click on the selected option deselects it in MUI; a setting always keeps one value
        onChange={(_, next) => next !== null && onChange(next)}>
        {items.map((item) => (
          <ToggleButton
            key={item.value}
            value={item.value}
            disabled={item.disabled}
            title={item.label}
            sx={{ fontSize: 12, py: 0.5, gap: 0.75, textTransform: "none", minWidth: 0 }}>
            {item.icon && <Icon iconName={item.icon} style={{ fontSize: 13 }} htmlColor="inherit" />}
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {item.label}
            </span>
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </FormControl>
  );
};

export default SegmentedControl;
