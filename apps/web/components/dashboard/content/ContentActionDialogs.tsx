"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";


import { refreshContentFeed } from "@/lib/api/content";
import { useDataset } from "@/lib/api/layers";
import { executeProcessAsync } from "@/lib/api/processes";
import { copyProject, useProject } from "@/lib/api/projects";
import { setRunningJobIds } from "@/lib/store/jobs/slice";
import type { ContentItem } from "@/lib/validations/content";

import { ContentActions } from "@/types/common";

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import ContentDialogWrapper from "@/components/modals/ContentDialogWrapper";
import FolderModal from "@/components/modals/Folder";

interface ContentActionDialogsProps {
  action: ContentActions;
  item: ContentItem;
  onClose: () => void;
}

/** Every action this component renders a dialog for — the rest (EXPORT,
 * DUPLICATE) run immediately with no dialog of their own. */
const DIALOG_ACTIONS = new Set([
  ContentActions.EDIT_METADATA,
  ContentActions.DOWNLOAD,
  ContentActions.UPDATE,
]);

/**
 * Bridges the kebab/action-bar picks that reuse today's existing dialogs:
 * a folder's RENAME opens `FolderModal`, and EDIT_METADATA/DOWNLOAD/UPDATE
 * for a layer or project load the full object and hand it to
 * `ContentDialogWrapper` exactly as the old datasets/projects pages do.
 * EXPORT and DUPLICATE have no dialog of their own in `ContentDialogWrapper`
 * — on the projects page they are one-shot side effects (start an export
 * job, copy the project) fired straight from the menu pick, so this
 * component reproduces those two handlers verbatim and runs the picked one
 * once on mount.
 */
const ContentActionDialogs = ({ action, item, onClose }: ContentActionDialogsProps) => {
  const { t } = useTranslation("common");
  const router = useRouter();
  const dispatch = useAppDispatch();
  const runningJobIds = useAppSelector((state) => state.jobs.runningJobIds);

  const needsContent = DIALOG_ACTIONS.has(action);
  const { dataset } = useDataset(item.type === "layer" && needsContent ? item.id : "");
  const { project } = useProject(item.type === "project" && needsContent ? item.id : undefined);

  // Guards the one-shot actions against StrictMode's double effect
  // invocation, which would otherwise duplicate the export job or the copy.
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    if (action === ContentActions.DUPLICATE && item.type === "project") {
      ran.current = true;
      (async () => {
        try {
          const newProject = await copyProject(item.id);
          toast.success(t("project_duplicated"));
          refreshContentFeed();
          if (newProject?.id) router.push(`/map/${newProject.id}`);
        } catch {
          toast.error(t("error_duplicating_project"));
        } finally {
          onClose();
        }
      })();
    } else if (action === ContentActions.EXPORT && item.type === "project") {
      ran.current = true;
      (async () => {
        try {
          const job = await executeProcessAsync("project_export", { project_id: item.id });
          if (job?.jobID) dispatch(setRunningJobIds([...runningJobIds, job.jobID]));
          toast.info(t("project_export_submitted"));
        } catch {
          toast.error(t("error_exporting_project"));
        } finally {
          onClose();
        }
      })();
    }
  }, [action, item, onClose, router, t, dispatch, runningJobIds]);

  if (action === ContentActions.RENAME && item.type === "folder") {
    return (
      <FolderModal
        type="update"
        open
        selectedFolder={{ id: item.id, name: item.name }}
        onClose={onClose}
        onEdit={() => {
          refreshContentFeed();
          onClose();
        }}
      />
    );
  }

  // Every dialog `ContentDialogWrapper` renders closes by calling `onClose`
  // whether the edit succeeded or was cancelled (see Metadata/Download/
  // Update); refreshing the feed on every close is a harmless no-op on
  // cancel and picks up a real edit without those modals needing to know
  // about the new Content feed's own SWR key.
  const handleClose = () => {
    refreshContentFeed();
    onClose();
  };

  if (item.type === "layer" && dataset) {
    return <ContentDialogWrapper action={action} type="layer" content={dataset} onClose={handleClose} />;
  }
  if (item.type === "project" && project) {
    return <ContentDialogWrapper action={action} type="project" content={project} onClose={handleClose} />;
  }

  return null;
};

export default ContentActionDialogs;
