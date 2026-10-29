/**
 * A line's or a trip's Schedule tab (board 11), in three parts: the period it
 * runs in; its service patterns — the sets of days with the same timetable,
 * each named by its weekdays, with the dates that differ from them grouped by
 * what happens instead; and month by month which pattern runs. Days that
 * differ from the usual week are dotted; the Explorer's date is outlined, and
 * a day clicked becomes it.
 */
import { Box, ButtonBase, Divider, Link, Stack, Typography } from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import type { TripRange } from "@/lib/explorer/derive/runs";
import { type DayType, dateRuns, exceptionMarks, isoWeekday } from "@/lib/explorer/derive/serviceCalendar";
import { dateLocale, dateSpan, dayMonth, shortDate, weekdayList, weekdayName } from "@/lib/explorer/format";
import { patternColors } from "@/lib/explorer/patternColors";
import { setExplorerDate } from "@/lib/store/explorer/slice";

import { useRouteCalendar } from "@/hooks/explorer/useExplorerData";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { useExplorer } from "@/components/explorer/ExplorerContext";
import { SectionHeader } from "@/components/explorer/SectionHeader";

/** The exception marks, in pastels beside the patterns' colours: service
 * added in green, removed in red; the glyph a shade deeper, to be read. */
const MARK = {
  "+": { edge: "#A5D6A7", color: "#66BB6A", label: "explorer_cal_added_on" },
  "-": { edge: "#EF9A9A", color: "#E57373", label: "explorer_cal_removed_on" },
} as const;

/** A mark's + or −, drawn rather than typed, so it sits in the middle of
 * its box whatever the font. */
function MarkGlyph({ mark, size = 8 }: { mark: "+" | "-"; size?: number }) {
  const h = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden style={{ display: "block" }}>
      <line x1={0} y1={h} x2={size} y2={h} stroke={MARK[mark].color} strokeWidth={1.75} />
      {mark === "+" && <line x1={h} y1={0} x2={h} y2={size} stroke={MARK[mark].color} strokeWidth={1.75} />}
    </svg>
  );
}

/** Spans of dates listed before "and n more". */
const LISTED = 3;
/** Patterns shown before the rest are folded: those covering the most days.
 * Feeds split a line's timetable at every engineering works, so a line can
 * have dozens, most on a few days. */
const PATTERNS_SHOWN = 5;

/** Whose calendar it is: a line's runs several timetables, a trip's one. */
type Of = "line" | "trip";

/** Dates as spans ("26 Oct – 6 Nov", "Fri 25 Dec"), the first few, the rest
 * behind "and n more". */
function DateList({ dates, weekdays }: { dates: string[]; weekdays: number[] }) {
  const { t, i18n } = useTranslation("common");
  const [open, setOpen] = useState(false);
  const lang = i18n.language;
  const runs = dateRuns(dates, weekdays);
  const shown = open ? runs : runs.slice(0, LISTED);
  const rest = runs.length - shown.length;
  const words = shown
    .map(([a, b]) => (a === b ? shortDate(a, lang) : `${dayMonth(a, lang)} – ${dayMonth(b, lang)}`))
    .join(", ");
  const more = (label: string) => (
    <>
      {" "}
      <Link component="button" variant="caption" underline="hover" onClick={() => setOpen(!open)}>
        {label}
      </Link>
    </>
  );
  return (
    <Typography variant="caption" sx={{ lineHeight: 1.45 }}>
      {words}
      {rest > 0 && more(t("explorer_and_more", { count: rest }))}
      {open && runs.length > LISTED && more(t("show_less"))}
    </Typography>
  );
}

/** A part of a pattern's card, named as the panels name what they show. */
function Overline({ children }: { children: React.ReactNode }) {
  return (
    <Typography
      variant="caption"
      color="text.secondary"
      display="block"
      sx={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", mb: 0.5 }}>
      {children}
    </Typography>
  );
}

/** The week, the pattern's usual weekdays filled in its colour; the dates
 * it departs from them on are marked in the month grid. */
function WeekRow({ weekdays, color }: { weekdays: number[]; color: string }) {
  const { i18n } = useTranslation("common");
  const on = new Set(weekdays);
  return (
    <Box sx={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "3px" }}>
      {[1, 2, 3, 4, 5, 6, 7].map((w) => (
        <Box
          key={w}
          sx={{
            height: 30,
            borderRadius: 0.75,
            display: "grid",
            placeItems: "center",
            fontSize: 11,
            fontWeight: on.has(w) ? 700 : 500,
            color: on.has(w) ? color : "text.disabled",
            bgcolor: on.has(w) ? alpha(color, 0.18) : "action.hover",
          }}>
          {weekdayName(w, i18n.language, "narrow")}
        </Box>
      ))}
    </Box>
  );
}

