import { useCallback, useState } from "react";

import { startEditing } from "@/lib/store/featureEditor/slice";
import { setDataPanelLayerId, setIsDataPanelOpen } from "@/lib/store/map/slice";

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

interface StartEditingPayload {
  layerId: string;
  geometryType: "point" | "line" | "polygon" | null;
  /** layer_project id — the data panel follows the edit session to this layer,
   * whether it is open or not: the panel ends any session whose layer is not
   * the one it points at. For a table layer it is also opened, since the table
   * is the only place that layer can be edited. */
  projectLayerId?: number;
}

/**
 * Guards `startEditing` dispatches: the reducer resets the whole edit
 * session (including pending features), so switching the edit target while
 * unsaved edits exist must be confirmed instead of silently discarding
 * them. Re-requesting the layer that is already being edited is a no-op.
 *
 * Render a ConfirmModal with the returned state:
 *   const guard = useStartEditingGuard();
 *   <ConfirmModal open={guard.confirmOpen} onConfirm={guard.confirm} onClose={guard.cancel} ... />
 */
export const useStartEditingGuard = () => {
  const dispatch = useAppDispatch();
  const activeLayerId = useAppSelector((state) => state.featureEditor.activeLayerId);
  const hasPendingEdits = useAppSelector(
    (state) => Object.keys(state.featureEditor.pendingFeatures).length > 0
  );
  const [pendingRequest, setPendingRequest] = useState<StartEditingPayload | null>(null);

  const beginEditing = useCallback(
    (payload: StartEditingPayload) => {
      dispatch(startEditing({ layerId: payload.layerId, geometryType: payload.geometryType }));
      // The data panel follows the session, open or not. It used to follow only
      // while open, which left a closed panel pointing at whatever was last
      // looked at — and the panel ends any session whose layer is not the one
      // it is pointed at, so starting one from the tree on any other layer was
      // undone the moment it began. Pointing a closed panel at the layer being
      // edited costs nothing and is what it should show when it opens.
      if (payload.projectLayerId !== undefined) {
        dispatch(setDataPanelLayerId(payload.projectLayerId));
      }
      // A table layer has nothing on the map, so the data table *is* the
      // editor: starting a session without it would leave the user editing a
      // layer they cannot see.
      if (payload.geometryType === null) {
        dispatch(setIsDataPanelOpen(true));
      }
    },
    [dispatch]
  );

  const requestStartEditing = useCallback(
    (payload: StartEditingPayload) => {
      // Already editing this layer — keep the session (and its edits) as-is
      if (activeLayerId === payload.layerId) return;
      if (activeLayerId && hasPendingEdits) {
        setPendingRequest(payload);
        return;
      }
      beginEditing(payload);
    },
    [activeLayerId, hasPendingEdits, beginEditing]
  );

  const confirm = useCallback(() => {
    if (pendingRequest) beginEditing(pendingRequest);
    setPendingRequest(null);
  }, [pendingRequest, beginEditing]);

  const cancel = useCallback(() => setPendingRequest(null), []);

  return { requestStartEditing, confirmOpen: !!pendingRequest, confirm, cancel };
};

export default useStartEditingGuard;
