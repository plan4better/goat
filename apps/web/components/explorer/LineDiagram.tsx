/**
 * A line diagram's parts (board 10): the rail a route runs along and the
 * dots of its stops. The Stops tab draws a pattern with them, the trip panel
 * a trip, so both read alike.
 */
import { Box } from "@mui/material";

/** The rail's column. */
export const RAIL = 24;

/** The rail through a row: a line above and below the marker, as it runs. */
export function Rail({ color, top, bottom }: { color: string; top: boolean; bottom: boolean }) {
  return (
    <>
      {top && (
        <Box
          sx={{ position: "absolute", left: RAIL / 2 - 2, top: 0, height: "50%", width: 4, bgcolor: color }}
        />
      )}
      {bottom && (
        <Box
          sx={{ position: "absolute", left: RAIL / 2 - 2, top: "50%", bottom: 0, width: 4, bgcolor: color }}
        />
      )}
    </>
  );
}

/** A stop on the rail; the ends ringed heavier, as the board draws them. */
export function StopDot({ color, end }: { color: string; end: boolean }) {
  const size = end ? 16 : 12;
  return (
    <Box
      sx={{
        position: "absolute",
        left: (RAIL - size) / 2,
        top: `calc(50% - ${size / 2}px)`,
        width: size,
        height: size,
        borderRadius: "50%",
        bgcolor: "background.paper",
        border: `${end ? 4 : 3}px solid ${color}`,
      }}
    />
  );
}
