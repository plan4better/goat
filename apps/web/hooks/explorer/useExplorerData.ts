/**
 * What the Explorer's panels show, queried from the bundle's DuckDB-WASM
 * database. Every query is scoped to what is on screen — the route list, one
 * route's trips — so it stays fast on the largest feeds.
 */
import { useEffect, useState } from "react";

import { remembered } from "@/lib/explorer/answers";
import type { SqlRunner } from "@/lib/explorer/db/types";
import { networkServiceDays } from "@/lib/explorer/derive/calendar";
import { type AnnualFigures, annualFigures, networkAnnualFigures, yearOf } from "@/lib/explorer/derive/cost";
import { type Direction, routeDirections } from "@/lib/explorer/derive/directions";
import {
  type Headway,
  type Operations,
  headways,
  operations,
  runningTimes,
  vehiclesInService,
} from "@/lib/explorer/derive/operations";
import { patternSections, patternTrips } from "@/lib/explorer/derive/patternSections";
import { routeTrips } from "@/lib/explorer/derive/routeTrips";
import { type TripRange, routeDayRuns, routeRuns } from "@/lib/explorer/derive/runs";
import { routeCalendar } from "@/lib/explorer/derive/serviceCalendar";
import {
  type Departure,
  type StopDetail,
  stopDepartures,
  stopDetail,
} from "@/lib/explorer/derive/stopTimetable";
import { places } from "@/lib/explorer/derive/stops";
import { stopsLine } from "@/lib/explorer/derive/stopsLine";
import { tripDetail } from "@/lib/explorer/derive/trip";
import { type ExplorerSettings, type Period, type Rate, rateFor, settingsKey } from "@/lib/explorer/settings";
import type { ExplorerRouteDrawing } from "@/lib/store/explorer/slice";

export interface RouteRow {
  route_idx: number;
  route_id: string;
  short_name: string | null;
  long_name: string | null;
  route_type: number | null;
  color: string | null;
  text_color: string | null;
  trip_lo: number | null;
  trip_hi: number | null;
  agency_idx: number | null;
  /** The operator's GTFS id: what cost rates are set by. */
  agency_id: string | null;
  agency: string | null;
}

