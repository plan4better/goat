/**
 * The trip strip (02-panel-behaviour-spec › Playback, Viewers; boards 6,
 * 12, 16): under a selected route, the bottom bar shows the route's trips
 * over its whole day — as a chart, which zooms into a box dragged on
 * it, or a list. One direction choice drives it, the route's Stops tab and
 * the stop timetable. A trip opens in the right panel.
 *
 * `TripStrip` is the body and footer below the bar's playback row;
 * `StripControls` the row's right-hand end while it is open, and `RouteChip`
 * what the mini bar shows of the route while it is folded away.
 */
import KeyboardDoubleArrowDownIcon from "@mui/icons-material/KeyboardDoubleArrowDown";
import KeyboardDoubleArrowUpIcon from "@mui/icons-material/KeyboardDoubleArrowUp";
import { Box, ButtonBase, IconButton, Skeleton, Stack, Tooltip, Typography } from "@mui/material";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import type { Run } from "@/lib/explorer/derive/runs";
import { modeOf, routeColor } from "@/lib/explorer/modes";
import {
  focusExplorerRun,
  openExplorerPanel,
  panelItem,
  setStripCollapsed,
  setStripView,
} from "@/lib/store/explorer/slice";

import { type RouteRow, useRouteSummary, useRouteTrips } from "@/hooks/explorer/useExplorerData";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { DirectionPicker, tripsByPattern, useDirectionChoice } from "@/components/explorer/DirectionPicker";
import { useExplorer } from "@/components/explorer/ExplorerContext";
import { RouteBadge } from "@/components/explorer/RouteBadge";
import { SegmentedSwitch } from "@/components/explorer/SegmentedSwitch";
import { StripChart } from "@/components/explorer/strip/StripChart";
import { StripList } from "@/components/explorer/strip/StripList";
import { BAR_HEIGHT, STRIP_FOOTER, stripWindow } from "@/components/explorer/strip/stripLayout";

/** What a box dragged on the chart zoomed into: a part of the day, and a
 * part of the route, 0–1 down the strip. */
interface Zoom {
  window: [number, number];
  range: [number, number];
}
const WHOLE: [number, number] = [0, 1];

function useStripData(route: RouteRow) {
  const { db, complete, window: feedWindow, dataPeriod, settings } = useExplorer();
  const date = useAppSelector((s) => s.explorer.date);
  const trips = useRouteTrips(complete ? db : undefined, route, date);
  // As the Overview: the cost period once known, the feed's window until then.
  const summary = useRouteSummary(db, route, date, dataPeriod ?? feedWindow, settings);
  return { trips, summary };
}

