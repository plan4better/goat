/**
 * A service edit in the Apply bar (4.1, 4.2, 5.2), under its change row
 * (which names the direction and what it sets): per group of service
 * patterns it changes, the line's trips a day and peak vehicles before and
 * after it, on a day of the group. Edit brings the service dialog back with
 * what was set.
 */
import { Box, Button, Stack, Typography } from "@mui/material";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { isServiceDraft } from "@/lib/explorer/edit/drafts";
import { setServiceDialog } from "@/lib/store/explorer/slice";

import type { DraftEdit } from "@/hooks/explorer/useDraftEdit";
import { useAppDispatch } from "@/hooks/store/ContextHooks";

import { SectionHeader } from "@/components/explorer/SectionHeader";

export function ServiceEffectCard({ edit }: { edit: DraftEdit }) {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const draft = edit.draft;
  if (!isServiceDraft(draft)) return null;
  const effect = edit.bar?.service;
  const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  const figure = (label: string, [a, b]: [number, number]) => (
    <Stack direction="row" alignItems="baseline" spacing={1}>
      <Typography variant="caption" color="text.secondary" sx={{ flex: 1, minWidth: 0 }}>
        {label}
      </Typography>
      <Typography variant="body2" sx={{ fontVariantNumeric: "tabular-nums" }}>
        {`${a} → ${b}`}
      </Typography>
      <Typography
        variant="body2"
        fontWeight={700}
        sx={{ fontVariantNumeric: "tabular-nums", minWidth: 32, textAlign: "right" }}>
        {b === a ? "±0" : signed(b - a)}
      </Typography>
    </Stack>
  );
  return (
    <Box sx={{ mb: 1 }}>
      <SectionHeader
        icon={ICON_NAME.CLOCK}
        label={t(`explorer_service_tab_${draft.kind.slice(5)}`)}
        px={0}
        aside={
          <Button
            size="small"
            variant="text"
            onClick={() =>
              dispatch(setServiceDialog({ route_idx: draft.route_idx, direction: draft.direction.key }))
            }
            sx={{ fontWeight: 700, textTransform: "none", minWidth: 0, px: 1, mr: -1 }}>
            {t("edit")}
          </Button>
        }
      />
      <Stack spacing={1} sx={{ mt: 1 }}>
        {(effect ?? draft.group_names.map((name) => ({ name, trips: null, vehicles: null }))).map((e, i) => (
          <Fragment key={i}>
            <Box sx={{ borderTop: 1, borderColor: "divider", pt: 0.75 }}>
              <Typography variant="body2" fontWeight={600} noWrap>
                {e.name}
              </Typography>
              {e.trips && e.vehicles ? (
                <>
                  {figure(t("explorer_trips_a_day_label"), e.trips)}
                  {figure(t("explorer_peak_vehicles"), e.vehicles)}
                </>
              ) : (
                <Typography variant="caption" color="text.secondary">
                  {t("explorer_calculating")}
                </Typography>
              )}
            </Box>
          </Fragment>
        ))}
      </Stack>
    </Box>
  );
}
