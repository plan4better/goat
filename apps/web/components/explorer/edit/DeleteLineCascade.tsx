/**
 * Deleting a line (1.5), shown at the top of the Apply bar, over its cost,
 * as a stop's delete card is: the line by its badge, the trips and paths
 * that go with it, and, where some of its stops no other line serves, the
 * choice to delete those too (unticked: a stop no trip serves is no error).
 */
import { Box, Checkbox, FormControlLabel, Stack, Typography, alpha } from "@mui/material";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { setEditDraft } from "@/lib/store/explorer/slice";

import type { DraftEdit } from "@/hooks/explorer/useDraftEdit";
import type { RouteRow } from "@/hooks/explorer/useExplorerData";
import { useAppDispatch } from "@/hooks/store/ContextHooks";

import { RouteBadge } from "@/components/explorer/RouteBadge";
import { CHECKBOX_SX, ICON_GAP } from "@/components/explorer/SectionHeader";

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

export function DeleteLineCascade({
  edit,
  routeByIdx,
}: {
  edit: DraftEdit;
  routeByIdx: Map<number, RouteRow>;
}) {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const draft = edit.draft;
  if (edit.building?.kind !== "line-delete" || draft.kind !== "line-delete") return null;
  const f = edit.building.built.facts;
  const route = routeByIdx.get(draft.route_idx);
  return (
    <Box
      sx={(theme) => ({
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
          {t("explorer_delete_line")}
        </Typography>
        {route && <RouteBadge route={route} small />}
      </Stack>
      {f && (
        <>
          <Heading>{t("explorer_affected_trips")}</Heading>
          <Typography variant="caption" color="text.secondary" display="block">
            {f.trips}
          </Typography>
          <Heading>{t("explorer_affected_paths")}</Heading>
          <Typography variant="caption" color="text.secondary" display="block">
            {f.paths}
          </Typography>
          {f.only_here > 0 ? (
            <FormControlLabel
              // The box centred on its one line of words.
              sx={{ mt: 1, mx: 0, gap: ICON_GAP, alignItems: "center" }}
              control={
                <Checkbox
                  size="small"
                  color="error"
                  checked={draft.stops}
                  onChange={(e) => dispatch(setEditDraft({ ...draft, stops: e.target.checked }))}
                  sx={CHECKBOX_SX}
                />
              }
              label={
                <Typography variant="caption" sx={{ display: "block" }}>
                  {t("explorer_line_delete_stops", { count: f.only_here })}
                </Typography>
              }
            />
          ) : (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
              {t("explorer_line_delete_no_stops")}
            </Typography>
          )}
        </>
      )}
    </Box>
  );
}
