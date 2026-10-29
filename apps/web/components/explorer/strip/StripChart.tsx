/**
 * The trip strip's chart (boards 6 and 12): the route's trips as lines from
 * origin to destination, time across and the distance along the direction
 * down, over a window of the day. The now-line marks playback.
 *
 * Down the left, the stops where trips start and end: the direction's ends,
 * and its short turns' and other patterns' ends; zoomed in, every stop in
 * view as room allows. With all directions, each runs the length of the
 * strip, the second from bottom to top. Ends are named alone, without
 * "origin" or "destination": the lines' slope says which way they run.
 * Dragged tall enough, the vehicles in service show along the bottom.
 *
 * A click on a line opens its trip; on the chart around the lines it moves
 * playback there, and the now-line drags it. A box dragged on the chart
 * zooms into it, in time and along the route; a box little taller than a
 * line zooms in time alone. Drawn as plain SVG: hundreds of lines, and a
 * now-line that moves with every frame on its own.
 */
import ZoomOutMapIcon from "@mui/icons-material/ZoomOutMap";
import { Button, Tooltip } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { type PointerEvent, memo, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Direction, StopInfo } from "@/lib/explorer/derive/directions";
import type { RouteTrips } from "@/lib/explorer/derive/routeTrips";
import type { Run } from "@/lib/explorer/derive/runs";
import type { ResolvedChoice } from "@/lib/explorer/directionChoice";
import { clock } from "@/lib/explorer/format";
import { setPlaybackTime, setPlaying, setScrub } from "@/lib/store/explorer/slice";

import { usePlaybackValue } from "@/hooks/explorer/usePlaybackValue";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { useSeek, useWidth } from "@/components/explorer/strip/stripLayout";

const LABEL_W = 150;
const RIGHT = 16;
const AXIS_H = 18;
const LANE_H = 44;
/** The chart's height (px) from which the vehicles lane shows. */
const LANE_FROM = 300;
/** How far (px) the pointer moves before a press becomes a box, and how
 * tall a box must be to zoom along the route as well as in time. */
const DRAG_PX = 4;
const BOX_TALL = 12;
/** The least a zoom shows: ten minutes; a fiftieth of the route. */
const ZOOM_MIN_S = 600;
const ZOOM_MIN_F = 0.02;
/** Labels closer than this (px) give way, the earlier kept. */
const LABEL_ROOM = 11;
/** How far (px) from a line a click still finds it. */
const HIT_W = 8;

interface Placed {
  direction: Direction;
  /** Where each of its stops lies down the strip, 0–1. */
  at: Map<number, number>;
}

export interface StripChartProps {
  trips: RouteTrips;
  choice: ResolvedChoice;
  window: [number, number];
  /** The whole day the window lies in: how far zooming out and panning go. */
  day: [number, number];
  /** The part of the route in view, 0–1 down the strip: all of it, or zoomed. */
  range: [number, number];
  height: number;
  color: string;
  /** Vehicles in service every five minutes from midnight (the summary's). */
  curve: number[] | null;
  openTrip: { trip_idx: number; run_dep_s: number } | null;
  onOpenTrip: (run: Run) => void;
  onZoom: (zoom: { window: [number, number]; range: [number, number] }) => void;
  /** Undoes the zoom; null when not zoomed. */
  onUnzoom: (() => void) | null;
}

/** Memoised: the strip around it re-renders with the bar, and the chart's
 * hundreds of lines need drawing again only when what they show changes. */
export const StripChart = memo(Chart);

