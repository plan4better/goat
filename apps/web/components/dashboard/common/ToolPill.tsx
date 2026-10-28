"use client";

import { ButtonBase, alpha, useTheme } from "@mui/material";
import { type ReactNode, forwardRef } from "react";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import CountPill from "@/components/dashboard/common/CountPill";

interface ToolPillProps {
  icon?: ICON_NAME;
  label: string;
  /** In front of the label instead of the icon (a class's swatch). */
  start?: ReactNode;
  /** A pill of the style panel (the named style, a section's scope): 28px, its text and icons those of the panel's
   * field values (body2 bold, the secondary text color, 14px icons). */
  small?: boolean;
  /** What the pill does, when its label shows the choice in force instead. */
  ariaLabel?: string;
  /** What the pill opens, for assistive tech, and whether it is open. */
  popup?: { kind: "menu" | "dialog"; open: boolean };
  /** Rendered next to the label; hidden when the label is. Only for a pill
   * that opens something (a popover, a menu) — a pill that just toggles says
   * so through `active` instead. */
  chevron?: boolean;
  /** Filled state (primary soft) — the pill's popover/menu is open, its
   * filter narrows what is on screen, or what it toggles is on. */
  active?: boolean;
  /** A count shown after the label (active filter types, a menu's selection). */
  badge?: number;
  /** Destructive action — label and icon take the error palette. */
  danger?: boolean;
  disabled?: boolean;
  /** Drops the visible label, leaving an icon-only pill; the `label` still
   * reaches assistive tech through `aria-label`. */
  iconOnly?: boolean;
  /** Sits in a row of outlined filter chips rather than a toolbar: no paper
   * fill, chip height and weight, so it does not read as a raised panel. */
  flat?: boolean;
  onClick?: () => void;
}

/** One 38px pill of a page's tool row — Filter, Sort, Details, and every
 * button of the Content selection action bar — so both pages' rows read as one
 * set. Ref-forwarding, so a popover or a menu can anchor to it. */
const ToolPill = forwardRef<HTMLButtonElement, ToolPillProps>(function ToolPill(
  {
    icon,
    label,
    start,
    small,
    ariaLabel,
    popup,
    chevron,
    active,
    badge,
    danger,
    disabled,
    iconOnly,
    flat,
    onClick,
  },
  ref
) {
  const theme = useTheme();
  const accent = danger
    ? theme.palette.error.main
    : active
      ? theme.palette.primary.main
      : small
        ? theme.palette.text.secondary
        : theme.palette.text.primary;
  const iconColor = danger
    ? theme.palette.error.main
    : active
      ? theme.palette.primary.main
      : theme.palette.text.secondary;

  return (
    <ButtonBase
      ref={ref}
      disabled={disabled}
      onClick={onClick}
      aria-label={ariaLabel ?? label}
      aria-haspopup={popup?.kind}
      aria-expanded={popup ? popup.open : undefined}
      sx={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        height: small ? 28 : flat ? 34 : 38,
        px: iconOnly ? 0 : small ? "10px" : "14px",
        width: iconOnly ? (flat ? 34 : 38) : "auto",
        maxWidth: "100%",
        minWidth: 0,
        gap: small ? "6px" : "7px",
        borderRadius: "999px",
        whiteSpace: "nowrap",
        border: `1px solid ${active ? theme.palette.primary.main : theme.palette.divider}`,
        backgroundColor: active
          ? alpha(theme.palette.primary.main, 0.12)
          : flat
            ? "transparent"
            : theme.palette.background.paper,
        // In the style panel the text of its field values (body2: the page's font, size and spacing).
        ...(small ? theme.typography.body2 : { fontSize: 13 }),
        // A button does not take the page's font by itself.
        fontFamily: "inherit",
        color: accent,
        fontWeight: flat && !small ? 600 : 700,
        flexShrink: 0,
        opacity: disabled ? 0.45 : 1,
        transition: theme.transitions.create(["background-color", "border-color"], {
          duration: 120,
        }),
        "&:hover": {
          backgroundColor: active
            ? alpha(theme.palette.primary.main, 0.16)
            : theme.palette.action.hover,
        },
      }}>
      {start}
      {icon && !start && <Icon iconName={icon} style={{ fontSize: 14, color: iconColor }} />}
      {!iconOnly && (
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
      )}
      {!iconOnly && badge !== undefined && <CountPill active>{badge}</CountPill>}
      {!iconOnly && chevron && (
        <Icon iconName={ICON_NAME.CHEVRON_DOWN} style={{ fontSize: small ? 10 : 12, color: iconColor }} />
      )}
    </ButtonBase>
  );
});

export default ToolPill;