/** A pattern's swatch, and how far in its name and the facts under it start. */
const SWATCH = 10;
const INDENT = 18;

/** A service pattern: its colour, as its days in the month grid, its name
 * and its usual week. */
function PatternRow({
  type,
  color,
  of,
  period,
}: {
  type: DayType;
  color: string;
  of: Of;
  /** The service period above: what the row need not say again. */
  period: { days: number };
}) {
  const { t, i18n } = useTranslation("common");
  const lang = i18n.language;
  const regular = type.weekdays.length > 0;
  const name = regular
    ? (weekdayList(type.weekdays, lang) ?? t("explorer_daily"))
    : t("explorer_individual_dates");
  // Its days only where the service period above does not already say them.
  const facts = [
    ...(type.days.length !== period.days ? [t("explorer_n_days", { count: type.days.length })] : []),
    ...(of === "line" || type.trips > 1 ? [t("explorer_trips_a_day", { count: type.trips })] : []),
  ];
  return (
    <Box sx={{ py: 1 }}>
      <Stack direction="row" spacing={`${INDENT - SWATCH}px`} alignItems="center">
        <Box sx={{ width: SWATCH, height: SWATCH, borderRadius: 0.5, bgcolor: color, flexShrink: 0 }} />
        <Typography variant="body2" fontWeight={700} noWrap sx={{ minWidth: 0 }}>
          {name}
        </Typography>
      </Stack>
      <Box sx={{ pl: `${INDENT}px` }}>
        {facts.length > 0 && (
          <Typography variant="caption" color="text.secondary" display="block" sx={{ lineHeight: 1.45 }}>
            {facts.join(" · ")}
          </Typography>
        )}
        {!regular && <DateList dates={type.days} weekdays={[]} />}
      </Box>
      {/* The week from the swatch's edge, across the panel. */}
      {regular && (
        <Box sx={{ mt: 0.75 }}>
          <WeekRow weekdays={type.weekdays} color={color} />
        </Box>
      )}
    </Box>
  );
}

function Month({
  year,
  month,
  dayColor,
  marks,
  selected,
  onPick,
}: {
  year: number;
  month: number;
  dayColor: Map<string, string | null>;
  /** Service added ("+") or removed ("-") against the usual week. */
  marks: Map<string, "+" | "-">;
  selected: string | null;
  onPick: (date: string) => void;
}) {
  const { i18n } = useTranslation("common");
  const theme = useTheme();
  const lang = i18n.language;
  const first = new Date(Date.UTC(year, month, 1));
  const length = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const lead = isoWeekday(first.toISOString().slice(0, 10)) - 1;
  const title = new Intl.DateTimeFormat(dateLocale(lang), {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(first);
  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="body2" fontWeight={700} sx={{ mb: 0.75 }}>
        {title}
      </Typography>
      <Box sx={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "3px" }}>
        {[1, 2, 3, 4, 5, 6, 7].map((w) => (
          <Typography
            key={w}
            variant="caption"
            color="text.secondary"
            sx={{ textAlign: "center", fontSize: 10 }}>
            {weekdayName(w, lang, "narrow")}
          </Typography>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <Box key={`lead${i}`} />
        ))}
        {Array.from({ length }, (_, i) => {
          const date = `${year}-${String(month + 1).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`;
          const inWindow = dayColor.has(date);
          const color = dayColor.get(date) ?? null;
          const isSelected = date === selected;
          const mark = marks.get(date);
          return (
            <ButtonBase
              key={date}
              disabled={!inWindow}
              onClick={() => onPick(date)}
              aria-label={date}
              aria-pressed={isSelected}
              sx={{
                position: "relative",
                aspectRatio: "1",
                borderRadius: 1,
                fontSize: 11,
                fontWeight: isSelected ? 700 : 500,
                color: inWindow ? (color ? "text.primary" : "text.secondary") : "text.disabled",
                bgcolor: color ? alpha(color, 0.18) : "transparent",
                // An exception's edge in its mark's colour; the Explorer's
                // date outlined around it, so a day can show both.
                border: "1.5px solid",
                borderColor: mark ? MARK[mark].edge : "transparent",
                outline: isSelected ? `2px solid ${theme.palette.text.primary}` : "none",
                outlineOffset: 1,
                "&:hover": { bgcolor: color ? alpha(color, 0.3) : "action.hover" },
              }}>
              {i + 1}
              {mark && (
                <Box sx={{ position: "absolute", top: 3, right: 3 }}>
                  <MarkGlyph mark={mark} size={6} />
                </Box>
              )}
            </ButtonBase>
          );
        })}
      </Box>
    </Box>
  );
}

