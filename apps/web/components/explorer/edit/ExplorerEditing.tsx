/**
 * Editing in the Explorer, for a user who may write the bundle: the edit
 * bar on the Explorer tab (on the Layers tab it is hidden: editing lives in
 * the Explorer, board 17), its second row (the selection's actions or a line
 * mode's controls) and under it what a tool does; its keys, the dialogs
 * edits are made in, the exit dialog wherever leaving starts, and the
 * browser's warning before a reload drops unsaved changes.
 */
import { useEffect } from "react";

import { setEditEnabled } from "@/lib/store/explorer/slice";

import { useEditActions } from "@/hooks/explorer/useEditActions";
import { useEditShortcuts } from "@/hooks/explorer/useEditShortcuts";
import { useLeaveWarning } from "@/hooks/explorer/useLeaveWarning";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import { useExplorer } from "@/components/explorer/ExplorerContext";
import { EditBar } from "@/components/explorer/edit/EditBar";
import { EditModeResolver } from "@/components/explorer/edit/EditModeResolver";
import { ExitDialog } from "@/components/explorer/edit/ExitDialog";
import { LineContextMenu } from "@/components/explorer/edit/LineContextMenu";
import { LinePropertiesDialog } from "@/components/explorer/edit/LinePropertiesDialog";
import { ServiceDialog } from "@/components/explorer/edit/ServiceDialog";
import { StopDialog } from "@/components/explorer/edit/StopDialog";
import { ToolHint } from "@/components/explorer/edit/ToolHint";
import { TripDialogs } from "@/components/explorer/edit/TripDialogs";

export function ExplorerEditing({ compact, barHidden }: { compact: boolean; barHidden: boolean }) {
  const { session } = useExplorer();
  const onExplorerTab = useAppSelector((s) => s.explorer.leftTab === "explorer");
  const unsaved = useAppSelector((s) => s.explorer.edit.changes.length > 0);
  const actions = useEditActions();
  const dispatch = useAppDispatch();
  useEffect(() => {
    dispatch(setEditEnabled(!!session));
    return () => void dispatch(setEditEnabled(false));
  }, [session, dispatch]);
  useEditShortcuts(!!session, actions);
  useLeaveWarning(unsaved);
  return (
    <>
      {session && onExplorerTab && !barHidden && (
        <>
          <EditBar compact={compact} undo={actions.undo} redo={actions.redo} />
          <ToolHint />
        </>
      )}
      <EditModeResolver />
      <LineContextMenu />
      <ExitDialog />
      <ServiceDialog />
      <LinePropertiesDialog />
      <StopDialog />
      <TripDialogs />
    </>
  );
}
