/**
 * The Explorer's bottom bar (boards 3, 6, 8; 02-panel-behaviour-spec ›
 * Playback): one row that plays the network through its day — play/pause,
 * the speed, the date, the time, a scrubber over the day's service, how many
 * vehicles are out. With the trip strip open, its top edge drags it taller or
 * shorter. Exit Explorer left the bar until editing brings it back as a
 * save-and-exit showing the changes (20 Oct 2026); the tab's × and the
 * bundle's menu leave the Explorer meanwhile.
 */
import PauseIcon from "@mui/icons-material/Pause";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import { Box, ButtonBase, Divider, IconButton, Slider, Stack, Tooltip, Typography } from "@mui/material";
import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { clock, count } from "@/lib/explorer/format";
import {
  PLAYBACK_SPEEDS,
  setPlaybackSpeed,
  setPlaybackTime,
  setPlaying,
  setScrub,
  setStripHeight,
} from "@/lib/store/explorer/slice";

import { type RouteRow, useRoutes } from "@/hooks/explorer/useExplorerData";
import { usePickedTrips } from "@/hooks/explorer/usePickedTrips";
import { usePlayback } from "@/hooks/explorer/usePlayback";
import { usePlaybackValue } from "@/hooks/explorer/usePlaybackValue";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { FloatingPanel } from "@/components/common/FloatingPanel";
import { AnalysisDate } from "@/components/explorer/AnalysisDate";
import { useExplorer } from "@/components/explorer/ExplorerContext";
import { routeName } from "@/components/explorer/RouteBadge";
import { RouteChip, StripControls, TripStrip } from "@/components/explorer/strip/TripStrip";
import { BAR_HEIGHT, STRIP_MIN, clampStripHeight, stripRoom } from "@/components/explorer/strip/stripLayout";

const HOUR = 3600;
/** How near the drawn time must come to where the scrubber was let go for
 * the thumb to follow it again, and how long it waits at most. */
const SETTLED_S = 120;
const SETTLE_MS = 2000;
/** Extra room (px) beside the round buttons at the bar's two ends. */
const END_ROOM = 8;
/** The vehicle count's slot, and its offset at the end: the row's gap
 * before it (6 px) against the bar's own padding after it (10 px), so it is
 * centred between the divider and the bar's edge (measured, 26 Oct 2026). */
const COUNT_W = 112;
const COUNT_END = -4;
/** How far (px) an arrow key moves the strip's top edge. */
const RESIZE_STEP = 24;

/** `compact`: squeezed between the side panels, the bar keeps one row with
 * less of each (02-panel-behaviour-spec › Viewers): one speed button that
 * cycles, the date without its day steps and no vehicle count. */
export const ExplorerBottomBar = memo(BottomBar);

