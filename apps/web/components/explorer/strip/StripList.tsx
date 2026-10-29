/**
 * The trip strip's list (board 16): the trips of the window and the chosen
 * direction, one a row — when each leaves and arrives, how long it takes,
 * how far, where it goes and its stops. Trips running at
 * the playback time are marked; the open one is highlighted, and a row opens
 * its trip.
 */
import { Box, ButtonBase, Typography } from "@mui/material";
import { memo, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { RouteTrips } from "@/lib/explorer/derive/routeTrips";
import type { Run } from "@/lib/explorer/derive/runs";
import { clock, distance } from "@/lib/explorer/format";

import { usePlaybackMinute } from "@/components/explorer/right/usePlaybackMinute";

/** The columns: their headings' keys and widths (px; 0 shares the rest). */
const COLUMNS: [string, number][] = [
  ["explorer_strip_departs", 64],
  ["explorer_strip_arrives", 64],
  ["explorer_strip_duration", 70],
  ["explorer_strip_distance", 76],
  ["explorer_strip_to", 0],
  ["explorer_strip_stops", 52],
];
const ROW_H = 30;

/** Memoised, as the chart: it redraws when what it lists changes. */
export const StripList = memo(List);

function List({
  trips,
  rows,
  height,
  openTrip,
  onOpenTrip,
}: {
  trips: RouteTrips;
  /** The runs to list, by index into `trips.runs`, in order. */
  rows: number[];
  height: number;
  openTrip: { trip_idx: number; run_dep_s: number } | null;
  onOpenTrip: (run: Run) => void;
}) {
  const { t, i18n } = useTranslation("common");
  const now = usePlaybackMinute();
  const scroller = useRef<HTMLDivElement | null>(null);

  // Where each pattern goes: the name of its last stop.
  const destination = useMemo(() => {
    const out = new Map<number, string>();
    trips.runs.forEach((run, r) => {
      if (out.has(run.pattern_idx)) return;
      const last = trips.stops.get(trips.stop_idx[trips.first[r + 1] - 1]);
      out.set(run.pattern_idx, last?.station ?? last?.name ?? run.headsign ?? "");
    });
    return out;
  }, [trips]);

  // The list opens where playback is: the first trip still to arrive.
  const firstLive = rows.findIndex((r) => now === null || trips.runs[r].arr_s >= now);
  useEffect(() => {
    if (scroller.current && firstLive > 0) scroller.current.scrollTop = Math.max(0, (firstLive - 1) * ROW_H);
    // Only when the list or the window changes, not as playback runs on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const cell = (width: number) => ({
    width: width || undefined,
    flex: width ? "none" : 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  });

  if (!rows.length)
    return (
      <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 2 }}>
        {t("explorer_strip_no_trips")}
      </Typography>
    );

  return (
    <Box sx={{ height, display: "flex", flexDirection: "column", minHeight: 0 }}>
      {/* The heading and the rows keep room for the rows' scrollbar alike,
          so each heading stays over its column. */}
      <Box
        sx={{
          display: "flex",
          columnGap: 1.5,
          px: 2,
          py: 0.75,
          borderBottom: 1,
          borderColor: "divider",
          overflowY: "hidden",
          scrollbarGutter: "stable",
        }}>
        {COLUMNS.map(([key, w]) => (
          <Typography
            key={key}
            variant="caption"
            fontWeight={600}
            color="text.secondary"
            sx={{ ...cell(w), textAlign: key === "explorer_strip_stops" ? "right" : "left" }}>
            {t(key)}
          </Typography>
        ))}
      </Box>
      <Box ref={scroller} sx={{ flex: 1, minHeight: 0, overflowY: "auto", scrollbarGutter: "stable" }}>
        {rows.map((r) => {
          const run = trips.runs[r];
          const running = now !== null && run.dep_s <= now && now < run.arr_s;
          const open = !!openTrip && openTrip.trip_idx === run.trip_idx && openTrip.run_dep_s === run.dep_s;
          return (
            <ButtonBase
              key={`${run.trip_idx}:${run.dep_s}`}
              onClick={() => onOpenTrip(run)}
              sx={{
                display: "flex",
                width: "100%",
                columnGap: 1.5,
                px: 2,
                height: ROW_H,
                justifyContent: "flex-start",
                textAlign: "left",
                borderBottom: 1,
                borderColor: "divider",
                bgcolor: open ? "action.selected" : "transparent",
                "&:hover": { bgcolor: open ? "action.selected" : "action.hover" },
                fontVariantNumeric: "tabular-nums",
              }}>
              <Typography
                variant="body2"
                fontWeight={700}
                sx={{ ...cell(64), display: "flex", alignItems: "center", gap: 0.75 }}>
                {clock(run.dep_s)}
                {running && (
                  <Box
                    component="span"
                    title={t("explorer_strip_running")}
                    sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: "primary.main", flexShrink: 0 }}
                  />
                )}
              </Typography>
              <Typography variant="body2" sx={cell(64)}>
                {clock(run.arr_s)}
              </Typography>
              <Typography variant="body2" sx={cell(70)}>
                {`${Math.round((run.arr_s - run.dep_s) / 60)} ${t("explorer_minutes_short")}`}
              </Typography>
              {/* A trip without a shape is measured stop to stop in straight
                  lines: shorter than it runs, so marked as an estimate. */}
              <Typography
                variant="body2"
                sx={cell(76)}
                title={
                  run.length_src === 1 || run.length_src === 2
                    ? undefined
                    : t("explorer_strip_distance_estimate")
                }>
                {run.length_m
                  ? `${run.length_src === 1 || run.length_src === 2 ? "" : "≈ "}${distance(run.length_m, i18n.language)}`
                  : "–"}
              </Typography>
              <Typography variant="body2" sx={cell(0)} title={destination.get(run.pattern_idx)}>
                {destination.get(run.pattern_idx)}
              </Typography>
              {/* A count, right-aligned under its heading. */}
              <Typography variant="body2" sx={{ ...cell(52), textAlign: "right" }}>
                {trips.first[r + 1] - trips.first[r]}
              </Typography>
            </ButtonBase>
          );
        })}
      </Box>
    </Box>
  );
}
