// The field's distribution under a classification (prototype 4.5): bars over the field's range in their class
// colors, the breaks as dashed lines, the minimum and maximum under it (without `format`, the bars alone). Handles
// (`handles`) stand on the bars where values can be dragged: the ends of a range as solid lines, class breaks as dashed
// ones. A handle is a slider: a drag moves it and the value counts once it is let go; the arrow keys step it (with
// Shift or the page keys ten steps), Home and End take it to its limits. It never passes its neighbours (`min`, `max`)
// nor leaves the bars; an end beyond them (a range wider than the band) stands at the edge and stays where it is until
// stepped toward them. A break at the bars' edge or beyond has no handle, so a break stops a step inside them. On
// whole-number data (`integer`) the handles step and snap by whole numbers.
import { Box, Tooltip, useTheme } from "@mui/material";
import { type KeyboardEvent, type PointerEvent, type RefObject, useRef, useState } from "react";

import type { HistogramBin } from "@/lib/style/raster/metadata";

export type { HistogramBin };

const WIDTH = 270;
const HEIGHT = 64;
const BARS = 46;
/** A handle's grip under its line, and the width a pointer can take it by. */
const HIT = 14;

/** The step over a range `span` wide: a hundredth of it, rounded to 1, 2 or 5 times a power of ten. */
export function niceStep(span: number): number {
  const raw = span / 100;
  const power = 10 ** Math.floor(Math.log10(raw));
  const m = raw / power;
  return Number(((m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * power).toPrecision(1));
}

/** A value that can be dragged on the bars. */
export interface HistogramHandle {
  /** Stays with the value while others come and go (`lo`, `hi`, `break-<class>`), so the focus stays on it. */
  id: string;
  value: number;
  /** The end of a range draws a solid line, a class break a dashed one. */
  kind: "end" | "break";
  /** Its name for screen readers. */
  label: string;
  /** The values it stays above and below: its neighbours. */
  min?: number;
  max?: number;
  /** A value let go or stepped to. */
  onChange: (value: number) => void;
}

/** Where values snap and stop: steps of a hundredth of the bars' span (of 1 at least on whole-number data), within the
 * bars and between a handle's neighbours (a step away from them). */
function scaleOf(min: number, max: number, integer?: boolean) {
  const nice = max > min ? niceStep(max - min) : 1;
  const step = integer ? Math.max(1, nice) : nice;
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const round = (v: number) => Number((Math.round(v / step) * step).toFixed(decimals));
  /** The first step above `v`, and the last one below it. */
  const above = (v: number) => Number(((Math.floor(v / step + 1e-9) + 1) * step).toFixed(decimals));
  const below = (v: number) => Number(((Math.ceil(v / step - 1e-9) - 1) * step).toFixed(decimals));
  // The bars' ends as an end handle reaches them: on whole-number data the whole numbers within them.
  const [first, last] = integer ? [Math.ceil(min), Math.floor(max)] : [min, max];
  /** The lowest and highest value `h` may take. An end: the bars, widened to its own value where it lies beyond them
   * (a key step away from the bars then leaves it as it is). A break: a step inside the bars, where it keeps its
   * handle. Null where its neighbours leave no step between them. */
  const limits = (h: HistogramHandle): [number, number] | null => {
    const [low, high] =
      h.kind === "break" ? [above(min), below(max)] : [Math.min(first, h.value), Math.max(last, h.value)];
    const lo = h.min === undefined ? low : Math.max(low, above(h.min));
    const hi = h.max === undefined ? high : Math.min(high, below(h.max));
    return lo <= hi ? [lo, hi] : null;
  };
  const place = (h: HistogramHandle, v: number): number | null => {
    const range = limits(h);
    return range ? Math.min(range[1], Math.max(range[0], round(v))) : null;
  };
  return { step, limits, place };
}

function Handle({
  handle,
  at,
  shown,
  format,
  box,
  scale,
  valueAt,
  onMove,
}: {
  handle: HistogramHandle;
  /** Where it stands, 0 to 1 along the bars. */
  at: number;
  /** The value it shows (where it is dragged to). */
  shown: number;
  format?: (value: number) => string;
  box: RefObject<HTMLDivElement | null>;
  scale: ReturnType<typeof scaleOf>;
  valueAt: (clientX: number) => number;
  onMove: (value: number | null) => void;
}) {
  const theme = useTheme();
  const [dragging, setDragging] = useState(false);
  // Stepped with the keys: its value shows until it loses the focus.
  const [stepped, setStepped] = useState(false);
  const moved = useRef<number | null>(null);
  const text = format ? format(shown) : String(shown);
  const limits = scale.limits(handle);
  const end = handle.kind === "end";

  const step = (event: KeyboardEvent<HTMLDivElement>) => {
    const by = event.shiftKey ? 10 : 1;
    const delta: Record<string, number> = {
      ArrowRight: by,
      ArrowUp: by,
      ArrowLeft: -by,
      ArrowDown: -by,
      PageUp: 10,
      PageDown: -10,
    };
    let next: number | null = null;
    if (event.key in delta) next = scale.place(handle, handle.value + delta[event.key] * scale.step);
    else if (event.key === "Home" && limits) next = limits[0];
    else if (event.key === "End" && limits) next = limits[1];
    else return;
    event.preventDefault();
    setStepped(true);
    if (next !== null && next !== handle.value) handle.onChange(next);
  };

  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== undefined && event.button > 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.focus();
    moved.current = null;
    setStepped(false);
    setDragging(true);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging || !box.current) return;
    const next = scale.place(handle, valueAt(event.clientX));
    if (next === null) return;
    moved.current = next;
    onMove(next);
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setDragging(false);
    onMove(null);
    const next = moved.current;
    moved.current = null;
    if (next !== null && next !== handle.value) handle.onChange(next);
  };
  /** The browser took the gesture over (a scroll, a system gesture): the drag ends, nothing is written. */
  const cancel = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setDragging(false);
    onMove(null);
    moved.current = null;
  };

  const color = theme.palette.text.primary;
  return (
    <Tooltip title={text} open={dragging || stepped} placement="top" arrow disableInteractive>
      <Box
        role="slider"
        tabIndex={0}
        aria-label={handle.label}
        aria-orientation="horizontal"
        aria-valuenow={shown}
        aria-valuetext={text}
        {...(limits ? { "aria-valuemin": limits[0], "aria-valuemax": limits[1] } : {})}
        data-handle={handle.kind}
        onKeyDown={step}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={cancel}
        onBlur={() => setStepped(false)}
        style={{ left: `${Math.round(at * 10000) / 100}%` }}
        sx={{
          position: "absolute",
          top: 0,
          bottom: 0,
          width: HIT,
          ml: `${-HIT / 2}px`,
          cursor: "ew-resize",
          touchAction: "none",
          outline: "none",
          // The line over the bars, the grip under them.
          "&::before": {
            content: '""',
            position: "absolute",
            top: 0,
            bottom: 0,
            left: "50%",
            borderLeft: `${end ? 1.5 : 1}px ${end ? "solid" : "dashed"} ${color}`,
            transform: "translateX(-50%)",
          },
          "& [data-grip]": {
            position: "absolute",
            bottom: -5,
            left: "50%",
            width: end ? 8 : 7,
            height: end ? 10 : 7,
            transform: "translateX(-50%)",
            borderRadius: end ? 0.5 : "50%",
            border: `1.5px solid ${color}`,
            bgcolor: "background.paper",
            transition: theme.transitions.create("box-shadow", { duration: 120 }),
          },
          "&:hover [data-grip], &:focus-visible [data-grip]": {
            boxShadow: `0 0 0 3px ${theme.palette.action.focus}`,
          },
          "&:focus-visible [data-grip]": { borderColor: theme.palette.primary.main },
        }}>
        <Box data-grip />
      </Box>
    </Tooltip>
  );
}

