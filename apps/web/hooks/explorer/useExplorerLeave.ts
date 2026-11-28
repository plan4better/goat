/**
 * The one way out of the Explorer (02-panel-behaviour-spec › Exit Explorer):
 * every exit — the bottom bar's Exit Explorer, the tab's ×, the bundle's
 * menu, another bundle's Explorer, leaving the map view — goes through
 * `leave`, which goes ahead at once when nothing is unsaved and otherwise
 * asks first. Outside the Explorer's provider too: the header calls it.
 */
import { useCallback } from "react";

import { holdLeave } from "@/lib/explorer/edit/leave";
import { askToLeave, hasUnsavedEdits } from "@/lib/store/explorer/slice";

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

export function useExplorerLeave(): (proceed: () => void) => void {
  const dispatch = useAppDispatch();
  const unsaved = useAppSelector((s) => hasUnsavedEdits(s.explorer));
  return useCallback(
    (proceed: () => void) => {
      if (!unsaved) {
        proceed();
        return;
      }
      holdLeave(proceed);
      dispatch(askToLeave());
    },
    [unsaved, dispatch]
  );
}
