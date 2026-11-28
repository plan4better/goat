/**
 * Extend a line (1.3): the line and direction, how far it reaches, and the
 * line's end as the Stops tab draws it: the terminus, the stops it runs on
 * to (each can be taken off again), and where the next is chosen, nearest
 * the last first, or on the map (a crosshair until the edit is applied).
 * Under them, how the new end is timed. The Apply bar at the panel's foot
 * says what it costs.
 */
import { Box, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { EditDraft } from "@/lib/explorer/edit/drafts";
import { metres } from "@/lib/explorer/edit/ops/geo";
import { modeOf, routeColor } from "@/lib/explorer/modes";
import { setEditDraft } from "@/lib/store/explorer/slice";
import { setMapCursor } from "@/lib/store/map/slice";

import { useDraftEditShown } from "@/hooks/explorer/useDraftEdit";
import { type LocationRow, useLocationsOfType, useRoutes } from "@/hooks/explorer/useExplorerData";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { useExplorer } from "@/components/explorer/ExplorerContext";
import { RAIL, Rail, StopDot } from "@/components/explorer/LineDiagram";
import { RouteBadge } from "@/components/explorer/RouteBadge";
import { PX } from "@/components/explorer/SectionHeader";
import { StopMarker } from "@/components/explorer/StopMarker";
import { directionLabel } from "@/components/explorer/directionWords";
import { ScopePicker } from "@/components/explorer/edit/ScopePicker";
import { NearestPicker } from "@/components/explorer/edit/StopDetails";

type Extending = Extract<EditDraft, { kind: "line-extend" }>;

export function ExtendPanel({ draft }: { draft: Extending }) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const dispatch = useAppDispatch();
  const { db } = useExplorer();
  const edit = useDraftEditShown();
  const route = useRoutes(db).data?.find((r) => r.route_idx === draft.scope.route_idx);
  const color = route ? routeColor(route.color, modeOf(route.route_type)) : theme.palette.text.disabled;
  const drawing = useAppSelector((s) => s.explorer.drawing);
  const direction = drawing?.directions.find((d) => d.patterns.includes(draft.scope.pattern_idx));
  const facts = edit?.building?.kind === "line-extend" && edit.built?.ok ? edit.building.built.facts : null;

  const stops = useLocationsOfType(db, 0);
  const byIdx = useMemo(() => new Map((stops.data ?? []).map((s) => [s.stop_idx, s])), [stops.data]);
  const options = useMemo(
    () => (stops.data ?? []).filter((s) => s.stop_idx !== draft.stop_idx && !draft.adds.includes(s.stop_idx)),
    [stops.data, draft.stop_idx, draft.adds]
  );
  // Nearest the stop it would run on from first: the last added, else the terminus.
  const from = byIdx.get(draft.adds[draft.adds.length - 1] ?? draft.stop_idx);
  const away = useCallback(
    (o: LocationRow) =>
      o.lon !== null && o.lat !== null && from?.lon != null && from?.lat != null
        ? metres([o.lon, o.lat], [from.lon, from.lat])
        : null,
    [from]
  );

  // A crosshair: a stop clicked on the map is the next one.
  useEffect(() => {
    dispatch(setMapCursor("crosshair"));
    return () => {
      dispatch(setMapCursor(undefined));
    };
  }, [dispatch]);

  const set = (adds: number[]) => dispatch(setEditDraft({ ...draft, adds }));
  const terminus = { key: "t", stop: draft.stop_idx, fresh: false };
  const added = draft.adds.map((a, j) => ({ key: `a${j}`, stop: a, fresh: true, j }));
  // In the trips' order: the terminus first at the end, last at the start.
  const rows = draft.end === "end" ? [terminus, ...added] : [...[...added].reverse(), terminus];
  const picker = (
    <Stack key="pick" direction="row" alignItems="center" spacing={1.5} sx={{ minHeight: 32 }}>
      <Box sx={{ position: "relative", width: RAIL, alignSelf: "stretch", flexShrink: 0 }}>
        <Rail color={color} top={draft.end === "end"} bottom={draft.end === "start"} />
        <StopDot color={theme.palette.primary.main} end={false} />
      </Box>
      <Box sx={{ flex: 1, minWidth: 0, py: 0.5 }}>
        <NearestPicker
          // Empty again for the next stop, once one is added.
          key={draft.adds.length}
          options={options}
          loading={stops.loading}
          away={away}
          value={null}
          onChange={(s) => s !== null && set([...draft.adds, s])}
          mark={<StopMarker size={10} />}
          label={t("explorer_extend_add")}
          placeholder={t("explorer_insert_choose")}
          noOptions={t("explorer_no_stops")}
        />
      </Box>
    </Stack>
  );

  return (
    <Stack sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
      <Box sx={{ px: PX, pt: 0.5, pb: 1.5 }}>
        <Typography
          variant="caption"
          color="text.secondary"
          fontWeight={700}
          display="block"
          sx={{ mb: 0.25 }}>
          {t("explorer_extend_line")}
        </Typography>
        {route && (
          <Stack direction="row" spacing={1.25} alignItems="center">
            <RouteBadge route={route} />
            {direction && (
              <Typography variant="h6" fontWeight="bold" noWrap sx={{ fontSize: 17, minWidth: 0 }}>
                {directionLabel(direction.name, t)}
              </Typography>
            )}
          </Stack>
        )}
      </Box>
      {edit?.scope && (
        <Box sx={{ px: PX, pb: 1.5 }}>
          <ScopePicker scope={edit.scope} />
        </Box>
      )}
      <Box sx={{ px: PX, pb: 2 }}>
        {draft.end === "start" && picker}
        {rows.map((r, n) => {
          const name = byIdx.get(r.stop)?.name ?? "…";
          // The line's own end runs on into it; the outermost stop is the end.
          const outer = draft.end === "end" ? n === rows.length - 1 : n === 0;
          return (
            <Stack
              key={r.key}
              className="ext"
              direction="row"
              alignItems="center"
              spacing={1.5}
              sx={{ minHeight: 32 }}>
              <Box sx={{ position: "relative", width: RAIL, alignSelf: "stretch", flexShrink: 0 }}>
                <Rail color={color} top bottom />
                <StopDot color={r.fresh ? theme.palette.primary.main : color} end={!r.fresh && outer} />
              </Box>
              <Typography
                variant="body2"
                fontWeight={r.fresh ? 500 : 700}
                noWrap
                title={name}
                sx={{ flex: 1, minWidth: 0 }}>
                {name}
              </Typography>
              {"j" in r && (
                <Tooltip title={t("explorer_extend_remove")} placement="top">
                  <IconButton
                    size="small"
                    aria-label={t("explorer_extend_remove")}
                    onClick={() => set(draft.adds.filter((_, x) => x !== r.j))}
                    sx={{ color: "text.secondary" }}>
                    <Icon iconName={ICON_NAME.XCLOSE} style={{ fontSize: 11 }} htmlColor="inherit" />
                  </IconButton>
                </Tooltip>
              )}
            </Stack>
          );
        })}
        {draft.end === "end" && picker}
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
          {t("explorer_insert_or_map")}
        </Typography>
        {facts && draft.adds.length > 0 && (
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
            {t("explorer_extend_timed", {
              minutes: Math.max(1, Math.round(facts.seconds / 60)),
              speed: facts.speed_kmh,
            })}
            {draft.adds.length > 1 && ` ${t("explorer_extend_untimed_between")}`}
          </Typography>
        )}
      </Box>
    </Stack>
  );
}
