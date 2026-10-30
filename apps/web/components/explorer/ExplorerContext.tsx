/**
 * The open bundle's Explorer data, for every panel of the Explorer: its
 * DuckDB-WASM database and the member layers the map draws from.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useBundleLayers } from "@/lib/api/bundles";
import type { SqlRunner } from "@/lib/explorer/db/types";
import { type DailyTrips, dailyTripCounts } from "@/lib/explorer/derive/calendar";
import { optimumPeriod } from "@/lib/explorer/derive/cost";
import { networkShapes, networkStations, networkStops, networkStore } from "@/lib/explorer/network";
import { DEFAULT_SETTINGS, type ExplorerSettings, loadSettings, saveSettings } from "@/lib/explorer/settings";
import { setExplorerBounds, setExplorerDate } from "@/lib/store/explorer/slice";

import { type ExplorerDbState, FIRST_TABLES, hasTables, useExplorerDb } from "@/hooks/explorer/useExplorerDb";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

interface ExplorerData {
  state: ExplorerDbState;
  /** The database, once the tables that list the network are loaded. */
  db: SqlRunner | undefined;
  /** The stop times are in too: per-trip figures can be computed. */
  complete: boolean;
  /** The feed's service window, `[first, last]` day. */
  window: [string, string] | null;
  /** The trips running on each day of the window, once the timetable is in. */
  daily: DailyTrips[] | null;
  /** The data period: the days figures are counted over (scaled to a
   * year), around the date the Explorer opens on. `optimum` is the stretch
   * the timetable fully covers (optimumPeriod); `dataPeriod` the user's,
   * where set and in the feed, else that. Null until the timetable is in. */
  optimum: [string, string] | null;
  dataPeriod: [string, string] | null;
  /** The bundle's shape_lines layer, which the map draws routes from. */
  shapeLinesLayerId: string | null;
  /** Share of the snapshot's bytes in the browser, 0–1; null before the download. */
  progress: number | null;
  /** Start a failed open over. */
  retry: () => void;
  /** The feed's `shape_dist_traveled` unit, as the snapshot found it. */
  shapeDistUnit: string | null;
  /** The assumptions figures rest on (settings.ts), and how to change them:
   * false when this browser could not keep them. */
  settings: ExplorerSettings;
  setSettings: (next: ExplorerSettings) => boolean;
}

const Context = createContext<ExplorerData | null>(null);

/** Today if the feed runs then, else the nearest end of its window. */
export function defaultDate(window: [string, string], today = new Date()): string {
  const iso = today.toISOString().slice(0, 10);
  if (iso < window[0]) return window[0];
  if (iso > window[1]) return window[1];
  return iso;
}

