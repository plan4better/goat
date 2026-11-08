"use client";

import { IconButton, ListItemIcon, ListItemText, Menu, MenuItem } from "@mui/material";
import { useState } from "react";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

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
 * button (40px below `md`) and a menu of 14px items with their icons. Nothing
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
        MenuListProps={{ disabledItemsFocusable: true, dense: true }}
        slotProps={{ paper: { sx: { minWidth: 220, maxWidth: 340 } } }}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}>
        {items.map((item) => (
          <MenuItem
            key={item.key}
            dense
            disabled={item.disabled}
            onClick={() => {
              // A focused disabled item still gets ButtonBase's Space click.
              if (item.disabled) return;
              setAnchor(null);
              item.onClick();
            }}
            sx={{
              color: item.danger ? "error.main" : "text.secondary",
              whiteSpace: "normal",
              py: "4px",
              "& .MuiListItemText-root": { my: "4px" },
              // PopperMenu's icon column: the icon and 16px to its label.
              "& .MuiListItemIcon-root": { minWidth: 0, pr: 4, color: "inherit" },
            }}>
            {item.icon && (
              <ListItemIcon>
                <Icon iconName={item.icon} style={{ fontSize: 15 }} htmlColor="inherit" />
              </ListItemIcon>
            )}
            <ListItemText
              primary={item.label}
              secondary={item.disabled ? item.reason : undefined}
              primaryTypographyProps={{ variant: "body2", color: "inherit" }}
              secondaryTypographyProps={{ variant: "caption" }}
            />
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
