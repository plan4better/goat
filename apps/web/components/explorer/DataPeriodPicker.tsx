/**
 * The data period, set on the feed's timeline: the trips running each day
 * from the feed's first day to its last, drawn as a graph, and two handles,
 * vertical bars across it, for the period's first and last day. Two presets:
 * the optimum period (optimumPeriod: the stretch the timetable fully covers)
 * and the entire feed.
 */
import { Box, ButtonBase, FormHelperText, Stack, Typography } from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import { type KeyboardEvent, type PointerEvent, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { DailyTrips } from "@/lib/explorer/derive/calendar";
import { shortDateYear } from "@/lib/explorer/format";

/** The graph's height, and its width in its own units (it stretches). */
const H = 120;
/** The busiest day's height, as a share of the graph's: room above it. */
const PEAK = 0.85;
const W = 1000;
/** The handles' grip, and the room kept at each side for it. */
const GRIP_W = 12;
const GRIP_H = 28;
const INSET = GRIP_W / 2;
/** At most this many month labels under the graph. */
const MAX_TICKS = 8;

type Range = [string, string];

const same = (a: Range, b: Range) => a[0] === b[0] && a[1] === b[1];

function Preset({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    // Both one size, in the text's weight; the one in force edged and
    // tinted in the theme's colour.
    <ButtonBase
      onClick={onClick}
      aria-pressed={active}
      sx={{
        height: 24,
        px: 1.75,
        borderRadius: "12px",
        border: 1,
        borderColor: active ? "primary.main" : "divider",
        bgcolor: active ? (t) => alpha(t.palette.primary.main, 0.08) : "transparent",
        color: active ? "primary.main" : "text.secondary",
        "&:hover": { borderColor: "primary.main" },
      }}>
      <Typography variant="caption" color="inherit" sx={{ lineHeight: 1 }}>
        {label}
      </Typography>
    </ButtonBase>
  );
}

/** One of the period's ends: a bar down the graph, a grip to drag it by. */
function Handle({
  at,
  n,
  label,
  valueText,
  onMove,
  onKey,
}: {
  at: number;
  n: number;
  label: string;
  valueText: string;
  onMove: (clientX: number) => void;
  onKey: (e: KeyboardEvent) => void;
}) {
  const x = n > 1 ? (at / (n - 1)) * 100 : 50;
  const drag = (e: PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1) return;
    onMove(e.clientX);
  };
  return (
    <Box
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={n - 1}
      aria-valuenow={at}
      aria-valuetext={valueText}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        onMove(e.clientX);
      }}
      onPointerMove={drag}
      onKeyDown={onKey}
      sx={{
        position: "absolute",
        top: 0,
        bottom: 0,
        left: `${x}%`,
        width: GRIP_W + 8,
        ml: `${-(GRIP_W + 8) / 2}px`,
        cursor: "ew-resize",
        touchAction: "none",
        outline: "none",
        // The bar, then the grip in its middle.
        "&::before": {
          content: '""',
          position: "absolute",
          top: 0,
          bottom: 0,
          left: "50%",
          width: 2,
          ml: "-1px",
          bgcolor: "primary.main",
        },
        "& > span": {
          position: "absolute",
          top: "50%",
          left: "50%",
          width: GRIP_W,
          height: GRIP_H,
          mt: `${-GRIP_H / 2}px`,
          ml: `${-GRIP_W / 2}px`,
          borderRadius: "6px",
          border: 2,
          borderColor: "primary.main",
          bgcolor: "background.paper",
          boxShadow: 1,
        },
        "&:focus-visible > span, &:hover > span": {
          boxShadow: (t) => `0 0 0 4px ${t.palette.primary.main}33`,
        },
      }}>
      <span />
    </Box>
  );
}

