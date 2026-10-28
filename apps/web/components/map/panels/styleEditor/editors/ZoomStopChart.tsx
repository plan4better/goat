"use client";

// The stops of a value by zoom on the whole zoom axis, 0 to 24 (prototype 4.3): a glyph per stop drawn with its value,
// the map zoom marked under the axis as the map moves, with its number (no tick marks: the stops name their zooms and
// a hover names any other), the axis dashed where the layer is hidden. Stop labels that would overlap give way: the
// hovered stop's and the selected one's show first, the others left to right as they fit; where a press would add a
// stop, its zoom shows just above the axis, clear of the stop labels. A press on a stop selects
// it and drags it in half zoom steps between its neighbors (the cursor says so over a stop); a press elsewhere on the
// axis adds a stop there, a faint circle showing where while hovering. Under the axis, the map zoom's pointer drags the
// map's zoom, and a press zooms the map there, a faint pointer with its zoom showing where while hovering.
import { useTheme } from "@mui/material";
import { type KeyboardEvent, type PointerEvent, type ReactNode, useState } from "react";

export const CHART_WIDTH = 270;
const CHART_HEIGHT = 96;
const PAD = 16;
const TRACK_Y = 66;
const GLYPH_Y = 36;
const LABEL_Y = 12;
/** Where a press would add a stop, its zoom just above the axis. */
const GHOST_LABEL_Y = TRACK_Y - 8;
const HIT = 10;
/** Below this the chart is the map's zoom (its pointer), above it the stops. */
const ZOOM_BAND_Y = TRACK_Y + 5;
/** The map zoom's pointer: its tip under the axis, its number under it. */
const POINTER_Y = TRACK_Y + 8;
const POINTER_LABEL_Y = POINTER_Y + 17;
const STEP = 0.5;
export const ZOOM_MIN = 0;
export const ZOOM_MAX = 24;

export type Stops = Array<[number, unknown]>;

export interface Axis {
  lo: number;
  hi: number;
}

/** Every zoom, so the stops keep their places whatever the map shows. */
export const ZOOM_AXIS: Axis = { lo: ZOOM_MIN, hi: ZOOM_MAX };

export const xOf = (axis: Axis, z: number): number =>
  PAD + ((z - axis.lo) / (axis.hi - axis.lo)) * (CHART_WIDTH - 2 * PAD);

const zoomAt = (axis: Axis, x: number): number =>
  axis.lo + ((x - PAD) / (CHART_WIDTH - 2 * PAD)) * (axis.hi - axis.lo);

const snap = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z / STEP) * STEP));

/** The zoom `z` kept at least a half step away from the stop's neighbors. */
export function between(stops: Stops, i: number, z: number): number {
  const low = i > 0 ? stops[i - 1][0] + STEP : ZOOM_MIN;
  const high = i < stops.length - 1 ? stops[i + 1][0] - STEP : ZOOM_MAX;
  return Math.min(high, Math.max(low, z));
}

export interface ZoomStopChartProps {
  stops: Stops;
  selected: number;
  mapZoom: number;
  /** The zooms the layer shows at; outside them the axis is shaded. */
  layerRange: [number, number];
  label: string;
  hiddenLabel: string;
  /** A stop's value drawn around (0, 0). */
  glyph: (value: unknown) => ReactNode;
  onSelect: (index: number) => void;
  /** Adds a stop at the zoom and returns its index. */
  onAdd: (zoom: number) => number;
  onMove: (index: number, zoom: number) => void;
  /** Moves the map to a zoom (smoothly for a press, at once while dragging); without it the map zoom is only shown. */
  onZoomTo?: (zoom: number, animate: boolean) => void;
}

type Hover = { kind: "stop" | "zoom"; zoom: number } | null;

const zoomText = (z: number) => (Math.round(z * 10) / 10).toFixed(1);

/** A stop's zoom as its label: to one decimal (the field under the chart has it exactly). */
const stopText = (z: number) => `z${Math.round(z * 10) / 10}`;

/** A stop label's half width in chart units, with a little room on each side. */
const labelHalf = (text: string) => text.length * 2.6 + 2;

/** The stops whose labels show: `first` (in order), then the rest left to right, each only where it overlaps no label
 * already shown. */
