"use client";

import { IconButton, Menu } from "@mui/material";
import { useState } from "react";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { MenuRow } from "@/components/common/MenuRow";

export interface RowMenuItem {
  key: string;
  label: string;
  /** Before the label, as in Content's row menus. */
  icon?: ICON_NAME;
  onClick: () => void;
  /** In error ink: removing, withdrawing, deleting. */
  danger?: boolean;
  disabled?: boolean;
  /** Why a disabled item is, shown below its label. */
  reason?: string;
}

/** A row's ⋮ menu, drawn as Content's (`ContentKebab`, `PopperMenu`): a 28px
 * button (40px below `md`) and a menu of the shared popover rows. Nothing
 * when there is nothing to offer. */
export default function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (items.length === 0) return null;
  return (
    <>
      <IconButton
        size="small"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        onClick={(event) => setAnchor(event.currentTarget)}
        // ContentKebab's sizes: a 40px tap target below `md`, 28px from it.
        sx={{ width: { xs: 40, md: 28 }, height: { xs: 40, md: 28 }, borderRadius: "6px", flexShrink: 0 }}>
        <Icon iconName={ICON_NAME.MORE_VERT} sx={{ fontSize: { xs: 20, md: 18 } }} />
      </IconButton>
      <Menu
        anchorEl={anchor}
        open={!!anchor}
        onClose={() => setAnchor(null)}
        // A disabled item stays reachable by keyboard, so its reason is read out.
        MenuListProps={{ disabledItemsFocusable: true }}
        slotProps={{ paper: { sx: { minWidth: 220, maxWidth: 340, mt: 1.5 } } }}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}>
        {items.map((item) => (
          <MenuRow
            key={item.key}
            icon={item.icon}
            label={item.label}
            secondary={item.disabled ? item.reason : undefined}
            danger={item.danger}
            disabled={item.disabled}
            onClick={() => {
              // A focused disabled item still gets ButtonBase's Space click.
              if (item.disabled) return;
              setAnchor(null);
              item.onClick();
            }}
          />
        ))}
      </Menu>
    </>
  );
}