export function DataPeriodPicker({
  days,
  value,
  optimum,
  onChange,
}: {
  days: DailyTrips[];
  /** The data period now: the user's, or the optimum. */
  value: Range;
  optimum: Range;
  /** A new period, or null for the optimum (which follows the feed). */
  onChange: (period: Range | null) => void;
}) {
  const { t, i18n } = useTranslation("common");
  const theme = useTheme();
  const lang = i18n.language;
  const plot = useRef<HTMLDivElement>(null);
  const n = days.length;
  const entire: Range = [days[0].date, days[n - 1].date];
  const index = (date: string) => {
    const i = days.findIndex((d) => d.date >= date);
    return i < 0 ? n - 1 : i;
  };
  const at: [number, number] = [index(value[0]), Math.max(index(value[0]), index(value[1]))];

  // The trips each day as an area, its peak at the top.
  const peak = useMemo(() => Math.max(1, ...days.map((d) => d.trips)), [days]);
  const area = useMemo(() => {
    const x = (i: number) => (n > 1 ? (i / (n - 1)) * W : W / 2);
    const pts = days.map((d, i) => `${x(i).toFixed(1)},${(H - (d.trips / peak) * H * PEAK).toFixed(1)}`);
    return `M0,${H} L${pts.join(" L")} L${W},${H} Z`;
  }, [days, n, peak]);

  // Month marks under the graph: a month's first day, thinned to fit.
  const ticks = useMemo(() => {
    // The feed's own first month too, where it starts after the 1st.
    const firsts = days.flatMap((d, i) => (d.date.endsWith("-01") || i === 0 ? [i] : []));
    const every = Math.ceil(firsts.length / MAX_TICKS) || 1;
    const month = new Intl.DateTimeFormat(lang, { month: "short", timeZone: "UTC" });
    return firsts
      .filter((_, k) => k % every === 0)
      .map((i) => {
        const d = new Date(`${days[i].date}T00:00:00Z`);
        const label = d.getUTCMonth() === 0 ? String(d.getUTCFullYear()) : month.format(d);
        return { i, label };
      });
  }, [days, lang]);

  const set = (range: Range) => onChange(same(range, optimum) ? null : range);
  const moveTo = (end: 0 | 1, i: number) => {
    const next: [number, number] = [...at];
    next[end] = end === 0 ? Math.min(Math.max(0, i), at[1]) : Math.max(Math.min(n - 1, i), at[0]);
    set([days[next[0]].date, days[next[1]].date]);
  };
  const fromPointer = (end: 0 | 1) => (clientX: number) => {
    const box = plot.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return;
    moveTo(end, Math.round(((clientX - box.left) / box.width) * (n - 1)));
  };
  // A day with the arrows, a week with Shift, the feed's ends with Home/End.
  const fromKey = (end: 0 | 1) => (e: KeyboardEvent) => {
    const step = e.shiftKey ? 7 : 1;
    const moves: Record<string, number> = {
      ArrowLeft: -step,
      ArrowDown: -step,
      ArrowRight: step,
      ArrowUp: step,
      Home: -n,
      End: n,
    };
    if (!(e.key in moves)) return;
    e.preventDefault();
    moveTo(end, at[end] + moves[e.key]);
  };

  const left = n > 1 ? (at[0] / (n - 1)) * W : 0;
  const right = n > 1 ? (at[1] / (n - 1)) * W : W;

  return (
    <Stack spacing={2}>
      {/* The period in force, first: what the graph below sets. */}
      <Box>
        <Typography variant="body2" fontWeight={600}>
          {shortDateYear(value[0], lang)} - {shortDateYear(value[1], lang)}
        </Typography>
      </Box>
      <Box
        sx={{
          border: 1,
          borderColor: "divider",
          borderRadius: 1.5,
          px: `${INSET + 8}px`,
          pt: "10px",
          pb: 1,
        }}>
        {/* The graph's title at its top left, in the dialog's label style
              (currency, operator); the presets at its top right. */}
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
          <FormHelperText sx={{ m: 0, color: "text.secondary" }}>
            {t("explorer_data_period_trips_axis")}
          </FormHelperText>
          <Stack direction="row" spacing="6px">
            <Preset
              label={t("explorer_data_period_optimum")}
              active={same(value, optimum)}
              onClick={() => onChange(null)}
            />
            <Preset
              label={t("explorer_data_period_entire")}
              active={same(value, entire)}
              onClick={() => set(entire)}
            />
          </Stack>
        </Stack>
        <Stack direction="row">
          {/* Its height follows its width (a wide dialog, a phone), kept
                between a readable least and a most. */}
          <Box
            ref={plot}
            sx={{
              position: "relative",
              flex: 1,
              minWidth: 0,
              aspectRatio: "4.5 / 1",
              minHeight: 88,
              maxHeight: 180,
            }}>
            <svg
              width="100%"
              height="100%"
              viewBox={`0 0 ${W} ${H}`}
              preserveAspectRatio="none"
              aria-hidden
              style={{ display: "block", position: "absolute", inset: 0 }}>
              <defs>
                <clipPath id="data-period-clip">
                  <rect x={left} y={0} width={Math.max(0, right - left)} height={H} />
                </clipPath>
              </defs>
              {/* The whole feed faint, the data period in GOAT's green. */}
              <path d={area} fill={theme.palette.text.disabled} opacity={0.3} />
              <rect
                x={left}
                y={0}
                width={Math.max(0, right - left)}
                height={H}
                fill={theme.palette.primary.main}
                opacity={0.06}
              />
              <path
                d={area}
                fill={theme.palette.primary.main}
                opacity={0.7}
                clipPath="url(#data-period-clip)"
              />
            </svg>
            <Handle
              at={at[0]}
              n={n}
              label={t("explorer_data_period_from")}
              valueText={shortDateYear(value[0], lang)}
              onMove={fromPointer(0)}
              onKey={fromKey(0)}
            />
            <Handle
              at={at[1]}
              n={n}
              label={t("explorer_data_period_to")}
              valueText={shortDateYear(value[1], lang)}
              onMove={fromPointer(1)}
              onKey={fromKey(1)}
            />
          </Box>
        </Stack>
        {/* The x axis: the months on a hairline, then the feed's first and
            last day at its ends. */}
        <Box>
          <Box sx={{ position: "relative", height: 18, borderTop: 1, borderColor: "divider" }}>
            {ticks.map(({ i, label }) => (
              <Typography
                key={i}
                variant="caption"
                color="text.secondary"
                sx={{
                  position: "absolute",
                  left: `${n > 1 ? (i / (n - 1)) * 100 : 0}%`,
                  top: 2,
                  fontSize: 11,
                  lineHeight: 1.2,
                  whiteSpace: "nowrap",
                  pl: "3px",
                  borderLeft: 1,
                  borderColor: "divider",
                }}>
                {label}
              </Typography>
            ))}
          </Box>
          <Stack direction="row" justifyContent="space-between" sx={{ mt: 0.25 }}>
            {[entire[0], entire[1]].map((d) => (
              <Typography key={d} variant="caption" color="text.secondary" sx={{ fontSize: 11 }}>
                {shortDateYear(d, lang)}
              </Typography>
            ))}
          </Stack>
        </Box>
      </Box>
    </Stack>
  );
}
