"use client";

import {
  Box,
  ButtonBase,
  Link,
  Popover,
  Stack,
  type Theme,
  Tooltip,
  Typography,
  alpha,
  useTheme,
} from "@mui/material";
import type { TFunction } from "i18next";
import NextLink from "next/link";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { aiCreditsRuleText } from "@/lib/assistant/aiCredits";
import { useActiveSurface } from "@/lib/assistant/store";
import { aiCreditsLevelColors, formatCredits, formatCreditsDay } from "@/lib/utils/credits";

import type { AiCredits, AiCreditsPool } from "@/hooks/assistant/useAiCredits";

import { CARD_RADIUS, accentSoft, accentText, focusRing, mutedText } from "@/components/assistant/styles";
import { surfaceShadows } from "@/components/dashboard/common/surfaceShadows";

/** The usage page opened on its AI credits tile. */
const USAGE_HREF = "/settings/usage?quota=ai";
/** The ring's circle: 16px wide, a 2.4px stroke. */
const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** The ring's and the bar's empty part. */
const trackColor = (theme: Theme) => alpha(theme.palette.text.primary, 0.14);

/** The usage page; inside a project in a new tab, so the project stays open, as the dock's other links. */
function UsageLink({ children }: { children: ReactNode }) {
  const inProject = !!useActiveSurface()?.project;
  return (
    <Link
      component={NextLink}
      href={USAGE_HREF}
      {...(inProject ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      underline="hover"
      sx={(theme) => ({ flexShrink: 0, fontSize: 13, fontWeight: 700, color: accentText(theme) })}>
      {children}
    </Link>
  );
}

/** "41 % of this month's AI credits used · resets on 1 Dec": the ring's name and tooltip. */
function ringLabel(pool: AiCreditsPool, t: TFunction, language: string) {
  const used = t(pool.onTrial ? "assistant_credits_used_trial" : "assistant_credits_used_month", {
    percent: pool.percent,
  });
  const day = formatCreditsDay(pool.resetsOn, language);
  if (!day) return used;
  return `${used} · ${t(pool.onTrial ? "assistant_credits_valid_until" : "assistant_credits_resets_on", { date: day })}`;
}

/**
 * The organization's AI credits next to Send: a 16px ring filled by the used
 * share, green, orange with "N left" under a tenth left, red when used up. A
 * click opens the pool right above it (not a modal: a click elsewhere or Escape
 * closes it, and the focus returns to the ring).
 */
export function AiCreditsRing({ pool, isAdmin }: { pool: AiCreditsPool; isAdmin: boolean }) {
  const { t, i18n } = useTranslation("common");
  const theme = useTheme();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const language = i18n.language;
  const colors = aiCreditsLevelColors(theme, pool.level);
  const low = pool.level === "low";
  const label = ringLabel(pool, t, language);
  const left = low ? t("usage_left", { left: formatCredits(pool.left, language) }) : null;
  const day = formatCreditsDay(pool.resetsOn, language);
  const rule = aiCreditsRuleText(pool.tiers, t, language);
  const title = t("assistant_credits_title");
  const muted = { fontSize: 12, lineHeight: 1.45, color: mutedText };
  return (
    <>
      <Tooltip title={label}>
        <ButtonBase
          // What the ring shows starts its name, so it can be named by what it says.
          aria-label={left ? `${left} · ${label}` : label}
          aria-haspopup="dialog"
          aria-expanded={!!anchor}
          onClick={(event) => setAnchor(event.currentTarget)}
          sx={{
            flexShrink: 0,
            height: 28,
            px: "6px",
            gap: "5px",
            borderRadius: "8px",
            fontSize: 12,
            fontWeight: 700,
            color: low ? colors.text : mutedText(theme),
            bgcolor: anchor ? accentSoft(theme) : "transparent",
            "&:hover": { bgcolor: anchor ? accentSoft(theme) : "action.hover" },
            ...focusRing(theme),
          }}>
          <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden="true">
            <circle cx={8} cy={8} r={RADIUS} fill="none" stroke={trackColor(theme)} strokeWidth={2.4} />
            {pool.percent > 0 && (
              <circle
                cx={8}
                cy={8}
                r={RADIUS}
                fill="none"
                stroke={colors.bar}
                strokeWidth={2.4}
                strokeLinecap="round"
                strokeDasharray={`${(CIRCUMFERENCE * pool.percent) / 100} ${CIRCUMFERENCE}`}
                transform="rotate(-90 8 8)"
              />
            )}
          </svg>
          {left && <span>{left}</span>}
        </ButtonBase>
      </Tooltip>
      <Popover
        open={!!anchor}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        // Not a modal: the page behind keeps its scrolling.
        disableScrollLock
        anchorOrigin={{ vertical: "top", horizontal: "right" }}
        transformOrigin={{ vertical: "bottom", horizontal: "right" }}
        PaperProps={{
          role: "dialog",
          "aria-label": title,
          sx: {
            mt: "-8px",
            width: 290,
            maxWidth: "calc(100vw - 32px)",
            borderRadius: CARD_RADIUS,
            border: 1,
            borderColor: "divider",
            boxShadow: surfaceShadows(theme).hover,
          },
        }}>
        <Stack gap="12px" sx={{ p: "14px" }}>
          <Stack direction="row" alignItems="baseline" gap="8px">
            <Typography sx={{ flex: 1, fontSize: 13, color: mutedText }}>{title}</Typography>
            {isAdmin && <UsageLink>{t("assistant_credits_see_usage")}</UsageLink>}
          </Stack>
          <Stack gap="6px">
            <Stack direction="row" alignItems="baseline" gap="8px">
              <Typography sx={{ flex: 1, fontSize: 13, fontWeight: 700, color: "text.primary" }}>
                {t(pool.onTrial ? "assistant_credits_period_trial" : "assistant_credits_period_month")}
              </Typography>
              {day && (
                <Typography sx={{ fontSize: 13, color: mutedText }}>
                  {`${t(pool.onTrial ? "valid_until" : "resets_on")} ${day}`}
                </Typography>
              )}
              <Typography
                sx={{
                  fontSize: 13,
                  fontWeight: 700,
                  fontVariantNumeric: "tabular-nums",
                  color: "text.primary",
                }}>
                {t("assistant_credits_percent", { percent: pool.percent })}
              </Typography>
            </Stack>
            <Box aria-hidden sx={{ height: 6, borderRadius: 3, overflow: "hidden", bgcolor: trackColor }}>
              <Box sx={{ height: "100%", width: `${pool.percent}%`, bgcolor: colors.bar }} />
            </Box>
            <Typography sx={muted}>
              {t("assistant_credits_left", {
                left: formatCredits(pool.left, language),
                total: formatCredits(pool.total, language),
              })}
            </Typography>
          </Stack>
          {rule && <Typography sx={muted}>{rule}</Typography>}
          {!isAdmin && <Typography sx={muted}>{t("assistant_credits_admins_manage")}</Typography>}
        </Stack>
      </Popover>
    </>
  );
}

/**
 * The line that takes the input's place while the organization's AI credits
 * are used up; the conversation above stays readable. Admins get the way to
 * Usage, members learn who can ask for more. `autoFocus` moves the focus to it
 * as it mounts (it took the place of the focused input), so the reason is read
 * out; shown on load it leaves the focus be and is a status message.
 */
export function AiCreditsUsedUp({
  usedUp,
  isAdmin,
  autoFocus = false,
}: {
  usedUp: NonNullable<AiCredits["usedUp"]>;
  isAdmin: boolean;
  autoFocus?: boolean;
}) {
  const { t, i18n } = useTranslation("common");
  const theme = useTheme();
  const line = useRef<HTMLDivElement>(null);
  // A status takes its name from the author, not its content: the sentence names it.
  const textId = useId();
  // Decided as it mounts: a later change of the prop does not move the focus again.
  const [focusOnMount] = useState(autoFocus);
  useEffect(() => {
    if (focusOnMount) line.current?.focus();
  }, [focusOnMount]);
  const day = formatCreditsDay(usedUp.resetsOn, i18n.language);
  const text = usedUp.onTrial
    ? t("assistant_credits_used_up_trial")
    : day
      ? // A date that ends in an abbreviation's dot ("1. Dez.") ends the sentence with it.
        t("assistant_credits_used_up", { date: day }).replace(/\.\.$/, ".")
      : t("assistant_credits_used_up_no_date");
  return (
    <Box>
      <Stack
        ref={line}
        role="status"
        aria-labelledby={textId}
        tabIndex={-1}
        direction="row"
        alignItems="center"
        gap="10px"
        sx={{
          outline: "none",
          "&:focus-visible": { outline: `2px solid ${accentText(theme)}`, outlineOffset: "2px" },
          border: 1,
          borderColor: alpha(theme.palette.text.primary, 0.24),
          borderRadius: "14px",
          bgcolor: "background.paper",
          p: "10px 12px",
        }}>
        <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden="true" style={{ flexShrink: 0 }}>
          <circle
            cx={8}
            cy={8}
            r={RADIUS}
            fill="none"
            stroke={aiCreditsLevelColors(theme, "empty").bar}
            strokeWidth={2.4}
          />
        </svg>
        <Typography
          id={textId}
          sx={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.45, color: "text.primary" }}>
          {text}
        </Typography>
        {isAdmin && <UsageLink>{t("usage")}</UsageLink>}
      </Stack>
      {!isAdmin && (
        <Typography sx={{ mt: "6px", px: "2px", fontSize: 12, lineHeight: 1.45, color: mutedText }}>
          {t("assistant_credits_ask_admin")}
        </Typography>
      )}
    </Box>
  );
}
