/**
 * Reroute a path (1.2): the line and direction, how far it reaches, and the
 * path as the Stops tab draws it: the stop before, the stretch drawn anew
 * (dotted, as the map previews it, with how many points it runs through and
 * what it gains), the stop after. The points are dragged on the map
 * (ExplorerEditLayers). The Apply bar at the panel's foot says what it costs.
 */
import { Box, Stack, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { useTranslation } from "react-i18next";

import type { EditDraft } from "@/lib/explorer/edit/drafts";
import { modeOf, routeColor } from "@/lib/explorer/modes";

import { useDraftEditShown } from "@/hooks/explorer/useDraftEdit";
import { useRoutes } from "@/hooks/explorer/useExplorerData";
import { useAppSelector } from "@/hooks/store/ContextHooks";

import { useExplorer } from "@/components/explorer/ExplorerContext";
import { RAIL, Rail, StopDot } from "@/components/explorer/LineDiagram";
import { RouteBadge } from "@/components/explorer/RouteBadge";
import { PX } from "@/components/explorer/SectionHeader";
import { directionLabel } from "@/components/explorer/directionWords";
import { ScopePicker } from "@/components/explorer/edit/ScopePicker";

type Rerouting = Extract<EditDraft, { kind: "line-reroute" }>;

export function ReroutePanel({ draft }: { draft: Rerouting }) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const { db } = useExplorer();
  const edit = useDraftEditShown();
  const route = useRoutes(db).data?.find((r) => r.route_idx === draft.scope.route_idx);
  const color = route ? routeColor(route.color, modeOf(route.route_type)) : theme.palette.text.disabled;
  const drawing = useAppSelector((s) => s.explorer.drawing);
  const direction = drawing?.directions.find((d) => d.patterns.includes(draft.scope.pattern_idx));
  const path = useAppSelector((s) => s.explorer.path);
  const facts = edit?.building?.kind === "line-reroute" && edit.built?.ok ? edit.building.built.facts : null;
  const names = [facts?.from_name ?? path?.from_name ?? "…", facts?.to_name ?? path?.to_name ?? "…"];
  const m = Math.round(facts?.metres ?? 0);
  const gained =
    m > 0
      ? t("explorer_path_longer", { metres: m })
      : m < 0
        ? t("explorer_path_shorter", { metres: -m })
        : null;

  const stop = (name: string) => (
    <Stack direction="row" alignItems="center" spacing={1.5} sx={{ minHeight: 32 }}>
      <Box sx={{ position: "relative", width: RAIL, alignSelf: "stretch", flexShrink: 0 }}>
        <Rail color={color} top bottom />
        <StopDot color={color} end={false} />
      </Box>
      <Typography variant="body2" fontWeight={500} noWrap sx={{ flex: 1, minWidth: 0 }} title={name}>
        {name}
      </Typography>
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
          {t("explorer_reroute_path")}
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
        <Box sx={{ position: "relative", width: RAIL, height: 12 }}>
          <Rail color={color} top bottom />
        </Box>
        {stop(names[0])}
        {/* The stretch drawn anew: dotted, as on the map. */}
        <Stack direction="row" alignItems="center" spacing={1.5} sx={{ minHeight: 40 }}>
          <Box sx={{ position: "relative", width: RAIL, alignSelf: "stretch", flexShrink: 0 }}>
            <Box
              sx={{
                position: "absolute",
                left: RAIL / 2 - 2,
                top: 0,
                bottom: 0,
                width: 4,
                backgroundImage: `radial-gradient(circle, ${color} 2px, transparent 2.5px)`,
                backgroundSize: "4px 8px",
              }}
            />
          </Box>
          <Typography variant="caption" color="text.secondary" noWrap sx={{ flex: 1, minWidth: 0 }}>
            {[t("explorer_reroute_points", { count: draft.via.length }), gained].filter(Boolean).join(" · ")}
          </Typography>
        </Stack>
        {stop(names[1])}
        <Box sx={{ position: "relative", width: RAIL, height: 12 }}>
          <Rail color={color} top bottom />
        </Box>
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
          {t("explorer_reroute_hint")}
        </Typography>
      </Box>
    </Stack>
  );
}
