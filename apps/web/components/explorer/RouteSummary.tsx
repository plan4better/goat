/**
 * A route's summary in the left panel (board 6): its name and its tabs —
 * Overview (board 22, the default; read-only until editing), Stops (board
 * 10) and Schedule (board 11).
 */
import { Box, ButtonBase, Skeleton, Stack, Tab, Tabs, Typography } from "@mui/material";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { highlightedPatterns } from "@/lib/explorer/directionChoice";
import { highlightStore } from "@/lib/explorer/highlightStore";
import { modeOf, routeColor } from "@/lib/explorer/modes";
import {
  type ExplorerRouteTab,
  selectExplorerRoute,
  setExplorerDrawing,
  setExplorerRouteTab,
} from "@/lib/store/explorer/slice";

import { type RouteRow, usePatternSections, useRouteSummary } from "@/hooks/explorer/useExplorerData";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { useExplorer } from "@/components/explorer/ExplorerContext";
import { useTimetablesPending } from "@/components/explorer/ExplorerLoading";
import { RouteBadge, namedByMode, routeName } from "@/components/explorer/RouteBadge";
import { RouteCalendar } from "@/components/explorer/RouteCalendar";
import { RouteService } from "@/components/explorer/RouteService";
import { RouteStops } from "@/components/explorer/RouteStops";
import { TAB_SX } from "@/components/explorer/SectionHeader";
import { modeIcon } from "@/components/explorer/modeIcon";

/** A tab's shape while the route's figures are worked out, so it fills in
 * rather than jumps in; says so while the timetables are still loading. */
function SummarySkeleton() {
  const { t } = useTranslation("common");
  const pending = useTimetablesPending();
  return (
    <Box aria-busy sx={{ pt: 2, pb: 2 }}>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
        {pending ?? t("explorer_calculating")}
      </Typography>
      <Skeleton variant="rounded" height={190} />
      <Skeleton variant="text" width="60%" sx={{ mt: 1 }} />
      <Skeleton variant="rounded" height={80} sx={{ mt: 2 }} />
      <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} variant="rounded" height={58} sx={{ flex: 1 }} />
        ))}
      </Stack>
    </Box>
  );
}

/** The meta line's line height: the icon beside it is centred on one. */
const META_LINE = "20px";

/** The route's tabs as GOAT's panels draw theirs (the toolbox's): sentence
 * case, 13 px, on a divider. They fill the bar, each as wide as its label plus
 * padding either side and a share of what is left, so no label meets an edge. */
export function RouteSummary({ route }: { route: RouteRow }) {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const { db, complete, window, shapeLinesLayerId, settings } = useExplorer();
  const date = useAppSelector((s) => s.explorer.date);
  const tab = useAppSelector((s) => s.explorer.routeTab);
  const summary = useRouteSummary(complete ? db : undefined, route, date, window, settings);
  const mode = modeOf(route.route_type);

  // The stretch of line the map highlights for the picked patterns: a short
  // turn's own part of the route, not the whole shape it rides.
  const choice = useAppSelector((s) => s.explorer.pattern);
  const highlightKey = summary.data
    ? (highlightedPatterns(choice, summary.data.drawing.directions, tab === "stops")?.join(",") ?? "")
    : "";
  const sections = usePatternSections(complete ? db : undefined, highlightKey);
  useEffect(() => {
    if (highlightKey && sections.data) highlightStore.set({ key: highlightKey, ...sections.data });
  }, [highlightKey, sections.data]);
  useEffect(() => () => highlightStore.set(null), []);

  useEffect(() => {
    if (!summary.data) return;
    dispatch(
      setExplorerDrawing({
        routeId: route.route_id,
        color: routeColor(route.color, mode),
        shapeLinesLayerId,
        ...summary.data.drawing,
      })
    );
  }, [summary.data, route.route_id, route.color, mode, shapeLinesLayerId, dispatch]);

  const meta = [
    // Named by its mode already, the heading needs no second mention of it.
    namedByMode(route) ? null : t(`explorer_mode_${mode}`),
    route.agency,
    summary.data ? t("explorer_directions", { count: summary.data.directions.length }) : null,
    summary.data ? t("explorer_stops", { count: summary.data.n_stops }) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Stack sx={{ height: "100%", minHeight: 0 }}>
      <Box sx={{ px: 2.5, pt: 1.5, pb: 0.5 }}>
        <ButtonBase
          onClick={() => dispatch(selectExplorerRoute(null))}
          sx={{ gap: 0.75, color: "text.secondary", borderRadius: 1, px: 0.5 }}>
          <Icon iconName={ICON_NAME.CHEVRON_LEFT} style={{ fontSize: 11 }} />
          <Typography variant="caption">{t("explorer_routes")}</Typography>
        </ButtonBase>
        <Stack direction="row" spacing={1.25} alignItems="center" sx={{ mt: 1 }}>
          <RouteBadge route={route} />
          <Typography variant="h6" fontWeight="bold" noWrap sx={{ fontSize: 17 }}>
            {routeName(route, t)}
          </Typography>
        </Stack>
        <Stack
          direction="row"
          spacing={0.75}
          alignItems="flex-start"
          sx={{ mt: 0.75, color: "text.secondary" }}>
          {/* One text line tall, so the icon centres on the first line however
              the text wraps. */}
          <Box sx={{ display: "flex", alignItems: "center", height: META_LINE, flexShrink: 0 }}>
            <Icon iconName={modeIcon(mode)} style={{ fontSize: 12 }} htmlColor="inherit" />
          </Box>
          <Typography variant="caption" sx={{ lineHeight: META_LINE }}>
            {meta}
          </Typography>
        </Stack>
      </Box>
      <Box sx={{ borderBottom: 1, borderColor: "divider", flexShrink: 0 }}>
        <Tabs
          value={tab}
          onChange={(_e, value: ExplorerRouteTab) => dispatch(setExplorerRouteTab(value))}
          sx={{ minHeight: 36 }}>
          <Tab value="service" label={t("explorer_tab_overview")} sx={TAB_SX} />
          <Tab value="stops" label={t("explorer_tab_stops")} sx={TAB_SX} />
          <Tab value="calendar" label={t("explorer_schedule_tab")} sx={TAB_SX} />
        </Tabs>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", px: 2.5 }}>
        {summary.error && (
          <Typography variant="body2" color="error" sx={{ mt: 2 }}>
            {summary.error}
          </Typography>
        )}
        {!summary.data && !summary.error && tab !== "calendar" && <SummarySkeleton />}
        {tab === "calendar" && <RouteCalendar trips={route} id={`route:${route.route_idx}`} of="line" />}
        {summary.data && tab === "service" && <RouteService route={route} data={summary.data} />}
        {summary.data && tab === "stops" && (
          <RouteStops route={route} directions={summary.data.directions.map((d) => d.direction)} />
        )}
      </Box>
    </Stack>
  );
}
