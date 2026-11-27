/**
 * Saving the editing session into its bundle: Save in the edits list keeps
 * the Explorer open (the edits stay in its snapshot, their undo history
 * goes; the next save starts from the revision this one made). Save and
 * exit in the exit dialog then goes on with what was leaving
 * (lib/explorer/edit/leave.ts). A save that does not go through keeps the
 * changes and opens the dialog, saying why.
 */
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import {
  SaveConflictError,
  SaveRefusedError,
  SaveTimeoutError,
  saveExplorerChanges,
} from "@/lib/explorer/edit/api";
import { takeLeave } from "@/lib/explorer/edit/leave";
import {
  editsDiscarded,
  editsSaved,
  saveFailed,
  setChangeListOpen,
  setExitState,
} from "@/lib/store/explorer/slice";

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { useExplorer } from "@/components/explorer/ExplorerContext";

export function useExplorerSave() {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const { session, revision, setRevision } = useExplorer();
  const bundleId = useAppSelector((s) => s.explorer.bundleId);
  const name = useAppSelector((s) => s.explorer.bundleName) ?? "";

  /** Drop the session's changes and go on with what was leaving. */
  const finish = useCallback(async () => {
    await session?.clear();
    dispatch(setExitState(null));
    takeLeave()?.();
  }, [session, dispatch]);

  const save = useCallback(async () => {
    if (!session || !bundleId || revision === null) return;
    dispatch(setExitState("saving"));
    try {
      const saved = await saveExplorerChanges(bundleId, revision, session.changeset());
      setRevision(saved.revision);
      dispatch(editsSaved());
      toast.success(t("explorer_saved", { name }));
      await finish();
    } catch (error) {
      // The edits list makes way for the dialog saying why.
      dispatch(setChangeListOpen(false));
      dispatch(
        saveFailed(
          error instanceof SaveConflictError
            ? t("explorer_save_conflict")
            : error instanceof SaveRefusedError
              ? t("explorer_save_refused")
              : error instanceof SaveTimeoutError
                ? t("explorer_save_timeout")
                : t("explorer_save_failed", { message: String((error as Error).message ?? error) })
        )
      );
    }
  }, [session, bundleId, revision, setRevision, name, t, dispatch, finish]);

  /** Undo the session's changes, so the snapshot is the bundle's again,
   * and go on with what was leaving. */
  const discard = useCallback(async () => {
    await session?.discard();
    dispatch(editsDiscarded());
    await finish();
  }, [session, dispatch, finish]);

  return { save, discard };
}
