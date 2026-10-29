/**
 * A route's Stops tab (board 10): the destination picker — directions, each
 * with its variants under it — and the chosen pattern as a line diagram,
 * with distances and minutes between stops, minutes from the start, and
 * where short turns end (no connecting lines at the stops, 22 Oct 2026). Picking a stop
 * shows it on the map.
 */
import { Box, ButtonBase, Stack, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { memo, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { Direction } from "@/lib/explorer/derive/directions";
import type { LineStop } from "@/lib/explorer/derive/stopsLine";
import { choiceValue, shownLine } from "@/lib/explorer/directionChoice";
import { distance } from "@/lib/explorer/format";
import { modeOf, routeColor } from "@/lib/explorer/modes";
import { closeExplorerPanel, openExplorerPanel, pickedStop } from "@/lib/store/explorer/slice";

import { type RouteRow, useRouteTrips, useStopsLine } from "@/hooks/explorer/useExplorerData";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { directionItems, tripsByPattern, useDirectionChoice } from "@/components/explorer/DirectionPicker";
import { useExplorer } from "@/components/explorer/ExplorerContext";
import { RAIL, Rail, StopDot } from "@/components/explorer/LineDiagram";
import Selector from "@/components/map/panels/common/Selector";

/** Memoised, as the hop under it: picking a stop changes two rows of the
 * line, not all of them. */
const StopRow = memo(function StopRow({
  stop,
  color,
  first,
  last,
  selected,
  onPick,
}: {
  stop: LineStop;
  color: string;
  first: boolean;
  last: boolean;
  selected: boolean;
  onPick: (stop: LineStop) => void;
}) {
  const end = first || last;
  return (
    <ButtonBase
      onClick={() => onPick(stop)}
      sx={{
        position: "relative",
        width: "100%",
        justifyContent: "flex-start",
        textAlign: "left",
        gap: 1.5,
        minHeight: 32,
        borderRadius: 1,
        bgcolor: selected ? "action.selected" : "transparent",
        "&:hover": { bgcolor: selected ? "action.selected" : "action.hover" },
      }}>
      <Box sx={{ position: "relative", width: RAIL, alignSelf: "stretch", flexShrink: 0 }}>
        <Rail color={color} top={!first} bottom={!last} />
        <StopDot color={color} end={end} />
      </Box>
      <Stack direction="row" alignItems="center" spacing={0.75} sx={{ flex: 1, minWidth: 0, py: 0.5 }}>
        <Typography variant="body2" fontWeight={end ? 700 : 500} noWrap title={stop.name}>
          {stop.name}
        </Typography>
      </Stack>
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ flexShrink: 0, fontVariantNumeric: "tabular-nums", pr: 0.5 }}>
        {stop.minutes !== null ? `${stop.minutes}′` : "–"}
      </Typography>
    </ButtonBase>
  );
});

