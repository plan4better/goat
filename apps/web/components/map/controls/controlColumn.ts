// The column of round map buttons (compass, View, zoom, fullscreen, basemap): one flex column with one gap, the gap
// GOAT keeps between Zoom in and Zoom out. Each control brings its own margins for other places; inside the column they
// are set to none, so every button is the same distance from the next, and a control that is not shown (the compass on
// a flat map) leaves no gap.

export const CONTROL_COLUMN_SX = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  gap: 2,
  "& > *, & .MuiFab-root": { m: 0 },
  "& .MuiStack-root": { m: 0, gap: 2 },
} as const;
