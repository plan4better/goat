/**
 * The edit bar's keys (board 17), while the Explorer is open for an editor:
 * V for Select, S for Stop, L for Line, Ctrl/⌘+Z to undo, Ctrl/⌘+Shift+Z
 * or Ctrl+Y to redo; Esc drops the edit being made (as its Cancel does),
 * else leaves a line mode, else goes back to Select from another
 * tool, and with Select clears the selection. Never while typing, nor while
 * a dialog (exit, service, a selection's edit dialog), the change list or a
 * handler that used the key (the strip's zoom) has it.
 */
import { useEffect } from "react";
import { useStore } from "react-redux";

import type { RootState } from "@/lib/store";
import { clearExplorerSelection, setEditDraft, setEditMode, setEditTool } from "@/lib/store/explorer/slice";

import { useAppDispatch } from "@/hooks/store/ContextHooks";

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export function useEditShortcuts(
  enabled: boolean,
  actions: { undo: () => Promise<void>; redo: () => Promise<void> }
): void {
  const dispatch = useAppDispatch();
  const store = useStore<RootState>();
  const { undo, redo } = actions;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || typing(e.target)) return;
      const explorer = store.getState().explorer;
      const edit = explorer.edit;
      // A dialog, the change list, the settings or a menu on the line own
      // the keys meanwhile (Esc closes the menu, not the selection).
      if (
        edit.exit ||
        edit.listOpen ||
        edit.service ||
        edit.dialog ||
        explorer.settingsTab ||
        explorer.lineMenu
      )
        return;
      const key = e.key.toLowerCase();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && key === "z") {
        e.preventDefault();
        void (e.shiftKey ? redo() : undo());
      } else if (mod && key === "y" && !e.metaKey) {
        e.preventDefault();
        void redo();
      } else if (!mod && !e.altKey && key === "v") {
        dispatch(setEditTool("select"));
      } else if (!mod && !e.altKey && key === "s") {
        dispatch(setEditTool("stop"));
      } else if (!mod && !e.altKey && key === "l") {
        dispatch(setEditTool("route"));
      } else if (key === "escape") {
        // The edit being made first, as its Cancel does (a line being drawn
        // puts its tool down too); then another tool: back to Select;
        // the mode on a line: out of it, its line still selected; Select:
        // nothing selected (board 17).
        if (edit.draft?.kind === "line-new") dispatch(setEditTool("select"));
        else if (edit.draft) dispatch(setEditDraft(null));
        else if (edit.mode) dispatch(setEditMode(null));
        else dispatch(edit.tool === "select" ? clearExplorerSelection() : setEditTool("select"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, undo, redo, dispatch, store]);
}