/** `height`: the whole bottom panel's, playback row included. */
export function TripStrip({ route, height: panelHeight }: { route: RouteRow; height: number }) {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const strip = useAppSelector((s) => s.explorer.strip);
  const open = useAppSelector((s) => {
    const item = panelItem(s.explorer);
    return item?.kind === "trip" ? item : null;
  });
  const { trips, summary } = useStripData(route);
  const directions = trips.data?.directions ?? [];
  const { resolved } = useDirectionChoice(directions);
  // The route's own day: its first departure to its last arrival.
  const span = useMemo(() => {
    const runs = trips.data?.runs ?? [];
    if (!runs.length) return null;
    return { first_s: runs[0].dep_s, last_s: Math.max(...runs.map((r) => r.arr_s)) };
  }, [trips.data]);
  const day = useMemo(() => stripWindow(span), [span]);
  const height = panelHeight - BAR_HEIGHT;
  const body = height - STRIP_FOOTER;

  // A zoom holds until set back, or until the route or the direction
  // changes; another day keeps it, so the same hours compare. Escape sets
  // it back.
  const [zoom, setZoom] = useState<Zoom | null>(null);
  // The choice as picked, not as resolved: that is worked out again from
  // each day's trips, and would set the zoom back on every date.
  const picked = useAppSelector((s) => s.explorer.pattern);
  useEffect(() => setZoom(null), [route.route_id, picked]);
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setZoom(null);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [zoom]);
  const [from, to] = zoom?.window ?? day;
  const color = routeColor(route.color, modeOf(route.route_type));

  // The runs of the choice in view, in order.
  const rows = useMemo(() => {
    const data = trips.data;
    if (!data) return [];
    const out: number[] = [];
    data.runs.forEach((r, i) => {
      if (resolved.patterns.has(r.pattern_idx) && r.dep_s <= to && r.arr_s >= from) out.push(i);
    });
    return out;
  }, [trips.data, resolved, from, to]);

  // Kept between renders, as what is in view, so the memoised chart and
  // list redraw only when what they show changes.
  const view = useMemo<[number, number]>(() => [from, to], [from, to]);
  const routeId = route.route_id;
  const openTrip = useCallback(
    (run: Run) => {
      dispatch(
        openExplorerPanel({
          item: { kind: "trip", trip_idx: run.trip_idx, run_dep_s: run.dep_s },
          fromRoute: routeId,
        })
      );
      // Out on the map now, its vehicle is flown to.
      dispatch(focusExplorerRun({ trip_idx: run.trip_idx, run_dep_s: run.dep_s }));
    },
    [dispatch, routeId]
  );
  // Zoomed back out to the whole day and route, it is no zoom.
  const onZoom = useCallback(
    (z: Zoom) =>
      setZoom(
        z.window[0] <= day[0] && z.window[1] >= day[1] && z.range[0] <= 0 && z.range[1] >= 1 ? null : z
      ),
    [day]
  );
  const unzoom = useCallback(() => setZoom(null), []);

  return (
    <Stack sx={{ height, borderTop: 1, borderColor: "divider" }}>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        {trips.error ? (
          <Typography variant="body2" color="error" sx={{ p: 2 }}>
            {trips.error}
          </Typography>
        ) : !trips.data ? (
          <Skeleton variant="rounded" sx={{ m: 2, height: body - 32 }} />
        ) : strip.view === "list" ? (
          <StripList trips={trips.data} rows={rows} height={body} openTrip={open} onOpenTrip={openTrip} />
        ) : (
          <StripChart
            trips={trips.data}
            choice={resolved}
            window={view}
            range={zoom?.range ?? WHOLE}
            height={body}
            color={color}
            curve={summary.data?.curve ?? null}
            openTrip={open}
            onOpenTrip={openTrip}
            day={day}
            onZoom={onZoom}
            onUnzoom={zoom ? unzoom : null}
          />
        )}
      </Box>
      {/* Chart | List; what is in view. */}
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ height: STRIP_FOOTER, px: 3, borderTop: 1, borderColor: "divider", flexShrink: 0 }}>
        <SegmentedSwitch
          label={t("explorer_strip_view")}
          options={[
            { value: "chart", label: t("explorer_strip_chart"), icon: ICON_NAME.LINE_CHART },
            { value: "list", label: t("explorer_strip_list"), icon: ICON_NAME.LIST },
          ]}
          value={strip.view}
          onChange={(v) => dispatch(setStripView(v))}
        />
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ flex: 1, pr: 0.75, textAlign: "right", fontVariantNumeric: "tabular-nums" }}
          noWrap>
          {trips.data && t("explorer_trips", { count: rows.length })}
        </Typography>
      </Stack>
    </Stack>
  );
}

/** The playback row's right-hand end with the strip open: the direction,
 * and folding the strip away. */
export function StripControls({ route, compact }: { route: RouteRow; compact: boolean }) {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const { trips } = useStripData(route);
  const dayTrips = useMemo(() => (trips.data ? tripsByPattern(trips.data.runs) : null), [trips.data]);
  return (
    <>
      {trips.data && (
        <DirectionPicker
          route={route}
          directions={trips.data.directions}
          dayTrips={dayTrips}
          compact={compact}
        />
      )}
      <Tooltip title={t("explorer_strip_collapse")}>
        <IconButton
          aria-label={t("explorer_strip_collapse")}
          aria-expanded
          onClick={() => dispatch(setStripCollapsed(true))}
          size="small"
          sx={{ flexShrink: 0 }}>
          {/* As the right panel folds: a double chevron to its own edge. */}
          <KeyboardDoubleArrowDownIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </>
  );
}

/** The mini bar's reminder of the route while the strip is folded away:
 * its badge, which brings the strip back. */
export function RouteChip({ route }: { route: RouteRow }) {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  return (
    <Tooltip title={t("explorer_strip_expand")}>
      <ButtonBase
        aria-label={t("explorer_strip_expand")}
        aria-expanded={false}
        onClick={() => dispatch(setStripCollapsed(false))}
        // Padded as the direction picker it stands in for: as much room
        // before the badge as after the chevron (whose glyph has its own).
        sx={{
          gap: 0.75,
          pl: "8px",
          pr: "6px",
          height: 32,
          borderRadius: "16px",
          bgcolor: "action.hover",
          flexShrink: 0,
        }}>
        <RouteBadge route={route} small />
        <KeyboardDoubleArrowUpIcon sx={{ fontSize: 18, color: "text.secondary" }} />
      </ButtonBase>
    </Tooltip>
  );
}
