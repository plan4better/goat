import { type Theme, alpha } from "@mui/material";
import { keyframes } from "@mui/material/styles";

import { surfaceShadows } from "@/components/dashboard/common/surfaceShadows";
import { TOOLBAR_HEIGHT, toolbarBorder } from "@/components/header/Toolbar";

/**
 * The dock's shared look, in theme tokens. It follows the dashboard pages (12px
 * cards on a divider border, 999px pills, small uppercase labels) and the AI
 * dock prototype. Lengths are written in px: this theme's spacing unit is 4px,
 * not MUI's 8px.
 */

/**
 * Text in the primary accent. `primary.main` is too light for text on paper,
 * so light mode takes the dark shade and dark mode the light one.
 */
export const accentText = (theme: Theme): string =>
  theme.palette.mode === "light" ? theme.palette.primary.dark : theme.palette.primary.light;

/**
 * Secondary text for the dock's small labels. The theme's `text.secondary`
 * (0.68) stays just under 4.5:1 on white and below it on tinted surfaces; this
 * is the same ink a little stronger, so small text keeps AA contrast.
 */
export const mutedText = (theme: Theme): string => alpha(theme.palette.text.primary, 0.76);

/** A band of light moving across the text, left to right. */
const shimmer = keyframes`
  from { background-position: 100% 0; }
  to { background-position: 0 0; }
`;

/**
 * Text for something still under way (the Answering line, a running step):
 * dim, with a bright band in the middle, three times as wide as the text, so
 * the band enters, crosses and leaves within one cycle. With reduced motion it
 * is plain muted text.
 */
export const shimmerSx = (theme: Theme) => {
  const dim = alpha(theme.palette.text.primary, 0.45);
  const bright = theme.palette.text.primary;
  return {
    color: mutedText(theme),
    backgroundImage: `linear-gradient(90deg, ${dim} 0%, ${dim} 38%, ${bright} 50%, ${dim} 62%, ${dim} 100%)`,
    backgroundSize: "300% 100%",
    backgroundClip: "text",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
    animation: `${shimmer} 1.8s ease-in-out infinite`,
    "@media (prefers-reduced-motion: reduce)": {
      animation: "none",
      backgroundImage: "none",
      WebkitTextFillColor: "currentColor",
    },
  };
};

/** The soft primary tint behind the user's messages, selected rows and the proposal header. */
export const accentSoft = (theme: Theme): string =>
  alpha(theme.palette.primary.main, theme.palette.mode === "light" ? 0.1 : 0.16);

/** A keyboard focus outline that stays visible on paper and on the soft tint. */
export const focusRing = (theme: Theme) => ({
  "&.Mui-focusVisible, &:focus-visible": {
    outline: `2px solid ${accentText(theme)}`,
    outlineOffset: "2px",
  },
});

/** The 12px card every dock block sits in, like the dashboard's `SurfaceCard`. */
export const CARD_RADIUS = "12px";

/** The height of a result card's preview (a map, or a table's first rows). */
export const ITEM_PREVIEW_HEIGHT = 280;

/** Small uppercase labels: CONTEXT, proposal tags and row names. */
export const eyebrowSx = {
  fontSize: 10.5,
  fontWeight: 800,
  letterSpacing: "0.5px",
  lineHeight: 1.5,
  textTransform: "uppercase",
} as const;

/**
 * The dock's pill buttons, sized for a 400px panel. `&&` outranks the theme's
 * size and variant paddings, which are more specific than a plain `sx`.
 */
export const pillButtonSx = {
  "&&": {
    borderRadius: "999px",
    minWidth: 0,
    px: "16px",
    py: "5px",
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: "0.3px",
    lineHeight: 1.5,
    textTransform: "none",
    whiteSpace: "nowrap",
  },
} as const;

/** A neutral outlined pill (Discard, Open): divider border and secondary text, not the primary accent. */
export const neutralPillSx = (theme: Theme) => ({
  ...pillButtonSx,
  "&&.MuiButton-outlined": {
    borderColor: theme.palette.divider,
    color: mutedText(theme),
    "&:hover": {
      borderColor: alpha(theme.palette.text.primary, 0.24),
      backgroundColor: theme.palette.action.hover,
    },
  },
});

/** The 28px icon buttons of the dock header. */
export const headerIconButtonSx = (theme: Theme) => ({
  width: 28,
  height: 28,
  borderRadius: "7px",
  color: theme.palette.text.secondary,
  "&:hover": { backgroundColor: theme.palette.action.hover },
  ...focusRing(theme),
});

/**
 * The dock's header bar: the app's top bar's height and bottom border, so the
 * two read as one bar. `sidebar`: full screen, beside the history.
 */
export const dockHeaderSx = (theme: Theme, sidebar?: boolean) => ({
  boxSizing: "content-box" as const,
  height: TOOLBAR_HEIGHT,
  flexShrink: 0,
  borderBottom: toolbarBorder(theme),
  pl: sidebar ? "16px" : "12px",
  pr: "10px",
});

/** The full-screen dock's history column. */
export const dockSidebarSx = {
  width: 272,
  flexShrink: 0,
  borderRight: 1,
  borderColor: "divider",
  bgcolor: "background.default",
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
} as const;

/** A darker, blurred scrim: the page around the full-screen dock reads as background, not as content. */
export const dockBackdropSx = (theme: Theme) => ({
  bgcolor: alpha(theme.palette.common.black, 0.55),
  backdropFilter: "blur(4px)",
});

/** The full-screen dock inset from the window's edges (a phone shows it over the whole screen). */
export const dockInsetPaperSx = (theme: Theme) => ({
  position: "fixed" as const,
  inset: 16,
  m: 0,
  width: "auto",
  maxWidth: "none",
  height: "auto",
  maxHeight: "none",
  overflow: "hidden",
  borderRadius: "16px",
  boxShadow: surfaceShadows(theme).hover,
});

/** The footer the composer sits in, below the transcript. */
export const composerFooterSx = (big?: boolean) => ({
  flexShrink: 0,
  borderTop: 1,
  borderColor: "divider",
  px: big ? "24px" : "16px",
  pt: big ? "14px" : "11px",
  pb: big ? "18px" : "16px",
});
