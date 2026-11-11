// A choice as a field of the row list that opens the panel's menu under it; each option may carry an icon and a
// one-line sub that says what it does. Long lists get the menu's search.
import { Box, type SxProps, type Theme, Typography } from "@mui/material";
import { type ReactNode, memo, useState } from "react";

import { DropdownMenu } from "@/components/map/panels/styleEditor/popovers/DropdownMenu";
import { FieldButton, FieldTrailingIcon } from "@/components/map/panels/styleEditor/rows/FieldButton";
import { Row } from "@/components/map/panels/styleEditor/rows/Row";

export interface ChoiceOption<T = string> {
  value: T;
  label: string;
  /** What the field shows once chosen, where the menu's label is too long for it (a comparison's "<"). */
  short?: string;
  sub?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface ChoiceRowProps<T = string> {
  label: ReactNode;
  value: T;
  options: ChoiceOption<T>[];
  onChange: (value: T) => void;
  fixed?: boolean;
  mode?: ReactNode;
  note?: ReactNode;
}

export interface ChoiceFieldProps<T = string> {
  value: T;
  options: ChoiceOption<T>[];
  onChange: (value: T) => void;
  /** The field's name where no label is beside it. */
  ariaLabel?: string;
  sx?: SxProps<Theme>;
}

/** The choice's field alone, for a row of several fields (a rule's condition). */
export function ChoiceField<T>({ value, options, onChange, ariaLabel, sx }: ChoiceFieldProps<T>) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const current = options.find((option) => Object.is(option.value, value));
  return (
    <>
      <FieldButton
        popup="listbox"
        expanded={anchor !== null}
        active={anchor !== null}
        ariaLabel={ariaLabel}
        sx={sx}
        onClick={(el) => setAnchor(anchor ? null : el)}
        end={<FieldTrailingIcon kind="caret" />}>
        {current?.icon && (
          <Box component="span" sx={{ display: "flex", flex: "none" }}>
            {current.icon}
          </Box>
        )}
        <Typography
          component="span"
          variant="body2"
          fontWeight="bold"
          noWrap
          title={current?.label}
          sx={{ flex: 1, minWidth: 0 }}>
          {current?.short ?? current?.label ?? ""}
        </Typography>
      </FieldButton>
      <DropdownMenu
        anchorEl={anchor}
        role="listbox"
        items={options.map((option) => ({
          label: option.label,
          sub: option.sub,
          icon: option.icon,
          disabled: option.disabled,
          selected: option === current,
          onClick: () => onChange(option.value),
        }))}
        onClose={() => setAnchor(null)}
      />
    </>
  );
}

function ChoiceRowInner<T>({ label, value, options, onChange, fixed, mode, note }: ChoiceRowProps<T>) {
  return (
    <Row label={label} actions={mode} note={note}>
      {fixed ? (
        <Typography variant="body2" fontWeight="bold" noWrap>
          {options.find((option) => Object.is(option.value, value))?.label ?? ""}
        </Typography>
      ) : (
        <ChoiceField
          value={value}
          options={options}
          onChange={onChange}
          ariaLabel={typeof label === "string" ? label : undefined}
        />
      )}
    </Row>
  );
}

export const ChoiceRow = memo(ChoiceRowInner) as typeof ChoiceRowInner;
