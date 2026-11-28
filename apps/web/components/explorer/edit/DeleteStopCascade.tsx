/**
 * Deleting a location (board 29), shown at the top of the Apply bar, over
 * its cost, while the delete waits there: the lines it affects, by their
 * badges (a stop's, those it is taken off; a station's, those calling at its
 * stops and platforms); for a station, how many of each kind of location
 * under it are deleted with it (its stops and platforms, its entrances and
 * nodes). Or that it is not possible (why is said in a toast).
 */
import { Box, Stack, Typography, alpha } from "@mui/material";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { locationKind } from "@/lib/explorer/edit/ops/stopRules";

import type { DraftEdit } from "@/hooks/explorer/useDraftEdit";
import type { RouteRow } from "@/hooks/explorer/useExplorerData";

import { RouteBadge, distinctLines, lineKey } from "@/components/explorer/RouteBadge";
import { ICON_GAP } from "@/components/explorer/SectionHeader";

function Heading({ children }: { children: string }) {
  return (
    <Typography
      variant="caption"
      color="text.secondary"
      fontWeight={700}
      display="block"
      sx={{ mt: 1, mb: 0.5 }}>
      {children}
    </Typography>
  );
}

export function DeleteStopCascade({
  edit,
  routeByIdx,
}: {
  edit: DraftEdit;
  routeByIdx: Map<number, RouteRow>;
}) {
  const { t } = useTranslation("common");
  const building = edit.building;
  if (building?.kind !== "stop-delete") return null;
  // An entrance or node takes nothing with it: no card.
  if (building.built.facts && building.built.facts.location_type > 1) return null;
  const built = building.built;
  const f = built.facts;
  const lines = f ? distinctLines(f.routes.map((i) => routeByIdx.get(i))) : [];
  return (
    <Box
      sx={(theme) => ({
        // In the Apply bar, on its edges; clear of the cost's header below.
        mt: "12px",
        mb: "4px",
        px: "12px",
        py: "10px",
        borderRadius: 1.5,
        border: 1,
        borderColor: alpha(theme.palette.error.main, 0.35),
        bgcolor: alpha(theme.palette.error.main, 0.05),
      })}>
      <Stack direction="row" alignItems="center" spacing={ICON_GAP} sx={{ color: "error.main" }}>
        <Icon iconName={ICON_NAME.TRASH} style={{ fontSize: 12 }} htmlColor="inherit" />
        <Typography variant="body2" fontWeight={700} color="inherit" sx={{ flex: 1 }}>
          {t(`explorer_delete_${locationKind(f?.location_type)}`)}
        </Typography>
        {!built.ok && (
          <Typography variant="caption" fontWeight={700} color="inherit">
            {t("explorer_not_possible")}
          </Typography>
        )}
      </Stack>
      {built.ok && (f?.location_type === 0 || f?.location_type === 1) && (
        <>
          <Heading>{t("explorer_affected_lines")}</Heading>
          {lines.length ? (
            // The lines' badges alone, as the stop panel's Lines row has them.
            <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.75}>
              {lines.map((r) => (
                <RouteBadge key={lineKey(r)} route={r} small />
              ))}
            </Stack>
          ) : (
            <Typography variant="caption" color="text.secondary" display="block">
              {t("explorer_no_lines")}
            </Typography>
          )}
        </>
      )}
      {built.ok &&
        f?.location_type === 1 &&
        (
          [
            ["explorer_affected_platforms", f.platforms],
            ["explorer_affected_entrances", f.entrances],
            ["explorer_affected_nodes", f.nodes],
          ] as const
        )
          // Generic nodes only where there are any: few feeds have them.
          .filter(([key, count]) => count > 0 || key !== "explorer_affected_nodes")
          .map(([key, count]) => (
            <Box key={key}>
              <Heading>{t(key)}</Heading>
              <Typography variant="caption" color="text.secondary" display="block">
                {count}
              </Typography>
            </Box>
          ))}
    </Box>
  );
}
