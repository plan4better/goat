"use client";

import { Box, Button, type Theme, Tooltip, alpha, useTheme } from "@mui/material";
import { keyframes } from "@mui/material/styles";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { getDockState, setDockState, useDockState } from "@/lib/assistant/store";

import { prefetchAssistant } from "@/components/assistant/dockLoader";
import { accentSoft, accentText, focusRing } from "@/components/assistant/styles";

/** One turn of the colour ring. */
export const RING_TURN_MS = 2400;
/** The turns of the intro, the first time the button shows in a browser session. */
const INTRO_TURNS = 3;
const INTRO_MS = INTRO_TURNS * RING_TURN_MS;
/** Set in sessionStorage as the intro starts. */
export const INTRO_KEY = "goat:assistant-ask-ai-intro";
/** The ring's fixed accent stops beside the primary green. */
const RING_TEAL = "#3BC9DB";
const RING_BLUE = "#4C6EF5";
const RING = "[data-ask-ai-ring]";
const MOTION_OK = "@media (prefers-reduced-motion: no-preference)";

const spin = keyframes`
  to { transform: rotate(1turn); }
`;
/** Shown through the turns, gone by their end. */
const fadeOut = keyframes`
  0%, 88% { opacity: 1; }
  100% { opacity: 0; }
`;

/** The intro played on this page already; without sessionStorage this is all there is. */
let introPlayed = false;

/** Whether this button plays the intro: the first to ask in the browser session does. */
function claimIntro(): boolean {
  if (introPlayed) return false;
  introPlayed = true;
  try {
    if (window.sessionStorage.getItem(INTRO_KEY)) return false;
    window.sessionStorage.setItem(INTRO_KEY, "1");
  } catch {
    // No storage (blocked, private mode): once per page load.
  }
  return true;
}

/** Tests: a new page load in the same session, whose flag stays in sessionStorage. */
export function resetAskAiIntro(): void {
  introPlayed = false;
}

const prefersReducedMotion = () =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A 1.5 px colour ring over the button's border: a conic gradient that turns
 * behind a mask which leaves only the band along the edge. Absolutely placed,
 * so the button keeps its size; at rest it is transparent. Every animation
 * waits for the system to allow motion.
 */
const ringSx = (theme: Theme) => ({
  position: "absolute",
  // The button's border box, from the padding box an absolute child is placed in.
  inset: "-1px",
  p: "1.5px",
  borderRadius: "inherit",
  overflow: "hidden",
  pointerEvents: "none",
  opacity: 0,
  transition: "opacity 250ms",
  mask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
  WebkitMaskComposite: "xor",
  maskComposite: "exclude",
  "&::before": {
    content: '""',
    position: "absolute",
    inset: "-160%",
    background: `conic-gradient(from 0deg, ${theme.palette.primary.main}, ${RING_TEAL}, ${RING_BLUE}, ${theme.palette.primary.main} 60%, ${RING_TEAL} 80%, ${theme.palette.primary.main})`,
  },
  [MOTION_OK]: {
    '&[data-ask-ai-ring="intro"]': {
      animation: `${fadeOut} ${INTRO_MS}ms ease forwards`,
      "&::before": { animation: `${spin} ${RING_TURN_MS}ms linear ${INTRO_TURNS}` },
    },
  },
});

/**
 * "Ask AI" in the top bar (spec §10); absent wherever the dock is not available.
 * `compact` shows the icon alone in a 32px circle, for narrow headers. Closed,
 * it is an outlined 32px pill like the header's onboarding pill; open, it takes
 * the primary tint. Only colours change, so the header does not shift when it
 * toggles. Both forms are the same element, so switching keeps keyboard focus
 * and the ring, and both say in their tooltip that the assistant is in beta.
 * Closed, a colour ring turns around it three times the first time it shows in
 * a browser session, and while the pointer is on it or it has keyboard focus.
 */
export default function AskAiButton({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const dock = useDockState();
  const [intro, setIntro] = useState(false);
  // This button's claim on the intro, kept across StrictMode's second run of the effect
  // (which must play what the first run claimed) and spent once the intro's time is up.
  const ownsIntro = useRef<boolean | null>(null);
  // Decided once the button shows in the browser: the server renders it at rest, and an
  // intro that cannot move (reduced motion) or that the open dock hides is not played.
  useEffect(() => {
    if (!dock.enabled || getDockState().open || prefersReducedMotion()) return;
    ownsIntro.current ??= claimIntro();
    if (!ownsIntro.current) return;
    setIntro(true);
    const timer = window.setTimeout(() => {
      ownsIntro.current = false;
      setIntro(false);
    }, INTRO_MS);
    return () => {
      window.clearTimeout(timer);
      setIntro(false);
    };
  }, [dock.enabled]);
  // The open dock ends it: no ring while open, and no replay once closed.
  if (intro && dock.open) setIntro(false);
  if (!dock.enabled) return null;
  const toggle = () => setDockState({ open: !dock.open });
  // A pointer on the button or focus on it: the dock is about to open, unless the idle page loaded
  // it already. The ring then turns for as long as it stays there, the intro gives way.
  const arrive = () => {
    prefetchAssistant();
    setIntro(false);
  };
  const prefetch = { onPointerEnter: arrive, onFocus: arrive };
  const ringShown = `&:hover ${RING}, &:focus-visible ${RING}, &.Mui-focusVisible ${RING}`;
  const sx = {
    height: 32,
    flexShrink: 0,
    border: `1px solid ${dock.open ? theme.palette.primary.main : theme.palette.divider}`,
    color: dock.open ? accentText(theme) : theme.palette.text.primary,
    bgcolor: dock.open ? accentSoft(theme) : "transparent",
    transition: theme.transitions.create(["background-color", "border-color", "color"], { duration: 120 }),
    "&:hover": {
      bgcolor: dock.open ? alpha(theme.palette.primary.main, 0.18) : theme.palette.action.hover,
      borderColor: dock.open ? theme.palette.primary.main : alpha(theme.palette.text.primary, 0.24),
    },
    [ringShown]: { opacity: 1 },
    [MOTION_OK]: {
      [ringShown.replaceAll(RING, `${RING}::before`)]: {
        animation: `${spin} ${RING_TURN_MS}ms linear infinite`,
      },
    },
    ...focusRing(theme),
  };
  const icon = (
    <Icon
      iconName={ICON_NAME.SPARKLES}
      style={{ fontSize: 16, color: dock.open ? "inherit" : theme.palette.primary.main }}
    />
  );
  const ring = !dock.open && (
    <Box component="span" aria-hidden data-ask-ai-ring={intro ? "intro" : "rest"} sx={ringSx(theme)} />
  );
  return (
    <Tooltip title={t("assistant_ask_ai_tooltip")} describeChild>
      <Button
        size="small"
        variant="text"
        // Compact, the label is left out: it names the button instead.
        aria-label={compact ? t("assistant_ask_ai") : undefined}
        aria-pressed={dock.open}
        onClick={toggle}
        {...prefetch}
        startIcon={icon}
        centerRipple={compact}
        sx={{
          ...sx,
          "&&": { px: compact ? 0 : "12px", py: 0 },
          "& .MuiButton-startIcon": { ml: 0, mr: compact ? 0 : "7px" },
          ...(compact && { minWidth: 32, width: 32 }),
          borderRadius: "999px",
          textTransform: "none",
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: "0.1px",
          whiteSpace: "nowrap",
        }}>
        {!compact && t("assistant_ask_ai")}
        {ring}
      </Button>
    </Tooltip>
  );
}
