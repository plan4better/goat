import type { TFunction } from "i18next";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { getJobResult, useJobs } from "@/lib/api/processes";
import { setRunningJobIds } from "@/lib/store/jobs/slice";
import { claimJobAnnouncement } from "@/lib/utils/jobAnnouncement";

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

/**
 * Announce what an import job did: how many layers arrived, and how many were left behind.
 *
 * The counts have to be fetched: the job list reports `result: null` for every entry, so
 * reading the result off the polled job silently under-reported a three-layer import as
 * one and hid the skip entirely. When the result cannot be read, the generic success
 * message is used — better to say less than to state a count that is not true.
 */
const announceImport = async (jobId: string, t: TFunction<"common">, fallback: string) => {
  const result = await getJobResult(jobId).catch(() => null);
  const imported = (result?.imported as unknown[] | undefined)?.length;
  const skipped = (result?.skipped as unknown[] | undefined)?.length ?? 0;

  if (imported === undefined) {
    toast.success(fallback);
    return;
  }
  const summary = t("upload_imported_n", { count: imported });
  if (skipped > 0) {
    toast.warning(`${summary}, ${t("upload_skipped_n", { count: skipped })}`);
  } else {
    toast.success(summary);
  }
};

export function useJobStatus(onSuccess?: () => void, onFailed?: () => void) {
  const runningJobIds = useAppSelector((state) => state.jobs.runningJobIds);
  const { jobs, mutate: mutateJobs } = useJobs({ read: false });
  const dispatch = useAppDispatch();
  const { t } = useTranslation("common");
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Stable callback refs to avoid stale closures
  const onSuccessRef = useRef(onSuccess);
  const onFailedRef = useRef(onFailed);
  useEffect(() => {
    onSuccessRef.current = onSuccess;
    onFailedRef.current = onFailed;
  }, [onSuccess, onFailed]);

  // Start/stop polling based on runningJobIds
  useEffect(() => {
    if (runningJobIds.length > 0 && !pollIntervalRef.current) {
      // Start polling every 2 seconds
      pollIntervalRef.current = setInterval(() => {
        mutateJobs();
      }, 2000);
      // Also trigger immediate fetch
      mutateJobs();
    } else if (runningJobIds.length === 0 && pollIntervalRef.current) {
      // Stop polling when no jobs to track
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [runningJobIds.length, mutateJobs]);

  // Check job status and call callbacks
  const checkJobStatus = useCallback(() => {
    if (runningJobIds.length === 0 || !jobs?.jobs) return;

    jobs.jobs.forEach((job) => {
      if (runningJobIds.includes(job.jobID)) {
        if (job.status === "running" || job.status === "accepted") return;

        dispatch(setRunningJobIds(runningJobIds.filter((id) => id !== job.jobID)));
        const type = t(job.processID) || "";
        let announce: (() => void) | undefined;

        if (job.status === "successful") {
          onSuccessRef.current?.();
          // Don't show success toast for:
          // - delete jobs: already handled optimistically
          // - layer_export/print_report/project_export: handled in JobsPopper with auto-download
          // - workflow_runner: handled by useWorkflowExecution
          // - finalize_layer: show custom message
          const isDeleteJob =
            job.processID === "layer_delete" || job.processID.toLowerCase().includes("delete");
          const isDownloadJob =
            job.processID === "layer_export" ||
            job.processID === "print_report" ||
            job.processID === "project_export";
          const isWorkflowJob = job.processID === "workflow_runner";
          const isFinalizeJob = job.processID === "finalize_layer";
          if (isFinalizeJob) {
            announce = () => toast.success(t("layer_saved_successfully"));
          } else if (job.processID === "layer_import") {
            // An upload can hold several datasets, and one of them failing does not fail
            // the job — so "success" on its own would hide what was left behind.
            announce = () => void announceImport(job.jobID, t, `"${type}" - ${t("job_success")}`);
          } else if (!isDeleteJob && !isDownloadJob && !isWorkflowJob) {
            announce = () => toast.success(`"${type}" - ${t("job_success")}`);
          }
        } else {
          onFailedRef.current?.();
          const isFinalizeJob = job.processID === "finalize_layer";
          // workflow_runner failures are surfaced by useWorkflowExecution
          // with a contextual message; don't double-toast here.
          const isWorkflowJob = job.processID === "workflow_runner";
          if (isFinalizeJob) {
            announce = () => toast.error(t("layer_save_failed"));
          } else if (!isWorkflowJob) {
            announce = () => toast.error(`"${type}" - ${t("job_failed")}`);
          }
        }

        // The callbacks refresh this tab's views; the toast goes to one tab only
        if (announce) {
          const show = announce;
          void claimJobAnnouncement(job.jobID).then((claimed) => claimed && show());
        }
      }
    });
  }, [runningJobIds, jobs, dispatch, t]);

  useEffect(() => {
    checkJobStatus();
  }, [checkJobStatus]);
}

/** Mounts the job-status polling in an isolated subtree. The jobs SWR data
 * changes identity on every poll, so whichever component calls useJobStatus
 * re-renders each time — hosting it here keeps those re-renders away from the
 * caller (MapPage renders its entire tree in ~300ms dev otherwise). */
export function JobStatusWatcher({ onSuccess, onFailed }: { onSuccess?: () => void; onFailed?: () => void }) {
  useJobStatus(onSuccess, onFailed);
  return null;
}
