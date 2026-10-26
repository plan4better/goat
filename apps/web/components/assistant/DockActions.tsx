"use client";

import { createContext, useContext } from "react";

import type { AddedToProject } from "@/lib/assistant/addToProject";
import type { ResultItem } from "@/lib/assistant/items";
import type { WorkflowChange } from "@/lib/assistant/workflowEdits";

/** What message parts can ask the dock to do; the dock provides it. */
export interface DockActions {
  /** The catalog record's page (a new tab inside a project, so the project stays open). */
  openRecord: (id: string) => void;
  /** A project of the user's, in a new tab inside a project, so the open one stays open. */
  openProject: (projectId: string) => void;
  /** A project's workflow or print layout in its editor (a new tab inside another project). */
  openInProjectMode: (projectId: string, mode: "workflows" | "reports", itemId: string) => void;
  /**
   * A workflow the running answer created: opened in the Workflows editor when
   * it belongs to the open project and the editor holds no unsaved changes,
   * after the project's workflow list was read again. Resolves whether it opened.
   */
  openCreatedWorkflow: (projectId: string, workflowId: string) => Promise<boolean>;
  /**
   * Workflows an answer changed, or the dock's Undo wrote back: the open one
   * loads the stored version, the project's workflow list is read again.
   */
  followWorkflowChanges: (changes: WorkflowChange[]) => void;
  /** Whether the Workflows editor holds changes of one of these workflows that are not saved yet. */
  unsavedWorkflowChanges: (workflowIds: string[]) => boolean;
  /** The existing dataset window (summary, data, map): a dataset's "All details". */
  previewDataset: (layerId: string) => void;
  /** The existing bundle window: a bundle's "All details". */
  previewBundle: (bundleId: string) => void;
  /** Selects a layer of the open project and fits the map to it. */
  zoomToLayer: (layerProjectId: number) => void;
  /** Adds what a card stands for to a project (default: the open one); throws when it fails. */
  addToProject: (item: ResultItem, projectId?: string) => Promise<AddedToProject>;
  /** Opens a project; binds an unbound conversation first when asked, and scrolls to a proposal. */
  openInProject: (
    projectId: string,
    options?: { bindConversationId?: string; partId?: string; projectName?: string | null }
  ) => Promise<void>;
  /** A catalog link with a search and filters in its URL. */
  openCatalog: (href: string) => void;
  newConversationHere: () => void;
}

export const DockActionsContext = createContext<DockActions | null>(null);

export function useDockActions(): DockActions {
  const actions = useContext(DockActionsContext);
  if (!actions) throw new Error("useDockActions is used outside the assistant dock");
  return actions;
}