export function shownLabels(stops: Stops, first: number[]): Set<number> {
  const placed: number[][] = [];
  const shown = new Set<number>();
  for (const i of [...first, ...stops.keys()]) {
    if (shown.has(i) || !stops[i]) continue;
    const x = xOf(ZOOM_AXIS, stops[i][0]);
    const half = labelHalf(stopText(stops[i][0]));
    if (placed.some(([px, ph]) => Math.abs(px - x) < ph + half)) continue;
    placed.push([x, half]);
    shown.add(i);
  }
  return shown;
}

export function ZoomStopChart({
  stops,
  selected,
  mapZoom,
  layerRange,
  label,
  hiddenLabel,
  glyph,
  onSelect,
  onAdd,
  onMove,
  onZoomTo,
}: ZoomStopChartProps) {
  const theme = useTheme();
  const [drag, setDrag] = useState<number | null>(null);
  const [zoomDrag, setZoomDrag] = useState(false);
  const [overStop, setOverStop] = useState(-1);
  const [overPointer, setOverPointer] = useState(false);
  const [hover, setHover] = useState<Hover>(null);
  // The focus ring shows for the keyboard only, not after a press.
  const [keyboard, setKeyboard] = useState(false);
  const axis = ZOOM_AXIS;
  // The stop nearest to x within reach, so stops close together each get their own press.
  const stopAt = (x: number) =>
    stops.reduce((best, [z], i) => {
      const d = Math.abs(xOf(axis, z) - x);
      return d <= HIT && (best < 0 || d < Math.abs(xOf(axis, stops[best][0]) - x)) ? i : best;
    }, -1);

  const xFromEvent = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return (event.clientX - rect.left) * (rect.width ? CHART_WIDTH / rect.width : 1);
  };
  /** Whether the pointer is under the axis, where the chart zooms the map. */
  const inZoomBand = (event: PointerEvent<SVGSVGElement>) => {
    if (!onZoomTo) return false;
    const rect = event.currentTarget.getBoundingClientRect();
    return (event.clientY - rect.top) * (rect.height ? CHART_HEIGHT / rect.height : 1) > ZOOM_BAND_Y;
  };
  const freeZoom = (x: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoomAt(axis, x)));
  const nearPointer = (x: number) => Math.abs(xOf(axis, mapZoom) - x) <= HIT;

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    const x = xFromEvent(event);
    if (inZoomBand(event)) {
      setKeyboard(false);
      setHover(null);
      if (nearPointer(x)) {
        setZoomDrag(true);
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } else onZoomTo?.(snap(freeZoom(x)), true);
      return;
    }
    const hit = stopAt(x);
    let index = hit;
    if (hit < 0) {
      const z = snap(zoomAt(axis, x));
      const near = stops.findIndex(([s]) => Math.abs(s - z) < STEP);
      index = near >= 0 ? near : onAdd(z);
    }
    onSelect(index);
    setKeyboard(false);
    setDrag(index);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const x = xFromEvent(event);
    if (zoomDrag) {
      onZoomTo?.(Math.round(freeZoom(x) * 10) / 10, false);
      return;
    }
    if (drag === null) {
      if (inZoomBand(event)) {
        const near = nearPointer(x);
        setOverPointer(near);
        setOverStop(-1);
        setHover(near ? null : { kind: "zoom", zoom: snap(freeZoom(x)) });
        return;
      }
      setOverPointer(false);
      const onStop = stopAt(x);
      setOverStop(onStop);
      const z = snap(zoomAt(axis, x));
      // Where a press adds a stop: not on a stop or a half step from one.
      setHover(onStop >= 0 || stops.some(([s]) => Math.abs(s - z) < STEP) ? null : { kind: "stop", zoom: z });
      return;
    }
    if (!stops[drag]) return;
    const z = between(stops, drag, snap(zoomAt(axis, xFromEvent(event))));
    if (z !== stops[drag][0]) onMove(drag, z);
  };

  const onPointerUp = (event: PointerEvent<SVGSVGElement>) => {
    setDrag(null);
    setZoomDrag(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    const step = event.key === "ArrowLeft" ? -STEP : event.key === "ArrowRight" ? STEP : 0;
    if (!step || !stops[selected]) return;
    event.preventDefault();
    setKeyboard(true);
    const z = between(stops, selected, stops[selected][0] + step);
    if (z !== stops[selected][0]) onMove(selected, z);
  };

  const first = stops[0]?.[0] ?? axis.lo;
  const last = stops[stops.length - 1]?.[0] ?? axis.hi;
  const muted = theme.palette.text.secondary;
  const line = theme.palette.divider;
  const accent = theme.palette.primary.main;
  const shownFrom = Math.min(Math.max(layerRange[0], axis.lo), axis.hi);
  const shownUntil = Math.max(Math.min(layerRange[1], axis.hi), shownFrom);
  const hidden = [
    shownFrom > axis.lo ? [axis.lo, shownFrom] : null,
    shownUntil < axis.hi ? [shownUntil, axis.hi] : null,
  ].filter((band): band is number[] => band !== null);
  const labels = shownLabels(stops, [overStop, selected]);

  return (
    <svg
      role="application"
      aria-label={label}
      tabIndex={0}
      width="100%"
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      style={{
        display: "block",
        touchAction: "none",
        cursor: drag !== null || zoomDrag || overStop >= 0 || overPointer ? "ew-resize" : "pointer",
        userSelect: "none",
        outline: keyboard ? `2px solid ${theme.palette.primary.main}` : "none",
        outlineOffset: -2,
        borderRadius: 6,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => {
        setOverStop(-1);
        setOverPointer(false);
        setHover(null);
      }}
      onBlur={() => setKeyboard(false)}
      onKeyDown={onKeyDown}>
      <line
        x1={xOf(axis, shownFrom)}
        x2={xOf(axis, shownUntil)}
        y1={TRACK_Y}
        y2={TRACK_Y}
        stroke={line}
        strokeWidth={2}
      />
      {hidden.map(([a, b]) => (
        <line
          key={`${a}-${b}`}
          data-hidden-zooms
          x1={xOf(axis, a)}
          x2={xOf(axis, b)}
          y1={TRACK_Y}
          y2={TRACK_Y}
          stroke={line}
          strokeWidth={2}
          strokeDasharray="3 3">
          <title>{hiddenLabel}</title>
        </line>
      ))}
      <line
        x1={xOf(axis, first)}
        x2={xOf(axis, last)}
        y1={TRACK_Y}
        y2={TRACK_Y}
        stroke={accent}
        strokeWidth={2}
      />
      <path d={`M ${xOf(axis, mapZoom)} ${POINTER_Y} l -4 6 h 8 z`} fill={theme.palette.text.primary}>
        <title>{String(Math.round(mapZoom * 10) / 10)}</title>
      </path>
      <text
        x={xOf(axis, mapZoom)}
        y={POINTER_LABEL_Y}
        fontSize={9}
        textAnchor="middle"
        fill={theme.palette.text.primary}>
        {zoomText(mapZoom)}
      </text>
      {hover?.kind === "zoom" && (
        <g data-ghost="zoom" opacity={0.5} pointerEvents="none">
          <path
            d={`M ${xOf(axis, hover.zoom)} ${POINTER_Y} l -4 6 h 8 z`}
            fill={theme.palette.text.primary}
          />
          <text
            x={xOf(axis, hover.zoom)}
            y={POINTER_LABEL_Y}
            fontSize={9}
            textAnchor="middle"
            fill={theme.palette.text.primary}>
            {zoomText(hover.zoom)}
          </text>
        </g>
      )}
      {hover?.kind === "stop" && (
        <g data-ghost="stop" opacity={0.6} pointerEvents="none">
          <text x={xOf(axis, hover.zoom)} y={GHOST_LABEL_Y} fontSize={9} textAnchor="middle" fill={muted}>
            {stopText(hover.zoom)}
          </text>
          <circle
            cx={xOf(axis, hover.zoom)}
            cy={TRACK_Y}
            r={4}
            fill={theme.palette.background.paper}
            stroke={accent}
            strokeWidth={1.5}
            strokeDasharray="2 1.5"
          />
        </g>
      )}
      {stops.map(([z, value], i) => {
        const x = xOf(axis, z);
        const isSelected = i === selected;
        return (
          <g key={i}>
            {isSelected && (
              <rect
                x={x - 15}
                y={2}
                width={30}
                height={TRACK_Y + 6}
                rx={6}
                fill={theme.palette.action.selected}
              />
            )}
            {labels.has(i) && (
              <text x={x} y={LABEL_Y} fontSize={9} textAnchor="middle" fill={muted}>
                {stopText(z)}
              </text>
            )}
            <g transform={`translate(${x} ${GLYPH_Y})`}>{glyph(value)}</g>
            <circle
              cx={x}
              cy={TRACK_Y}
              r={isSelected ? 5 : 4}
              fill={isSelected ? accent : theme.palette.background.paper}
              stroke={accent}
              strokeWidth={1.5}
            />
          </g>
        );
      })}
    </svg>
  );
}
