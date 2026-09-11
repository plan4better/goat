"use client";

import { Box, IconButton, InputBase, Typography, alpha, darken, useTheme } from "@mui/material";
import type { SxProps, Theme } from "@mui/material";
import type { ReactNode, RefObject } from "react";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

/** The chrome the Content dialogs (Share, Move, Transfer) share: a fixed
 * dialog width with a 16px radius, a header row whose leading icon sits in a
 * tinted block, and the pill search field the Share tabs filter with. */

/** The ink an amber surface is written with. `warning.main` is a bright
 * signal yellow: on a light tint it needs darkening to be read at icon
 * size, and on a dark ground it needs the light end of the ramp instead. */
export const warningInk = (theme: Theme): string =>
  theme.palette.mode === "dark" ? theme.palette.warning.light : darken(theme.palette.warning.main, 0.3);

/** The amber a filled ownership button is painted with. Dark in both modes,
 * because it carries white text either way. */
export const warningFill = (theme: Theme): string => darken(theme.palette.warning.main, 0.3);

/** What MUI's default 32px paper margin costs a dialog either side. The
 * paper's `100%` is the container's full width, which that margin is taken
 * out of — so a width stated as `min(560px, 100%)` is 560px wide at a 600px
 * viewport and overflows it by its own margins. Below 600px the theme
 * narrows the margin and caps the paper itself (`overrides/dialog.ts`), so
 * this is the cap that matters from `sm` up. */
export const DIALOG_PAPER_GUTTER = "64px";

/** `PaperProps.sx` for a Content dialog: the prototype's width, held inside
 * the room the paper's margins leave, and a 16px radius — both dropped on a
 * full-screen (mobile) dialog where the paper is the whole viewport. */
export const contentDialogPaperSx = (maxWidth: number | string, fullScreen: boolean): SxProps<Theme> => {
  if (fullScreen) return { borderRadius: 0 };
  // A number is a plain pixel cap; a string is a width expression a dialog
  // states for itself (the Add-layer sources size to the viewport).
  const stated = typeof maxWidth === "number" ? `${maxWidth}px` : maxWidth;
  const width = `min(${stated}, calc(100% - ${DIALOG_PAPER_GUTTER}))`;
  return { width, maxWidth: width, borderRadius: "16px" };
};

interface ContentDialogHeaderProps {
  icon: ICON_NAME;
  /** Which palette tints the icon block — `warning` marks the ownership
   * hand-over, everything else uses the primary accent. */
  tone?: "primary" | "warning";
  title: string;
  /** A muted second line under the title, for the one-sentence case. A
   * caller that needs its own markup passes `subline` instead. */
  subtitle?: ReactNode;
  subline?: ReactNode;
  onClose: () => void;
  closeLabel: string;
  /** Grays out the close button and blocks the click while a dialog is
   * mid-flight — the header X's counterpart to a footer's disabled Cancel. */
  closeDisabled?: boolean;
  /** Move/Transfer close their header with a rule; Share's header runs
   * straight into its tab bar, which carries the rule instead. */
  divider?: boolean;
  padding?: string;
}

/** A Content dialog's header: a 34px tinted icon block, the title, an
 * optional second line, and the close button. */
