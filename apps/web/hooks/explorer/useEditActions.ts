/**
 * Apply, undo, redo and discard on the open bundle's editing session, with the
 * change list (Redux) kept in step: the session holds the rows, Redux the
 * summaries the bar and the list show.
 */
import { useCallback } from "react";

import type { EditChange } from "@/lib/explorer/edit/types";
import { editApplied, editRedone, editUndone, editsDiscarded } from "@/lib/store/explorer/slice";

import { useAppDispatch } from "@/hooks/store/ContextHooks";

import { useExplorer } from "@/components/explorer/ExplorerContext";

export function useEditActions() {
  const { session } = useExplorer();
  const dispatch = useAppDispatch();
  const apply = useCallback(
    async (change: EditChange) => {
      if (!session) return;
      dispatch(editApplied(await session.apply(change)));
    },
    [session, dispatch]
  );
  const undo = useCallback(async () => {
    if (session && (await session.undo())) dispatch(editUndone());
  }, [session, dispatch]);
  const redo = useCallback(async () => {
    if (session && (await session.redo())) dispatch(editRedone());
  }, [session, dispatch]);
  const discard = useCallback(async () => {
    if (!session) return;
    await session.discard();
    dispatch(editsDiscarded());
  }, [session, dispatch]);
  return { apply, undo, redo, discard };
}
