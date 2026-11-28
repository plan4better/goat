/**
 * The map's menu while editing. Out of a line mode, a right click
 * selects what is under it and offers its actions, as the selection's bar
 * has them (useSelectionActions). In "Edit stops", on one of the line's stops
 * (a click or a right click): the stop's edits on the line, off it, the
 * line ended or started there, and at either end, the line run on from it;
 * a right click on the line between two stops: a stop added there. Along
 * the variant picked, else the direction's main pattern.
 */
import { Popover } from "@mui/material";
import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { patternLine, stretchAt } from "@/lib/explorer/derive/path";
import { shownPattern } from "@/lib/explorer/directionChoice";
import type { LineEnd } from "@/lib/explorer/edit/ops/extendLine";
import { sqlNumber } from "@/lib/explorer/edit/sql";
import { closeExplorerLineMenu } from "@/lib/store/explorer/slice";

import { type LineStopRef, useLineStopEdits } from "@/hooks/explorer/useLineStopEdits";
import { useSelectionActions } from "@/hooks/explorer/useSelectionActions";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { PopperMenuContent, type PopperMenuItem } from "@/components/common/PopperMenu";
import { useExplorer } from "@/components/explorer/ExplorerContext";

/** A stop's edits on its line: at either end (`end`), the line extended
 * from it; the line ended there unless it is the last stop (`i` of `n`),
 * started there unless the first; off the line. */
function lineStopMenu(t: TFunction, i: number, n: number, end?: LineEnd): PopperMenuItem[] {
  return [
    ...(end ? [{ id: `extend-${end}`, label: t("explorer_extend_line"), icon: ICON_NAME.PLUS }] : []),
    ...(i < n - 1
      ? [{ id: "cut-end", label: t("explorer_line_cut_end"), icon: ICON_NAME.CHEVRON_RIGHT, group: "cut" }]
      : []),
    ...(i > 0
      ? [{ id: "cut-start", label: t("explorer_line_cut_start"), icon: ICON_NAME.CHEVRON_LEFT, group: "cut" }]
      : []),
    {
      id: "remove",
      label: t("explorer_remove_stop_from_line"),
      icon: ICON_NAME.MINUS,
      color: "error.main",
    },
  ];
}

/** The line between two stops: a stop added there, one there is (picked
 * next, nearest first) or a new one where the line was clicked. */
function segmentMenu(t: TFunction): PopperMenuItem[] {
  return [
    { id: "insert", label: t("explorer_insert_existing_stop"), icon: ICON_NAME.PLUS },
    { id: "create", label: t("explorer_create_new_stop"), icon: ICON_NAME.CIRCLE_DOT },
  ];
}

type Resolved =
  | { kind: "stop"; stop: LineStopRef; items: PopperMenuItem[] }
  | { kind: "segment"; a: number; b: number; at: [number, number]; items: PopperMenuItem[] }
  | { kind: "selection"; items: PopperMenuItem[] };

export function LineContextMenu() {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const { db } = useExplorer();
  const at = useAppSelector((s) => s.explorer.lineMenu);
  const drawing = useAppSelector((s) => s.explorer.drawing);
  const choice = useAppSelector((s) => s.explorer.pattern);
  const { insertBetween, createBetween, removeFromLine, extend, cutLine } = useLineStopEdits();
  const selection = useSelectionActions();
  const [resolved, setResolved] = useState<Resolved | null>(null);

  useEffect(() => {
    setResolved(null);
    if (!at) return;
    // A menu with nothing to offer is let go at once: one held open unseen
    // would hold the map's clicks and keys (the mode stands down for it).
    if (at.selection) {
      if (!selection) dispatch(closeExplorerLineMenu());
      return;
    }
    const pattern = drawing && shownPattern(choice, drawing.directions);
    if (!db || pattern === null || pattern === undefined) {
      dispatch(closeExplorerLineMenu());
      return;
    }
    let current = true;
    const close = () => current && dispatch(closeExplorerLineMenu());
    (async () => {
      const [p] = await db.all<{ stops: ArrayLike<number> }>(
        `SELECT stops FROM patterns WHERE pattern_idx = ${sqlNumber(pattern)}`
      );
      const stops = p ? Array.from(p.stops) : [];
      // On a stop of the line shown: its edits.
      if (at.stop_idx !== null && stops.includes(at.stop_idx)) {
        const [row] = await db.all<LineStopRef>(`
          SELECT s.stop_idx, COALESCE(p.name, s.name, s.stop_id) AS name, s.lat, s.lon
          FROM stops s LEFT JOIN stops p ON p.stop_idx = s.parent_idx WHERE s.stop_idx = ${sqlNumber(at.stop_idx)}`);
        if (!current) return;
        // At either end of the line shown: extended from there too.
        const end: LineEnd | undefined =
          at.stop_idx === stops[stops.length - 1] ? "end" : at.stop_idx === stops[0] ? "start" : undefined;
        const i = stops.indexOf(at.stop_idx);
        if (row) setResolved({ kind: "stop", stop: row, items: lineStopMenu(t, i, stops.length, end) });
        else close();
        return;
      }
      // On the line: between the two stops around the click, and the point
      // on the line under it, where a new stop goes.
      const line = await patternLine(db, pattern);
      if (!current) return;
      const path = line && stretchAt(line, at.lon, at.lat);
      if (path && stops[path.from_i] !== undefined && stops[path.to_i] !== undefined)
        setResolved({
          kind: "segment",
          a: stops[path.from_i],
          b: stops[path.to_i],
          at: path.at,
          items: segmentMenu(t),
        });
      else close();
    })().catch(close);
    return () => {
      current = false;
    };
  }, [at, db, drawing, choice, t, dispatch, selection]);

  const close = () => dispatch(closeExplorerLineMenu());
  // The selection's actions, as its bar has them, once the right click has
  // selected what it was on.
  const shown: Resolved | null = at?.selection
    ? selection
      ? {
          kind: "selection",
          items: selection.actions.map((a) => ({ id: a.id, label: a.label, icon: a.icon })),
        }
      : null
    : resolved;
  return (
    <Popover
      open={!!at && !!shown}
      // Esc closes it after the keys' other listeners have seen it open,
      // so the editor's Esc does not also let go of the selection.
      onClose={(_e, reason) => (reason === "escapeKeyDown" ? setTimeout(close) : close())}
      anchorReference="anchorPosition"
      anchorPosition={at ? { top: at.y, left: at.x } : undefined}
      // The menu's own paper, as PopperMenu draws it.
      slotProps={{ paper: { sx: { boxShadow: "none", bgcolor: "transparent", overflow: "visible" } } }}>
      {shown && (
        <PopperMenuContent
          menuItems={shown.items}
          onPick={(item) => {
            close();
            if (shown.kind === "selection") selection?.actions.find((a) => a.id === item.id)?.run();
            else if (shown.kind === "segment")
              if (item.id === "create") createBetween(shown.a, shown.b, shown.at[0], shown.at[1]);
              else insertBetween(shown.a, shown.b);
            else if (item.id === "extend-end" || item.id === "extend-start")
              extend(shown.stop.stop_idx, item.id === "extend-end" ? "end" : "start");
            else if (item.id === "cut-end" || item.id === "cut-start")
              cutLine(shown.stop, item.id === "cut-end" ? "end" : "start");
            else removeFromLine(shown.stop);
          }}
        />
      )}
    </Popover>
  );
}
