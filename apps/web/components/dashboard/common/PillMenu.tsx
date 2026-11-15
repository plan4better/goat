"use client";

import { Menu } from "@mui/material";
import { useRef, useState } from "react";

import type { ICON_NAME } from "@p4b/ui/components/Icon";

import { MenuRow } from "@/components/common/MenuRow";
import ToolPill from "@/components/dashboard/common/ToolPill";

export type PillMenuOption<V extends string = string> = { value: V; label: string; icon?: ICON_NAME };

interface PillMenuProps<V extends string> {
  value: V;
  options: PillMenuOption<V>[];
  onChange: (value: V) => void;
  /** The pill's glyph. When the option in force carries its own icon, that
   * one is shown instead, so a narrowed list is readable from the pill. */
  icon: ICON_NAME;
  /** Filled state while the menu is closed — the choice in force narrows
   * what is on screen (a source other than Everyone); a sort never does. */
  active?: boolean;
  /** `ToolPill`'s flat look, for a pill sitting among outlined filter chips. */
  flat?: boolean;
  /** Phone layout: the pill keeps only its glyph, dropping the current
   * option's label and the chevron. */
  compact?: boolean;
  /** The pill's accessible name — what the pill chooses ("Sort", "Source"). */
  label: string;
}

/** A tool pill naming the option in force, opening a menu with a check on
 * it — the single-choice control of a page's tool row (Sort on Content and
 * Catalog, the template source on Home). */
const PillMenu = <V extends string>({
  value,
  options,
  onChange,
  icon,
  active,
  flat,
  compact,
  label,
}: PillMenuProps<V>) => {
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const current = options.find((option) => option.value === value) ?? options[0];

  return (
    <>
      <ToolPill
        ref={anchor}
        icon={current?.icon ?? icon}
        label={compact ? label : (current?.label ?? label)}
        chevron={!compact}
        active={open || active}
        flat={flat}
        iconOnly={compact}
        onClick={() => setOpen(true)}
      />
      <Menu
        anchorEl={anchor.current}
        open={open}
        onClose={() => setOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { minWidth: 180, mt: 1.5 } } }}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <MenuRow
              key={option.value}
              icon={option.icon}
              label={option.label}
              selected={selected}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            />
          );
        })}
      </Menu>
    </>
  );
};

export default PillMenu;
