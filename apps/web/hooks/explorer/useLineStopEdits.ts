/**
 * The edits on a stop of the selected line (01-editing-operations § 3),
 * started from wherever they are offered — the "Edit stops" mode's menus,
 * the selection's actions — alike: the same draft, the same scope to start from (the
 * variant picked, else the direction). The Apply bar widens or narrows it.
 */
import { useCallback } from "react";

import { shownPattern } from "@/lib/explorer/directionChoice";
import { NO_STOP_VALUES } from "@/lib/explorer/edit/drafts";
import type { LineEnd } from "@/lib/explorer/edit/ops/extendLine";
import type { CutEnd, LineScope } from "@/lib/explorer/edit/ops/lineStops";
import {
  type ExplorerPatternChoice,
  type ExplorerRouteDrawing,
  openExplorerPanel,
  setEditDraft,
} from "@/lib/store/explorer/slice";

import { useRoutes } from "@/hooks/explorer/useExplorerData";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { useExplorer } from "@/components/explorer/ExplorerContext";

export interface LineStopRef {
  stop_idx: number;
  name: string;
  lat: number | null;
  lon: number | null;
}

/** Where an edit on line `route_idx`, drawn as `drawing`, starts: the
 * variant picked, else the direction shown. */
export function lineScope(
  route_idx: number,
  drawing: ExplorerRouteDrawing,
  choice: ExplorerPatternChoice | null
): LineScope | null {
  const direction = drawing.directions.find((d) => d.key === choice?.direction) ?? drawing.directions[0];
  const pattern_idx = shownPattern(choice, drawing.directions);
  if (!direction || pattern_idx === null) return null;
  const variant = choice?.pattern_idx != null && direction.patterns.includes(choice.pattern_idx);
  return {
    route_idx,
    level: variant ? "variant" : "direction",
    pattern_idx,
    direction: direction.patterns,
  };
}

export function useLineStopEdits() {
  const dispatch = useAppDispatch();
  const { db } = useExplorer();
  const routeId = useAppSelector((s) => s.explorer.selectedRouteId);
  const route = useRoutes(db).data?.find((r) => r.route_id === routeId);
  const drawing = useAppSelector((s) => s.explorer.drawing);
  const choice = useAppSelector((s) => s.explorer.pattern);

  /** Where an edit on the line starts; null with no line selected. */
  const scope = useCallback((): LineScope | null => {
    if (!route || !drawing || drawing.routeId !== route.route_id) return null;
    return lineScope(route.route_idx, drawing, choice);
  }, [route, drawing, choice]);

  /** 3.1: a stop to add between `a` and `b`, picked on the map next. */
  const insertBetween = useCallback(
    (a: number, b: number) => {
      const s = scope();
      if (s) dispatch(setEditDraft({ kind: "line-stop-add", a, b, stop_idx: null, scope: s }));
    },
    [scope, dispatch]
  );

  /** 3.1 with 2.1: a new stop at `[lon, lat]` on the line, between `a`
   * and `b`; named and created first, then added to the line (useDraftEdit
   * chains the two, each applied on its own). */
  const createBetween = useCallback(
    (a: number, b: number, lon: number, lat: number) => {
      const s = scope();
      if (s)
        dispatch(
          setEditDraft({
            kind: "stop-new",
            lon,
            lat,
            stop_id: null,
            values: NO_STOP_VALUES,
            onLine: { a, b, scope: s },
          })
        );
    },
    [scope, dispatch]
  );

  /** 3.2: `stop` off the line, its panel open for the Apply bar. */
  const removeFromLine = useCallback(
    (stop: LineStopRef) => {
      const s = scope();
      if (!s || !route) return;
      dispatch(openExplorerPanel({ item: { kind: "stop", stop }, fromRoute: route.route_id }));
      dispatch(setEditDraft({ kind: "line-stop-remove", stop_idx: stop.stop_idx, scope: s }));
    },
    [scope, route, dispatch]
  );

  /** 1.3: the line run on past `stop`, its terminus at `end`, through stops
   * picked next, on the map or in the panel. */
  const extend = useCallback(
    (stop_idx: number, end: LineEnd) => {
      const s = scope();
      if (s) dispatch(setEditDraft({ kind: "line-extend", stop_idx, end, adds: [], scope: s }));
    },
    [scope, dispatch]
  );

  /** 1.4: the line cut back at `stop`, ending or starting there, its panel
   * open for the Apply bar. */
  const cutLine = useCallback(
    (stop: LineStopRef, end: CutEnd) => {
      const s = scope();
      if (!s || !route) return;
      dispatch(openExplorerPanel({ item: { kind: "stop", stop }, fromRoute: route.route_id }));
      dispatch(setEditDraft({ kind: "line-cut", stop_idx: stop.stop_idx, end, scope: s }));
    },
    [scope, route, dispatch]
  );

  return { insertBetween, createBetween, removeFromLine, extend, cutLine };
}
