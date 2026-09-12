"use client";

import LoadingButton from "@mui/lab/LoadingButton";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import type { DialogProps } from "@mui/material";
import type { SxProps, Theme } from "@mui/material";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { ICON_NAME } from "@p4b/ui/components/Icon";

import { ContentDialogHeader, contentDialogPaperSx } from "@/components/modals/content/ContentDialogChrome";

export interface AppDialogProps {
  open: boolean;
  onClose: () => void;
  icon: ICON_NAME;
  title: string;
  /** A muted second line under the title — a string, or a sentence with
   * its own markup. */
  subtitle?: ReactNode;
  /** `warning` tints the header's icon tile amber — what a destructive or
   * hand-over dialog is marked with. */
  tone?: "primary" | "warning";
  /** Paper width: a number is a pixel cap, a string is a width expression
   * the dialog states for itself. */
  maxWidth?: number | string;
  /** Below this breakpoint the dialog takes the whole viewport. */
  fullScreenBelow?: "sm" | "md";
  children: ReactNode;
  /** Extra styling for the body, merged over its default padding. */
  bodySx?: SxProps<Theme>;
  /** Drops the body padding, for a body that lays out its own edges. */
  bleed?: boolean;
  /** The action row; omitted leaves the dialog without one. */
  footer?: ReactNode;
  /** An alert-sized slot between the body and the footer. */
  notice?: ReactNode;
  /** The label the header's close button is read out with; defaults to
   * "Close". */
  closeLabel?: string;
  /** Blocks every way out through the header X — the click itself, and a
   * backdrop click or Escape — while a dialog is mid-flight. */
  closeDisabled?: boolean;
  /** Extra paper styling merged over the shell's width and radius — a
   * minimum height for a body that must not collapse while it loads. */
  paperSx?: SxProps<Theme>;
  /** Names the dialog for assistive technology when the title alone does
   * not identify it (a setup dialog named after its file). */
  ariaLabel?: string;
  /** MUI's fade timing; a dialog that takes over from another one in the
   * same click enters (or leaves) in 0ms so the backdrop never blinks. */
  transitionDuration?: DialogProps["transitionDuration"];
}

/**
 * The chrome every GOAT dialog wears: a 16px paper, a header with a tinted
 * icon tile beside the title, a scrolling body, and a footer rule with the
 * actions right-aligned.
 *
 * It owns none of a dialog's rules — what the primary action does, whether
 * it is allowed, what the body holds — so a dialog migrating onto it keeps
 * its own behaviour and only hands over its frame.
 */
const AppDialog = ({
  open,
  onClose,
  icon,
  title,
  subtitle,
  tone = "primary",
  maxWidth = 560,
  fullScreenBelow = "sm",
  children,
  bodySx,
  bleed,
  footer,
  notice,
  closeLabel,
  closeDisabled,
  paperSx,
  ariaLabel,
  transitionDuration,
}: AppDialogProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down(fullScreenBelow));

  // MUI hands the backdrop-click/Escape reason to `onClose` itself, so
  // gating those two paths (alongside the header X, which just never calls
  // this at all while disabled) only needs ignoring the call here.
  const handleClose = () => {
    if (closeDisabled) return;
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      aria-label={ariaLabel}
      transitionDuration={transitionDuration}
      fullScreen={fullScreen}
      maxWidth={false}
      PaperProps={{
        sx: [
          contentDialogPaperSx(maxWidth, fullScreen),
          ...(Array.isArray(paperSx) ? paperSx : [paperSx]),
        ] as SxProps<Theme>,
      }}>
      <ContentDialogHeader
        icon={icon}
        tone={tone}
        title={title}
        subtitle={subtitle}
        onClose={handleClose}
        closeLabel={closeLabel ?? t("close")}
        closeDisabled={closeDisabled}
        divider
      />

      <DialogContent sx={[bleed ? { p: 0 } : {}, ...(Array.isArray(bodySx) ? bodySx : [bodySx])]}>
        {children}
      </DialogContent>

      {notice && <Box sx={{ px: 6, pt: 3, flexShrink: 0 }}>{notice}</Box>}

      {footer}
    </Dialog>
  );
};

export interface AppDialogFooterProps {
  /** Defaults to "Cancel". */
  cancelLabel?: string;
  /** Omitted leaves the footer with the primary action alone. */
  onCancel?: () => void;
  /** Blocks the way out while the dialog is mid-flight. */
  cancelDisabled?: boolean;
  /** Omitting both `primaryLabel` and `onPrimary` leaves a dismiss-only row
   * with the Cancel button alone. */
  primaryLabel?: string;
  onPrimary?: () => void;
  primaryDisabled?: boolean;
  primaryLoading?: boolean;
  primaryColor?: "primary" | "error";
  /** Says why the primary action is refused, on hover. */
  primaryTooltip?: string;
  /** `submit` makes the button a submit control for the form named by
   * `primaryForm`, so Enter in one of that form's fields triggers it too.
   * Defaults to a plain `button`. */
  primaryType?: "button" | "submit";
  /** The `id` of the `<form>` the primary submits when `primaryType` is
   * `submit` — the form itself can sit outside this footer. */
  primaryForm?: string;
  /** Sits at the left end of the row — a Back step, a secondary link. */
  extra?: ReactNode;
}

/** A dialog's action row: whatever `extra` holds at the left, then a text
 * Cancel and the contained primary at the right. */
export const AppDialogFooter = ({
  cancelLabel,
  onCancel,
  cancelDisabled,
  primaryLabel,
  onPrimary,
  primaryDisabled,
  primaryLoading,
  primaryColor = "primary",
  primaryTooltip,
  primaryType = "button",
  primaryForm,
  extra,
}: AppDialogFooterProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();

  return (
    <DialogActions
      disableSpacing
      // The doubled `&` is load-bearing: the theme zeroes a dialog footer's top
      // padding through `.MuiDialogContent-root + .MuiDialogActions-root`, which
      // ties with a normal `sx` selector on specificity and wins on order, so the
      // buttons sit against the rule. Three classes settle it.
      sx={{
        "&&.MuiDialogActions-root": {
          borderTop: `1px solid ${theme.palette.divider}`,
          py: 4,
          px: 6,
        },
        justifyContent: "flex-end",
        gap: 2,
        flexShrink: 0,
      }}>
      {extra && <Box sx={{ display: "inline-flex", mr: "auto" }}>{extra}</Box>}
      {onCancel && (
        <Button variant="text" onClick={onCancel} disabled={cancelDisabled}>
          <Typography variant="body2" fontWeight="bold">
            {cancelLabel ?? t("cancel")}
          </Typography>
        </Button>
      )}
      {primaryLabel !== undefined && (
        <Tooltip title={primaryTooltip ?? ""}>
          <Box component="span" sx={{ display: "inline-flex" }}>
            <LoadingButton
              type={primaryType}
              form={primaryForm}
              variant="contained"
              color={primaryColor}
              disabled={primaryDisabled}
              loading={primaryLoading}
              onClick={(event) => {
                // A submit button linked to a form outside it (via `form`) fires
                // both this click and, unless stopped, the form's own native
                // submit — which would run `onPrimary` a second time. Enter in a
                // form field clicks this button (it is the form's default
                // button), so both paths run `onPrimary` exactly once.
                if (primaryType === "submit") event.preventDefault();
                onPrimary?.();
              }}>
              <Typography variant="body2" fontWeight="bold" color="inherit">
                {primaryLabel}
              </Typography>
            </LoadingButton>
          </Box>
        </Tooltip>
      )}
    </DialogActions>
  );
};

export default AppDialog;
