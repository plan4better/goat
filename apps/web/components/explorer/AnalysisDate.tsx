/**
 * The Explorer's one date (02-panel-behaviour-spec › Viewers), set in the
 * bottom bar: a pill with the day, in black and bold as the clock beside it,
 * a step to the day before and after, and on a click the platform's calendar
 * straight away (the pill already shows the date: no field to click again),
 * bounded to the feed's service window. The panels show it, as a pill on
 * each section its figures depend on.
 */
import { Box, ButtonBase, IconButton, Popover, Stack, Tooltip, Typography } from "@mui/material";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";
import TemporalCalendar from "@p4b/ui/components/TemporalCalendar";

import { useDayjsLocale } from "@/i18n/utils";

import { shortDate } from "@/lib/explorer/format";
import { setExplorerDate } from "@/lib/store/explorer/slice";

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { useExplorer } from "@/components/explorer/ExplorerContext";

/** `YYYY-MM-DD` moved by `days`. */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Digits all one width, so the 1st and the 28th take the same room. */
const DIGITS = { fontVariantNumeric: "tabular-nums" } as const;

/** Every weekday with every month, as dates read in `locale`: the date's
 * width can be no more than the widest of these. Days 22–28 of each month of
 * a year: each weekday once, all two-digit. */
function widthSamples(locale: string): string[] {
  const out = new Set<string>();
  for (let m = 1; m <= 12; m++)
    for (let d = 22; d <= 28; d++) out.add(shortDate(`2026-${String(m).padStart(2, "0")}-${d}`, locale));
  return [...out];
}

/** `compact`: without the day before and after, for a squeezed bar; the
 * picker still sets any day. */
export function AnalysisDate({ compact = false }: { compact?: boolean }) {
  const { t, i18n } = useTranslation("common");
  const dispatch = useAppDispatch();
  const locale = useDayjsLocale();
  const date = useAppSelector((s) => s.explorer.date);
  const { window, dataPeriod } = useExplorer();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const widest = useMemo(() => widthSamples(i18n.language), [i18n.language]);
  if (!date || !window) return null;
  const step = (days: number) => {
    const next = addDays(date, days);
    if (next >= window[0] && next <= window[1]) dispatch(setExplorerDate(next));
  };
  const stepSx = { width: 24, height: 24, color: "text.secondary" } as const;
  // A day outside the data period is still shown, said to be outside it.
  const outside = !!dataPeriod && (date < dataPeriod[0] || date > dataPeriod[1]);
  return (
    <Stack
      direction="row"
      alignItems="center"
      // As much room inside the pill's ends as the speed pill beside it.
      sx={{ height: 32, px: 0.5, borderRadius: "16px", bgcolor: "action.hover", flexShrink: 0 }}>
      {!compact && (
        <IconButton
          size="small"
          aria-label={t("explorer_day_before")}
          disabled={date <= window[0]}
          onClick={() => step(-1)}
          sx={stepSx}>
          <Icon iconName={ICON_NAME.CHEVRON_LEFT} style={{ fontSize: 10 }} />
        </IconButton>
      )}
      <Tooltip title={outside ? t("explorer_date_outside_period") : ""}>
        <ButtonBase
          onClick={(e) => setAnchor(e.currentTarget)}
          aria-label={t("explorer_pick_date")}
          sx={{
            gap: 0.75,
            px: 1,
            height: 28,
            borderRadius: "14px",
            color: "text.secondary",
            "&:hover": { bgcolor: "action.selected" },
          }}>
          <Icon iconName={ICON_NAME.CALENDAR} style={{ fontSize: 12 }} htmlColor="inherit" />
          {/* As wide as the widest date it can show, so stepping a day does not
            shift the bar: every weekday-and-month pair laid out unseen in the
            same cell, the date shown over them. */}
          <Box sx={{ display: "grid", justifyItems: "center", "& > *": { gridArea: "1 / 1" } }}>
            {widest.map((d) => (
              <Typography
                key={d}
                aria-hidden
                variant="body2"
                fontWeight={700}
                noWrap
                sx={{ visibility: "hidden", ...DIGITS }}>
                {d}
              </Typography>
            ))}
            <Typography
              variant="body2"
              fontWeight={700}
              color={outside ? "text.disabled" : "text.primary"}
              noWrap
              sx={DIGITS}>
              {shortDate(date, i18n.language)}
            </Typography>
          </Box>
        </ButtonBase>
      </Tooltip>
      {!compact && (
        <IconButton
          size="small"
          aria-label={t("explorer_day_after")}
          disabled={date >= window[1]}
          onClick={() => step(1)}
          sx={stepSx}>
          <Icon iconName={ICON_NAME.CHEVRON_RIGHT} style={{ fontSize: 10 }} />
        </IconButton>
      )}
      <Popover
        open={!!anchor}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "top", horizontal: "center" }}
        transformOrigin={{ vertical: "bottom", horizontal: "center" }}
        slotProps={{ paper: { sx: { mt: -1, borderRadius: 2 } } }}>
        <TemporalCalendar
          locale={locale}
          value={date}
          onChange={(value) => {
            dispatch(setExplorerDate(value));
            setAnchor(null);
          }}
          min={window[0]}
          max={window[1]}
          highlight={dataPeriod ?? undefined}
        />
      </Popover>
    </Stack>
  );
}
