/**
 * What can be done to what is selected, while editing (decided 26 Nov 2026):
 * the selection's action bar under the edit bar shows these, and a right
 * click on the map offers the same. The most specific selection wins: a
 * stop or trip in the right panel, else the line selected.
 *
 * - a stop: its properties dialog (fields, Delete there), and off the selected
 *   line if it calls there; dragged on the map, it moves;
 * - a line: "Edit stops" and "Edit path" (the modes), its service, its
 *   properties;
 * - a trip: shifted, duplicated, its times edited (Delete in that dialog).
 *
 * Deleting is never an action of its own here: it is in the dialog, and
 * what it takes is said on its card in the Apply bar.
 */
import type { TFunction } from "i18next";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { clock } from "@/lib/explorer/format";
import { panelItem, setEditDialog, setEditMode, setServiceDialog } from "@/lib/store/explorer/slice";

import { type RouteRow, useRoutes } from "@/hooks/explorer/useExplorerData";
import { useLineStopEdits } from "@/hooks/explorer/useLineStopEdits";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { useExplorer } from "@/components/explorer/ExplorerContext";
import { routeName } from "@/components/explorer/RouteBadge";

export interface SelectionAction {
  id: string;
  label: string;
  icon: ICON_NAME;
  run: () => void;
}

export interface SelectionActions {
  kind: "stop" | "line" | "trip";
  /** What is selected, as the bar names it; a line by its badge too. */
  name: string;
  route?: RouteRow;
  actions: SelectionAction[];
  /** What the map does with it besides (a stop is dragged to move). */
  hint: string | null;
}

export function useSelectionActions(): SelectionActions | null {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const { db, session } = useExplorer();
  const item = useAppSelector((s) => panelItem(s.explorer));
  const routeId = useAppSelector((s) => s.explorer.selectedRouteId);
  const drawing = useAppSelector((s) => s.explorer.drawing);
  const choice = useAppSelector((s) => s.explorer.pattern);
  const route = useRoutes(db).data?.find((r) => r.route_id === routeId);
  const { removeFromLine } = useLineStopEdits();

  return useMemo(() => {
    if (!session) return null;
    if (item?.kind === "stop") {
      const stop = item.stop;
      // On the selected line as drawn: taken off it from here too.
      const onLine =
        !!route &&
        drawing?.routeId === route.route_id &&
        drawing.stops.some((s) => s.stop_idx === stop.stop_idx);
      return {
        kind: "stop",
        name: stop.name,
        hint: t("explorer_selection_stop_hint"),
        actions: [
          {
            id: "properties",
            label: t("explorer_action_properties"),
            icon: ICON_NAME.SLIDERS,
            run: () => dispatch(setEditDialog({ kind: "stop", stop_idx: stop.stop_idx })),
          },
          ...(onLine && route
            ? [
                {
                  id: "remove",
                  label: t("explorer_action_remove_from_line", { line: lineLabel(route, t) }),
                  icon: ICON_NAME.MINUS,
                  run: () => removeFromLine(stop),
                },
              ]
            : []),
        ],
      };
    }
    if (item?.kind === "trip") {
      const trip_idx = item.trip_idx;
      return {
        kind: "trip",
        name: t("explorer_selection_trip", { time: clock(item.run_dep_s) }),
        hint: null,
        actions: [
          {
            id: "shift",
            label: t("explorer_action_shift"),
            icon: ICON_NAME.CLOCK,
            run: () => dispatch(setEditDialog({ kind: "trip-shift", trip_idx })),
          },
          {
            id: "duplicate",
            label: t("explorer_action_duplicate"),
            icon: ICON_NAME.COPY,
            run: () => dispatch(setEditDialog({ kind: "trip-duplicate", trip_idx, dep_s: item.run_dep_s })),
          },
          {
            id: "times",
            label: t("explorer_action_edit_times"),
            icon: ICON_NAME.EDIT,
            run: () => dispatch(setEditDialog({ kind: "trip-times", trip_idx })),
          },
        ],
      };
    }
    if (route) {
      const route_idx = route.route_idx;
      return {
        kind: "line",
        name: lineLabel(route, t),
        route,
        hint: null,
        actions: [
          {
            id: "stops",
            label: t("explorer_action_edit_stops"),
            icon: ICON_NAME.CIRCLE_DOT,
            run: () => dispatch(setEditMode({ route_idx, kind: "stops" })),
          },
          {
            id: "path",
            label: t("explorer_action_edit_path"),
            icon: ICON_NAME.ROUTE,
            run: () => dispatch(setEditMode({ route_idx, kind: "path" })),
          },
          {
            id: "service",
            label: t("explorer_action_service"),
            icon: ICON_NAME.CLOCK,
            run: () =>
              dispatch(
                setServiceDialog({
                  route_idx,
                  direction:
                    drawing?.routeId === route.route_id
                      ? (choice?.direction ?? drawing.directions[0]?.key ?? null)
                      : null,
                })
              ),
          },
          {
            id: "properties",
            label: t("explorer_action_properties"),
            icon: ICON_NAME.SLIDERS,
            run: () => dispatch(setEditDialog({ kind: "line", route_idx })),
          },
        ],
      };
    }
    return null;
  }, [session, item, route, drawing, choice, t, dispatch, removeFromLine]);
}

/** A line as the bar names it: its number, else its name. */
function lineLabel(route: Parameters<typeof routeName>[0], t: TFunction): string {
  return route.short_name || routeName(route, t);
}
