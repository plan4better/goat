/**
 * The Explorer's right panel (02-panel-behaviour-spec › Panel regions,
 * Viewers): one item at a time — a stop's timetable (board 13) or a trip
 * (board 7) — opened from the lists, the map, or one another. "‹" goes back
 * to the item it was opened from, × closes it. It does not fold away
 * (dropped 20 Oct 2026): closed, it is opened again from where it came.
 */
import { Box, ButtonBase, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { isServiceDraft } from "@/lib/explorer/edit/drafts";
import { clock } from "@/lib/explorer/format";
import {
  type ExplorerPanelItem,
  closeExplorerPanel,
  explorerPanelBack,
  panelItem,
} from "@/lib/store/explorer/slice";

import { DraftEditContext, useDraftEdit } from "@/hooks/explorer/useDraftEdit";
import { useRoutes, useTripDetail } from "@/hooks/explorer/useExplorerData";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { FloatingPanel } from "@/components/common/FloatingPanel";
import { useExplorer } from "@/components/explorer/ExplorerContext";
import { RouteBadge, routeName } from "@/components/explorer/RouteBadge";
import { ICON_GAP } from "@/components/explorer/SectionHeader";
import { ApplyBar } from "@/components/explorer/edit/ApplyBar";
import { DeleteLineCascade } from "@/components/explorer/edit/DeleteLineCascade";
import { DeleteStopCascade } from "@/components/explorer/edit/DeleteStopCascade";
import { ExtendPanel } from "@/components/explorer/edit/ExtendPanel";
import { InsertStopPanel } from "@/components/explorer/edit/InsertStopPanel";
import { NewLinePanel } from "@/components/explorer/edit/NewLinePanel";
import { NewStopPanel } from "@/components/explorer/edit/NewStopPanel";
import { ReroutePanel } from "@/components/explorer/edit/ReroutePanel";
import { ServiceEffectCard } from "@/components/explorer/edit/ServiceEffectCard";
import { StopPanel } from "@/components/explorer/right/StopPanel";
import { TripPanel } from "@/components/explorer/right/TripPanel";
import { EXPLORER_RIGHT_PANEL_WIDTH } from "@/components/explorer/right/panelSize";

/** An item as the breadcrumb names it. */
function useItemName(item: ExplorerPanelItem | null): string {
  const { t } = useTranslation("common");
  const { db, complete } = useExplorer();
  const date = useAppSelector((s) => s.explorer.date);
  const trip = useTripDetail(
    item?.kind === "trip" && complete ? db : undefined,
    item?.kind === "trip" ? item.trip_idx : -1,
    item?.kind === "trip" ? item.run_dep_s : -1,
    date
  );
  if (!item) return "";
  if (item.kind === "stop") return item.stop.name;
  const first = trip.data?.stops.find((s) => s.dep_s !== null)?.dep_s ?? item.run_dep_s;
  return t("explorer_trip_at", { time: clock(first) });
}

/** Memoised: the map layout re-renders around it as its widths change. */
export const ExplorerRightPanel = memo(RightPanel);

function RightPanel() {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const panel = useAppSelector((s) => s.explorer.panel);
  const item = useAppSelector((s) => panelItem(s.explorer));
  const previous = panel.stack.length > 1 ? panel.stack[panel.stack.length - 2] : null;
  const routes = useRoutes(useExplorer().db).data;
  const fromRoute = routes?.find((r) => r.route_id === panel.fromRoute);
  const routeByIdx = useMemo(() => new Map((routes ?? []).map((r) => [r.route_idx, r])), [routes]);
  const previousName = useItemName(previous);
  // The edit being made on the item shown: drafts go with the panel's item.
  const edit = useDraftEdit();
  // A stop being placed fills the panel until it is created (board 18).
  const placing = edit?.draft.kind === "stop-new" ? edit.draft : null;
  // A stop being added to a line, likewise until it is (3.1).
  const inserting = edit?.draft.kind === "line-stop-add" ? edit.draft : null;
  // A path being rerouted, likewise (1.2).
  const rerouting = edit?.draft.kind === "line-reroute" ? edit.draft : null;
  // A line being extended (1.3).
  const extending = edit?.draft.kind === "line-extend" ? edit.draft : null;
  // A line being drawn with the Route tool (1.1).
  const drawingLine = edit?.draft.kind === "line-new" ? edit.draft : null;
  // An edit made in a dialog on a line (deleted, its fields, its service):
  // its Apply bar alone, nothing open above it.
  const lineDialogEdit =
    edit?.draft.kind === "line-delete" || edit?.draft.kind === "route-details" || isServiceDraft(edit?.draft);
  if (!item && !placing && !inserting && !rerouting && !extending && !drawingLine && !lineDialogEdit)
    return null;
  // A draft that fills the panel (a new stop, a stop added to a line) is the
  // edit itself: its fields and its confirmation one panel. Any other edit is
  // made on the item shown, its confirmation a panel of its own under it.
  // Both as every other floating panel: no outline or glow of their own.
  const whole = !!(placing || inserting || rerouting || extending || drawingLine);
  const applyBar = edit && (
    <ApplyBar
      edit={edit}
      titled={!whole}
      // Adding a stop to a line, or rerouting a path, asks how far it
      // reaches first, at the top.
      scoped={!inserting && !rerouting && !extending}
      // What a delete takes, at the top: read before its cost.
      impact={
        edit.building?.kind === "stop-delete" ? (
          <DeleteStopCascade edit={edit} routeByIdx={routeByIdx} />
        ) : edit.building?.kind === "line-delete" ? (
          <DeleteLineCascade edit={edit} routeByIdx={routeByIdx} />
        ) : isServiceDraft(edit.draft) ? (
          <ServiceEffectCard edit={edit} />
        ) : null
      }
    />
  );

  return (
    <DraftEditContext.Provider value={edit}>
      {/* The item, and under it, while an edit is made, its confirmation as
          a panel of its own, as the left panel has the operating cost. */}
      <Stack spacing={2} sx={{ height: "100%", width: EXPLORER_RIGHT_PANEL_WIDTH, pointerEvents: "none" }}>
        {(item || whole) && (
          <FloatingPanel
            width={EXPLORER_RIGHT_PANEL_WIDTH}
            maxHeight="100%"
            minHeight={0}
            sx={{ flex: 1, minHeight: 0 }}>
            {/* The back link starts on the panel's content line: its own padding
          (0.5) and the row's (2) make the content's (PX). */}
            <Stack
              direction="row"
              alignItems="center"
              spacing={0.5}
              sx={{ pl: 2, pr: 1.5, pt: 1, minHeight: 36 }}>
              <Box sx={{ flex: 1, minWidth: 0, display: "flex" }}>
                {previous ? (
                  // Back to the item this one was opened from.
                  <ButtonBase
                    onClick={() => dispatch(explorerPanelBack())}
                    sx={{
                      gap: ICON_GAP,
                      color: "text.secondary",
                      borderRadius: 1,
                      px: 0.5,
                      maxWidth: "100%",
                    }}>
                    <Icon iconName={ICON_NAME.CHEVRON_LEFT} style={{ fontSize: 11 }} />
                    <Typography variant="caption" noWrap>
                      {previousName}
                    </Typography>
                  </ButtonBase>
                ) : fromRoute ? (
                  // The route it belongs to, open in the left panel.
                  <Stack direction="row" spacing={ICON_GAP} alignItems="center" sx={{ px: 0.5, minWidth: 0 }}>
                    <RouteBadge route={fromRoute} small />
                    <Typography variant="caption" color="text.secondary" noWrap>
                      {routeName(fromRoute, t)}
                    </Typography>
                  </Stack>
                ) : null}
              </Box>
              <Tooltip title={t("explorer_panel_close")}>
                <IconButton
                  size="small"
                  aria-label={t("explorer_panel_close")}
                  onClick={() => dispatch(closeExplorerPanel())}>
                  <Icon iconName={ICON_NAME.XCLOSE} style={{ fontSize: 14 }} htmlColor="inherit" />
                </IconButton>
              </Tooltip>
            </Stack>
            <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
              {placing ? (
                <NewStopPanel draft={placing} />
              ) : inserting ? (
                <InsertStopPanel draft={inserting} />
              ) : rerouting ? (
                <ReroutePanel draft={rerouting} />
              ) : extending ? (
                <ExtendPanel draft={extending} />
              ) : drawingLine ? (
                <NewLinePanel draft={drawingLine} />
              ) : item?.kind === "stop" ? (
                <StopPanel key={item.stop.stop_idx} stop={item.stop} />
              ) : item ? (
                <TripPanel
                  key={`${item.trip_idx}:${item.run_dep_s}`}
                  trip_idx={item.trip_idx}
                  run_dep_s={item.run_dep_s}
                />
              ) : null}
            </Box>
            {/* The draft's confirmation at its foot, set off by a line. */}
            {whole && <Box sx={{ borderTop: 1, borderColor: "divider", flexShrink: 0 }}>{applyBar}</Box>}
          </FloatingPanel>
        )}
        {edit && !whole && (
          <FloatingPanel width={EXPLORER_RIGHT_PANEL_WIDTH} minHeight={0} sx={{ flexShrink: 0 }}>
            {applyBar}
          </FloatingPanel>
        )}
      </Stack>
    </DraftEditContext.Provider>
  );
}