/** Run `query` against `db` for `key`; the answer for the latest key wins. */
function useQuery<T>(db: SqlRunner | undefined, key: string, query: (db: SqlRunner) => Promise<T>) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  useEffect(() => {
    if (!db) return;
    let current = true;
    setState((s) => ({ ...s, loading: true }));
    remembered(db, key, query)
      .then((data) => current && setState({ data, loading: false }))
      .catch((e: unknown) => current && setState({ error: String(e), loading: false }));
    return () => {
      current = false;
    };
    // The key names everything the query depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, key]);
  return state;
}

export function useRoutes(db: SqlRunner | undefined) {
  return useQuery(db, "routes", (d) =>
    d.all<RouteRow>(`
        SELECT r.route_idx, r.route_id, r.short_name, r.long_name, r.route_type, r.color,
               r.text_color, r.trip_lo, r.trip_hi, r.agency_idx, a.agency_id, a.name AS agency
        FROM routes r LEFT JOIN agencies a USING (agency_idx)
        WHERE r.trip_lo IS NOT NULL
        ORDER BY r.route_idx`)
  );
}

/** Stations and stops on their own, with the routes calling there. */
export function useStops(db: SqlRunner | undefined) {
  return useQuery(db, "places", places);
}

export interface AgencyRow {
  agency_idx: number;
  name: string | null;
}

export function useAgencies(db: SqlRunner | undefined) {
  return useQuery(db, "agencies", (d) =>
    d.all<AgencyRow>("SELECT agency_idx, name FROM agencies ORDER BY name, agency_idx")
  );
}

export interface DirectionSummary {
  direction: Direction;
  headways: Map<string, Headway>;
  /** Minutes end to end on each period's busiest pattern. */
  running: Map<string, number | null>;
  operations: Operations;
}

export interface RouteSummaryData {
  directions: DirectionSummary[];
  /** The whole route on the date. */
  operations: Operations;
  /** Vehicles in service every 5 minutes from midnight. */
  curve: number[];
  n_stops: number;
  annual: AnnualFigures;
  rate: Rate;
  drawing: Omit<ExplorerRouteDrawing, "routeId" | "color" | "shapeLinesLayerId">;
}

async function summarize(
  db: SqlRunner,
  route: RouteRow,
  date: string,
  window: [string, string],
  settings: ExplorerSettings
): Promise<RouteSummaryData> {
  const [{ directions, stops, patterns }, runs] = await Promise.all([
    routeDirections(db, route),
    routeRuns(db, route, date),
  ]);
  const directionOfPattern = new Map<number, Direction>();
  for (const d of directions) for (const p of d.patterns) directionOfPattern.set(p.pattern_idx, d);
  const perDirection = directions.map((direction) => {
    const own = runs.filter((r) => directionOfPattern.get(r.pattern_idx) === direction);
    return {
      direction,
      headways: headways(own, settings.periods),
      running: runningTimes(own, settings.periods),
      operations: operations(own, settings.layover_s),
    };
  });

  const rate = rateFor(settings, route.agency_id, route.route_type);
  const annual = await annualFigures(db, route, window, rate);

  // The map: the route's shapes — the feed's, or the line through the stops
  // of trips without one (the snapshot's stop chains).
  const shapes = await db.all<{ shape_id: string; pattern_idx: number }>(`
    SELECT DISTINCT s.shape_id, t.pattern_idx FROM trips t JOIN shapes_meta s USING (shape_idx)
    WHERE t.trip_idx BETWEEN ${route.trip_lo} AND ${route.trip_hi}`);
  const coord = (idx: number): [number, number] | null => {
    const s = stops.get(idx);
    return s && s.lon != null && s.lat != null ? [s.lon, s.lat] : null;
  };
  const stopIds = new Set(patterns.flatMap((p) => p.stops));
  return {
    directions: perDirection,
    operations: operations(runs, settings.layover_s),
    curve: vehiclesInService(runs, 300),
    n_stops: stopIds.size,
    annual,
    rate,
    drawing: {
      shapeIds: [...new Set(shapes.map((s) => s.shape_id))],
      stops: [...stopIds].flatMap((idx) => {
        const c = coord(idx);
        return c
          ? [
              {
                stop_idx: idx,
                lon: c[0],
                lat: c[1],
                name: stops.get(idx)?.station ?? stops.get(idx)?.name ?? "",
              },
            ]
          : [];
      }),
      directions: directions.map((d) => ({
        key: d.key,
        patterns: d.patterns.map((p) => p.pattern_idx),
        name: d.name,
      })),
      patternShapes: shapes.reduce<Record<number, string[]>>((acc, s) => {
        (acc[s.pattern_idx] ??= []).push(s.shape_id);
        return acc;
      }, {}),
      patternEnds: Object.fromEntries(
        patterns
          .filter((p) => p.stops.length)
          .map((p) => [p.pattern_idx, [p.stops[0], p.stops[p.stops.length - 1]]])
      ),
      patternBounds: Object.fromEntries(
        patterns.flatMap((p) => {
          const cs = p.stops.map(coord).filter((c): c is [number, number] => c !== null);
          if (!cs.length) return [];
          const xs = cs.map((c) => c[0]);
          const ys = cs.map((c) => c[1]);
          return [[p.pattern_idx, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]]];
        })
      ),
    },
  };
}

export function useRouteSummary(
  db: SqlRunner | undefined,
  route: RouteRow | undefined,
  date: string | null,
  window: [string, string] | null,
  settings: ExplorerSettings
) {
  return useQuery(
    route && date && window ? db : undefined,
    `route:${route?.route_idx}:${date}:${window?.[0]}:${window?.[1]}:${settingsKey(settings)}`,
    (d) => summarize(d, route as RouteRow, date as string, window as [string, string], settings)
  );
}

/** The network's annual operating cost; needs the whole snapshot loaded. */
export function useNetworkCost(
  db: SqlRunner | undefined,
  window: [string, string] | null,
  settings: ExplorerSettings
) {
  return useQuery(
    window ? db : undefined,
    `network-cost:${window?.[0]}:${window?.[1]}:${JSON.stringify(settings.rates)}`,
    (d) => networkAnnualFigures(d, window as [string, string], (a, type) => rateFor(settings, a, type))
  );
}

/** One trip's year, priced at its line's rate: its runs on every day its
 * service runs, as a route's year is counted. */
export function useTripCost(
  db: SqlRunner | undefined,
  trip_idx: number,
  route: RouteRow | undefined,
  window: [string, string] | null,
  settings: ExplorerSettings
) {
  return useQuery(
    window && route ? db : undefined,
    `trip-cost:${trip_idx}:${window?.[0]}:${window?.[1]}:${JSON.stringify(settings.rates)}`,
    (d) =>
      annualFigures(
        d,
        { trip_lo: trip_idx, trip_hi: trip_idx },
        window as [string, string],
        rateFor(settings, (route as RouteRow).agency_id, (route as RouteRow).route_type)
      )
  );
}