function Chart(props: StripChartProps) {
  const { trips, choice, window, day, range, height, color, curve, openTrip, onOpenTrip, onZoom, onUnzoom } =
    props;
  const { t } = useTranslation("common");
  const theme = useTheme();
  const seek = useSeek();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [from, to] = window;
  const [r0, r1] = range;
  const zoomedIn = r1 - r0 < 1;
  const lane = !!curve && height >= LANE_FROM;

  const x0 = LABEL_W;
  const x1 = Math.max(x0 + 40, width - RIGHT);
  // The time of day across the top, the lines below it.
  const y0 = AXIS_H + 8;
  const y1 = height - (lane ? LANE_H + 16 : 0) - 14;
  const xOf = (s: number) => x0 + ((s - from) / (to - from)) * (x1 - x0);
  const sOf = (x: number) => from + ((x - x0) / (x1 - x0)) * (to - from);
  const yOf = (f: number) => y0 + ((f - r0) / (r1 - r0)) * (y1 - y0);
  const fOf = (y: number) => r0 + ((y - y0) / (y1 - y0)) * (r1 - r0);
  const inView = (f: number) => f >= r0 - 1e-9 && f <= r1 + 1e-9;

  // The usual gestures over the plot, as on a map: a pinch, or the wheel
  // with Ctrl or ⌘, zooms in time about the pointer; a sideways swipe or
  // Shift and the wheel pans in time, and scrolling pans along the route,
  // when zoomed that way. Anything else, and anything with nowhere to go,
  // is left to the page (the browser's own zoom, a swipe back).
  const view = useRef({ from, to, day, range, x0, x1, y0, y1, onZoom });
  view.current = { from, to, day, range, x0, x1, y0, y1, onZoom };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const v = view.current;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (x < v.x0 || x > v.x1 || y < v.y0 - 6 || y > v.y1 + 6) return;
      const px = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1;
      const dx = e.deltaX * px;
      const dy = e.deltaY * px;
      const span = v.to - v.from;
      const [d0, d1] = v.day;
      const [f0, f1] = v.range;
      let next: { window: [number, number]; range: [number, number] } | null = null;
      if (e.ctrlKey || e.metaKey) {
        // A wheel's notch zooms by about 1.6×; a pinch, in small steps.
        const width = Math.min(
          Math.max(span * Math.exp(Math.max(-100, Math.min(100, dy)) * 0.005), ZOOM_MIN_S),
          d1 - d0
        );
        const at = v.from + ((x - v.x0) / (v.x1 - v.x0)) * span;
        const start = Math.min(Math.max(at - (at - v.from) * (width / span), d0), d1 - width);
        next = { window: [start, start + width], range: v.range };
      } else if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
        const by = ((e.shiftKey && !dx ? dy : dx) / (v.x1 - v.x0)) * span;
        const start = Math.min(Math.max(v.from + by, d0), d1 - span);
        if (start !== v.from) next = { window: [start, start + span], range: v.range };
      } else if (f1 - f0 < 1) {
        const by = (dy / (v.y1 - v.y0)) * (f1 - f0);
        const start = Math.min(Math.max(f0 + by, 0), 1 - (f1 - f0));
        if (start !== f0) next = { window: [v.from, v.to], range: [start, start + (f1 - f0)] };
      }
      if (!next) return;
      e.preventDefault();
      v.onZoom(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref]);

  // Which directions are drawn, and where each stop lies down the strip.
  const placed = useMemo<Placed[]>(() => {
    const shown = choice.direction ? [choice.direction] : [];
    return shown.map((direction) => {
      const axis = trips.axes.get(direction.key);
      const at = new Map<number, number>();
      if (axis) {
        const d0 = axis.d[0];
        axis.stop_idx.forEach((stop, i) => {
          if (at.has(stop)) return; // a loop's last stop is its first
          const f = (axis.d[i] - d0) / axis.length_m;
          at.set(stop, f);
        });
      }
      return { direction, at };
    });
  }, [trips, choice]);
  const placedOf = useMemo(() => {
    const m = new Map<number, Placed>();
    for (const p of placed) for (const pattern of p.direction.patterns) m.set(pattern.pattern_idx, p);
    return m;
  }, [placed]);
  const kindOf = useMemo(
    () => new Map(trips.directions.flatMap((d) => d.patterns.map((p) => [p.pattern_idx, p.kind] as const))),
    [trips.directions]
  );

  // Each run in the window, as a path through its stops.
  const lines = useMemo(() => {
    if (width === 0) return [];
    const out: { run: Run; d: string; short: boolean; open: boolean }[] = [];
    trips.runs.forEach((run, r) => {
      if (!choice.patterns.has(run.pattern_idx) || run.arr_s < from || run.dep_s > to) return;
      const p = placedOf.get(run.pattern_idx);
      if (!p) return;
      let d = "";
      for (let k = trips.first[r]; k < trips.first[r + 1]; k++) {
        const f = p.at.get(trips.stop_idx[k]);
        if (f === undefined) continue;
        const y = yOf(f).toFixed(1);
        for (const s of [trips.arr[k], trips.dep[k]]) {
          if (Number.isNaN(s)) continue;
          d += `${d ? "L" : "M"}${xOf(s).toFixed(1)} ${y}`;
        }
      }
      if (d)
        out.push({
          run,
          d,
          short: kindOf.get(run.pattern_idx) === "short_turn",
          open: !!openTrip && openTrip.trip_idx === run.trip_idx && openTrip.run_dep_s === run.dep_s,
        });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trips, choice, placedOf, kindOf, from, to, r0, r1, width, height, lane, openTrip]);

  // Down the left, where trips start and end: the direction's ends, in
  // bold, and where its other patterns start or end — a short turn's in
  // its lines' colour — so the difference shows. The stops in between are
  // where the lines bend.
  const labels = useMemo(() => {
    const name = (s: StopInfo | undefined) => s?.station ?? s?.name ?? "";
    type Label = { y: number; text: string; tone: "end" | "short" | "other" };
    const out: Label[] = [];
    for (const p of placed) {
      const axis = trips.axes.get(p.direction.key);
      if (!axis || !axis.stop_idx.length) continue;
      const [first, last] = [axis.stop_idx[0], axis.stop_idx[axis.stop_idx.length - 1]];
      for (const stop of [first, last]) {
        const f = p.at.get(stop);
        if (f === undefined || !inView(f)) continue;
        out.push({
          y: yOf(f),
          text: name(trips.stops.get(stop)),
          tone: "end",
        });
      }
      for (const pattern of p.direction.patterns) {
        if (pattern.kind === "main" || !choice.patterns.has(pattern.pattern_idx)) continue;
        const r = trips.runs.findIndex((run) => run.pattern_idx === pattern.pattern_idx);
        if (r < 0 || trips.first[r + 1] <= trips.first[r]) continue;
        for (const stop of [trips.stop_idx[trips.first[r]], trips.stop_idx[trips.first[r + 1] - 1]]) {
          const f = p.at.get(stop);
          if (f === undefined || !inView(f) || stop === first || stop === last) continue;
          out.push({
            y: yOf(f),
            text: name(trips.stops.get(stop)),
            tone: pattern.kind === "short_turn" ? "short" : "other",
          });
        }
      }
    }
    // Zoomed in along the route, the stops in between are named too, so the
    // part in view can be told apart.
    if (zoomedIn)
      for (const p of placed) {
        const axis = trips.axes.get(p.direction.key);
        for (const stop of axis?.stop_idx ?? []) {
          const f = p.at.get(stop);
          if (f !== undefined && inView(f))
            out.push({ y: yOf(f), text: name(trips.stops.get(stop)), tone: "other" });
        }
      }
    // The direction's ends first; the rest give way where they would crowd.
    const kept: Label[] = [];
    for (const l of out) if (kept.every((k) => Math.abs(k.y - l.y) >= LABEL_ROOM)) kept.push(l);
    return kept;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed, trips, choice, height, lane, r0, r1, t]);

  // Ticks as far apart as the width allows: on the hour, or closer zoomed in.
  const tickStep =
    TICK_STEPS.find((step) => ((x1 - x0) / (to - from)) * step >= 64) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const ticks: number[] = [];
  for (let s = Math.ceil(from / tickStep) * tickStep; s <= to; s += tickStep) ticks.push(s);

  const muted = theme.palette.text.secondary;
  const amber = theme.palette.warning.main;
  const primary = theme.palette.primary.main;

  // A press anywhere on the plot, on a line or around them: dragged, it
  // draws the box to zoom into, so a busy hour can be zoomed as easily as a
  // quiet one; let go where it was, it opens the trip it was on, or else
  // moves playback there.
  const press = useRef<{ x: number; y: number; line: number | null } | null>(null);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const local = (e: PointerEvent<SVGGElement>) => {
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    return {
      x: Math.min(x1, Math.max(x0, e.clientX - rect.left)),
      y: Math.min(y1, Math.max(y0, e.clientY - rect.top)),
    };
  };
  const plot = {
    onPointerDown: (e: PointerEvent<SVGGElement>) => {
      if (e.button !== 0) return;
      const hit = (e.target as Element).closest("[data-line]")?.getAttribute("data-line");
      e.currentTarget.setPointerCapture(e.pointerId);
      press.current = { ...local(e), line: hit == null ? null : Number(hit) };
    },
    onPointerMove: (e: PointerEvent<SVGGElement>) => {
      const start = press.current;
      if (!start) return;
      const at = local(e);
      if (box || Math.abs(at.x - start.x) > DRAG_PX || Math.abs(at.y - start.y) > DRAG_PX)
        setBox({
          x: Math.min(start.x, at.x),
          y: Math.min(start.y, at.y),
          w: Math.abs(at.x - start.x),
          h: Math.abs(at.y - start.y),
        });
    },
    onPointerUp: () => {
      const start = press.current;
      press.current = null;
      setBox(null);
      if (!start) return;
      if (!box) {
        const line = start.line === null ? undefined : lines[start.line];
        if (line) onOpenTrip(line.run);
        else seek(sOf(start.x));
        return;
      }
      if (box.w <= DRAG_PX) return;
      const zoomTo = widen([sOf(box.x), sOf(box.x + box.w)], ZOOM_MIN_S, [from, to]);
      const zoomRange = box.h < BOX_TALL ? range : widen([fOf(box.y), fOf(box.y + box.h)], ZOOM_MIN_F, range);
      onZoom({ window: zoomTo, range: zoomRange });
    },
    onPointerCancel: () => {
      press.current = null;
      setBox(null);
    },
    onDoubleClick: () => onUnzoom?.(),
  };

  return (
    <div ref={ref} style={{ width: "100%", height, position: "relative" }}>
      {/* Zoomed, the way back sits on the chart, at its top right, where
          the eye already is. */}
      {onUnzoom && (
        <Tooltip title={t("explorer_strip_unzoom_hint")} describeChild>
          <Button
            variant="contained"
            size="small"
            disableElevation
            startIcon={<ZoomOutMapIcon fontSize="small" />}
            onClick={onUnzoom}
            sx={{
              position: "absolute",
              // Its corner on the plot's: level with the first stop's row
              // (y0) and flush with where the lines end (x1).
              top: AXIS_H + 8,
              right: RIGHT,
              zIndex: 1,
              height: 28,
              borderRadius: "25px",
              px: 1.5,
              textTransform: "none",
              fontWeight: "bold",
              boxShadow: "0 1px 4px rgba(0, 0, 0, 0.2)",
            }}>
            {t("explorer_strip_unzoom")}
          </Button>
        </Tooltip>
      )}
      {width > 0 && (
        <svg width={width} height={height} style={{ display: "block", userSelect: "none" }}>
          <defs>
            <clipPath id="strip-plot">
              <rect x={x0} y={y0 - 6} width={x1 - x0} height={y1 - y0 + 12} />
            </clipPath>
          </defs>
          {/* The plot: a click on a line opens its trip, around them moves
              playback there; a drag from anywhere on it zooms. */}
          <g {...plot} style={{ touchAction: "none" }}>
            <rect
              x={x0}
              y={y0 - 6}
              width={x1 - x0}
              height={y1 - y0 + 12}
              fill="transparent"
              style={{ cursor: "crosshair" }}>
              <title>{t(onUnzoom ? "explorer_strip_set_time_zoomed" : "explorer_strip_set_time")}</title>
            </rect>
            {ticks.map((s) => (
              <g key={s} pointerEvents="none">
                <line
                  x1={xOf(s)}
                  x2={xOf(s)}
                  y1={y0}
                  y2={y1}
                  stroke={theme.palette.divider}
                  strokeDasharray="2 3"
                />
                {/* At the plot's left edge, the label starts there, clear of the stop names. */}
                <text
                  x={xOf(s)}
                  y={12}
                  fontSize={10}
                  fill={muted}
                  textAnchor={xOf(s) - x0 < 16 ? "start" : "middle"}>
                  {clock(s)}
                </text>
              </g>
            ))}
            <g clipPath="url(#strip-plot)">
              {lines.map((l, i) => (
                <g key={`${l.run.trip_idx}:${l.run.dep_s}`} data-line={i} style={{ cursor: "pointer" }}>
                  <path d={l.d} fill="none" stroke="transparent" strokeWidth={HIT_W} />
                  <path
                    d={l.d}
                    fill="none"
                    stroke={l.open ? primary : l.short ? amber : color}
                    strokeWidth={l.open ? 3 : 1.4}
                    strokeDasharray={l.short && !l.open ? "4 3" : undefined}
                    pointerEvents="none"
                  />
                </g>
              ))}
            </g>
          </g>
          {lines.length === 0 && (
            <text
              x={(x0 + x1) / 2}
              y={(y0 + y1) / 2}
              fontSize={12}
              fill={muted}
              textAnchor="middle"
              pointerEvents="none">
              {t("explorer_strip_no_trips")}
            </text>
          )}
          {labels.map((l) => (
            <g key={`${l.y}:${l.text}`} pointerEvents="none">
              <text
                x={x0 - 10}
                y={l.y + 3.5}
                fontSize={11}
                fontWeight={l.tone === "other" ? 500 : 700}
                fill={l.tone === "short" ? amber : l.tone === "end" ? theme.palette.text.primary : muted}
                textAnchor="end">
                {truncate(l.text, 22)}
              </text>
            </g>
          ))}
          {lane && curve && (
            <VehiclesLane
              curve={curve}
              from={from}
              to={to}
              xOf={xOf}
              top={y1 + 20}
              height={LANE_H - 10}
              color={color}
            />
          )}
          {box && (
            <rect
              x={box.x}
              y={box.h < BOX_TALL ? y0 : box.y}
              width={box.w}
              height={box.h < BOX_TALL ? y1 - y0 : box.h}
              fill={primary}
              fillOpacity={0.08}
              stroke={primary}
              strokeDasharray="4 3"
              pointerEvents="none"
            />
          )}
          <NowLine from={from} to={to} xOf={xOf} sOf={sOf} y0={y0 - 6} y1={y1 + 4} color={primary} />
        </svg>
      )}
    </div>
  );
}

/** Tick spacings to choose from (s): five minutes to three hours. */
const TICK_STEPS = [300, 600, 900, 1800, 3600, 3 * 3600];

/** `[a, b]` widened about its middle to at least `least`, kept inside `within`. */
function widen([a, b]: [number, number], least: number, within: [number, number]): [number, number] {
  const width = Math.min(Math.max(b - a, least), within[1] - within[0]);
  const start = Math.min(Math.max((a + b) / 2 - width / 2, within[0]), within[1] - width);
  return [start, start + width];
}

function truncate(text: string, n: number) {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

/** Vehicles in service along the bottom, as the Overview's curve. */
function VehiclesLane({
  curve,
  from,
  to,
  xOf,
  top,
  height,
  color,
}: {
  curve: number[];
  from: number;
  to: number;
  xOf: (s: number) => number;
  top: number;
  height: number;
  color: string;
}) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const step = 300;
  const k0 = Math.max(0, Math.floor(from / step));
  const k1 = Math.min(curve.length - 1, Math.ceil(to / step));
  const peak = curve.reduce((m, v) => Math.max(m, v), 0);
  if (k1 < k0 || peak === 0) return null;
  const yOf = (v: number) => top + height - (v / peak) * height;
  let d = `M${xOf(Math.max(k0 * step, from)).toFixed(1)} ${top + height}`;
  for (let k = k0; k <= k1; k++) {
    const x = xOf(Math.min(Math.max(k * step, from), to)).toFixed(1);
    d += `L${x} ${yOf(curve[k]).toFixed(1)}`;
    const next = xOf(Math.min(Math.max((k + 1) * step, from), to)).toFixed(1);
    d += `L${next} ${yOf(curve[k]).toFixed(1)}`;
  }
  d += `L${xOf(Math.min((k1 + 1) * step, to)).toFixed(1)} ${top + height}Z`;
  return (
    <g pointerEvents="none">
      <path d={d} fill={color} fillOpacity={0.15} stroke={color} strokeWidth={1} />
      <text
        x={LABEL_W - 10}
        y={top + 10}
        fontSize={11}
        fontWeight={700}
        fill={theme.palette.text.primary}
        textAnchor="end">
        {t("explorer_strip_vehicles")}
      </text>
    </g>
  );
}

/** Playback's time: redrawn with every frame on its own, and dragged to
 * scrub, as the mini bar's scrubber: paused while dragged, the line and the
 * clock follow the pointer and the map is drawn for where it is let go,
 * playing on after if it was. Let go, the line stays there until the map has
 * caught up (the bottom bar lets go of it) rather than flicking back to the
 * time last drawn. A drag cut short — the pointer lost, the strip folded
 * under it — ends where it was, as if let go. */
function NowLine({
  from,
  to,
  xOf,
  sOf,
  y0,
  y1,
  color,
}: {
  from: number;
  to: number;
  xOf: (s: number) => number;
  sOf: (x: number) => number;
  y0: number;
  y1: number;
  color: string;
}) {
  const dispatch = useAppDispatch();
  const playing = useAppSelector((s) => s.explorer.playing);
  const scrub = useAppSelector((s) => s.explorer.scrub);
  const live = usePlaybackValue((f) => f.time_s);
  // While dragged: where it is, and whether playback ran before.
  const dragging = useRef<{ t: number; resume: boolean } | null>(null);
  const finish = () => {
    const d = dragging.current;
    if (!d) return;
    dragging.current = null;
    dispatch(setScrub({ t: d.t, let_go: true }));
    dispatch(setPlaybackTime(d.t));
    if (d.resume) requestAnimationFrame(() => dispatch(setPlaying(true)));
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => () => finishRef.current(), []);
  const now = scrub?.t ?? live;
  if (now === null || now < from || now > to) return null;
  const x = xOf(now);
  const at = (e: PointerEvent<SVGElement>) => {
    const box = ((e.currentTarget as SVGElement).ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    return Math.round(Math.min(to, Math.max(from, sOf(e.clientX - box.left))));
  };
  const move = (t: number) => {
    if (!dragging.current) return;
    dragging.current.t = t;
    dispatch(setScrub({ t, let_go: false }));
  };
  return (
    <g
      style={{ cursor: "ew-resize" }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        dragging.current = { t: Math.round(now), resume: playing };
        if (playing) dispatch(setPlaying(false));
        dispatch(setScrub({ t: Math.round(now), let_go: false }));
      }}
      onPointerMove={(e) => move(at(e))}
      onPointerUp={(e) => {
        move(at(e));
        finish();
      }}
      onLostPointerCapture={finish}
      onPointerCancel={finish}>
      <line x1={x} x2={x} y1={y0} y2={y1} stroke="transparent" strokeWidth={12} />
      <line x1={x} x2={x} y1={y0} y2={y1} stroke={color} strokeWidth={2} />
      <circle cx={x} cy={y0} r={4.5} fill={color} />
    </g>
  );
}
