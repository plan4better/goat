"use client";

import { Box, LinearProgress, Skeleton, useMediaQuery, useTheme } from "@mui/material";
import type { Theme } from "@mui/material";
import { visuallyHidden } from "@mui/utils";
import { type KeyboardEvent, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { CreditBalance } from "@/lib/api/usage";
import {
  type AiCreditsLevel,
  aiCreditsLevelColors,
  formatCredits,
  formatCreditsDay,
  formatMegabytes,
} from "@/lib/utils/credits";

import { accentText, focusRing } from "@/components/assistant/styles";
import SurfaceCard from "@/components/dashboard/common/SurfaceCard";

export type QuotaKey = "credits" | "ai" | "storage" | "projects" | "editors";

export const QUOTA_KEYS: QuotaKey[] = ["credits", "ai", "storage", "projects", "editors"];

/** The id of a quota's tile, for the panel it controls to be labelled by. */
export const quotaTabId = (panelId: string, key: QuotaKey): string => `${panelId}-${key}`;

/** Within the limit, at 90 % of it or more, or over it. */
type QuotaLevel = "ok" | "full" | "over";

/** What a quota uses and its limit; null: no limit. */
const amountsOf = (balance: CreditBalance): Record<QuotaKey, [number, number | null]> => ({
  credits: [balance.used_credits, balance.total_credits],
  ai: [balance.used_ai_credits, balance.total_ai_credits],
  storage: [balance.used_storage, balance.total_storage],
  projects: [balance.used_projects, balance.total_projects],
  editors: [balance.used_editors, balance.total_editors],
});

/** Exactly at the limit is full, not over: every seat taken is not one too many. */
const levelOf = (used: number, limit: number | null): QuotaLevel => {
  if (limit === null) return "ok";
  // A pool of nothing that nothing used (AI switched off by the deal) needs
  // no attention; any use of it is over.
  if (limit <= 0 && used <= 0) return "ok";
  if (used > limit) return "over";
  return used >= limit * 0.9 ? "full" : "ok";
};

/** A tile's level in the credit levels' colours: green, orange, red. */
const LEVEL_COLORS: Record<QuotaLevel, AiCreditsLevel> = { ok: "ok", full: "low", over: "empty" };

const levelColors = (theme: Theme, level: QuotaLevel) => {
  const { bar, text } = aiCreditsLevelColors(theme, LEVEL_COLORS[level]);
  return {
    bar,
    text: level === "ok" ? theme.palette.text.primary : text,
    note: level === "ok" ? undefined : text,
  };
};

interface Tile {
  key: QuotaKey;
  label: string;
  beta?: boolean;
  used: string;
  limit: string | null;
  level: QuotaLevel;
  /** How full the bar is, 0 to 100. */
  percent: number;
  note: string | null;
}

const ellipsis = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;

/**
 * The five quotas as the tabs of the usage page: each tile names its quota,
 * what is used of its limit, a bar and one line on the limit, with a dot when
 * it is over its limit (red) or at 90 % or more (amber). The open tile carries
 * the primary border; the arrow keys move between the tiles and open them.
 */
export const QuotaTiles = ({
  balance,
  isLoading,
  value,
  onChange,
  panelId,
}: {
  balance?: CreditBalance;
  isLoading: boolean;
  value: QuotaKey;
  onChange: (key: QuotaKey) => void;
  /** The id of the panel the tiles open their detail in. */
  panelId: string;
}) => {
  const { t, i18n } = useTranslation("common");
  const language = i18n.language;
  const theme = useTheme();
  // A phone's tiles are two to a row: a smaller figure, and a label row that
  // may put the Beta chip below the label instead of cutting it.
  const isPhone = useMediaQuery(theme.breakpoints.down("sm"));
  const tabs = useRef<(HTMLElement | null)[]>([]);
  const ready = !isLoading && balance ? balance : null;

  const labels: Record<QuotaKey, string> = {
    credits: t("credits"),
    ai: t("usage_ai_credits"),
    // Not the shared `storage`, which reads as the limit in German.
    storage: t("usage_tile_storage"),
    projects: t("projects"),
    editors: t("editors"),
  };

  const tiles = (data: CreditBalance): Tile[] => {
    const amounts = amountsOf(data);
    const count = (n: number) => new Intl.NumberFormat(language).format(n);
    const fixed = data.on_trial ? t("usage_trial_limit") : t("usage_fixed_by_plan");
    const resetDay = formatCreditsDay(data.credits_reset_at, language);
    const pool = data.on_trial ? t("usage_whole_trial") : resetDay && `${t("resets_on")} ${resetDay}`;
    const viewers =
      data.total_viewers === null
        ? fixed
        : t(
            data.total_editors !== null && data.used_editors >= data.total_editors
              ? "usage_all_in_use"
              : "usage_viewers_of",
            { used: count(data.used_viewers), total: count(data.total_viewers) }
          );
    const format: Record<QuotaKey, (n: number) => string> = {
      credits: (n) => formatCredits(n, language),
      ai: (n) => formatCredits(n, language),
      storage: (n) => formatMegabytes(n, language),
      projects: count,
      editors: count,
    };
    const noteOf = (key: QuotaKey, used: number, limit: number): string | null => {
      if (key === "credits" || key === "ai") return pool;
      if (key === "editors") return viewers;
      return used > limit ? t("usage_over_by", { amount: format[key](used - limit) }) : fixed;
    };
    return QUOTA_KEYS.map((key) => {
      const [used, limit] = amounts[key];
      return {
        key,
        label: labels[key],
        beta: key === "ai",
        used: format[key](used),
        limit: limit === null ? null : format[key](limit),
        level: levelOf(used, limit),
        // A pool of nothing is full once anything uses it, and empty until then.
        percent: limit === null ? 0 : limit > 0 ? Math.min(used / limit, 1) * 100 : used > 0 ? 100 : 0,
        note: limit === null ? t("usage_no_limit") : noteOf(key, used, limit),
      };
    });
  };

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const last = QUOTA_KEYS.length - 1;
    const next =
      event.key === "ArrowRight"
        ? index === last
          ? 0
          : index + 1
        : event.key === "ArrowLeft"
          ? index === 0
            ? last
            : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    tabs.current[next]?.focus();
    onChange(QUOTA_KEYS[next]);
  };

  const content = ready ? tiles(ready) : null;

  return (
    <Box
      role="tablist"
      aria-label={t("usage_quotas")}
      sx={{
        display: "grid",
        gridTemplateColumns: { xs: "repeat(2, minmax(0, 1fr))", sm: "repeat(5, minmax(0, 1fr))" },
        gap: 3,
      }}>
      {QUOTA_KEYS.map((key, index) => {
        const open = key === value;
        const tile = content?.[index];
        const colors = tile && levelColors(theme, tile.level);
        return (
          <SurfaceCard
            key={key}
            ref={(node: HTMLElement | null) => {
              tabs.current[index] = node;
            }}
            component="button"
            // A plain button, never one that submits a form around it; the
            // spread passes it on, as SurfaceCard's props are a div's.
            {...{ type: "button" }}
            role="tab"
            id={quotaTabId(panelId, key)}
            aria-selected={open}
            aria-controls={panelId}
            tabIndex={open ? 0 : -1}
            selected={open}
            onClick={() => onChange(key)}
            onKeyDown={(event: KeyboardEvent) => onKeyDown(event, index)}
            sx={{
              display: "flex",
              flexDirection: "column",
              alignItems: "stretch",
              gap: "6px",
              minWidth: 0,
              m: 0,
              p: "14px 16px 16px",
              textAlign: "left",
              font: "inherit",
              color: "text.primary",
              cursor: "pointer",
              ...focusRing(theme),
            }}>
            <Box
              component="span"
              sx={{
                display: "flex",
                flexWrap: isPhone ? "wrap" : "nowrap",
                alignItems: "center",
                gap: "6px",
                fontSize: 13,
                fontWeight: 700,
                color: open ? accentText(theme) : "text.secondary",
              }}>
              <Box component="span" sx={{ ...ellipsis, minWidth: 0 }}>
                {labels[key]}
              </Box>
              {key === "ai" && (
                <Box
                  component="span"
                  sx={{
                    flexShrink: 0,
                    px: "6px",
                    border: `1px solid ${theme.palette.primary.main}`,
                    borderRadius: "999px",
                    fontSize: 10,
                    fontWeight: 800,
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                    color: accentText(theme),
                  }}>
                  {t("beta")}
                </Box>
              )}
              {tile && tile.level !== "ok" && (
                <>
                  <Box
                    component="span"
                    aria-hidden
                    sx={{
                      flexShrink: 0,
                      width: 8,
                      height: 8,
                      ml: "auto",
                      borderRadius: "50%",
                      backgroundColor: tile.level === "over" ? "error.main" : "warning.main",
                    }}
                  />
                  <Box component="span" sx={visuallyHidden}>
                    {t("usage_needs_attention")}
                  </Box>
                </>
              )}
            </Box>
            {tile && colors ? (
              <>
                <Box component="span" sx={{ ...ellipsis, fontSize: 13, color: "text.secondary" }}>
                  <Box
                    component="strong"
                    sx={{
                      fontSize: isPhone ? 18 : 22,
                      fontWeight: 800,
                      color: colors.text,
                      fontVariantNumeric: "tabular-nums",
                    }}>
                    {tile.used}
                  </Box>{" "}
                  {tile.limit === null ? t("usage_used") : `/ ${tile.limit}`}
                </Box>
                {tile.limit === null ? (
                  // The bar's place, so the notes of all tiles stay on one line.
                  <Box component="span" aria-hidden sx={{ display: "block", height: 4 }} />
                ) : (
                  <LinearProgress
                    variant="determinate"
                    value={tile.percent}
                    aria-hidden
                    sx={{
                      height: 4,
                      borderRadius: "2px",
                      backgroundColor: "action.selected",
                      "& .MuiLinearProgress-bar": { borderRadius: "2px", backgroundColor: colors.bar },
                    }}
                  />
                )}
                {tile.note && (
                  // A long note (German, a narrow tile) wraps to a second line
                  // rather than losing its end, and stops there.
                  <Box
                    component="span"
                    sx={{
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                      fontSize: 12,
                      lineHeight: 1.4,
                      color: colors.note ?? "text.secondary",
                    }}>
                    {tile.note}
                  </Box>
                )}
              </>
            ) : (
              <>
                <Skeleton variant="rounded" height={24} width="70%" sx={{ borderRadius: "6px" }} />
                <Skeleton variant="rounded" height={4} sx={{ borderRadius: "2px" }} />
                <Skeleton variant="rounded" height={12} width="50%" sx={{ borderRadius: "6px" }} />
              </>
            )}
          </SurfaceCard>
        );
      })}
    </Box>
  );
};
