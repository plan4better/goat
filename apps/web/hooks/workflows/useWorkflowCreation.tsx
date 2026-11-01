"use client";

import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { createWorkflow } from "@/lib/api/workflows";
import type { Project } from "@/lib/validations/project";
import type { TemplateRead, TemplateUseResult } from "@/lib/validations/template";
import { createEmptyWorkflowConfig } from "@/lib/validations/workflow";
import type { Workflow } from "@/lib/validations/workflow";

import TemplateBrowser from "@/components/templates/TemplateBrowser";
import UseTemplateFlow from "@/components/templates/UseTemplateFlow";

export interface WorkflowCreation {
  /** A project is loaded, so a workflow can be created in it. */
  canCreate: boolean;
  /** A workflow from scratch is being created. */
  isCreating: boolean;
  createFromScratch: () => Promise<void>;
  /** Opens the template browser, locked to workflow templates. */
  openTemplateBrowser: () => void;
  /** Opens the workflow with this id as soon as the project's list carries it. */
  selectWhenListed: (workflowId: string) => void;
  /** A workflow waiting to be opened; the list's "open the first workflow" rule waits for it. */
  pendingSelectId: string | null;
  /** The template browser and the use-template flow, mounted while in use. */
  dialogs: ReactNode;
}

interface UseWorkflowCreationArgs {
  project?: Project;
  workflows?: Workflow[];
  mutateWorkflows: () => Promise<unknown>;
  onSelectWorkflow: (workflow: Workflow) => void;
}

/**
 * The two ways to a new workflow, from scratch and from a template, shared by
 * the workflow list's New menu and the card a project without workflows shows
 * on the canvas. The new workflow opens once the project's list carries it.
 * The template browser is mounted only while open: a mounted but closed one
 * still runs its template, space and pin requests.
 */
export function useWorkflowCreation({
  project,
  workflows,
  mutateWorkflows,
  onSelectWorkflow,
}: UseWorkflowCreationArgs): WorkflowCreation {
  const { t } = useTranslation("common");
  const projectId = project?.id;
  const [isCreating, setIsCreating] = useState(false);
  const [pendingSelectId, setPendingSelectId] = useState<string | null>(null);
  const [templateBrowserOpen, setTemplateBrowserOpen] = useState(false);
  const [templateForFlow, setTemplateForFlow] = useState<TemplateRead | null>(null);

  useEffect(() => {
    if (!workflows || !pendingSelectId) return;
    const listed = workflows.find((w) => w.id === pendingSelectId);
    if (listed) {
      setPendingSelectId(null);
      onSelectWorkflow(listed);
    }
  }, [workflows, pendingSelectId, onSelectWorkflow]);

  const createFromScratch = useCallback(async () => {
    if (!projectId) return;
    setIsCreating(true);
    try {
      const created = await createWorkflow(projectId, {
        name: `${t("workflow")} ${(workflows?.length || 0) + 1}`,
        description: null,
        is_default: false,
        config: createEmptyWorkflowConfig(),
      });
      await mutateWorkflows();
      setPendingSelectId(created.id);
    } catch (error) {
      console.error("Failed to create workflow:", error);
    } finally {
      setIsCreating(false);
    }
  }, [projectId, t, workflows?.length, mutateWorkflows]);

  const openTemplateBrowser = useCallback(() => setTemplateBrowserOpen(true), []);

  // A template picked from the browser hands off to UseTemplateFlow, which
  // inserts the workflow into this project and marks unresolved inputs on the
  // canvas.
  const handleUseTemplate = useCallback((template: TemplateRead) => {
    setTemplateBrowserOpen(false);
    setTemplateForFlow(template);
  }, []);

  const handleTemplateFlowDone = useCallback(
    async (result: TemplateUseResult) => {
      setTemplateForFlow(null);
      await mutateWorkflows();
      if (result.workflow_id) setPendingSelectId(result.workflow_id);
    },
    [mutateWorkflows]
  );

  const dialogs = (
    <>
      {templateBrowserOpen && (
        <TemplateBrowser
          mode="dialog"
          open
          onClose={() => setTemplateBrowserOpen(false)}
          lockedKind="workflow"
          onUse={handleUseTemplate}
        />
      )}
      {templateForFlow && projectId && (
        <UseTemplateFlow
          template={templateForFlow}
          context={{ kind: "in_project", projectId }}
          onClose={() => setTemplateForFlow(null)}
          onDone={handleTemplateFlowDone}
        />
      )}
    </>
  );

  return {
    canCreate: !!projectId,
    isCreating,
    createFromScratch,
    openTemplateBrowser,
    selectWhenListed: setPendingSelectId,
    pendingSelectId,
    dialogs,
  };
}
