"use client";

import { Box, useMediaQuery, useTheme } from "@mui/material";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { type Pool, type Seats, seatLevel } from "@/components/settings/members/seats";
import { QuotaTile } from "@/components/settings/usage/QuotaTile";
import { levelColors } from "@/components/settings/usage/quotaLevels";

export type SeatFilter = "editors" | "viewers" | "invitations";

/** The long note from `lg`, the short one below: from `md` the settings nav
 * takes 312px beside the tiles, so they are narrow until `lg`. */
const sized = (long: string, short: string): ReactNode => (
  <>
    <Box component="span" sx={{ display: { xs: "none", lg: "inline" } }}>
      {long}
    </Box>
    <Box component="span" sx={{ display: { xs: "inline", lg: "none" } }}>
      {short}
    </Box>
  </>
);

/** Mitglieder's three tiles: Bearbeiter and Betrachter seats and the open
 * invitations. Each toggles its filter of the list (`aria-pressed`). */
export default function SeatTiles({
  seats,
  pendingInvitations,
  value,
  onChange,
}: {
  seats?: Seats;
  pendingInvitations?: number;
  value: SeatFilter | null;
  onChange: (next: SeatFilter | null) => void;
}) {
  const { t, i18n } = useTranslation("common");
  const theme = useTheme();
  // Narrow tiles until `lg` (a phone, or beside the settings nav): a label
  // may wrap and the figure is smaller, as Usage's phone tiles.
  const compact = useMediaQuery(theme.breakpoints.down("lg"));
  const count = (n: number) => new Intl.NumberFormat(i18n.language).format(n);
  const toggle = (key: SeatFilter) => onChange(value === key ? null : key);

  const poolTile = (
    key: "editors" | "viewers",
    label: string,
    pool: Pool | undefined,
    notes: { free: (free: string) => ReactNode; full: ReactNode }
  ) => {
    const level = pool ? seatLevel(pool) : "ok";
    const colors = levelColors(theme, level);
    const note = !pool
      ? null
      : pool.free === null
        ? t("settings_members_no_limit")
        : pool.free > 0
          ? notes.free(count(pool.free))
          : notes.full;
    return (
      <QuotaTile
        key={key}
        label={label}
        aria-pressed={value === key}
        selected={value === key}
        compact={compact}
        onClick={() => toggle(key)}
        attention={level === "ok" ? null : level}
        attentionText={t("usage_needs_attention")}
        figure={
          pool
            ? {
                used: count(pool.used),
                limit: pool.total === null ? null : count(pool.total),
                usedWord: "",
                color: colors.text,
              }
            : undefined
        }
        bar={
          pool && pool.total !== null
            ? {
                // A pool of no seats is full once anyone is on it, and empty until then.
                percent: pool.total > 0 ? Math.min(pool.used / pool.total, 1) * 100 : pool.used > 0 ? 100 : 0,
                color: colors.bar,
              }
            : null
        }
        note={note === null ? null : { text: note, color: colors.note }}
      />
    );
  };

  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: { xs: "repeat(2, minmax(0, 1fr))", md: "repeat(3, minmax(0, 1fr))" },
        gap: 3,
      }}>
      {poolTile("editors", t("settings_members_tile_editors"), seats?.editors, {
        free: (free) =>
          sized(t("settings_members_editors_free", { free }), t("settings_members_free_short", { free })),
        full: sized(t("settings_members_editors_full"), t("settings_members_full_short")),
      })}
      {poolTile("viewers", t("settings_members_tile_viewers"), seats?.viewers, {
        free: (free) => t("settings_members_free_short", { free }),
        full: t("settings_members_full_short"),
      })}
      <QuotaTile
        label={t("settings_members_tile_invitations")}
        aria-pressed={value === "invitations"}
        selected={value === "invitations"}
        compact={compact}
        onClick={() => toggle("invitations")}
        attentionText={t("usage_needs_attention")}
        figure={
          pendingInvitations === undefined
            ? undefined
            : {
                used: count(pendingInvitations),
                limit: null,
                usedWord: "",
                color: theme.palette.text.primary,
              }
        }
        bar={null}
        note={
          pendingInvitations === undefined
            ? null
            : {
                text: t(
                  pendingInvitations > 0
                    ? "settings_members_invitations_hold"
                    : "settings_members_invitations_none"
                ),
              }
        }
        sx={{ gridColumn: { xs: "1 / -1", md: "auto" } }}
      />
    </Box>
  );
}
