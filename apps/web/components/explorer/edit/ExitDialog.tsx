/**
 * Leaving the Explorer with changes (02-panel-behaviour-spec › Exit
 * Explorer): "Save edits to <bundle>?", with how many edits there are and the
 * reminder that saving updates the bundle for everyone in the project. It
 * asks when the Explorer is left another way with changes, and comes back,
 * saying why, when a Save and exit does not go through.
 * Discard changes (red, left) drops them; Keep editing (or Esc, or a click
 * outside) stays; Save and exit writes them into the bundle and goes on with
 * whatever was leaving — closing the Explorer, another bundle's, another view.
 */
import { Alert, Button, Stack, Typography } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { takeLeave } from "@/lib/explorer/edit/leave";
import { setExitState } from "@/lib/store/explorer/slice";

import { useExplorerSave } from "@/hooks/explorer/useExplorerSave";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";

export function ExitDialog() {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const { save, discard } = useExplorerSave();
  const exit = useAppSelector((s) => s.explorer.edit.exit);
  const problem = useAppSelector((s) => s.explorer.edit.saveProblem);
  const changes = useAppSelector((s) => s.explorer.edit.changes);
  const name = useAppSelector((s) => s.explorer.bundleName) ?? "";
  const saving = exit === "saving";
  // Open only when it asks: leaving with edits, or a save that failed. A
  // save started elsewhere (Save and exit in the bar, Save in the edits
  // list) shows its progress on its own button; one started here, here.
  const [asked, setAsked] = useState(false);
  if (exit === "asking" && !asked) setAsked(true);
  if (exit === null && asked) setAsked(false);
  const open = exit === "asking" || (saving && asked);

  const keepEditing = () => {
    if (saving) return;
    takeLeave();
    dispatch(setExitState(null));
  };

  return (
    <AppDialog
      open={open}
      onClose={keepEditing}
      icon={ICON_NAME.SAVE}
      title={t("explorer_exit_title", { name })}
      closeDisabled={saving}
      maxWidth={480}
      footer={
        <AppDialogFooter
          extra={
            <Button color="error" disabled={saving} onClick={() => void discard()}>
              <Typography variant="body2" fontWeight="bold" color="inherit">
                {t("explorer_discard_edits")}
              </Typography>
            </Button>
          }
          cancelLabel={t("explorer_keep_editing")}
          onCancel={keepEditing}
          cancelDisabled={saving}
          primaryLabel={t("explorer_save_exit")}
          onPrimary={() => void save()}
          primaryLoading={saving}
        />
      }>
      <Stack spacing={2}>
        {/* A count, not the edits themselves: a session's list can run
            long, and the edits list under the bar holds it. */}
        <Typography variant="body2">{t("explorer_exit_body", { count: changes.length })}</Typography>
        <Typography variant="body2" color="text.secondary">
          {t("explorer_exit_everyone")}
        </Typography>
        {problem && <Alert severity="error">{problem}</Alert>}
      </Stack>
    </AppDialog>
  );
}