/** A pattern's line diagram for the Stops tab, on the Explorer's date. */
export function useStopsLine(
  db: SqlRunner | undefined,
  route: RouteRow,
  direction: Direction | undefined,
  pattern_idx: number | undefined,
  date: string | null,
  shapeDistUnit: string | null,
  periods: Period[]
) {
  return useQuery(
    direction && pattern_idx !== undefined && date ? db : undefined,
    `line:${route.route_idx}:${pattern_idx}:${date}:${periods.map((p) => p.start_s).join(",")}`,
    (d) =>
      stopsLine(
        d,
        route,
        direction as Direction,
        pattern_idx as number,
        date as string,
        shapeDistUnit,
        periods
      )
  );
}

/** Which service a route runs on which day, over the feed's window. */
/** The calendar of a range of trips — a route's, or one trip's — keyed by `id`. */
export function useRouteCalendar(
  db: SqlRunner | undefined,
  trips: TripRange,
  id: string,
  window: [string, string] | null
) {
  return useQuery(window ? db : undefined, `calendar:${id}:${window?.[0]}:${window?.[1]}`, (d) =>
    routeCalendar(d, trips, window as [string, string])
  );
}

/** Days with any service in the year the cost is counted over, by kind of day. */
export function useServiceDays(db: SqlRunner | undefined, window: [string, string] | null) {
  const year = window ? yearOf(window) : null;
  return useQuery(year ? db : undefined, `service-days:${year?.[0]}:${year?.[1]}`, (d) =>
    networkServiceDays(d, (year as [string, string])[0], (year as [string, string])[1])
  );
}

export interface StopTimetableData {
  stop: StopDetail | null;
  departures: Departure[];
  /** The directions of each route leaving the stop, by route_idx. */
  directions: Map<number, Direction[]>;
}

/** A stop's (or station's) departures on the date, with its routes' directions. */
export function useStopTimetable(db: SqlRunner | undefined, stop_idx: number, date: string | null) {
  return useQuery(date ? db : undefined, `stop-timetable:${stop_idx}:${date}`, async (d) => {
    const [stop, departures] = await Promise.all([
      stopDetail(d, stop_idx),
      stopDepartures(d, stop_idx, date as string),
    ]);
    const idxs = [...new Set(departures.map((x) => x.route_idx))];
    const ranges = idxs.length
      ? await d.all<{ route_idx: number; trip_lo: number | null; trip_hi: number | null }>(
          `SELECT route_idx, trip_lo, trip_hi FROM routes WHERE route_idx IN (${idxs.join(",")})`
        )
      : [];
    const directions = new Map(
      await Promise.all(
        ranges.map(
          async (r) =>
            [
              r.route_idx,
              (await remembered(d, `directions:${r.route_idx}`, (x) => routeDirections(x, r))).directions,
            ] as const
        )
      )
    );
    return { stop, departures, directions } satisfies StopTimetableData;
  });
}

/** One run of a trip on the date: its stops and times, and its neighbours. */
export function useTripDetail(
  db: SqlRunner | undefined,
  trip_idx: number,
  run_dep_s: number,
  date: string | null
) {
  return useQuery(date ? db : undefined, `trip:${trip_idx}:${run_dep_s}:${date}`, (d) =>
    tripDetail(d, trip_idx, run_dep_s, date as string)
  );
}

/** The stretch each of `key`'s patterns runs (comma-joined pattern_idx),
 * for the map's highlight. */
export function usePatternSections(db: SqlRunner | undefined, key: string) {
  return useQuery(key ? db : undefined, `pattern-sections:${key}`, async (d) => {
    const patterns = key.split(",").map(Number);
    const [sections, trips] = await Promise.all([patternSections(d, patterns), patternTrips(d, patterns)]);
    return { sections, trips };
  });
}

/** Each route's runs on the date, for ranking and dimming the route list. */
export function useRouteDayRuns(db: SqlRunner | undefined, date: string | null) {
  return useQuery(date ? db : undefined, `route-day-runs:${date}`, (d) => routeDayRuns(d, date as string));
}

/** A route's runs on the date with their stop times, for the trip strip. */
export function useRouteTrips(db: SqlRunner | undefined, route: RouteRow | undefined, date: string | null) {
  return useQuery(route && date ? db : undefined, `route-trips:${route?.route_idx}:${date}`, (d) =>
    routeTrips(d, route as RouteRow, date as string)
  );
}
