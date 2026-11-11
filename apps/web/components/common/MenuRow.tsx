"use client";

import { Box, ListSubheader, MenuItem, type MenuItemProps, useTheme } from "@mui/material";
import { type ReactNode, forwardRef } from "react";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { readableText } from "@/lib/utils/credits";

import { POPOVER_ROW_ICON_SIZE, POPOVER_ROW_SX } from "@/components/common/popoverRow";

export type MenuRowProps = Omit<MenuItemProps, "children"> & {
  /** An icon name (drawn muted, at the rows' size) or your own node. */
  icon?: ICON_NAME | ReactNode;
  label: ReactNode;
  /** A muted second line under the label; it wraps. */
  secondary?: ReactNode;
  /** After the label, at the right end: a count, a shortcut. A `selected` row
   * draws its check there by itself. */
  trailing?: ReactNode;
  /** A destructive action: label and icon in the error colour. */
  danger?: boolean;
};

/**
 * The one row of the app's menus (in a MUI `Menu`): the header popovers'
 * measures, so an action reads the same wherever it is offered. `selected`
 * marks the option in force with primary ink and a check; a fill is how the
 * navigation says where you are. Options of a form's select are values in a
 * field, not actions: they stay `MenuItem`s.
 */
export const MenuRow = forwardRef<HTMLLIElement, MenuRowProps>(function MenuRow(
  { icon, label, secondary, trailing, danger = false, selected = false, sx, ...rest },
  ref
) {
  const theme = useTheme();
  const ink = readableText(theme, theme.palette.primary.main);
  const color = danger ? theme.palette.error.main : selected ? ink : theme.palette.text.primary;
  return (
    <MenuItem
      ref={ref}
      selected={selected}
      {...rest}
      sx={[
        {
          ...POPOVER_ROW_SX,
          alignItems: secondary ? "flex-start" : "center",
          color,
          "&.Mui-selected": { backgroundColor: "transparent" },
          "&.Mui-selected:hover": { backgroundColor: theme.palette.action.hover },
          "&.Mui-selected.Mui-focusVisible": { backgroundColor: theme.palette.action.focus },
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}>
      {typeof icon === "string" ? (
        <Icon
          iconName={icon as ICON_NAME}
          style={{
            fontSize: POPOVER_ROW_ICON_SIZE,
            flexShrink: 0,
            // Beside the first line when there are two.
            ...(secondary ? { marginTop: 3 } : {}),
            color: danger || selected ? color : theme.palette.text.secondary,
          }}
        />
      ) : (
        icon
      )}
      <Box component="span" sx={{ flex: 1, minWidth: 0 }}>
        <Box component="span" sx={{ display: "block", overflow: "hidden", textOverflow: "ellipsis" }}>
          {label}
        </Box>
        {secondary && (
          <Box
            component="span"
            sx={{
              display: "block",
              mt: "1px",
              fontSize: 11.5,
              fontWeight: 400,
              color: theme.palette.text.secondary,
              whiteSpace: "normal",
            }}>
            {secondary}
          </Box>
        )}
      </Box>
      {trailing}
      {selected && (
        <Icon
          iconName={ICON_NAME.CHECK}
          style={{ fontSize: 12, flexShrink: 0, color: ink, ...(secondary ? { marginTop: 4 } : {}) }}
        />
      )}
    </MenuItem>
  );
});

/** The heading of a group of rows: small, bold and muted, never a row itself. */
export const MenuHeading = forwardRef<HTMLLIElement, { children: ReactNode }>(function MenuHeading(
  { children },
  ref
) {
  const theme = useTheme();
  return (
    <ListSubheader
      ref={ref}
      disableSticky
      sx={{
        p: "8px 10px 4px",
        lineHeight: 1.5,
        fontSize: 11.5,
        fontWeight: 700,
        color: theme.palette.text.secondary,
        backgroundColor: "transparent",
      }}>
      {children}
    </ListSubheader>
  );
});
