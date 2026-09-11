import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import {
  BundleEditConflictError,
  type BundleEditResponse,
  applyBundleEdits,
  buildBundleEditPayload,
} from "@/lib/api/bundleEdits";
import { useBundleForLayer } from "@/lib/api/bundles";
import { setRunningJobIds } from "@/lib/store/jobs/slice";

import type { PendingFeature } from "@/lib/store/featureEditor/types";

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

/**
 * Saving an editable bundle member.
 *
 * The batch goes to the bundle's own endpoint, which derives the nodes layer,
 * marks the routing graph stale, and queues the rebuild server-side — so the
 * graph's return to ready never depends on this tab surviving the save. Until
 * the rebuild lands, tools refuse to route on the bundle rather than quietly
 * using a graph that no longer matches the layers.
 */
export function useBundleEditSave(activeLayerId: string | null) {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const runningJobIds = useAppSelector((state) => state.jobs.runningJobIds);
  const {
    bundleForLayer,
    isMembershipUnresolved,
    mutate: mutateBundleForLayer,
  } = useBundleForLayer(activeLayerId);

  // The revision as it was when this session opened, not the freshest one.
  // Sending the freshest value would mean a concurrent change is never
  // detected, which is the whole point of the check.
  const sessionRevision = useRef<number | null>(null);
  useEffect(() => {
    sessionRevision.current = null;
  }, [activeLayerId]);
  useEffect(() => {
    if (sessionRevision.current === null && bundleForLayer) {
      sessionRevision.current = bundleForLayer.layers_revision;
    }
  }, [bundleForLayer]);

  const saveBundleEdits = useCallback(
    async (
      pendingFeatures: Record<string, PendingFeature>
    ): Promise<BundleEditResponse | null> => {
      if (!activeLayerId || !bundleForLayer?.editable) return null;

      const payload = buildBundleEditPayload(
        pendingFeatures,
        sessionRevision.current ?? bundleForLayer.layers_revision
      );
      let result: BundleEditResponse;
      try {
        result = await applyBundleEdits(activeLayerId, payload);
      } catch (error) {
        if (error instanceof BundleEditConflictError) {
          // The pending edits are kept: they are still the user's work, and a
          // reload is the only way to rebase them on what someone else saved.
          toast.error(error.message);
          return null;
        }
        throw error;
      }

      // The server queued the rebuild with the save; track it. When the
      // dispatch failed the layers are still saved — only the graph is behind,
      // and analyses on this bundle will refuse until it is rebuilt.
      if (result.rebuild_job_id) {
        dispatch(setRunningJobIds([...runningJobIds, result.rebuild_job_id]));
      } else {
        toast.warning(t("bundle_update_not_started"));
      }

      // The save advanced the revision, so a second save in the same session
      // rebases on what this one wrote rather than reporting a false conflict.
      sessionRevision.current = result.revision;
      // Also write it into the SWR entry: re-entering edit mode re-seeds the
      // ref from this cache, and the stale value would make the next save a
      // false 409 that only a full reload clears.
      mutateBundleForLayer({ ...bundleForLayer, layers_revision: result.revision }, { revalidate: false });
      return result;
    },
    [activeLayerId, bundleForLayer, dispatch, mutateBundleForLayer, runningJobIds, t]
  );

  return { bundleForLayer, isMembershipUnresolved, saveBundleEdits };
}

export default useBundleEditSave;