export function ExplorerProvider({ bundleId, children }: { bundleId: string; children: ReactNode }) {
  const dispatch = useAppDispatch();
  const date = useAppSelector((s) => s.explorer.date);
  const { state, retry } = useExplorerDb(bundleId);
  const [settings, setSettingsState] = useState<ExplorerSettings>(DEFAULT_SETTINGS);
  useEffect(() => setSettingsState(loadSettings(bundleId)), [bundleId]);
  const setSettings = useCallback(
    (next: ExplorerSettings) => {
      setSettingsState(next);
      return saveSettings(bundleId, next);
    },
    [bundleId]
  );
  const { members } = useBundleLayers(bundleId);

  const manifest = state.status === "loading" || state.status === "ready" ? state.manifest : undefined;
  const window = useMemo<[string, string] | null>(() => {
    const [first, last] = manifest?.service_window ?? [null, null];
    return first && last ? [first, last] : null;
  }, [manifest]);

  // The date to open on: today within the feed at first, then within the
  // data period once it is known, unless the user picked one meanwhile.
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (window && !date) {
      opened.current = defaultDate(window);
      dispatch(setExplorerDate(opened.current));
    }
  }, [window, date, dispatch]);

  // The trips running each day, for the period costs are counted over and
  // the timeline that sets it: once the whole timetable is in.
  const readyDb = state.status === "ready" ? state.db : undefined;
  const [daily, setDaily] = useState<{ db: SqlRunner; days: DailyTrips[] } | null>(null);
  useEffect(() => {
    if (!readyDb || !window) return;
    let current = true;
    dailyTripCounts(readyDb, window[0], window[1])
      .then((days) => current && setDaily({ db: readyDb, days }))
      .catch(() => current && setDaily({ db: readyDb, days: [] }));
    return () => {
      current = false;
    };
  }, [readyDb, window]);
  const days = daily && daily.db === readyDb ? daily.days : null;
  const optimum = useMemo(() => (window && days ? optimumPeriod(window, days) : null), [window, days]);
  // The user's period, where it lies in the feed; else the default.
  const set = settings.data_period;
  const dataPeriod = set && window && set[0] >= window[0] && set[1] <= window[1] ? set : optimum;
  useEffect(() => {
    if (!dataPeriod || !date || date !== opened.current) return;
    if (date < dataPeriod[0] || date > dataPeriod[1]) {
      opened.current = defaultDate(dataPeriod);
      dispatch(setExplorerDate(opened.current));
    }
  }, [dataPeriod, date, dispatch]);

  // The network's extent, from its stops as soon as they are in: the map
  // fits it once, on opening.
  const firstDb = state.status === "loading" || state.status === "ready" ? state.db : undefined;
  const listed = state.status === "ready" || (state.status === "loading" && hasTables(state, FIRST_TABLES));
  useEffect(() => {
    if (!firstDb || !listed) return;
    let current = true;
    firstDb
      .all<{ w: number | null; s: number | null; e: number | null; n: number | null }>(
        // Where most stops are: a regional feed's few far-off stops would
        // otherwise zoom the map out to half a country.
        `SELECT quantile_cont(lon, 0.01) AS w, quantile_cont(lat, 0.01) AS s,
                quantile_cont(lon, 0.99) AS e, quantile_cont(lat, 0.99) AS n
         FROM stops WHERE lon IS NOT NULL AND lat IS NOT NULL`
      )
      .then(([b]) => {
        if (current && b && b.w !== null && b.s !== null && b.e !== null && b.n !== null)
          dispatch(setExplorerBounds([b.w, b.s, b.e, b.n]));
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [firstDb, listed, dispatch]);

  // The member the map draws shapes from: whichever the snapshot found the
  // lines in (an older import keeps them as its shapes); before its manifest
  // is in — a first opening, while the snapshot is still built — the
  // bundle's shape_lines member, so the network shows from the start.
  const linesRole = manifest ? (manifest.shape_lines_role ?? null) : "shape_lines";
  const shapeLinesLayerId = linesRole ? (members?.find((m) => m.role === linesRole)?.layer_id ?? null) : null;

  // The network the map draws by itself, each part as soon as what it comes
  // from is in, not once the whole timetable is: the lines from their
  // prebuilt tiles at once (grey until coloured); their routes' colours with
  // the few small tables that say which route draws each line; the stops and
  // stations with theirs.
  useEffect(() => () => networkStore.reset(), [bundleId]);
  useEffect(() => networkStore.update({ shapeLinesLayerId }), [shapeLinesLayerId]);
  const has = (tables: string[]) =>
    state.status === "ready" || (state.status === "loading" && hasTables(state, tables));
  const shapesIn = has(["shapes_meta", "shape_route", "routes"]);
  const stopsIn = has(["stops", "patterns"]);
  useEffect(() => {
    if (!firstDb || !shapesIn) return;
    let current = true;
    networkShapes(firstDb)
      .then((part) => current && networkStore.update(part))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [firstDb, shapesIn]);
  useEffect(() => {
    if (!firstDb || !stopsIn) return;
    let current = true;
    Promise.all([networkStops(firstDb), networkStations(firstDb)])
      .then(([stops, stations]) => current && networkStore.update({ stops, stations }))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [firstDb, stopsIn]);

  const value = useMemo<ExplorerData>(() => {
    const ready = state.status === "loading" || state.status === "ready";
    return {
      state,
      db: ready && hasTables(state, FIRST_TABLES) ? state.db : undefined,
      complete: state.status === "ready",
      window,
      daily: days,
      optimum,
      dataPeriod,
      shapeLinesLayerId,
      progress:
        state.status === "ready"
          ? 1
          : state.status === "loading" && state.progress.total
            ? state.progress.received / state.progress.total
            : null,
      retry,
      shapeDistUnit: manifest?.shape_dist_unit ?? null,
      settings,
      setSettings,
    };
  }, [state, window, days, optimum, dataPeriod, retry, manifest, settings, setSettings, shapeLinesLayerId]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useExplorer(): ExplorerData {
  const value = useContext(Context);
  if (!value) throw new Error("useExplorer outside an ExplorerProvider");
  return value;
}