export function Histogram({
  bins,
  breaks,
  colorAt,
  format,
  handles,
  integer,
}: {
  bins: HistogramBin[];
  /** Breaks drawn as dashed lines, without handles. */
  breaks: number[];
  colorAt: (value: number) => string;
  format?: (value: number) => string;
  handles?: HistogramHandle[];
  /** Whole-number data: the handles never step by less than 1. */
  integer?: boolean;
}) {
  const theme = useTheme();
  const box = useRef<HTMLDivElement>(null);
  // The handle being dragged (its id) and where to; null while every handle shows its value.
  const [moving, setMoving] = useState<{ id: string; value: number } | null>(null);
  if (!bins.length) return null;
  const min = bins[0].range[0];
  const max = bins[bins.length - 1].range[1];
  const top = Math.max(...bins.map((b) => b.count), 1);
  const x = (v: number) => (max === min ? 0 : ((v - min) / (max - min)) * WIDTH);
  const height = format ? HEIGHT : BARS;
  const scale = scaleOf(min, max, integer);
  const valueAt = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    const share = rect && rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    return min + Math.min(1, Math.max(0, share)) * (max - min);
  };
  const bars = (
    <svg width="100%" viewBox={`0 0 ${WIDTH} ${height}`} aria-hidden="true" style={{ display: "block" }}>
      {bins.map((bin) => {
        const h = (bin.count / top) * BARS;
        return (
          <rect
            key={`${bin.range[0]}`}
            x={x(bin.range[0]) + 0.5}
            y={BARS - h}
            width={Math.max(x(bin.range[1]) - x(bin.range[0]) - 1, 0.5)}
            height={h}
            fill={colorAt((bin.range[0] + bin.range[1]) / 2)}
          />
        );
      })}
      {breaks
        .filter((b) => b > min && b < max)
        .map((b) => (
          <line
            key={b}
            x1={x(b)}
            x2={x(b)}
            y1={0}
            y2={BARS}
            stroke={theme.palette.text.primary}
            strokeDasharray="2 2"
            strokeWidth={0.75}
          />
        ))}
      {format && (
        <>
          <text x={0} y={HEIGHT - 4} fontSize={9} fill={theme.palette.text.secondary}>
            {format(min)}
          </text>
          <text x={WIDTH} y={HEIGHT - 4} fontSize={9} textAnchor="end" fill={theme.palette.text.secondary}>
            {format(max)}
          </text>
        </>
      )}
    </svg>
  );
  if (!handles?.length) return bars;
  return (
    <Box ref={box} data-histogram sx={{ position: "relative" }}>
      {bars}
      {/* Over the bars only, so the end labels under them stay clear. */}
      <Box sx={{ position: "absolute", left: 0, right: 0, top: 0, height: `${(BARS / height) * 100}%` }}>
        {handles.map((handle) => {
          // A break at the bars' edge or beyond would stand there as if it were the band's lowest or highest value.
          if (handle.kind === "break" && !(handle.value > min && handle.value < max)) return null;
          const shown = moving?.id === handle.id ? moving.value : handle.value;
          const at = max === min ? 0 : Math.min(1, Math.max(0, (shown - min) / (max - min)));
          return (
            <Handle
              key={handle.id}
              handle={handle}
              at={at}
              shown={shown}
              format={format}
              box={box}
              scale={scale}
              valueAt={valueAt}
              onMove={(value) => setMoving(value === null ? null : { id: handle.id, value })}
            />
          );
        })}
      </Box>
    </Box>
  );
}
