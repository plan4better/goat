// A menu under its trigger that closes on a pointer-down outside it (the rest of the panel stays usable).
import {
  Box,
  ClickAwayListener,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  MenuItem,
  MenuList,
  Paper,
  Popper,
  Typography,
} from "@mui/material";
import { type ReactNode, useEffect, useState } from "react";

import MenuSearchField from "@/components/map/panels/common/MenuSearchField";
import { SEARCH_FROM } from "@/components/map/panels/styleEditor/rows/ChoiceRow";

export interface DropdownItem {
  label: string;
  sub?: string;
  icon?: ReactNode;
  /** A CSS background for a swatch before the label. */
  swatch?: string;
  selected?: boolean;
  disabled?: boolean;
  /** A heading row, not selectable. */
  heading?: boolean;
  onClick?: () => void;
}

export interface DropdownMenuProps {
  anchorEl: HTMLElement | null;
  title?: string;
  items: DropdownItem[];
  onClose: () => void;
  width?: number;
  /** A line under the items saying what the menu is for. */
  hint?: string;
}

/** The menu's title and headings: the panel's row labels (caption, the secondary text color) above the bold items. */
const HEADING = { typography: "caption", color: "text.secondary" } as const;

export function DropdownMenu({ anchorEl, title, items, onClose, width = 260, hint }: DropdownMenuProps) {
  const [search, setSearch] = useState("");
  useEffect(() => setSearch(""), [anchorEl]);
  if (!anchorEl) return null;
  const choices = items.filter((item) => !item.heading);
  const searchable = choices.length >= SEARCH_FROM;
  const needle = search.trim().toLocaleLowerCase();
  // While searching, the matching items only (headings drop out).
  const shown = needle ? choices.filter((item) => item.label.toLocaleLowerCase().includes(needle)) : items;
  // Focus goes back to the button that opened the menu, as MUI's Menu does.
  const close = () => {
    onClose();
    anchorEl.focus();
  };
  return (
    <Popper open anchorEl={anchorEl} placement="bottom-start" sx={{ zIndex: 1400 }}>
      {/* A press on the trigger is left to the trigger, which closes the menu: closing here too would reopen it. */}
      <ClickAwayListener
        mouseEvent="onPointerDown"
        touchEvent={false}
        onClickAway={(event) => {
          if (event.target instanceof Node && anchorEl.contains(event.target)) return;
          onClose();
        }}>
        {/* The look of MUI's Menu (its paper elevation), so every menu in the panel reads the same. */}
        <Paper
          elevation={8}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            // The menu closes alone: the popover it sits in stays open.
            event.stopPropagation();
            close();
          }}
          // Long lines wrap: the menu never scrolls sideways, so its start stays in view.
          sx={{ width, maxHeight: 360, overflowY: "auto", overflowX: "hidden", mt: 1 }}>
          <MenuList dense autoFocusItem={!searchable}>
            {/* Only the search box stays at the top when the list scrolls: the title and headings scroll away. */}
            {title && (
              <ListSubheader disableSticky sx={{ ...HEADING, lineHeight: "32px" }}>
                {title}
              </ListSubheader>
            )}
            {searchable && <MenuSearchField onChange={setSearch} />}
            {shown.map((item, i) =>
              item.heading ? (
                <ListSubheader key={`h-${i}`} disableSticky sx={{ ...HEADING, lineHeight: "28px" }}>
                  {item.label}
                </ListSubheader>
              ) : (
                <MenuItem
                  key={`${item.label}-${i}`}
                  selected={item.selected}
                  disabled={item.disabled}
                  // Icons at the panel's size: MenuItem's own rule would draw them at 20 px.
                  sx={{
                    "& .MuiListItemIcon-root": { minWidth: 28 },
                    "& .MuiListItemIcon-root svg": { fontSize: 14 },
                  }}
                  onClick={() => {
                    item.onClick?.();
                    close();
                  }}>
                  {(item.icon || item.swatch) && (
                    <ListItemIcon>
                      {item.icon ?? (
                        <Box
                          sx={{
                            width: 16,
                            height: 16,
                            borderRadius: 0.5,
                            border: 1,
                            borderColor: "divider",
                            background: item.swatch,
                          }}
                        />
                      )}
                    </ListItemIcon>
                  )}
                  <ListItemText
                    primary={item.label}
                    secondary={item.sub}
                    // The panel's Selector items: body2 bold.
                    primaryTypographyProps={{
                      variant: "body2",
                      fontWeight: "bold",
                      sx: { whiteSpace: "normal" },
                    }}
                    secondaryTypographyProps={{ variant: "caption", sx: { whiteSpace: "normal" } }}
                  />
                </MenuItem>
              )
            )}
          </MenuList>
          {hint && (
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", px: 4, pb: 2 }}>
              {hint}
            </Typography>
          )}
        </Paper>
      </ClickAwayListener>
    </Popper>
  );
}
