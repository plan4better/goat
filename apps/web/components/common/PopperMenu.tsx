import {
  Chip,
  Divider,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Paper,
  Tooltip,
  useTheme,
} from "@mui/material";
import { useState } from "react";

import type { ICON_NAME } from "@p4b/ui/components/Icon";
import { Icon } from "@p4b/ui/components/Icon";

import { ArrowPopper } from "@/components/ArrowPoper";

export interface PopperMenuItem {
  id: string;
  label: string;
  icon?: ICON_NAME;
  color?: string;
  disabled?: boolean;
  /** Shown on hover; for a disabled item, why it is. */
  tooltip?: string;
  group?: string;
  tag?: string;
  tagTooltip?: string;
  onClick?: () => void;
}

export interface PopperMenuProps {
  menuItems: PopperMenuItem[];
  selectedItem?: PopperMenuItem;
  menuButton: React.ReactNode;
  onSelect?: (item: PopperMenuItem) => void;
  disablePortal?: boolean;
  placement?: "bottom" | "right" | "left" | "top";
  enableFlip?: boolean;
}

export default function PopperMenu(props: PopperMenuProps) {
  const {
    menuItems,
    menuButton,
    selectedItem,
    disablePortal = true,
    placement = "bottom",
    enableFlip = false,
  } = props;
  const theme = useTheme();
  const [popperMenuOpen, setPopperMenuOpen] = useState<boolean>(false);

  // Group menu items by their group property
  const groupedMenuItems = menuItems.reduce(
    (acc, item) => {
      const group = item.group || "default";
      if (!acc[group]) {
        acc[group] = [];
      }
      acc[group].push(item);
      return acc;
    },
    {} as Record<string, PopperMenuItem[]>
  );

  return (
    <ArrowPopper
      open={popperMenuOpen}
      placement={placement}
      onClose={() => setPopperMenuOpen(false)}
      disablePortal={disablePortal}
      enableFlip={enableFlip}
      arrow={false}
      popperStyle={{ zIndex: 10000, pointerEvents: "all" }} // Ensure the popper menu is above any other element and clickable
      content={
        <Paper
          elevation={8}
          sx={{
            minWidth: 220,
            maxWidth: 340,
            overflow: "auto",
            py: theme.spacing(2),
            pointerEvents: "all",
          }}>
          <List dense={true} disablePadding>
            {Object.keys(groupedMenuItems).map((group, groupIndex) => (
              <div key={groupIndex}>
                {groupedMenuItems[group].map((item) => {
                  const button = (
                    <ListItemButton
                      disabled={item.disabled}
                      selected={selectedItem?.label === item.label}
                      key={item.id}
                      onClick={(event) => {
                        if (item.disabled) return;
                        props?.onSelect?.(item);
                        item.onClick?.();
                        setPopperMenuOpen(false);
                        event.stopPropagation();
                      }}
                      sx={{
                        ...(item.color && {
                          color: item.color,
                        }),
                      }}>
                      {item.icon && (
                        <ListItemIcon
                          sx={{
                            color: item.color || "inherit",
                            pr: 4,
                            minWidth: 0,
                          }}>
                          <Icon
                            style={{ fontSize: 15 }}
                            iconName={item.icon}
                            htmlColor={item.color || "inherit"}
                          />
                        </ListItemIcon>
                      )}
                      <ListItemText
                        primary={item.label}
                        sx={{
                          "& .MuiTypography-root": {
                            ...(item.color && {
                              color: item.color,
                            }),
                          },
                        }}
                      />
                      {item.tag && (
                        <Tooltip title={item.tagTooltip || ""} placement="right" arrow>
                          <Chip
                            label={item.tag}
                            size="small"
                            sx={{
                              ml: 1,
                              height: 18,
                              fontSize: "0.65rem",
                              fontWeight: 600,
                            }}
                          />
                        </Tooltip>
                      )}
                    </ListItemButton>
                  );
                  // A disabled button takes no pointer events: the tooltip listens on a wrapper.
                  return item.tooltip ? (
                    <Tooltip key={item.id} title={item.tooltip} placement="right" arrow>
                      <span style={{ display: "block" }}>{button}</span>
                    </Tooltip>
                  ) : (
                    button
                  );
                })}
                {groupIndex < Object.keys(groupedMenuItems).length - 1 && <Divider sx={{ mx: 2 }} />}
              </div>
            ))}
          </List>
        </Paper>
      }>
      <div
        style={{ pointerEvents: "all" }}
        onClick={(event) => {
          event.stopPropagation();
          setPopperMenuOpen(!popperMenuOpen);
        }}>
        {menuButton}
      </div>
    </ArrowPopper>
  );
}
