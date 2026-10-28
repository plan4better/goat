// The field's distribution under a classification (prototype 4.5): bars over the field's range in their class
// colors, the breaks as dashed lines, the minimum and maximum under it.
import { useTheme } from "@mui/material";

const WIDTH = 270;
const HEIGHT = 64;
const BARS = 46;

export interface HistogramBin {
  range: [number, number];
  count: number;
}

export function Histogram({
  bins,
  breaks,
  colorAt,
  format,
}: {
  bins: HistogramBin[];
  breaks: number[];
  colorAt: (value: number) => string;
  format: (value: number) => string;
}) {
  const theme = useTheme();
  if (!bins.length) return null;
  const min = bins[0].range[0];
  const max = bins[bins.length - 1].range[1];
  const top = Math.max(...bins.map((b) => b.count), 1);
  const x = (v: number) => (max === min ? 0 : ((v - min) / (max - min)) * WIDTH);
  return (
    <svg width="100%" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-hidden="true" style={{ display: "block" }}>
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
      <text x={0} y={HEIGHT - 4} fontSize={9} fill={theme.palette.text.secondary}>
        {format(min)}
      </text>
      <text x={WIDTH} y={HEIGHT - 4} fontSize={9} textAnchor="end" fill={theme.palette.text.secondary}>
        {format(max)}
      </text>
    </svg>
  );
}
