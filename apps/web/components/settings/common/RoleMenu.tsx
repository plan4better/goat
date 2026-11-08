"use client";

import { Box, ButtonBase, Menu, MenuItem, Typography, alpha, useTheme } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { focusRing } from "@/components/assistant/styles";
import { type AssignableRole, roleWords } from "@/components/settings/common/roleWords";
import type { RoleOption } from "@/components/settings/members/seats";

/** The role of a member or an invitation as a menu of the three roles, each
 * with its line; a role without a free seat is disabled with the reason in
 * place of its line. Drawn as the share dialog's role picker
 * (`components/modals/content/RolePicker.tsx`): a primary pill, since every
 * row it sits in has a role, and the same menu card. */
export default function RoleMenu({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: AssignableRole;
  options: RoleOption[];
  onChange: (role: AssignableRole) => void;
  /** "Rolle von Anna Weber" */
  label: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const words = roleWords(t);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  return (
    <>
      <ButtonBase
        disabled={disabled}
        aria-label={`${label}: ${words[value].word}`}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        onClick={(event) => setAnchor(event.currentTarget)}
        sx={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "7px",
          flexShrink: 0,
          padding: "5px 10px 5px 12px",
          borderRadius: "999px",
          border: `1px solid ${theme.palette.primary.main}`,
          backgroundColor: alpha(theme.palette.primary.main, 0.12),
          color: theme.palette.primary.main,
          // The app's font: a bare button would fall back to the browser's.
          fontFamily: "inherit",
          fontSize: 12.5,
          fontWeight: 700,
          lineHeight: 1.15,
          whiteSpace: "nowrap",
          opacity: disabled ? 0.5 : 1,
          // A bare ButtonBase draws no focus of its own: the keyboard's ring.
          ...focusRing(theme),
        }}>
        {words[value].word}
        <Icon iconName={ICON_NAME.CHEVRON_DOWN} style={{ fontSize: 11, color: theme.palette.primary.main }} />
      </ButtonBase>
      <Menu
        anchorEl={anchor}
        open={!!anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { width: 250, borderRadius: "12px", padding: "6px" } } }}
        // A disabled role stays reachable by keyboard, so its reason is read out.
        MenuListProps={{ "aria-label": label, disabledItemsFocusable: true }}>
        {options.map(({ role, disabledReason }) => {
          const current = role === value;
          return (
            <MenuItem
              key={role}
              role="menuitemradio"
              aria-checked={current}
              // `selected` is what the open menu focuses first; the current
              // role reads from its primary ink and check, not from a fill.
              selected={current}
              disabled={!!disabledReason}
              onClick={() => {
                // A focused disabled item still gets ButtonBase's Space click.
                if (disabledReason) return;
                setAnchor(null);
                if (role !== value) onChange(role);
              }}
              sx={{
                alignItems: "flex-start",
                gap: "10px",
                padding: "9px 11px",
                borderRadius: "8px",
                whiteSpace: "normal",
                "&.Mui-selected": { backgroundColor: "transparent" },
                "&.Mui-selected:hover": { backgroundColor: theme.palette.action.hover },
                "&.Mui-selected.Mui-focusVisible": { backgroundColor: theme.palette.action.focus },
              }}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography
                  component="div"
                  sx={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: current ? theme.palette.primary.main : theme.palette.text.primary,
                  }}>
                  {words[role].word}
                </Typography>
                <Typography
                  component="div"
                  sx={{
                    fontSize: 11.5,
                    color: theme.palette.text.secondary,
                    marginTop: "1px",
                    lineHeight: 1.4,
                  }}>
                  {disabledReason ?? words[role].description}
                </Typography>
              </Box>
              {current && (
                <Icon
                  iconName={ICON_NAME.CIRCLECHECK}
                  style={{ fontSize: 13, color: theme.palette.primary.main, marginTop: 2 }}
                />
              )}
            </MenuItem>
          );
        })}
      </Menu>
    </>
  );
}
