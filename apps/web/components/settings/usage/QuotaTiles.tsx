"use client";

import { Box, useMediaQuery, useTheme } from "@mui/material";
import { type KeyboardEvent, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { CreditBalance } from "@/lib/api/usage";
import { formatCredits, formatCreditsDay, formatMegabytes } from "@/lib/utils/credits";

import { accentText } from "@/components/assistant/styles";
import { QuotaTile } from "@/components/settings/usage/QuotaTile";
import {
  QUOTA_KEYS,
  type QuotaKey,
  type QuotaLevel,
  amountsOf,
  levelColors,
  levelOf,
} from "@/components/settings/usage/quotaLevels";

// The old import paths keep working.
export { QUOTA_KEYS, type QuotaKey } from "@/components/settings/usage/quotaLevels";

/** The id of a quota's tile, for the panel it controls to be labelled by. */
export const quotaTabId = (panelId: string, key: QuotaKey): string => `${panelId}-${key}`;

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
          <QuotaTile
            key={key}
            ref={(node: HTMLDivElement | null) => {
              tabs.current[index] = node;
            }}
            role="tab"
            id={quotaTabId(panelId, key)}
            aria-selected={open}
            aria-controls={panelId}
            tabIndex={open ? 0 : -1}
            selected={open}
            onClick={() => onChange(key)}
            onKeyDown={(event: KeyboardEvent) => onKeyDown(event, index)}
            label={labels[key]}
            compact={isPhone}
            badge={
              key === "ai" ? (
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
              ) : undefined
            }
            attention={tile && tile.level !== "ok" ? tile.level : null}
            attentionText={t("usage_needs_attention")}
            figure={
              tile && colors
                ? { used: tile.used, limit: tile.limit, usedWord: t("usage_used"), color: colors.text }
                : undefined
            }
            bar={tile && colors && tile.limit !== null ? { percent: tile.percent, color: colors.bar } : null}
            note={tile?.note && colors ? { text: tile.note, color: colors.note } : null}
          />
        );
      })}
    </Box>
  );
};
