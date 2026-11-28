/**
 * A stop as the map draws it: the stops layer's default marker, a grey dot
 * in a white ring (4 px radius, 2 px stroke). A station is the same marker,
 * larger, with a white centre — the map has no symbol of its own for one.
 */
import { Box } from "@mui/material";

/** The stops layer's default colours, rgb(113, 113, 113) on white. */
export const STOP_FILL = "#717171";
const RING = "#FFFFFF";

export function StopMarker({
  station = false,
  size = 12,
  fill = STOP_FILL,
}: {
  station?: boolean;
  size?: number;
  /** Its dot's colour: the map's grey, or `currentColor` where it marks a
   * control that colours its icon (the edit bar's Stop tool, chosen). */
  fill?: string;
}) {
  const d = station ? size + 2 : size;
  return (
    <Box
      component="span"
      aria-hidden
      sx={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: d,
        height: d,
        // Its ring inside its size, wherever it is put (a select's value
        // passes content-box down).
        boxSizing: "border-box",
        flexShrink: 0,
        borderRadius: "50%",
        bgcolor: fill,
        border: `2px solid ${RING}`,
        // The white ring needs an edge of its own on a white panel.
        boxShadow: (theme) => `0 0 0 1px ${theme.palette.divider}`,
      }}>
      {station && <Box component="span" sx={{ width: 4, height: 4, borderRadius: "50%", bgcolor: RING }} />}
    </Box>
  );
}
