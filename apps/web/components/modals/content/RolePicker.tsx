"use client";

import { ButtonBase, Menu, alpha, useTheme } from "@mui/material";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { focusRing } from "@/components/assistant/styles";
import { MenuRow } from "@/components/common/MenuRow";

export type RolePrefix = "layer" | "project" | "folder" | "bundle" | "template";

interface RolePickerProps {
  /** "" (no access), "<prefix>-viewer", or "<prefix>-editor". */
  value: string;
  prefix: RolePrefix;
  onChange: (role: string) => void;
  disabled?: boolean;
}

/**
 * The role dropdown every share row uses: no access / viewer / editor,
 * each menu option carrying a one-line hint underneath its label and a
 * check on the current one. Maps the abstract viewer/editor choice to and
 * from the typed role string (`${prefix}-viewer` / `${prefix}-editor`) for
 * whichever content type owns this row. Renders as a pill button that takes
 * the primary accent once a role is actually granted, so a row with access
 * reads differently from one without at a glance.
 */
const RolePicker = ({ value, prefix, onChange, disabled }: RolePickerProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  const viewerRole = `${prefix}-viewer`;
  const editorRole = `${prefix}-editor`;

  const options: { role: string; label: string; hint?: string }[] = [
    { role: "", label: t("no_access") },
    { role: viewerRole, label: t("viewer"), hint: t("viewer_hint") },
    { role: editorRole, label: t("editor"), hint: t("editor_hint") },
  ];

  const current = options.find((option) => option.role === value) ?? options[0];
  const accent = value !== "";

  return (
    <>
      <ButtonBase
        ref={anchorRef}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        sx={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "7px",
          flexShrink: 0,
          padding: "5px 10px 5px 12px",
          borderRadius: "999px",
          border: `1px solid ${accent || open ? theme.palette.primary.main : alpha(theme.palette.text.primary, 0.24)}`,
          backgroundColor: accent ? alpha(theme.palette.primary.main, 0.12) : "transparent",
          color: accent ? theme.palette.primary.main : theme.palette.text.primary,
          // The app's font: a bare button would fall back to the browser's.
          fontFamily: "inherit",
          fontSize: 12.5,
          fontWeight: 700,
          opacity: disabled ? 0.5 : 1,
          // A bare ButtonBase draws no focus of its own: the keyboard's ring.
          ...focusRing(theme),
        }}>
        {current.label}
        <Icon
          iconName={ICON_NAME.CHEVRON_DOWN}
          style={{ fontSize: 11, color: accent ? theme.palette.primary.main : theme.palette.text.secondary }}
        />
      </ButtonBase>
      <Menu
        anchorEl={anchorRef.current}
        open={open}
        onClose={() => setOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { width: 250, mt: 1.5 } } }}>
        {options.map((option) => (
          <MenuRow
            key={option.role || "none"}
            label={option.label}
            secondary={option.hint}
            selected={option.role === value}
            onClick={() => {
              onChange(option.role);
              setOpen(false);
            }}
          />
        ))}
      </Menu>
    </>
  );
};

export default RolePicker;
