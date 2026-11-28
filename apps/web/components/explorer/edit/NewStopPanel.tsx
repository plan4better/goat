/**
 * A location being placed with the Stop tool (board 18), in the right
 * panel: its GTFS fields filled in before it is created, its id drawn
 * unused. It joins the network only on Create (the Apply bar
 * under it); a stop is served once a line calls there, added from the line
 * (3.1), never on placing.
 */
import { Box, Stack, Typography } from "@mui/material";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import type { EditDraft } from "@/lib/explorer/edit/drafts";
import { newStopId } from "@/lib/explorer/edit/ops/stops";
import { presetNewStopId, setEditDraft } from "@/lib/store/explorer/slice";

import { useDraftEditShown } from "@/hooks/explorer/useDraftEdit";
import { useAppDispatch } from "@/hooks/store/ContextHooks";

import { useExplorer } from "@/components/explorer/ExplorerContext";
import { PX } from "@/components/explorer/SectionHeader";
import { StopMarker } from "@/components/explorer/StopMarker";
import { DetailsSection, StopFields, TypeSections } from "@/components/explorer/edit/StopDetails";
import { PanelKind } from "@/components/explorer/right/PanelKind";

/** What the panel calls a new location, by its type. */
const KIND = { 0: "stop", 1: "station", 2: "entrance" } as const;

export function NewStopPanel({ draft }: { draft: Extract<EditDraft, { kind: "stop-new" }> }) {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const { db } = useExplorer();
  const edit = useDraftEditShown();
  // An id no stop of the feed has.
  const needsId = draft.stop_id === null;
  useEffect(() => {
    if (!db || !needsId) return;
    let current = true;
    newStopId(db)
      .then((id) => current && dispatch(presetNewStopId(id)))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [db, needsId, dispatch]);

  const kind = KIND[draft.values.location_type as keyof typeof KIND] ?? "stop";
  const refused = edit?.draft.kind === "stop-new" && edit.built && !edit.built.ok ? edit.built.refused : null;
  return (
    <Stack sx={{ flex: 1, minHeight: 0 }}>
      <Box sx={{ px: PX, pt: 0.5, pb: 1.5, borderBottom: 1, borderColor: "divider" }}>
        <PanelKind kind={kind} />
        <Stack direction="row" spacing={1.25} alignItems="center">
          <StopMarker />
          <Typography variant="h6" fontWeight="bold" noWrap sx={{ fontSize: 17 }}>
            {draft.values.name.trim() || t(`explorer_new_${kind}`)}
          </Typography>
        </Stack>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", pb: 2 }}>
        <DetailsSection first ruled icon={ICON_NAME.EDIT} label={t("explorer_stop_tab_properties")}>
          <StopFields
            autoFocus
            values={draft.values}
            onChange={(next) => dispatch(setEditDraft({ ...draft, values: { ...draft.values, ...next } }))}
            refused={refused}
            lat={draft.lat}
            lon={draft.lon}
            onLocation={(lon, lat) => dispatch(setEditDraft({ ...draft, lon, lat }))}
          />
        </DetailsSection>
        <TypeSections type={draft.values.location_type} stop_idx={null} lines={[]} />
      </Box>
    </Stack>
  );
}