/** The calendar of `trips` (a line's range, or one trip's), cached by `id`. */
export function RouteCalendar({ trips, id, of }: { trips: TripRange; id: string; of: Of }) {
  const { t, i18n } = useTranslation("common");
  const dispatch = useAppDispatch();
  const { db, window } = useExplorer();
  const selected = useAppSelector((s) => s.explorer.date);
  const calendar = useRouteCalendar(db, trips, id, window);
  const [allPatterns, setAllPatterns] = useState(false);
  const lang = i18n.language;
  const data = calendar.data;

  const { colors, dayColor, marks, running } = useMemo(() => {
    const colors = patternColors(data?.types ?? []);
    const colorOf = new Map((data?.types ?? []).map((ty, i) => [ty.key, colors[i]]));
    const dayColor = new Map<string, string | null>(
      (data?.days ?? []).map((d) => [d.date, d.key ? (colorOf.get(d.key) ?? null) : null])
    );
    const running = (data?.days ?? []).filter((d) => d.key).map((d) => d.date);
    return { colors, dayColor, marks: exceptionMarks(data?.types ?? []), running };
  }, [data]);

  if (!window || !data) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
        {calendar.error ?? t("explorer_calculating")}
      </Typography>
    );
  }

  const months: [number, number][] = [];
  const [y0, m0] = window[0].split("-").map(Number);
  const [y1, m1] = window[1].split("-").map(Number);
  for (let y = y0, m = m0 - 1; y < y1 || (y === y1 && m <= m1 - 1); m === 11 ? (y++, (m = 0)) : m++)
    months.push([y, m]);
  const first = running[0];
  const last = running[running.length - 1];
  const patterns = data.types.length;
  // Folded: the patterns past the largest few, but not the one of the Explorer's date.
  const folded = new Set(
    data.types
      .filter((ty, i) => i >= PATTERNS_SHOWN && !(selected && ty.days.includes(selected)))
      .map((ty) => ty.key)
  );

  return (
    <Box sx={{ pt: 1, pb: 2 }}>
      <SectionHeader px={0} icon={ICON_NAME.CALENDAR} label={t("explorer_service_period")} />
      {first ? (
        <Box sx={{ mb: 2.5 }}>
          <Typography variant="body2" fontWeight={700}>
            {dateSpan(first, last, lang)}
          </Typography>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ lineHeight: 1.45 }}>
            {t("explorer_days_with_service_count", { count: running.length })}
            {of === "line" && ` · ${t("explorer_service_patterns_count", { count: patterns })}`}
          </Typography>
        </Box>
      ) : (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
          {t("explorer_no_service_window")}
        </Typography>
      )}

      {!!patterns && (
        <>
          <SectionHeader
            px={0}
            icon={ICON_NAME.CLOCK}
            label={t("explorer_service_pattern_heading", { count: patterns })}
          />
          <Stack divider={<Divider flexItem />} sx={{ mb: marks.size > 0 ? 2 : 2.5 }}>
            {data.types.map((ty, i) =>
              !allPatterns && folded.has(ty.key) ? null : (
                <PatternRow
                  key={ty.key}
                  type={ty}
                  color={colors[i]}
                  of={of}
                  period={{ days: running.length }}
                />
              )
            )}
            {folded.size > 0 && (
              <Link
                component="button"
                variant="caption"
                underline="hover"
                sx={{ alignSelf: "flex-start" }}
                onClick={() => setAllPatterns(!allPatterns)}>
                {allPatterns ? t("show_less") : t("explorer_more_patterns", { count: folded.size })}
              </Link>
            )}
          </Stack>
        </>
      )}
      {/* The exceptions, and how the month grid below marks them. */}
      {marks.size > 0 && (
        <Box sx={{ mb: 2.5 }}>
          <Overline>{t("explorer_cal_exceptions")}</Overline>
          <Stack spacing={0.5}>
            {(["-", "+"] as const).map((m) => {
              const days = [...marks.values()].filter((v) => v === m).length;
              if (!days) return null;
              return (
                <Stack key={m} direction="row" spacing={1.5} alignItems="center">
                  <Box
                    sx={{
                      width: 14,
                      height: 14,
                      borderRadius: 0.5,
                      border: `1.5px solid ${MARK[m].edge}`,
                      display: "grid",
                      placeItems: "center",
                      flexShrink: 0,
                    }}>
                    <MarkGlyph mark={m} />
                  </Box>
                  <Typography variant="caption" color="text.secondary">
                    {t(MARK[m].label, { count: days })}
                  </Typography>
                </Stack>
              );
            })}
          </Stack>
        </Box>
      )}

      <SectionHeader px={0} icon={ICON_NAME.TABLE} label={t("explorer_days_with_service")} />
      {months.map(([y, m]) => {
        const key = `${y}-${String(m + 1).padStart(2, "0")}`;
        return (
          <Month
            key={key}
            year={y}
            month={m}
            dayColor={dayColor}
            marks={marks}
            selected={selected}
            onPick={(date) => dispatch(setExplorerDate(date))}
          />
        );
      })}
    </Box>
  );
}
