"use client";

// The Light popover's sky chart (3D spec 8.3): compass directions along the horizon (N E S W N) and height upward to
// 90 degrees; the light is a point on it, dragged with the pointer or moved with the arrow keys.
import { Box, useTheme } from "@mui/material";
import type { KeyboardEvent, PointerEvent } from "react";

export const CHART_WIDTH = 320;
const HEIGHT = 114;
const LEFT = 16;
const SPAN = 288;
const HORIZON_Y = 96;
const AZ_PX = SPAN / 360;
const ALT_PX = 80 / 90;
const LIGHT = "#F5B83D";

export const chartX = (azimuth: number) => Math.round((LEFT + azimuth * AZ_PX) * 10) / 10;
export const chartY = (altitude: number) =>
  Math.round((HORIZON_Y - Math.max(0, Math.min(altitude, 90)) * ALT_PX) * 10) / 10;

export interface SkyPosition {
  azimuth: number;
  altitude: number;
}

export interface SkyChartProps {
  point: SkyPosition;
  /** "N,E,S,W,N" in the UI language. */
  axis: string[];
  ariaLabel: string;
  /** A pointer position on the chart, as a sky position. */
  onPlace: (position: SkyPosition) => void;
  /** An arrow key: -1 or 1 across (direction), -1 or 1 up and down (height). */
  onStep: (across: number, up: number) => void;
}

export function SkyChart({ point, axis, ariaLabel, onPlace, onStep }: SkyChartProps) {
  const theme = useTheme();
  const text2 = theme.palette.text.secondary;
  const place = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const k = rect.width ? CHART_WIDTH / rect.width : 1;
    onPlace({
      azimuth: ((event.clientX - rect.left) * k - LEFT) / AZ_PX,
      altitude: (HORIZON_Y - (event.clientY - rect.top) * k) / ALT_PX,
    });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const steps: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, 1],
      ArrowDown: [0, -1],
    };
    const step = steps[event.key];
    if (!step) return;
    event.preventDefault();
    onStep(...step);
  };
  const x = chartX(point.azimuth);
  const y = chartY(point.altitude);
  const label = (props: object, children: string) => (
    <text fontSize={9} fill={text2} style={{ fontVariantNumeric: "tabular-nums" }} {...props}>
      {children}
    </text>
  );
  return (
    <Box
      role="img"
      aria-label={ariaLabel}
      tabIndex={0}
      onKeyDown={onKeyDown}
      sx={{ display: "block", pt: 1, "&:focus-visible": { outline: `2px solid ${theme.palette.primary.main}` } }}>
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${HEIGHT}`}
        width={CHART_WIDTH}
        height={HEIGHT}
        aria-hidden="true"
        style={{ display: "block", touchAction: "none", cursor: "crosshair" }}
        onPointerDown={(event) => {
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // A synthetic pointer has no capture.
          }
          place(event);
        }}
        onPointerMove={(event) => {
          if (event.buttons & 1) place(event);
        }}>
        <rect x={0} y={0} width={CHART_WIDTH} height={HEIGHT} fill="transparent" />
        {[30, 60, 90].map((alt) => (
          <g key={alt}>
            <line
              x1={LEFT}
              x2={LEFT + SPAN}
              y1={chartY(alt)}
              y2={chartY(alt)}
              stroke={theme.palette.divider}
              strokeDasharray="2 3"
            />
            {label({ x: LEFT + SPAN, y: chartY(alt) - 3, textAnchor: "end" }, `${alt}°`)}
          </g>
        ))}
        <line
          x1={LEFT}
          x2={LEFT + SPAN}
          y1={HORIZON_Y}
          y2={HORIZON_Y}
          stroke={theme.palette.divider}
          strokeWidth={1.5}
        />
        {axis.map((name, i) => (
          <g key={i}>{label({ x: LEFT + i * (SPAN / 4), y: HORIZON_Y + 14, textAnchor: "middle" }, name)}</g>
        ))}
        <line x1={x} x2={x} y1={y} y2={HORIZON_Y} stroke={text2} strokeDasharray="2 2" />
        <circle
          cx={x}
          cy={y}
          r={7}
          fill={LIGHT}
          stroke={theme.palette.background.paper}
          strokeWidth={1.5}
          style={{ cursor: "grab" }}
        />
      </svg>
    </Box>
  );
}
