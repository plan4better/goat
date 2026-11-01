import type { DynamicToolUIPart } from "ai";

import type { AssistantMessage } from "@/lib/assistant/types";

/** The tool that changes an existing workflow (contract "Workflow edits"). */
export const EDIT_WORKFLOW_TOOL = "workflow_update";

/** A workflow an answer changed, and the revision its change left. */
export interface WorkflowEdit {
  workflowId: string;
  revision: number;
}

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null;
const whole = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null;

/**
 * The change a finished `workflow_update` step saved, else null: an edit
 * that changed nothing keeps its revision and saved nothing.
 */
export function workflowEdit(part: DynamicToolUIPart): WorkflowEdit | null {
  if (part.state !== "output-available" || part.toolName !== EDIT_WORKFLOW_TOOL) return null;
  const output = isRow(part.output) ? part.output : {};
  const workflowId = typeof output.workflow_id === "string" ? output.workflow_id : null;
  const before = whole(output.revision_before);
  const after = whole(output.revision_after);
  if (!workflowId || before === null || after === null || after === before) return null;
  return { workflowId, revision: after };
}

const toolParts = (message: AssistantMessage): DynamicToolUIPart[] =>
  message.parts.filter((part): part is DynamicToolUIPart => part.type === "dynamic-tool");

/** The changes an answer saved, in order: the dock's Undo shows only for an answer with some. */
export const answerEdits = (message: AssistantMessage): WorkflowEdit[] =>
  message.role !== "assistant"
    ? []
    : toolParts(message)
        .map(workflowEdit)
        .filter((edit): edit is WorkflowEdit => edit !== null);

/** Every change the answers of `messages` saved, each keyed by its answer and step. */
export const workflowEdits = (messages: AssistantMessage[]): Array<WorkflowEdit & { key: string }> =>
  messages.flatMap((message) =>
    message.role !== "assistant"
      ? []
      : toolParts(message).flatMap((part) => {
          const edit = workflowEdit(part);
          return edit ? [{ ...edit, key: `${message.id}:${part.toolCallId}` }] : [];
        })
  );

/** A workflow changed elsewhere (an assistant edit, the dock's Undo of one) and the revision that left it. */
export interface WorkflowChange {
  workflowId: string;
  /** Null when core did not name it: the open editor then learns of the change from its next save. */
  revision: number | null;
  /** Its project, when known; else the open project's, where the assistant edits. */
  projectId?: string | null;
}

export interface FollowWorkflowChangesDeps {
  /** The workflow the Workflows editor has open (also while the page shows another mode). */
  openWorkflowId: () => string | null;
  /** The project the page shows, or null outside a project. */
  openProjectId: () => string | null;
  /** Has the editor load the stored workflow once it saved what it holds (`requestWorkflowReload`). */
  requestReload: (workflowId: string, revision: number) => void;
  /** Reads the project's workflow list again (`refreshWorkflowList`). */
  refreshList: (projectId: string) => Promise<unknown>;
}

/**
 * Keeps the page in step with workflow changes made elsewhere: the open
 * workflow loads the stored version (one step of its undo), and the
 * project's workflow list is read again for the others.
 */
export function followWorkflowChanges(changes: WorkflowChange[], deps: FollowWorkflowChangesDeps): void {
  if (changes.length === 0) return;
  const open = deps.openWorkflowId();
  for (const change of changes) {
    if (change.workflowId === open && change.revision !== null) {
      deps.requestReload(change.workflowId, change.revision);
    }
  }
  const projects = new Set(
    changes
      .map((change) => change.projectId ?? deps.openProjectId())
      .filter((project): project is string => !!project)
  );
  projects.forEach((project) => void deps.refreshList(project).catch(() => undefined));
}