function BottomBar({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const { db, complete } = useExplorer();
  const routes = useRoutes(db);
  const playing = useAppSelector((s) => s.explorer.playing);
  const speed = useAppSelector((s) => s.explorer.speed);
  const memory = usePlayback(complete ? db : undefined, routes.data);
  // A route selected opens the trip strip under the playback row, unless
  // folded away by hand; folded, the row shows the route's chip instead.
  const selectedRouteId = useAppSelector((s) => s.explorer.selectedRouteId);
  const stripCollapsed = useAppSelector((s) => s.explorer.strip.collapsed);
  const route = routes.data?.find((r) => r.route_id === selectedRouteId);
  const stripOpen = !!route && !stripCollapsed;
  // While its edge is dragged the strip follows the pointer here; the height
  // is kept for the session once let go.
  const storedHeight = useAppSelector((s) => s.explorer.strip.height);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  // As far up as the map leaves room: measured by the edge, as the window
  // or the panels around change.
  const [room, setRoom] = useState<number | undefined>(undefined);
  const stripHeight = clampStripHeight(dragHeight ?? storedHeight, room);
  // The row is the same with the strip open or folded away, but for the
  // scrubber: the chart is the scrubber.
  const tight = compact;
  // Not every frame: the span, and the minute the clock and the scrubber
  // show (a scrubber step is a minute). What changes every frame, the
  // vehicle count, renders on its own (VehicleCount).
  const span = usePlaybackValue((f) => f.span);
  const minute = usePlaybackValue((f) => (f.time_s === null ? null : Math.floor(f.time_s / 60) * 60));
  // While the scrubber is dragged only the clock follows it; the map is
  // drawn for the time it is let go at, and playback, if it ran, goes on
  // from there. Let go, the thumb stays where it was left until the map has
  // caught up, rather than flicking back to the time last drawn.
  const [drag, setDrag] = useState<{ t: number; let_go: boolean } | null>(null);
  const resume = useRef(false);
  useEffect(() => {
    if (!drag?.let_go) return;
    if (minute !== null && Math.abs(minute - drag.t) <= SETTLED_S) {
      setDrag(null);
      return;
    }
    // A frame that never comes (a window that failed to read) does not hold the thumb.
    const timer = window.setTimeout(() => setDrag(null), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [drag, minute]);
  // The strip's now-line, dragged, moves the clock as the scrubber does;
  // let go, it is let go of here once the map has caught up, as the thumb
  // is — here, as the bar stays when the strip folds and its chart goes.
  const scrub = useAppSelector((s) => s.explorer.scrub);
  useEffect(() => {
    if (!scrub?.let_go) return;
    if (minute !== null && Math.abs(minute - scrub.t) <= SETTLED_S) {
      dispatch(setScrub(null));
      return;
    }
    const timer = window.setTimeout(() => dispatch(setScrub(null)), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [scrub, minute, dispatch]);
  const time = drag?.t ?? (scrub ? Math.floor(scrub.t / 60) * 60 : minute);
  const ready = complete && span !== null && time !== null;

  const ticks: { value: number }[] = [];
  if (span)
    for (let h = Math.ceil(span.first_s / HOUR / 3) * 3; h * HOUR <= span.last_s; h += 3)
      ticks.push({ value: h * HOUR });

  return (
    // The bar spans the room the layout gives it (DataProjectLayout). One
    // row: how to play · the day and the time in it · what is out · the way
    // out. Fully rounded to follow the round buttons at its ends, with as
    // much room beside them as above and below.
    <FloatingPanel
      minHeight={0}
      sx={{ width: "100%", position: "relative", borderRadius: stripOpen ? "16px" : "28px" }}>
      {stripOpen && (
        <ResizeEdge
          height={stripHeight}
          room={room}
          onRoom={setRoom}
          onDrag={setDragHeight}
          onDone={(h) => {
            dispatch(setStripHeight(h));
            setDragHeight(null);
          }}
        />
      )}
      <Stack
        direction="row"
        alignItems="center"
        spacing={1.5}
        sx={{ px: "10px", height: BAR_HEIGHT, flexShrink: 0 }}>
        {/* Short of memory, playback is off: the rest of the Explorer comes
            first. Play leads the bar, with a little more room after it, as
            the vehicle count has at the other end. */}
        <Tooltip title={memory.ok ? "" : t(`explorer_playback_memory_${memory.reason}`)}>
          <span style={{ marginRight: END_ROOM }}>
            <IconButton
              aria-label={playing ? t("explorer_pause") : t("explorer_play")}
              disabled={!ready || (!memory.ok && !playing)}
              onClick={() => dispatch(setPlaying(!playing))}
              sx={{
                width: 36,
                height: 36,
                flexShrink: 0,
                bgcolor: "primary.main",
                color: "primary.contrastText",
                "&:hover": { bgcolor: "primary.dark" },
                "&.Mui-disabled": { bgcolor: "action.disabledBackground" },
              }}>
              {playing ? <PauseIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
            </IconButton>
          </span>
        </Tooltip>
        {/* Speed: every choice in view, the one in use raised (board 3);
            compact, one button stepping through them. */}
        {tight ? (
          <Tooltip title={t("explorer_speed")}>
            <ButtonBase
              aria-label={t("explorer_speed")}
              onClick={() =>
                dispatch(
                  setPlaybackSpeed(
                    PLAYBACK_SPEEDS[(PLAYBACK_SPEEDS.indexOf(speed) + 1) % PLAYBACK_SPEEDS.length]
                  )
                )
              }
              sx={{
                height: 32,
                minWidth: 48,
                px: 1,
                borderRadius: "16px",
                bgcolor: "action.hover",
                fontSize: 12,
                fontWeight: 700,
                fontVariantNumeric: "tabular-nums",
                flexShrink: 0,
              }}>
              {speed}×
            </ButtonBase>
          </Tooltip>
        ) : (
          <Stack
            direction="row"
            role="radiogroup"
            aria-label={t("explorer_speed")}
            sx={{ p: 0.25, borderRadius: "16px", bgcolor: "action.hover", flexShrink: 0 }}>
            {PLAYBACK_SPEEDS.map((s) => (
              <ButtonBase
                key={s}
                role="radio"
                aria-checked={s === speed}
                onClick={() => dispatch(setPlaybackSpeed(s))}
                sx={{
                  height: 28,
                  minWidth: 44,
                  px: 1,
                  borderRadius: "14px",
                  fontSize: 12,
                  fontWeight: 700,
                  fontVariantNumeric: "tabular-nums",
                  color: "text.secondary",
                  bgcolor: s === speed ? "background.paper" : "transparent",
                  boxShadow: s === speed ? "0 1px 2px rgba(0, 0, 0, 0.12)" : "none",
                }}>
                {s}×
              </ButtonBase>
            ))}
          </Stack>
        )}
        <Divider orientation="vertical" flexItem sx={{ my: 1.5 }} />
        <AnalysisDate compact={tight} />
        {/* The time the scrubber beside it stands at; past midnight the clock
            counts on, as a timetable does (24:48). */}
        <Typography
          fontWeight={700}
          sx={{ fontSize: 18, fontVariantNumeric: "tabular-nums", width: 52, flexShrink: 0 }}>
          {time !== null ? clock(time) : "--:--"}
        </Typography>
        {stripOpen ? (
          <Box sx={{ flex: 1, minWidth: 0 }} />
        ) : (
          <Slider
            size="small"
            aria-label={t("explorer_playback_time")}
            disabled={!ready}
            min={span?.first_s ?? 0}
            max={span?.last_s ?? 1}
            step={60}
            marks={ticks}
            value={time ?? 0}
            // The clock beside the play button reads the dragged time.
            valueLabelDisplay="off"
            // Playback holds while the scrubber is dragged, and resumes from
            // where it is let go.
            onChange={(_e, v) => {
              if (!drag || drag.let_go) {
                resume.current = playing;
                if (playing) dispatch(setPlaying(false));
              }
              setDrag({ t: v as number, let_go: false });
            }}
            onChangeCommitted={(_e, v) => {
              setDrag({ t: v as number, let_go: true });
              dispatch(setPlaybackTime(v as number));
              if (resume.current && memory.ok) dispatch(setPlaying(true));
              resume.current = false;
            }}
            sx={{
              flex: 1,
              minWidth: compact ? 48 : 120,
              mx: 1,
              "& .MuiSlider-rail": { opacity: 1, bgcolor: "action.selected" },
              "& .MuiSlider-mark": { width: 2, height: 2, borderRadius: "50%", bgcolor: "text.disabled" },
              "& .MuiSlider-thumb": { width: 14, height: 14 },
              // Dragged, the thumb is under the pointer: no easing behind it.
              ...(drag && { "& .MuiSlider-thumb, & .MuiSlider-track": { transition: "none" } }),
            }}
          />
        )}
        {stripOpen && route && <StripControls route={route} compact={compact} />}
        {!stripOpen && route && <RouteChip route={route} />}
        {!tight && <Divider orientation="vertical" flexItem sx={{ my: 1.5 }} />}
        {!tight && <VehicleCount ready={ready} route={route} />}
      </Stack>
      {stripOpen && route && <TripStrip route={route} height={stripHeight} />}
    </FloatingPanel>
  );
}

/** The strip's top edge: dragged, or moved with the arrow keys, it sets
 * how tall the strip is. A short grip shows where to take it. */
function ResizeEdge({
  height,
  room,
  onRoom,
  onDrag,
  onDone,
}: {
  height: number;
  /** How tall the panel can grow, as last measured. */
  room: number | undefined;
  onRoom: (room: number) => void;
  onDrag: (height: number) => void;
  onDone: (height: number) => void;
}) {
  const { t } = useTranslation("common");
  const ref = useRef<HTMLDivElement | null>(null);
  const start = useRef<{ y: number; height: number } | null>(null);
  // The room above, measured from the panel's own bottom edge: on showing,
  // as the window resizes, and as a drag starts.
  const measure = () => {
    const panel = ref.current?.parentElement;
    if (panel) onRoom(stripRoom(panel));
  };
  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const to = (e: React.PointerEvent) =>
    start.current ? clampStripHeight(start.current.height + start.current.y - e.clientY, room) : height;
  return (
    <Box
      ref={ref}
      role="separator"
      aria-orientation="horizontal"
      aria-label={t("explorer_strip_resize")}
      aria-valuenow={height}
      aria-valuemin={STRIP_MIN}
      aria-valuemax={room}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        measure();
        start.current = { y: e.clientY, height };
      }}
      onPointerMove={(e) => start.current && onDrag(to(e))}
      onPointerUp={(e) => {
        if (!start.current) return;
        onDone(to(e));
        start.current = null;
      }}
      onPointerCancel={() => {
        if (start.current) onDone(start.current.height);
        start.current = null;
      }}
      onKeyDown={(e) => {
        const by = e.key === "ArrowUp" ? RESIZE_STEP : e.key === "ArrowDown" ? -RESIZE_STEP : 0;
        if (!by) return;
        e.preventDefault();
        onDone(clampStripHeight(height + by, room));
      }}
      sx={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: 10,
        zIndex: 1,
        display: "flex",
        justifyContent: "center",
        pt: "4px",
        cursor: "ns-resize",
        touchAction: "none",
        outline: "none",
        "& > span": { width: 36, height: 4, borderRadius: 2, bgcolor: "divider" },
        "&:hover > span, &:focus-visible > span": { bgcolor: "text.secondary" },
      }}>
      <span />
    </Box>
  );
}

/** Vehicles out at the time: the figure bold, its unit quiet, as the left
 * panel's figures are; the figure's width fixed so it does not jostle the bar
 * as it plays. Apart from the bar, as it changes with every frame. */
function VehicleCount({ ready, route }: { ready: boolean; route: RouteRow | undefined }) {
  const { t, i18n } = useTranslation("common");
  // With a line selected, its vehicles the map shows in full: those of the
  // direction or variant shown. Else the whole network's.
  const picked = usePickedTrips();
  const routeIdx = route?.route_idx ?? null;
  const n = usePlaybackValue((f) => {
    const v = f.vehicles;
    if (routeIdx === null) return v.n;
    let k = 0;
    for (let i = 0; i < v.n; i++)
      if (v.route_idx[i] === routeIdx && (!picked || picked.has(v.trip_idx[i]))) k++;
    return k;
  });
  return (
    <Tooltip
      title={
        route
          ? t("explorer_vehicles_scope_line", {
              line: routeName(route, t),
              interpolation: { escapeValue: false },
            })
          : t("explorer_vehicles_scope_network")
      }>
      {/* Centred between the divider and the bar's end, in a slot of its
          own width: its digits are all one width (tabular), so it moves only
          when the count gains a digit. */}
      <Stack
        direction="row"
        alignItems="baseline"
        justifyContent="center"
        spacing={1}
        // Inline, as the play button's: the row's spacing resets margins set in sx.
        style={{ marginRight: COUNT_END }}
        sx={{ flexShrink: 0, width: COUNT_W, visibility: ready ? "visible" : "hidden" }}>
        <Typography variant="body2" fontWeight={700} sx={{ fontVariantNumeric: "tabular-nums" }}>
          {count(n, i18n.language)}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {t("explorer_vehicles_out", { count: n })}
        </Typography>
      </Stack>
    </Tooltip>
  );
}
