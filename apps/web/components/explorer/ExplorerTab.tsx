/**
 * The Explorer tab (boards 3, 4): the bundle's routes and its stations
 * and platforms, searched together and filtered by type, route type and agency.
 * Selecting a route turns the tab into its summary; picking a station or
 * platform shows it on the map. The operating cost sits below, in CostSection.
 */
import { Box, InputAdornment, List, ListItemButton, Stack, TextField, Typography } from "@mui/material";
import { type ReactNode, memo, useDeferredValue, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import {
  filterCount,
  listPlaces,
  matchingRouteIdxs,
  routeMatches,
  searchRoutes,
  shows,
} from "@/lib/explorer/filters";
import { compact, count } from "@/lib/explorer/format";
import { modeOf } from "@/lib/explorer/modes";
import { selectExplorerRoute } from "@/lib/store/explorer/slice";

import {
  type RouteRow,
  useAgencies,
  useRouteDayRuns,
  useRoutes,
  useStops,
} from "@/hooks/explorer/useExplorerData";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { useExplorer } from "@/components/explorer/ExplorerContext";
import { ExplorerFilterButton, ExplorerFilterChips } from "@/components/explorer/ExplorerFilter";
import { RouteBadge } from "@/components/explorer/RouteBadge";
import { RouteSummary } from "@/components/explorer/RouteSummary";
import { PX, SectionHeader } from "@/components/explorer/SectionHeader";
import { StationsList } from "@/components/explorer/StationsList";
import { StopMarker } from "@/components/explorer/StopMarker";
import { modeIcon } from "@/components/explorer/modeIcon";

/** A list longer than this is cut short: narrowing the search finds the rest. */
const SHOWN = 200;

/** A row's height, routes and stops alike. */
const ROW_HEIGHT = 36;

/** "8 of 89" once something narrows the list, else the plain count. */
function useAmount(shown: number, total: number | undefined, narrowed: boolean): string {
  const { t, i18n } = useTranslation("common");
  if (total === undefined) return "…";
  if (!narrowed) return count(total, i18n.language);
  // A five-digit total is shortened, so the pill leaves the title room.
  const m = total >= 10000 ? compact(total, i18n.language) : count(total, i18n.language);
  return t("explorer_n_of_m", { n: count(shown, i18n.language), m });
}

/** The open section's rows: all the room below the headers, scrolling. */
function SectionList({ hidden, children }: { hidden: boolean; children: ReactNode }) {
  // Its rows are drawn once it is first opened, and kept after: a folded
  // section costs nothing as the Explorer opens (Munich's stations are 200
  // rows), yet opens again at once.
  const [opened, setOpened] = useState(!hidden);
  if (!hidden && !opened) setOpened(true);
  return (
    <List
      dense
      disablePadding
      sx={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        display: hidden ? "none" : "block",
        borderTop: 1,
        borderColor: "divider",
      }}>
      {opened && children}
    </List>
  );
}

/** The routes listed: a row each, opening the route; one not running on
 * the date dimmed, and saying so. */
const RouteRows = memo(function RouteRows({
  routes,
  dayRuns,
}: {
  routes: RouteRow[];
  /** Each route's runs on the date, once known: one making none is dimmed. */
  dayRuns: Map<number, number> | null;
}) {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  return (
    <>
      {routes.map((route) => {
        const idle = !!dayRuns && !dayRuns.has(route.route_idx);
        return (
          <ListItemButton
            key={route.route_idx}
            onClick={() => dispatch(selectExplorerRoute(route.route_id))}
            title={idle ? t("explorer_route_no_trips_on_date") : undefined}
            sx={{ px: PX, py: 0.75, gap: 1.5, minHeight: ROW_HEIGHT, opacity: idle ? 0.5 : 1 }}>
            <RouteBadge route={route} />
            <Typography variant="body2" noWrap title={route.long_name ?? undefined} sx={{ flex: 1 }}>
              {route.long_name || route.short_name || route.route_id}
            </Typography>
            <Box sx={{ color: "text.disabled", display: "flex" }}>
              <Icon
                iconName={modeIcon(modeOf(route.route_type))}
                style={{ fontSize: 13 }}
                htmlColor="inherit"
              />
            </Box>
          </ListItemButton>
        );
      })}
    </>
  );
});

function Note({ children }: { children: ReactNode }) {
  return (
    <Typography variant="caption" color="text.secondary" sx={{ display: "block", px: PX, py: 1 }}>
      {children}
    </Typography>
  );
}

