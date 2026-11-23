"use client";

// One row of the filter panel (a condition, a custom filter, the area): what it says (a kind and a sentence) on a flat
// line that opens its editor, a remove button over the line's end that shows with the pointer or the focus on the row,
// and a switch at the edge. For a viewer the line alone.
import { Box, ButtonBase, IconButton, Switch, Typography, alpha } from "@mui/material";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useIsOpen } from "@/components/map/panels/styleEditor/popovers/usePopover";

/** The room the remove button takes at the line's end while it shows. */
const REMOVE_ROOM = 28;

/** The key of a row's editor among the panel's popovers. */
export const editorKey = (id: string) => `filter-row:${id}`;

export interface RowShellProps {
  id: string;
  /** The row's kind, before what it says. */
  glyph?: ReactNode;
  /** What the row says. */
  children: ReactNode;
  /** Under what it says: why the row saves nothing, or what is wrong with it. */
  note?: ReactNode;
  /** The row said in full, shown on hover when it does not fit. */
  title?: string;
  /** Switched off. */
  off?: boolean;
  /** Saves nothing yet. */
  draft?: boolean;
  canEdit: boolean;
  /** Opens the row's editor; a row without it has none. */
  onOpen?: (anchor: HTMLElement) => void;
  /** Switches the row on or off; no switch without it. */
  onToggle?: () => void;
  /** The switch shows but cannot be used: a switched-off row the filter has no room for. */
  switchDisabled?: boolean;
  /** Removes the row; no remove button without it. */
  onRemove?: () => void;
  /** The names of the remove button and the switch; a condition's without them. */
  removeLabel?: string;
  switchLabel?: string;
  /** A button of the row's own between the line and the switch (the area's "use the current view"). */
  action?: ReactNode;
}

export function RowShell({
  id,
  glyph,
  children,
  note,
  title,
  off,
  draft,
  canEdit,
  onOpen,
  onToggle,
  switchDisabled,
  onRemove,
  removeLabel,
  switchLabel,
  action,
}: RowShellProps) {
  const { t } = useTranslation("common");
  const open = useIsOpen(editorKey(id));
  const said = (
    <>
      {glyph}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        {children}
        {note && (
          <Typography component="p" variant="caption" color="text.secondary" noWrap>
            {note}
          </Typography>
        )}
      </Box>
    </>
  );
  const line = {
    display: "flex",
    alignItems: "center",
    gap: 2,
    flex: 1,
    minWidth: 0,
    minHeight: 40,
    py: 1,
    opacity: off ? 0.55 : 1,
  };
  return (
    <Box
      data-filter-row={id}
      data-removable={canEdit && onRemove ? "" : undefined}
      sx={(theme) => ({
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 1,
        px: 3,
        bgcolor: open ? alpha(theme.palette.primary.main, 0.08) : undefined,
        ...(canEdit && { "&:hover": { bgcolor: open ? undefined : "action.hover" } }),
        // A row that saves nothing yet is outlined, not filled.
        ...(draft && {
          "&::before": {
            content: '""',
            position: "absolute",
            inset: "2px 6px",
            border: `1px dashed ${theme.palette.divider}`,
            borderRadius: "8px",
            pointerEvents: "none",
          },
        }),
        // The remove button lies over the line's end, so what the row says has the whole width until the button
        // shows; the line then makes room for it. A row without one keeps its width: nothing at its end moves.
        "& [data-row-remove]": { opacity: 0, transition: theme.transitions.create("opacity") },
        "&:hover [data-row-remove], &:focus-within [data-row-remove]": { opacity: 1 },
        "&[data-removable]:hover [data-row-line], &[data-removable]:focus-within [data-row-line]": {
          pr: `${REMOVE_ROOM}px`,
        },
        // No pointer to hover with: the button always shows.
        "@media (hover: none)": {
          "& [data-row-remove]": { opacity: 1 },
          "&[data-removable] [data-row-line]": { pr: `${REMOVE_ROOM}px` },
        },
      })}>
      <Box sx={{ position: "relative", display: "flex", flex: 1, minWidth: 0 }}>
        {canEdit && onOpen ? (
          <ButtonBase
            data-row-line
            disableRipple
            title={title}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={(event) => onOpen(event.currentTarget)}
            onKeyDown={(event) => {
              if (!onRemove || (event.key !== "Delete" && event.key !== "Backspace")) return;
              event.preventDefault();
              onRemove();
            }}
            sx={{
              ...line,
              justifyContent: "flex-start",
              textAlign: "left",
              borderRadius: 1,
              "&.Mui-focusVisible": { outline: 2, outlineColor: "primary.main", outlineOffset: -2 },
            }}>
            {said}
          </ButtonBase>
        ) : (
          <Box data-row-line title={title} sx={line}>
            {said}
          </Box>
        )}
        {canEdit && onRemove && (
          <IconButton
            data-row-remove
            size="small"
            aria-label={removeLabel ?? t("style_editor.remove_condition")}
            onClick={onRemove}
            sx={{ position: "absolute", right: 0, top: "50%", transform: "translateY(-50%)" }}>
            <Icon iconName={ICON_NAME.TRASH} sx={{ fontSize: 12 }} />
          </IconButton>
        )}
      </Box>
      {canEdit && action}
      {canEdit && onToggle && (
        <Switch
          size="small"
          checked={!off}
          disabled={switchDisabled}
          onChange={onToggle}
          inputProps={{ "aria-label": switchLabel ?? t("filter_panel.switch") }}
          sx={{ mr: -1 }}
        />
      )}
    </Box>
  );
}
