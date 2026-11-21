// A switch with an optional value text.
import { Switch, Typography } from "@mui/material";
import { type ReactNode, memo } from "react";

import { Row } from "@/components/map/panels/styleEditor/rows/Row";

export interface SwitchRowProps {
  label: ReactNode;
  on: boolean;
  onToggle: () => void;
  valueText?: string;
  note?: ReactNode;
}

export const SwitchRow = memo(function SwitchRow({ label, on, onToggle, valueText, note }: SwitchRowProps) {
  return (
    <Row label={label} note={note}>
      <Switch
        size="small"
        checked={on}
        onChange={onToggle}
        inputProps={{ "aria-label": typeof label === "string" ? label : undefined }}
      />
      {valueText && (
        <Typography variant="caption" color="text.secondary" noWrap>
          {valueText}
        </Typography>
      )}
    </Row>
  );
});
