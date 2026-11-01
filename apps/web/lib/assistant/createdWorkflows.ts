import type { DynamicToolUIPart } from "ai";

import { CREATE_WORKFLOW_TOOLS } from "@/lib/assistant/items";
import type { AssistantMessage } from "@/lib/assistant/types";

/** A workflow the assistant created, as its create step's result names it (contract "Created workflows"). */
export interface CreatedWorkflow {
  id: string;
  projectId: string;
  name: string | null;
}

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null;
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
const CREATE_TOOLS: ReadonlySet<string> = new Set<string>(CREATE_WORKFLOW_TOOLS);

/** The workflow a finished `workflow_create` or `workflow_create_from_template` step made, else null. */
export function createdWorkflow(part: DynamicToolUIPart): CreatedWorkflow | null {
  if (part.state !== "output-available" || !CREATE_TOOLS.has(part.toolName)) return null;
  const workflow = isRow(part.output) && isRow(part.output.workflow) ? part.output.workflow : null;
  const id = text(workflow?.id);
  const projectId = text(workflow?.project_id);
  if (!id || !projectId) return null;
  return { id, projectId, name: text(workflow?.name) };
}

/** Every workflow the answers of `messages` created, in order. */
export const createdWorkflows = (messages: AssistantMessage[]): CreatedWorkflow[] =>
  messages.flatMap((message) =>
    message.role !== "assistant"
      ? []
      : message.parts
          .filter((part): part is DynamicToolUIPart => part.type === "dynamic-tool")
          .map(createdWorkflow)
          .filter((workflow): workflow is CreatedWorkflow => workflow !== null)
  );

/** The project page in Workflows mode with the workflow selected (read by `useMapUrlIntent`). */
export const workflowHref = (projectId: string, workflowId: string): string =>
  `/map/${projectId}?mode=workflows&workflow=${encodeURIComponent(workflowId)}`;

export interface OpenCreatedWorkflowDeps {
  /** The project the page shows, or null outside a project. */
  openProjectId: () => string | null;
  /**
   * The page holds changes not saved yet: the workflow editor's (an autosave
   * pending, or one that failed: "Not saved"), or features drawn or edited on the map.
   */
  hasUnsavedChanges: () => boolean;
  /** Reads the project's workflow list again (`refreshWorkflowList`). */
  refreshList: (projectId: string) => Promise<unknown>;
  navigate: (href: string) => void;
}

/**
 * Opens a workflow the running answer created in the Workflows editor, when
 * its project is the one the page shows and the page holds no unsaved
 * changes (contract "Created workflows"). Both are checked before the list is
 * read again and after, because the person may start editing or leave the
 * project meanwhile, and opening selects the new workflow in place of the
 * edited one. Returns whether it opened; otherwise, and when the list cannot
 * be read, the workflow's card offers Open.
 */
export async function openCreatedWorkflow(
  target: { projectId: string; workflowId: string },
  deps: OpenCreatedWorkflowDeps
): Promise<boolean> {
  const allowed = () => deps.openProjectId() === target.projectId && !deps.hasUnsavedChanges();
  if (!allowed()) return false;
  try {
    await deps.refreshList(target.projectId);
  } catch {
    return false;
  }
  if (!allowed()) return false;
  deps.navigate(workflowHref(target.projectId, target.workflowId));
  return true;
}
