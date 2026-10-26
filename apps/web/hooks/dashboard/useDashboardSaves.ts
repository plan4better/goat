"use client";

import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import type { KeyedMutator } from "swr";

import { type ProjectUpdate, getProject, updateProject } from "@/lib/api/projects";
import type { SaveConflict, SaveOutcome } from "@/lib/utils/revisionedSaver";
import type { Project } from "@/lib/validations/project";

import { useRevisionedSaver } from "@/hooks/useRevisionedSaver";

interface UseDashboardSavesArgs {
  projectId: string;
  /** The dashboard revision of the project the page shows. */
  builderRevision?: number | null;
  /** The page's SWR `mutate` of the project. */
  mutateProject: KeyedMutator<Project>;
}

export interface DashboardSaves {
  /** Saves a dashboard change (`builder_config`), in turn with the others;
   * with `refresh`, reads the project again once it is in. "held" while a
   * conflict is open. */
  save: (update: ProjectUpdate, refresh?: boolean) => Promise<SaveOutcome>;
  /** A dashboard save core refused because the dashboard changed elsewhere;
   * no dashboard save goes out until Reload or Keep mine. */
  conflict: SaveConflict | null;
  /** Shows the stored project and saves on from its revision. */
  reload: () => Promise<void>;
  /** Saves what the conflict held on top of the stored dashboard; when that
   * fails, says so and shows the stored project. */
  keepMine: () => Promise<void>;
}

/**
 * Saves the project's dashboard on its revision (`builder_base_revision`).
 * The builder edits the project SWR holds, so a newer read of it brings its
 * revision along; a save's answer can be newer than the read the page still
 * shows, and is kept.
 */
export function useDashboardSaves({
  projectId,
  builderRevision,
  mutateProject,
}: UseDashboardSavesArgs): DashboardSaves {
  const { t } = useTranslation("common");
  const { saver, conflict } = useRevisionedSaver<ProjectUpdate>({
    send: async (id, update, baseRevision) => {
      const updated = await updateProject(id, { ...update, builder_base_revision: baseRevision });
      const revision = updated?.builder_revision;
      if (typeof revision === "number") {
        // The page's copy of the project carries it on, so a saver created
        // again (the page mounted again) starts from it.
        // A copy tagged newer is a read of the stored project and stays.
        void mutateProject(
          (current) =>
            current && !(typeof current.builder_revision === "number" && current.builder_revision > revision)
              ? { ...current, builder_revision: revision }
              : current,
          { revalidate: false }
        );
      }
      return revision;
    },
    isOpen: () => true,
  });

  useEffect(() => {
    saver.seed(projectId, builderRevision);
  }, [saver, projectId, builderRevision]);

  const save = useCallback(
    async (update: ProjectUpdate, refresh = false) => {
      const outcome = await saver.save(projectId, update);
      if (outcome === "saved" && refresh) await mutateProject();
      return outcome;
    },
    [saver, projectId, mutateProject]
  );

  const keepMine = useCallback(async () => {
    try {
      // A read of the project may have brought the other dashboard on screen
      // meanwhile; show the one now stored.
      if ((await saver.keepMine()) === "saved") await mutateProject();
    } catch (error) {
      console.error("Failed to save the dashboard:", error);
      toast.error(t("error_updating_project"));
      await mutateProject();
    }
  }, [saver, mutateProject, t]);

  const reload = useCallback(async () => {
    if (!saver.conflict) return;
    try {
      const stored = await getProject(projectId);
      saver.dismiss();
      if (typeof stored.builder_revision === "number") saver.setRevision(projectId, stored.builder_revision);
      await mutateProject(stored, { revalidate: false });
    } catch (error) {
      console.error("Failed to reload the dashboard:", error);
    }
  }, [saver, projectId, mutateProject]);

  return { save, conflict, reload, keepMine };
}
