/**
 * Add stop to line (3.1): the line and direction, and where the stop goes,
 * as the Stops tab draws the line: the stop before, the new one, the stop
 * after, the rail running on either side. The stop is chosen in its place
 * on the line — nearest the stretch first, as a stop's station is chosen —
 * or on the map, the cursor a crosshair until one is (the map fits the
 * stretch: ExplorerMapLayers). The Apply bar at the panel's foot says how far the edit reaches
 * and what it costs.
 */
import { Box, Stack, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

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

type Adding = Extract<EditDraft, { kind: "line-stop-add" }>;
type LonLat = [number, number];

/** How far `p` is from the straight stretch from `a` to `b`, in metres. */
function fromStretch(p: LonLat, a: LonLat, b: LonLat): number {
  const k = Math.cos((p[1] * Math.PI) / 180) * 111_320;
  const xy = (q: LonLat) => [(q[0] - p[0]) * k, (q[1] - p[1]) * 110_540];
  const [ax, ay] = xy(a);
  const [bx, by] = xy(b);
  const len = (bx - ax) ** 2 + (by - ay) ** 2;
  const f = len > 0 ? Math.max(0, Math.min(1, -(ax * (bx - ax) + ay * (by - ay)) / len)) : 0;
  return metres(p, [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])]);
}

const at = (s: LocationRow | undefined): LonLat | null =>
  s && s.lon !== null && s.lat !== null ? [s.lon, s.lat] : null;

export function InsertStopPanel({ draft }: { draft: Adding }) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const dispatch = useAppDispatch();
  const { db } = useExplorer();
  const edit = useDraftEditShown();
  const route = useRoutes(db).data?.find((r) => r.route_idx === draft.scope.route_idx);
  const color = route ? routeColor(route.color, modeOf(route.route_type)) : theme.palette.text.disabled;
  // The direction of the variant shown, as the line's drawing names it.
  const drawing = useAppSelector((s) => s.explorer.drawing);
  const direction = drawing?.directions.find((d) => d.patterns.includes(draft.scope.pattern_idx));

  // Every stop or platform; the two it goes between, and the rest to pick.
  const stops = useLocationsOfType(db, 0);
  const byIdx = useMemo(() => new Map((stops.data ?? []).map((s) => [s.stop_idx, s])), [stops.data]);
  const [a, b] = [byIdx.get(draft.a), byIdx.get(draft.b)];
  const [from, to] = [at(a), at(b)];
  const options = useMemo(
    () => (stops.data ?? []).filter((s) => s.stop_idx !== draft.a && s.stop_idx !== draft.b),
    [stops.data, draft.a, draft.b]
  );
  // Nearest the stretch it goes on first.
  const away = useCallback(
    (o: LocationRow) => {
      const p = at(o);
      return p && from && to ? fromStretch(p, from, to) : null;
    },
    [from, to]
  );

  // A crosshair while a stop is to be picked.
  const picking = draft.stop_idx === null;
  useEffect(() => {
    if (!picking) return;
    dispatch(setMapCursor("crosshair"));
    return () => {
      dispatch(setMapCursor(undefined));
    };
  }, [picking, dispatch]);

  const rows = [
    { key: "a", name: a?.name ?? "…", fresh: false },
    { key: "new", name: "", fresh: true },
    { key: "b", name: b?.name ?? "…", fresh: false },
  ];

  return (
    <Stack sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
      <Box sx={{ px: PX, pt: 0.5, pb: 1.5 }}>
        <Typography
          variant="caption"
          color="text.secondary"
          fontWeight={700}
          display="block"
          sx={{ mb: 0.25 }}>
          {t("explorer_add_stop_to_line")}
        </Typography>
        {/* The line and the direction it is added to, as a trip's header
            has them: the badge, then "→ place". */}
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
      {/* How far it reaches, asked first. */}
      {edit?.scope && (
        <Box sx={{ px: PX, pb: 1.5 }}>
          <ScopePicker scope={edit.scope} />
        </Box>
      )}
      <Box sx={{ px: PX, pb: 2 }}>
        {/* Where it goes: the line clipped round it, as the Stops tab draws
            it; the rail running on above and below. */}
        <Box sx={{ position: "relative", width: RAIL, height: 12 }}>
          <Rail color={color} top bottom />
        </Box>
        {rows.map((r) => (
          <Stack key={r.key} direction="row" alignItems="center" spacing={1.5} sx={{ minHeight: 32 }}>
            <Box sx={{ position: "relative", width: RAIL, alignSelf: "stretch", flexShrink: 0 }}>
              <Rail color={color} top bottom />
              <StopDot color={r.fresh ? theme.palette.primary.main : color} end={false} />
            </Box>
            {r.fresh ? (
              // The stop, chosen in its place on the line, or on the map.
              <Box sx={{ flex: 1, minWidth: 0, py: 0.5 }}>
                <NearestPicker
                  options={options}
                  loading={stops.loading}
                  away={away}
                  value={draft.stop_idx}
                  onChange={(stop_idx) => dispatch(setEditDraft({ ...draft, stop_idx }))}
                  mark={<StopMarker size={10} />}
                  label={t("explorer_add_stop_to_line")}
                  placeholder={t("explorer_insert_choose")}
                  noOptions={t("explorer_no_stops")}
                />
              </Box>
            ) : (
              <Typography variant="body2" fontWeight={500} noWrap sx={{ flex: 1, minWidth: 0 }}>
                {r.name}
              </Typography>
            )}
          </Stack>
        ))}
        <Box sx={{ position: "relative", width: RAIL, height: 12 }}>
          <Rail color={color} top bottom />
        </Box>
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
          {t("explorer_insert_or_map")}
        </Typography>
      </Box>
    </Stack>
  );
}
