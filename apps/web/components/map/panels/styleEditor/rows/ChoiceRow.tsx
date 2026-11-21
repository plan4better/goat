// A choice as a field of the row list that opens the panel's menu under it; each option may carry an icon and a
// one-line sub that says what it does. Long lists get the menu's search.
import { Box, type SxProps, type Theme, Typography } from "@mui/material";
import { type ReactNode, memo, useState } from "react";

import { type ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { POPOVER_ROW_ICON_SIZE } from "@/components/common/popoverRow";
import { DropdownMenu } from "@/components/map/panels/styleEditor/popovers/DropdownMenu";
import { FieldButton, FieldTrailingIcon } from "@/components/map/panels/styleEditor/rows/FieldButton";
import { Row } from "@/components/map/panels/styleEditor/rows/Row";

export interface ChoiceOption<T = string> {
  value: T;
  label: string;
  /** What the field shows once chosen, where the menu's label is too long for it (a comparison's "<"). */
  short?: string;
  sub?: string;
  /** An icon name, drawn at the menu rows' icon size in the field and in the menu (the selected one in its ink), or a
   * glyph of its own. */
  icon?: ICON_NAME | ReactNode;
  disabled?: boolean;
  /** The heading of the menu's group the option is in (a font's "Italic"): the menu heads each run of options of one
   * group with it. The option's full name is then its `short`, which the field shows and which names the option. */
  group?: string;
  /** The option's name for assistive tech where its full name lacks the text it shows in the menu (default: the full
   * name, in a group). */
  ariaLabel?: string;
}

export interface ChoiceRowProps<T = string> {
  label: ReactNode;
  value: T;
  options: ChoiceOption<T>[];
  onChange: (value: T) => void;
  fixed?: boolean;
  mode?: ReactNode;
  note?: ReactNode;
  /** The choice waits for something (a file's info): shown, but its menu does not open. */
  disabled?: boolean;
}

export interface ChoiceFieldProps<T = string> {
  value: T;
  options: ChoiceOption<T>[];
  onChange: (value: T) => void;
  /** The field's name where no label is beside it. */
  ariaLabel?: string;
  disabled?: boolean;
  sx?: SxProps<Theme>;
}

/** An option's whole name: its label, or in a group its `short`. */
const fullName = <T,>(option: ChoiceOption<T> | undefined): string =>
  (option?.group ? option.short : undefined) ?? option?.label ?? "";

/** The choice's field alone, for a row of several fields (a rule's condition). */
export function ChoiceField<T>({ value, options, onChange, ariaLabel, disabled, sx }: ChoiceFieldProps<T>) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const current = options.find((option) => Object.is(option.value, value));
  const items = options.flatMap((option, i) => [
    ...(option.group && option.group !== options[i - 1]?.group
      ? [{ label: option.group, heading: true }]
      : []),
    {
      label: option.label,
      ariaLabel: option.ariaLabel ?? (option.group ? fullName(option) : undefined),
      sub: option.sub,
      icon: option.icon,
      disabled: option.disabled,
      selected: option === current,
      onClick: () => onChange(option.value),
    },
  ]);
  return (
    <>
      <FieldButton
        popup="listbox"
        expanded={anchor !== null}
        active={anchor !== null}
        ariaLabel={ariaLabel}
        disabled={disabled}
        sx={sx}
        onClick={(el) => setAnchor(anchor ? null : el)}
        end={<FieldTrailingIcon kind="caret" />}>
        {current?.icon && (
          <Box component="span" sx={{ display: "flex", flex: "none" }}>
            {typeof current.icon === "string" ? (
              <Icon iconName={current.icon as ICON_NAME} sx={{ fontSize: POPOVER_ROW_ICON_SIZE }} />
            ) : (
              current.icon
            )}
          </Box>
        )}
        <Typography
          component="span"
          variant="body2"
          fontWeight="bold"
          noWrap
          title={fullName(current)}
          sx={{ flex: 1, minWidth: 0 }}>
          {current?.short ?? current?.label ?? ""}
        </Typography>
      </FieldButton>
      <DropdownMenu anchorEl={anchor} role="listbox" items={items} onClose={() => setAnchor(null)} />
    </>
  );
}

function ChoiceRowInner<T>({
  label,
  value,
  options,
  onChange,
  fixed,
  mode,
  note,
  disabled,
}: ChoiceRowProps<T>) {
  return (
    <Row label={label} actions={mode} note={note}>
      {fixed ? (
        <Typography variant="body2" fontWeight="bold" noWrap>
          {fullName(options.find((option) => Object.is(option.value, value)))}
        </Typography>
      ) : (
        <ChoiceField
          value={value}
          options={options}
          onChange={onChange}
          ariaLabel={typeof label === "string" ? label : undefined}
          disabled={disabled}
        />
      )}
    </Row>
  );
}

export const ChoiceRow = memo(ChoiceRowInner) as typeof ChoiceRowInner;
