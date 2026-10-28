// Two to four choices side by side, as words or as glyphs named by their label.
import { ToggleButton, ToggleButtonGroup } from "@mui/material";
import { type ReactNode, memo } from "react";

import { Row } from "@/components/map/panels/styleEditor/rows/Row";

export interface SegmentedRowProps<T extends string = string> {
  label: ReactNode;
  value: T;
  options: { value: T; label: string; icon?: ReactNode }[];
  onChange: (value: T) => void;
}

function SegmentedRowInner<T extends string>({ label, value, options, onChange }: SegmentedRowProps<T>) {
  return (
    <Row label={label}>
      <ToggleButtonGroup
        exclusive
        size="small"
        value={value}
        onChange={(_, next: T | null) => next !== null && onChange(next)}
        sx={{
          flex: 1,
          "& .MuiToggleButton-root": { flex: 1, textTransform: "none", py: 0.5, minHeight: 32 },
        }}>
        {options.map((option) => (
          <ToggleButton
            key={option.value}
            value={option.value}
            aria-label={option.icon ? option.label : undefined}
            title={option.icon ? option.label : undefined}>
            {option.icon ?? option.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </Row>
  );
}

export const SegmentedRow = memo(SegmentedRowInner) as typeof SegmentedRowInner;
