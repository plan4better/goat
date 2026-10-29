/**
 * The Explorer's right panel (02-panel-behaviour-spec › Panel regions,
 * Viewers): one item at a time — a stop's timetable (board 13) or a trip
 * (board 7) — opened from the lists, the map, or one another. "‹" goes back
 * to the item it was opened from, × closes it. It does not fold away
 * (dropped 20 Oct 2026): closed, it is opened again from where it came.
 */
import { Box, ButtonBase, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import { memo } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { clock } from "@/lib/explorer/format";
import {
  type ExplorerPanelItem,
  closeExplorerPanel,
  explorerPanelBack,
  panelItem,
} from "@/lib/store/explorer/slice";

import { useRoutes, useTripDetail } from "@/hooks/explorer/useExplorerData";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { FloatingPanel } from "@/components/common/FloatingPanel";
import { useExplorer } from "@/components/explorer/ExplorerContext";
import { RouteBadge, routeName } from "@/components/explorer/RouteBadge";
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
  const fromRoute = useRoutes(useExplorer().db).data?.find((r) => r.route_id === panel.fromRoute);
  const previousName = useItemName(previous);
  if (!item) return null;

  return (
    <FloatingPanel width={EXPLORER_RIGHT_PANEL_WIDTH} maxHeight="100%" fillHeight>
      {/* The back link starts on the panel's content line: its own padding
          (0.5) and the row's (2) make the content's (PX). */}
      <Stack direction="row" alignItems="center" spacing={0.5} sx={{ pl: 2, pr: 1.5, pt: 1, minHeight: 36 }}>
        <Box sx={{ flex: 1, minWidth: 0, display: "flex" }}>
          {previous ? (
            // Back to the item this one was opened from.
            <ButtonBase
              onClick={() => dispatch(explorerPanelBack())}
              sx={{ gap: 0.75, color: "text.secondary", borderRadius: 1, px: 0.5, maxWidth: "100%" }}>
              <Icon iconName={ICON_NAME.CHEVRON_LEFT} style={{ fontSize: 11 }} />
              <Typography variant="caption" noWrap>
                {previousName}
              </Typography>
            </ButtonBase>
          ) : fromRoute ? (
            // The route it belongs to, open in the left panel.
            <Stack direction="row" spacing={0.75} alignItems="center" sx={{ px: 0.5, minWidth: 0 }}>
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
        {item.kind === "stop" ? (
          <StopPanel key={item.stop.stop_idx} stop={item.stop} />
        ) : (
          <TripPanel
            key={`${item.trip_idx}:${item.run_dep_s}`}
            trip_idx={item.trip_idx}
            run_dep_s={item.run_dep_s}
          />
        )}
      </Box>
    </FloatingPanel>
  );
}
