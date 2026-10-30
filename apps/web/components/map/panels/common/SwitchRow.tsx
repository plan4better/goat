import { FormControlLabel, Switch, Typography } from "@mui/material";

type SwitchRowProps = {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  name?: string;
  disabled?: boolean;
};

/**
 * An on/off setting: switch first, label after, the same layout as the
 * checkbox options next to it. One component so every panel lines them up alike.
 */
const SwitchRow = ({ label, checked, onChange, name, disabled }: SwitchRowProps) => (
  <FormControlLabel
    control={
      <Switch size="small" name={name} checked={checked} onChange={(e) => onChange(e.target.checked)} />
    }
    label={<Typography variant="body2">{label}</Typography>}
    disabled={disabled}
    sx={{ ml: 0, mr: 0, gap: 1 }}
  />
);

export default SwitchRow;