export function ExplorerTab() {
  const { t } = useTranslation("common");
  const { db } = useExplorer();
  const bundleName = useAppSelector((s) => s.explorer.bundleName);
  const selectedRouteId = useAppSelector((s) => s.explorer.selectedRouteId);
  const filters = useAppSelector((s) => s.explorer.filters);
  const routes = useRoutes(db);
  // Each route's runs on the date: what runs ranks first in a search, and
  // what does not run is dimmed. Known once the timetable is in.
  const date = useAppSelector((s) => s.explorer.date);
  const { complete } = useExplorer();
  const dayRuns = useRouteDayRuns(complete ? db : undefined, date).data ?? null;
  const stops = useStops(db);
  const agencies = useAgencies(db);
  const [query, setQuery] = useState("");
  // One section open at a time, filling the room the other's header leaves:
  // neither list is squeezed on a small screen. Its header folds it again,
  // leaving both folded.
  const [open, setOpen] = useState<"routes" | "stops" | null>("routes");

  // The field shows every keystroke at once; the lists follow when they
  // can, a newer keystroke cutting short the filtering of an older one.
  const q = useDeferredValue(query.trim());
  const narrowed = !!q || filterCount(filters) > 0;
  const filteredRoutes = useMemo(
    () =>
      searchRoutes(
        (routes.data ?? []).filter((r) => routeMatches(r, filters)),
        q,
        dayRuns
      ),
    [routes.data, filters, q, dayRuns]
  );

  const filteredStops = useMemo(
    () => listPlaces(stops.data ?? [], q, matchingRouteIdxs(routes.data ?? [], filters)),
    [stops.data, routes.data, filters, q]
  );
  const routeByIdx = useMemo(() => new Map((routes.data ?? []).map((r) => [r.route_idx, r])), [routes.data]);
  // What the lists show, kept between renders: the memoised rows below are
  // drawn again only when it changes, not as each key is typed.
  const shownRoutes = useMemo(() => filteredRoutes.slice(0, SHOWN), [filteredRoutes]);
  const shownStops = useMemo(() => filteredStops.slice(0, SHOWN), [filteredStops]);
  const routesAmount = useAmount(filteredRoutes.length, routes.data?.length, narrowed);
  const stopsAmount = useAmount(filteredStops.length, stops.data?.length, narrowed);

  const selected = routes.data?.find((r) => r.route_id === selectedRouteId);
  if (selected) return <RouteSummary route={selected} />;

  const showRoutes = shows(filters, "routes");
  const showStops = shows(filters, "stops");
  // A search that finds only one kind opens its section: the match is the
  // point. A filter showing one kind shows it open.
  const searchOpens =
    q && filteredRoutes.length === 0 && filteredStops.length > 0
      ? "stops"
      : q && filteredStops.length === 0 && filteredRoutes.length > 0
        ? "routes"
        : null;
  // Both folded, a search still shows what it finds.
  const shown =
    open === null && !q
      ? null
      : !showStops
        ? "routes"
        : !showRoutes
          ? "stops"
          : (searchOpens ?? open ?? "routes");
  const routesOpen = shown === "routes";
  const stopsOpen = shown === "stops";

  return (
    <Stack sx={{ height: "100%", minHeight: 0 }}>
      {/* No title of its own: the tab bar above already says Explorer. */}
      <Box sx={{ px: PX, pt: 2, pb: 1.5 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ color: "text.secondary" }}>
          <Icon iconName={ICON_NAME.CUBE} style={{ fontSize: 13 }} htmlColor="inherit" />
          <Typography variant="body2" fontWeight="bold" color="text.primary" noWrap>
            {bundleName}
          </Typography>
        </Stack>
        <TextField
          size="small"
          fullWidth
          // body2, as the rows below: the field's default size outweighs them.
          sx={{ mt: 1.5, "& .MuiInputBase-input": { fontSize: 14 } }}
          placeholder={t("explorer_search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <Icon iconName={ICON_NAME.SEARCH} style={{ fontSize: 14 }} />
              </InputAdornment>
            ),
            endAdornment: (
              <InputAdornment position="end">
                <ExplorerFilterButton
                  routes={routes.data ?? []}
                  agencies={agencies.data ?? []}
                  stopCount={stops.data?.length}
                />
              </InputAdornment>
            ),
          }}
        />
        <ExplorerFilterChips agencies={agencies.data ?? []} />
      </Box>

      {showRoutes && (
        <>
          <SectionHeader
            icon={ICON_NAME.ROUTE}
            label={t("explorer_routes")}
            amount={routesAmount}
            folded={!routesOpen}
            onFold={() => setOpen(routesOpen ? null : "routes")}
          />
          <SectionList hidden={!routesOpen}>
            <RouteRows routes={shownRoutes} dayRuns={dayRuns} />
            {filteredRoutes.length > SHOWN && (
              <Note>{t("explorer_more_routes", { count: filteredRoutes.length - SHOWN })}</Note>
            )}
            {routes.data && filteredRoutes.length === 0 && <Note>{t("explorer_no_routes")}</Note>}
          </SectionList>
        </>
      )}

      {showStops && (
        <>
          <SectionHeader
            icon={<StopMarker size={12} />}
            label={t("explorer_stops_stations")}
            amount={stopsAmount}
            folded={!stopsOpen}
            onFold={() => setOpen(stopsOpen ? null : "stops")}
          />
          <SectionList hidden={!stopsOpen}>
            <StationsList listed={shownStops} routeByIdx={routeByIdx} />
            {filteredStops.length > SHOWN && (
              <Note>{t("explorer_more_stops", { count: filteredStops.length - SHOWN })}</Note>
            )}
            {stops.data && filteredStops.length === 0 && <Note>{t("explorer_no_stops")}</Note>}
          </SectionList>
        </>
      )}
    </Stack>
  );
}