export const ContentDialogHeader = ({
  icon,
  tone = "primary",
  title,
  subtitle,
  subline,
  onClose,
  closeLabel,
  closeDisabled,
  divider,
  padding = "18px 22px 14px",
}: ContentDialogHeaderProps) => {
  const theme = useTheme();
  const toneColor = tone === "warning" ? warningInk(theme) : theme.palette.primary.main;
  const toneBackground = alpha(
    tone === "warning" ? theme.palette.warning.main : theme.palette.primary.main,
    tone === "warning" ? 0.16 : 0.12
  );

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "flex-start",
        gap: "10px",
        padding,
        flexShrink: 0,
        borderBottom: divider ? `1px solid ${theme.palette.divider}` : undefined,
      }}>
      <Box
        sx={{
          width: 34,
          height: 34,
          borderRadius: "9px",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: toneBackground,
        }}
        data-testid="dialog-icon-tile">
        <Icon iconName={icon} style={{ fontSize: 17, color: toneColor }} />
      </Box>
      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          // A lone title centres on the 34px tile; a second line grows the
          // block past it and the pair starts at the tile's top.
          minHeight: 34,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
        }}>
        <Typography component="div" noWrap sx={{ fontSize: 16, fontWeight: 700 }}>
          {title}
        </Typography>
        {subtitle && (
          <Typography
            component="div"
            sx={{ fontSize: 12.5, color: "text.secondary", lineHeight: 1.4, marginTop: "2px" }}>
            {subtitle}
          </Typography>
        )}
        {subline}
      </Box>
      <Box sx={{ height: 34, display: "flex", alignItems: "center", flexShrink: 0 }}>
        <IconButton size="small" onClick={onClose} disabled={closeDisabled} aria-label={closeLabel}>
          <Icon iconName={ICON_NAME.CLOSE} style={{ fontSize: 16 }} />
        </IconButton>
      </Box>
    </Box>
  );
};

interface ContentDialogSublineProps {
  icon: ICON_NAME;
  children: ReactNode;
}

/** The header's second line: a small muted marker plus the "lives in …"
 * sentence, at the prototype's 11.8px. */
export const ContentDialogSubline = ({ icon, children }: ContentDialogSublineProps) => {
  const theme = useTheme();

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: "6px",
        marginTop: "2px",
        fontSize: 11.8,
        color: theme.palette.text.secondary,
      }}>
      <Icon iconName={icon} style={{ fontSize: 12, color: theme.palette.text.disabled }} />
      <Box component="span" sx={{ minWidth: 0 }}>
        {children}
      </Box>
    </Box>
  );
};

interface DialogSearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  clearLabel: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  /** The field took focus — a tab may open its list of candidates on it. */
  onFocus?: () => void;
}

/** The pill search field at the top of a Share tab: a soft band with a
 * search mark, the input, and a clear button once something is typed. */
export const DialogSearchField = ({
  value,
  onChange,
  placeholder,
  clearLabel,
  inputRef,
  onFocus,
}: DialogSearchFieldProps) => {
  const theme = useTheme();

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: "9px",
        flexShrink: 0,
        backgroundColor: theme.palette.action.hover,
        border: `1px solid ${theme.palette.divider}`,
        borderRadius: "999px",
        padding: "4px 10px 4px 14px",
      }}>
      <Icon iconName={ICON_NAME.SEARCH} style={{ fontSize: 14, color: theme.palette.text.secondary }} />
      <InputBase
        inputRef={inputRef}
        sx={{ flex: 1, fontSize: 13 }}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={onFocus}
        endAdornment={
          value ? (
            <IconButton size="small" aria-label={clearLabel} onClick={() => onChange("")}>
              <Icon iconName={ICON_NAME.CLOSE} style={{ fontSize: 13 }} />
            </IconButton>
          ) : undefined
        }
      />
    </Box>
  );
};

interface DialogGroupLabelProps {
  children: ReactNode;
  /** The first label in a body sits tight against the top of its column;
   * every later one opens a gap above itself. */
  first?: boolean;
}

/** The uppercase group label that separates the sections inside a dialog
 * body ("Organization", "Teams", "To", "What happens"). */
export const DialogGroupLabel = ({ children, first }: DialogGroupLabelProps) => (
  <Typography
    component="div"
    sx={{
      fontSize: 10.5,
      fontWeight: 800,
      letterSpacing: "0.7px",
      textTransform: "uppercase",
      color: "text.disabled",
      margin: first ? "2px 0 6px" : "16px 0 6px",
    }}>
    {children}
  </Typography>
);
