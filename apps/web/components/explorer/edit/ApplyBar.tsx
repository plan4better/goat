/**
 * The Apply bar (spec 01, Interaction model; boards 18, 23, 29): where every
 * edit ends, a panel of its own under the right panel. For an edit on a line, how far
 * it reaches (Apply to); what it takes with it (a delete's card), its ≈
 * cost; Cancel, and the
 * edit's own action, greyed out while it is refused (why is said once, in a
 * toast: useDraftEdit).
 * What else an edit changes is the panel's to show, in sections of its own
 * kind (a stop's delete card).
 */
import { Box, Button, Stack, Typography, alpha } from "@mui/material";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import type { DraftEdit } from "@/hooks/explorer/useDraftEdit";

import { PX, SectionHeader } from "@/components/explorer/SectionHeader";
import { FixedScope, ScopePicker } from "@/components/explorer/edit/ScopePicker";

export function ApplyBar({
  edit,
  impact,
  titled = true,
  scoped = true,
}: {
  edit: DraftEdit;
  impact?: ReactNode;
  /** Its own title; none at the foot of a draft's panel, which has one. */
  titled?: boolean;
  /** Its Apply to; none where the draft's panel asks it first. */
  scoped?: boolean;
}) {
  const { t } = useTranslation("common");
  const { built, bar, applying } = edit;
  const nothing = built?.ok ? !built.rows.sql.length : true;

  return (
    // A panel of its own under the right panel, as the operating cost is
    // under the left. Less above than below: the first section header's own
    // row (32 px) already sets its name off the panel's edge.
    <Box sx={{ px: PX, pt: titled ? "4px" : "8px", pb: "12px" }}>
      {/* Its title, as the panels' section headers and the edits list's. */}
      {titled && <SectionHeader icon={ICON_NAME.EDIT} label={t("explorer_edit_panel")} px={0} />}
      {/* The edit as the change list will keep it: its name, and what else
          it changes. A destructive one on the delete cards' red ground,
          unless it has a card of its own below. */}
      {titled && edit.words && <ChangeRow words={edit.words} danger={!!bar?.danger && !impact} />}
      {/* How far an edit on a line reaches, then what it takes with it,
          where it has a card for it. */}
      {scoped && edit.scope && <ScopePicker scope={edit.scope} />}
      {(edit.building?.kind === "stop-move" || edit.building?.kind === "stop-delete") &&
        edit.building.built.facts &&
        edit.building.built.facts.trips > 0 && (
          <FixedScope
            lines={edit.building.built.facts.routes.length}
            trips={edit.building.built.facts.trips}
          />
        )}
      {impact}
      {/* As the operating cost card: its coins, and the change a year in
          the card's step figures. */}
      <Box>
        <SectionHeader icon={ICON_NAME.COINS} label={t("explorer_operating_cost")} px={0} />
        {bar?.costs ? (
          <Stack direction="row" alignItems="center" spacing={1} sx={{ minHeight: 24 }}>
            <Typography variant="caption" color="text.secondary" sx={{ flex: 1, minWidth: 0 }}>
              {t("explorer_cost_change")}
            </Typography>
            <Typography
              fontWeight="bold"
              noWrap
              sx={{ fontSize: 14, lineHeight: 1.2, fontVariantNumeric: "tabular-nums" }}>
              {bar.cost}
            </Typography>
          </Stack>
        ) : (
          // No change, not known, or still being worked out: said as the
          // sections' empty lines are.
          <Typography variant="caption" color="text.secondary" display="block">
            {bar?.cost ?? "…"}
          </Typography>
        )}
      </Box>
      {/* The cost set off from the buttons by a line across the panel, as
          the bar is from the panel above it. */}
      <Box sx={{ mx: -PX, mt: "12px", borderTop: 1, borderColor: "divider" }} />
      <Stack direction="row" justifyContent="flex-end" alignItems="center" spacing={1} sx={{ mt: "12px" }}>
        {/* As the dialogs' footer: Cancel in words, the action filled; both
            in the buttons' one size and weight, as the panel's others. */}
        <Button
          size="small"
          variant="text"
          onClick={edit.cancel}
          sx={{
            borderRadius: "16px",
            px: 1.5,
            fontWeight: 700,
            textTransform: "none",
            color: "text.secondary",
          }}>
          {t("cancel")}
        </Button>
        <Button
          size="small"
          variant="contained"
          color={bar?.danger ? "error" : "primary"}
          disabled={!built?.ok || nothing || applying}
          onClick={() => void edit.apply()}
          sx={{ borderRadius: "16px", px: 1.5, fontWeight: 700, textTransform: "none" }}>
          {bar?.action ?? t("done")}
        </Button>
      </Stack>
    </Box>
  );
}

/** The pending edit as a row of the change list (ChangeList): its name, and
 * under it what else it changes. */
function ChangeRow({ words, danger }: { words: NonNullable<DraftEdit["words"]>; danger: boolean }) {
  return (
    <Box
      sx={(theme) => ({
        mb: "8px",
        px: "12px",
        py: "10px",
        borderRadius: 1.5,
        border: 1,
        borderColor: danger ? alpha(theme.palette.error.main, 0.35) : "divider",
        bgcolor: danger ? alpha(theme.palette.error.main, 0.05) : "transparent",
      })}>
      <Typography variant="body2" fontWeight={600} color={danger ? "error.main" : "text.primary"}>
        {words.label}
      </Typography>
      {words.impact && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
          {words.impact}
        </Typography>
      )}
    </Box>
  );
}
