"use client";

import { Box, Stack, Typography, useTheme } from "@mui/material";
import type { SxProps, Theme } from "@mui/material";
import type { ElementType, MouseEventHandler, ReactNode } from "react";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { POPOVER_LIST_PADDING, POPOVER_ROW_ICON_SIZE, POPOVER_ROW_SX } from "@/components/common/popoverRow";

/** One width for every header popover, unless one genuinely needs another. */
export const HEADER_POPOVER_WIDTH = "min(340px, calc(100vw - 24px))";

/**
 * Parts of a header popover, in the measures of the onboarding tray: put them inside a
 * `HeaderPopoverPaper`, in this order — header, one or more lists, an optional footer.
 */

type HeaderProps = {
  title: ReactNode;
  /** Small caps text on the right, e.g. "5/6 COMPLETED". */
  aside?: ReactNode;
  /** Something before the title, e.g. an avatar. */
  leading?: ReactNode;
  /** Below the title row, e.g. a progress bar or the user's name. */
  children?: ReactNode;
};

export const HeaderPopoverHeader = ({ title, aside, leading, children }: HeaderProps) => {
  const theme = useTheme();
  return (
    <Box sx={{ p: "14px 16px 12px", borderBottom: `1px solid ${theme.palette.divider}` }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing="12px">
        <Stack direction="row" alignItems="center" spacing="10px" sx={{ minWidth: 0 }}>
          {leading}
          <Typography noWrap sx={{ fontSize: 14.5, fontWeight: 700 }}>
            {title}
          </Typography>
        </Stack>
        {aside && (
          <Typography
            sx={{
              flexShrink: 0,
              fontSize: 10.5,
              fontWeight: 800,
              letterSpacing: "0.5px",
              textTransform: "uppercase",
              color: theme.palette.text.secondary,
            }}>
            {aside}
          </Typography>
        )}
      </Stack>
      {children}
    </Box>
  );
};

export const HeaderPopoverList = ({ children, sx }: { children: ReactNode; sx?: SxProps<Theme> }) => (
  <Stack sx={[{ p: POPOVER_LIST_PADDING }, ...(Array.isArray(sx) ? sx : [sx])]}>{children}</Stack>
);

type RowProps = {
  /** An icon name (drawn at 15px, muted) or your own node, e.g. a status dot. */
  icon?: ICON_NAME | ReactNode;
  label: ReactNode;
  /** A muted line below the label, ellipsised. */
  secondary?: ReactNode;
  /** After the label, pushed to the right: a count, an external-link mark. */
  trailing?: ReactNode;
  onClick?: MouseEventHandler<HTMLElement>;
  /** Renders a link; with `newTab` it opens in a new tab. */
  href?: string;
  newTab?: boolean;
  disabled?: boolean;
  /** Greyed text for something already done. */
  muted?: boolean;
  tone?: "default" | "danger";
};

/** A row of a popover list: a link when it has `href`, a button when it has `onClick`, else plain. */
export const HeaderPopoverRow = ({
  icon,
  label,
  secondary,
  trailing,
  onClick,
  href,
  newTab,
  disabled,
  muted,
  tone = "default",
}: RowProps) => {
  const theme = useTheme();
  const interactive = !disabled && (!!onClick || !!href);
  const danger = tone === "danger";
  const component: ElementType = href && !disabled ? "a" : onClick ? "button" : "div";
  const color = danger
    ? theme.palette.error.main
    : muted
      ? theme.palette.text.secondary
      : theme.palette.text.primary;
  return (
    <Box
      component={component}
      {...(component === "button" ? { type: "button", disabled } : {})}
      {...(component === "a"
        ? { href, ...(newTab ? { target: "_blank", rel: "noopener noreferrer" } : {}) }
        : {})}
      onClick={interactive ? onClick : undefined}
      sx={{
        ...POPOVER_ROW_SX,
        display: "flex",
        alignItems: "center",
        width: "100%",
        border: "none",
        background: "none",
        textAlign: "left",
        textDecoration: "none",
        fontFamily: "inherit",
        color,
        opacity: disabled ? 0.5 : 1,
        cursor: interactive ? "pointer" : "default",
        "&:hover": interactive ? { backgroundColor: theme.palette.action.hover } : undefined,
        "&:focus-visible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: -2 },
      }}>
      {typeof icon === "string" ? (
        <Icon
          iconName={icon as ICON_NAME}
          style={{
            fontSize: POPOVER_ROW_ICON_SIZE,
            color: danger ? "inherit" : theme.palette.text.secondary,
            flexShrink: 0,
          }}
        />
      ) : (
        icon
      )}
      <Box sx={{ minWidth: 0, flexGrow: 1 }}>
        <Box
          component="span"
          sx={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}>
            {secondary}
          </Box>
        )}
      </Box>
      {trailing}
    </Box>
  );
};

/** The mark after a row that opens another tab. */
export const HeaderPopoverExternalMark = () => {
  const theme = useTheme();
  return (
    <Icon
      iconName={ICON_NAME.EXTERNAL_LINK}
      style={{ fontSize: 11, color: theme.palette.text.secondary, flexShrink: 0 }}
    />
  );
};

export const HeaderPopoverFooter = ({ children }: { children: ReactNode }) => {
  const theme = useTheme();
  return (
    <Box
      // On the card's own surface, ruled off: a tinted strip read as the page showing through.
      sx={{ p: "10px 16px", borderTop: `1px solid ${theme.palette.divider}` }}>
      {children}
    </Box>
  );
};

/** The link-styled action of a footer: a button, or a link with `href`. */
export const HeaderPopoverFooterAction = ({
  children,
  onClick,
  href,
  newTab,
}: {
  children: ReactNode;
  onClick?: MouseEventHandler<HTMLElement>;
  href?: string;
  newTab?: boolean;
}) => {
  const theme = useTheme();
  return (
    <Box
      component={href ? "a" : "button"}
      {...(href
        ? { href, ...(newTab ? { target: "_blank", rel: "noopener noreferrer" } : {}) }
        : { type: "button" })}
      onClick={onClick}
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        border: "none",
        background: "none",
        p: 0,
        fontFamily: "inherit",
        fontSize: 12.5,
        fontWeight: 700,
        textDecoration: "none",
        color: theme.palette.primary.main,
        cursor: "pointer",
        "&:focus-visible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2 },
      }}>
      {children}
    </Box>
  );
};
