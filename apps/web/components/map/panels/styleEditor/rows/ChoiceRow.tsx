// A choice as GOAT's Selector; each option may carry an icon and a one-line sub that says what it does. Long lists
// get the Selector's search.
import { Typography } from "@mui/material";
import { type ReactNode, memo, useMemo } from "react";

import type { SelectorItem } from "@/types/map/common";

import Selector from "@/components/map/panels/common/Selector";
import { Row } from "@/components/map/panels/styleEditor/rows/Row";
import { fieldSx } from "@/components/map/panels/styleEditor/rows/fieldBox";

/** The menu is wider than the panel's narrow fields, so options and their subs read in full. */
const MENU_WIDTH = 260;

/** From this many options on, the menu has a search box. */
export const SEARCH_FROM = 9;

export interface ChoiceOption<T = string> {
  value: T;
  label: string;
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

function ChoiceRowInner<T>({ label, value, options, onChange, fixed, mode, note }: ChoiceRowProps<T>) {
  const index = options.findIndex((option) => Object.is(option.value, value));
  // Values of any type go through the Selector as their position.
  const items = useMemo<SelectorItem[]>(
    () =>
      options.map((option, i) => ({
        value: String(i),
        label: option.label,
        iconNode: option.icon,
        sub: option.sub,
        disabled: option.disabled,
      })),
    [options]
  );
  return (
    <Row label={label} actions={mode} note={note}>
      {fixed ? (
        <Typography variant="body2" fontWeight="bold" noWrap>
          {options[index]?.label ?? ""}
        </Typography>
      ) : (
        <Selector
          items={items}
          selectedItems={index < 0 ? undefined : items[index]}
          setSelectedItems={(item) => {
            if (item && !Array.isArray(item)) onChange(options[Number(item.value)].value);
          }}
          enableSearch={options.length >= SEARCH_FROM}
          ariaLabel={typeof label === "string" ? label : undefined}
          sx={fieldSx}
          menuWidth={MENU_WIDTH}
        />
      )}
    </Row>
  );
}

export const ChoiceRow = memo(ChoiceRowInner) as typeof ChoiceRowInner;
