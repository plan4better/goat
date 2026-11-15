"use client";

import { Button, CircularProgress, Menu } from "@mui/material";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { MenuRow } from "@/components/common/MenuRow";
import { DASHBOARD_MENU_SLOT_PROPS } from "@/components/dashboard/common/NewProjectMenu";

export interface NewMenuItem {
  key: string;
  label: string;
  icon: ICON_NAME;
  onSelect: () => void;
}

interface NewMenuButtonProps {
  items: NewMenuItem[];
  /** Nothing can be created yet (no project loaded, say). */
  disabled?: boolean;
  /** A create is in flight: the button shows a spinner and refuses clicks. */
  loading?: boolean;
  /** The button's label; "New" by default. */
  label?: string;
}

/**
 * A compact "New ▾" button opening a menu of the ways to create something —
 * the pattern Home's "New Project" uses, for panel headers where a full label
 * per way would not fit.
 */
const NewMenuButton = ({ items, disabled, loading, label }: NewMenuButtonProps) => {
  const { t } = useTranslation("common");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        ref={buttonRef}
        variant="contained"
        size="small"
        disabled={disabled || loading}
        startIcon={
          loading ? (
            <CircularProgress size={14} color="inherit" />
          ) : (
            <Icon iconName={ICON_NAME.PLUS} style={{ fontSize: 12 }} />
          )
        }
        endIcon={<Icon iconName={ICON_NAME.CHEVRON_DOWN} style={{ fontSize: 11 }} />}
        onClick={() => setOpen(true)}
        sx={{ textTransform: "none", whiteSpace: "nowrap" }}>
        {label ?? t("new")}
      </Button>
      <Menu
        anchorEl={buttonRef.current}
        open={open}
        onClose={() => setOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={DASHBOARD_MENU_SLOT_PROPS}>
        {items.map((item) => (
          <MenuRow
            key={item.key}
            icon={item.icon}
            label={item.label}
            onClick={() => {
              setOpen(false);
              item.onSelect();
            }}
          />
        ))}
      </Menu>
    </>
  );
};

export default NewMenuButton;
