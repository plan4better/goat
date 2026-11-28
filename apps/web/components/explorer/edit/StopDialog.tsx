/**
 * A stop's properties, edited (decided 26 Nov 2026: its Details tab only
 * shows them), opened from the stop's Properties action (its action bar,
 * its menu). Its fields as a form (StopEditor); each change is the draft the
 * Apply bar applies, so Preview hands it there, as the line's dialog does.
 * Delete, in red at the left of the footer, goes to the Apply bar's delete
 * card, which says what it takes with it. Cancel lets go of what was typed.
 */
import { Button, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { locationKind, stopFieldProblems } from "@/lib/explorer/edit/ops/stopRules";
import { setEditDialog, setEditDraft } from "@/lib/store/explorer/slice";

import { useStopRecord } from "@/hooks/explorer/useExplorerData";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import { useExplorer } from "@/components/explorer/ExplorerContext";
import { StopEditor } from "@/components/explorer/edit/StopDetails";

export function StopDialog() {
  const dialog = useAppSelector((s) => s.explorer.edit.dialog);
  return dialog?.kind === "stop" ? <Dialog stop_idx={dialog.stop_idx} /> : null;
}

function Dialog({ stop_idx }: { stop_idx: number }) {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const { db } = useExplorer();
  const record = useStopRecord(db, stop_idx).data;
  const draft = useAppSelector((s) => s.explorer.edit.draft);
  const mine =
    (draft?.kind === "stop-details" || draft?.kind === "stop-move") && draft.stop_idx === stop_idx
      ? draft
      : null;
  const close = () => dispatch(setEditDialog(null));
  const cancel = () => {
    if (mine) dispatch(setEditDraft(null));
    close();
  };
  const kind = locationKind(record?.location_type ?? 0);
  return (
    <AppDialog
      open
      onClose={cancel}
      icon={ICON_NAME.SLIDERS}
      title={t("explorer_action_properties")}
      maxWidth={520}
      footer={
        <AppDialogFooter
          extra={
            <Button
              color="error"
              onClick={() => {
                dispatch(setEditDraft({ kind: "stop-delete", stop_idx }));
                close();
              }}>
              <Typography variant="body2" fontWeight="bold" color="inherit">
                {t(`explorer_delete_${kind}`)}
              </Typography>
            </Button>
          }
          cancelLabel={t("cancel")}
          onCancel={cancel}
          primaryLabel={t("explorer_preview")}
          // As the line's dialog: nothing to preview, or a field still wrong.
          primaryDisabled={
            !mine || (mine.kind === "stop-details" && Object.keys(stopFieldProblems(mine.values)).length > 0)
          }
          onPrimary={close}
        />
      }>
      <StopEditor stop_idx={stop_idx} />
    </AppDialog>
  );
}