/** Between two stops: how far, how long; and where short turns end. */
const HopRow = memo(function HopRow({ stop, color, last }: { stop: LineStop; color: string; last: boolean }) {
  const { t, i18n } = useTranslation("common");
  const theme = useTheme();
  const turn = theme.palette.warning.main;
  const hop = [
    distance(stop.next_m, i18n.language),
    stop.next_min !== null ? t("explorer_n_min", { count: stop.next_min }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      {stop.short_turns.map((s, k) => (
        <Stack
          // Two short turns may end here for one destination.
          key={k}
          direction="row"
          alignItems="center"
          spacing={1.5}
          sx={{ position: "relative", minHeight: 24 }}>
          <Box sx={{ position: "relative", width: RAIL, alignSelf: "stretch", flexShrink: 0 }}>
            <Rail color={color} top bottom />
            {/* A dashed tick off the rail: trips leave the line here. */}
            <Box
              sx={{
                position: "absolute",
                left: RAIL / 2 + 2,
                top: "50%",
                width: 12,
                borderTop: `2px dashed ${turn}`,
              }}
            />
          </Box>
          <Typography variant="caption" fontWeight={600} sx={{ color: turn }}>
            {t("explorer_short_turn_ends", { count: s.trips })}
          </Typography>
        </Stack>
      ))}
      {!last && (
        <Stack direction="row" alignItems="center" spacing={1.5} sx={{ position: "relative", minHeight: 22 }}>
          <Box sx={{ position: "relative", width: RAIL, alignSelf: "stretch", flexShrink: 0 }}>
            <Rail color={color} top bottom />
          </Box>
          <Typography variant="caption" color="text.disabled">
            {hop}
          </Typography>
        </Stack>
      )}
    </>
  );
});

export function RouteStops({ route, directions }: { route: RouteRow; directions: Direction[] }) {
  const { t, i18n } = useTranslation("common");
  const dispatch = useAppDispatch();
  const { db, complete, shapeDistUnit, settings } = useExplorer();
  const date = useAppSelector((s) => s.explorer.date);
  const picked = useAppSelector((s) => pickedStop(s.explorer));
  // A stop's timetable opens in the right panel; picked again, it closes.
  // One handler for every row, reading the picked stop as it is now.
  const pickedIdx = useRef<number | undefined>(undefined);
  pickedIdx.current = picked?.stop_idx;
  const routeId = route.route_id;
  const pickStop = useCallback(
    (s: LineStop) =>
      dispatch(
        pickedIdx.current === s.stop_idx
          ? closeExplorerPanel()
          : openExplorerPanel({
              item: { kind: "stop", stop: { stop_idx: s.stop_idx, name: s.name, lat: s.lat, lon: s.lon } },
              fromRoute: routeId,
            })
      ),
    [dispatch, routeId]
  );
  const lang = i18n.language;
  const color = routeColor(route.color, modeOf(route.route_type));

  // The choice the strip and the stop timetable share; one line drawn here:
  // the variant chosen, else the direction's main pattern (the first
  // direction's, when all are chosen).
  const { resolved, pick } = useDirectionChoice(directions);
  const shown = shownLine(resolved, directions);
  const direction = shown?.direction;
  const pattern_idx = shown?.pattern_idx;

  const line = useStopsLine(
    complete ? db : undefined,
    route,
    direction,
    pattern_idx,
    date,
    shapeDistUnit,
    settings.periods
  );
  // The day's trips, as the trip strip counts them (the same query, kept):
  // the direction's whole, or the variant's.
  const dayTrips = useRouteTrips(complete ? db : undefined, route, date);

  if (!direction) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
        {t("explorer_no_service")}
      </Typography>
    );
  }

  const byPattern = dayTrips.data ? tripsByPattern(dayTrips.data.runs) : null;
  const items = directionItems(directions, route, t, byPattern);
  const variant = direction.patterns.find((p) => p.pattern_idx === pattern_idx);
  const counted = new Set(
    variant && variant.kind !== "main" ? [variant.pattern_idx] : direction.patterns.map((p) => p.pattern_idx)
  );
  const trips = byPattern ? [...counted].reduce((n, p) => n + (byPattern.get(p) ?? 0), 0) : null;
  const data = line.data;
  const summary = data
    ? [
        trips === null ? null : t("explorer_trips", { count: trips }),
        t("explorer_stops", { count: data.stops.length }),
        distance(data.length_m, lang),
      ]
        .filter(Boolean)
        .join(" · ")
    : null;

  return (
    <Box sx={{ pt: 2, pb: 2 }}>
      {/* GOAT's own selector, as the toolbox's: directions with the route's
          badge, each with its variants under it. */}
      <Selector
        label={t("explorer_direction")}
        items={items}
        selectedItems={items.find((it) => it.value === choiceValue({ ...resolved, direction }))}
        setSelectedItems={(item) => {
          if (!item || Array.isArray(item)) return;
          pick(String(item.value));
        }}
      />

      <Typography
        variant="caption"
        color="text.secondary"
        display="block"
        sx={{ mt: 1, mb: 1.5, minHeight: 18 }}>
        {summary ?? t("explorer_calculating")}
        {data && !data.of_date && ` · ${t("explorer_times_other_days")}`}
      </Typography>

      {data && (
        <Box>
          {data.stops.map((s, i) => {
            const last = i === data.stops.length - 1;
            return (
              <Box key={`${s.stop_idx}:${i}`}>
                <StopRow
                  stop={s}
                  color={color}
                  first={i === 0}
                  last={last}
                  selected={picked?.stop_idx === s.stop_idx}
                  onPick={pickStop}
                />
                <HopRow stop={s} color={color} last={last} />
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
