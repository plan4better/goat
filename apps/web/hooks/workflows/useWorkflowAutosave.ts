"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDispatch, useSelector, useStore } from "react-redux";

import { WorkflowIssuesError, getWorkflow, updateWorkflow } from "@/lib/api/workflows";
import type { AppDispatch, RootState } from "@/lib/store";
import {
  selectContentDirty,
  selectEdges,
  selectIsDirty,
  selectNodes,
  selectOpenReloadRequest,
  selectSelectedWorkflowId,
  selectVariables,
  selectViewport,
} from "@/lib/store/workflow/selectors";
import {
  markSaved,
  reloadWorkflow,
  setWorkflowRevision,
  syncToWorkflowConfig,
  updateViewport,
} from "@/lib/store/workflow/slice";
import type { SaveConflict } from "@/lib/utils/revisionedSaver";
import type { Workflow, WorkflowNode, WorkflowUpdate } from "@/lib/validations/workflow";
import type { WorkflowIssue } from "@/lib/validations/workflowIssues";

import { useRevisionedSaver } from "@/hooks/useRevisionedSaver";

/** How long the editor waits after the last change before it saves. */
export const AUTOSAVE_DELAY_MS = 1000;

export type AutosaveStatus = "idle" | "saving" | "failed";

export interface WorkflowAutosave {
  status: AutosaveStatus;
  /** What core listed when it refused the config as damaged; empty otherwise. */
  issues: WorkflowIssue[];
  /** Saves the open workflow now, as the "Not saved" notice's Retry does. */
  retry: () => void;
  /** A save core refused because the open workflow changed elsewhere. No
   * autosave goes out until Reload or Keep mine. */
  conflict: SaveConflict | null;
  /** The conflict is with the change made elsewhere this editor waits to
   * load (an assistant edit, or the dock's Undo of one): core holds that
   * change's revision. */
  conflictByAssistant: boolean;
  /** Loads the stored workflow over the canvas. */
  reload: () => Promise<void>;
  /** Saves the canvas as it is now on top of the stored workflow; resolves
   * once that save is in (or failed, as "Not saved"). */
  keepMine: () => Promise<void>;
  /** Renames a workflow of the project, in turn with the saves: a rename
   * moves the workflow to a new revision too. */
  rename: (workflowId: string, name: string) => Promise<void>;
}

interface UseWorkflowAutosaveArgs {
  projectId?: string;
  /** False for a workflow the editor shows as damaged: it is never saved over. */
  enabled: boolean;
  /** After a save went through or the stored workflow was loaded (the layout
   * refreshes its workflow list). */
  onSaved: () => void;
}

/**
 * Saves the open workflow a moment after its last change. The config is read
 * from the store when the save starts, so the debounce restarts on every
 * change but a failed save does not retry on its own: it stays "failed" until
 * Retry or the next change. A change made while a save is under way keeps the
 * workflow unsaved, and the debounce that change started saves it once the
 * save under way is done.
 *
 * Each save sends the revision the canvas is based on (the store's
 * `revisions`). When core refuses it because the workflow changed elsewhere,
 * autosave stops and `conflict` says who changed it and when, until Reload
 * or Keep mine.
 *
 * A change made elsewhere that the editor takes over (`requestWorkflowReload`:
 * the assistant edited the open workflow, or the dock's Undo took that back)
 * never drops work made here. What is not saved yet is saved first, at once:
 * a change of the steps runs into the other change and the conflict banner
 * lets the person choose; a pan alone waits and is saved on the loaded
 * revision. An open banner and a failed save keep their work: the change is
 * loaded only after Reload, Keep mine (which saves over it) or a save that
 * lands. Then the stored workflow is loaded with its revision.
 */
export function useWorkflowAutosave({
  projectId,
  enabled,
  onSaved,
}: UseWorkflowAutosaveArgs): WorkflowAutosave {
  const dispatch = useDispatch<AppDispatch>();
  const store = useStore<RootState>();
  const workflowId = useSelector(selectSelectedWorkflowId);
  const nodes = useSelector(selectNodes);
  const edges = useSelector(selectEdges);
  const viewport = useSelector(selectViewport);
  const variables = useSelector(selectVariables);
  const isDirty = useSelector(selectIsDirty);
  const contentDirty = useSelector(selectContentDirty);
  const reloadRequest = useSelector(selectOpenReloadRequest);
  const [status, setStatus] = useState<AutosaveStatus>("idle");
  /** A requested reload is under way; one that comes meanwhile follows it. */
  const loading = useRef(false);
  const [followed, setFollowed] = useState(0);
  /** The request read last, by workflow and revision: a failed read is not repeated on its own. */
  const attempted = useRef<string | null>(null);
  const [issues, setIssues] = useState<WorkflowIssue[]>([]);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { saver, conflict } = useRevisionedSaver<WorkflowUpdate>({
    send: async (id, update, baseRevision) => {
      if (!projectId) throw new Error("No project to save the workflow in");
      const updated = await updateWorkflow(projectId, id, { ...update, base_revision: baseRevision });
      return updated?.revision;
    },
    isOpen: (id) => store.getState().workflow.selectedWorkflowId === id,
    revisions: {
      get: (id) => store.getState().workflow.revisions[id],
      set: (id, revision) => dispatch(setWorkflowRevision({ id, revision })),
    },
  });

  /** Saves the canvas; with `keepMine`, on top of the revision a conflict reported. */
  const save = useCallback(
    async (keepMine = false) => {
      const state = store.getState().workflow;
      const workflow = state.workflows.find((w) => w.id === state.selectedWorkflowId);
      if (!enabled || !projectId || !workflow) return;

      const saved = {
        nodes: state.nodes,
        edges: state.edges,
        viewport: state.viewport,
        variables: state.variables,
      };
      const config: Workflow["config"] = {
        ...workflow.config,
        nodes: saved.nodes.map((node) => ({
          id: node.id,
          type: node.type as WorkflowNode["type"],
          position: node.position,
          data: node.data as WorkflowNode["data"],
        })),
        edges: saved.edges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          sourceHandle: edge.sourceHandle || undefined,
          target: edge.target,
          targetHandle: edge.targetHandle || undefined,
        })),
        viewport: saved.viewport,
        variables: saved.variables,
      };

      setStatus("saving");
      try {
        dispatch(syncToWorkflowConfig());
        const outcome = keepMine
          ? await saver.keepMine({ config })
          : await saver.save(workflow.id, { config });
        if (outcome !== "saved") {
          // Held by a conflict: the banner takes over from here.
          setStatus("idle");
          return;
        }
        const now = store.getState().workflow;
        if (
          now.nodes === saved.nodes &&
          now.edges === saved.edges &&
          now.viewport === saved.viewport &&
          now.variables === saved.variables
        ) {
          dispatch(markSaved());
        }
        setStatus("idle");
        setIssues([]);
        onSaved();
      } catch (error) {
        console.error("Failed to save workflow:", error);
        setStatus("failed");
        setIssues(error instanceof WorkflowIssuesError ? error.issues : []);
      }
    },
    [enabled, projectId, store, dispatch, onSaved, saver]
  );

  // With a change made elsewhere waiting to be loaded, a change of the steps
  // is saved at once (after a save under way; a failed one waits for Retry)
  // and a pan alone waits for the load.
  const following = reloadRequest !== undefined;
  const waitForSave = following && status !== "idle";
  useEffect(() => {
    if (!isDirty || !enabled || conflict) return;
    if (following && (!contentDirty || waitForSave)) return;
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = setTimeout(
      () => {
        void save();
      },
      following ? 0 : AUTOSAVE_DELAY_MS
    );
    return () => {
      if (timeout.current) clearTimeout(timeout.current);
    };
  }, [
    isDirty,
    contentDirty,
    following,
    waitForSave,
    enabled,
    conflict,
    save,
    nodes,
    edges,
    viewport,
    variables,
  ]);

  // Another workflow opened: the last one's failed save or conflict no longer
  // applies here.
  useEffect(() => {
    setStatus("idle");
    setIssues([]);
    saver.dismiss();
  }, [workflowId, saver]);

  const retry = useCallback(() => {
    if (timeout.current) clearTimeout(timeout.current);
    void save();
  }, [save]);

  const keepMine = useCallback(() => {
    if (timeout.current) clearTimeout(timeout.current);
    return save(true);
  }, [save]);

  const reload = useCallback(async () => {
    const open = saver.conflict;
    if (!open || !projectId) return;
    try {
      const stored = await getWorkflow(projectId, open.id);
      dispatch(reloadWorkflow(stored));
      saver.dismiss();
      setStatus("idle");
      setIssues([]);
      onSaved();
    } catch (error) {
      console.error("Failed to reload workflow:", error);
    }
  }, [saver, projectId, dispatch, onSaved]);

  useEffect(() => {
    if (reloadRequest === undefined || !projectId || !workflowId || loading.current) return;
    // The person chooses first (banner), a save runs or failed, or work is
    // not saved yet (saved at once above): the load waits.
    if (conflict || status !== "idle" || contentDirty) return;
    const key = `${workflowId}:${reloadRequest}`;
    if (attempted.current === key) return;
    attempted.current = key;
    loading.current = true;
    const id = workflowId;
    void (async () => {
      try {
        await saver.idle();
        const stored = await getWorkflow(projectId, id);
        const now = store.getState().workflow;
        if (now.selectedWorkflowId !== id) return;
        if (saver.conflict || now.contentDirty) {
          // A change made while it was read goes first; read again after it.
          attempted.current = null;
          return;
        }
        const panned = now.isDirty;
        if (timeout.current) clearTimeout(timeout.current);
        dispatch(reloadWorkflow(stored));
        // A pan made here stays, and is saved on the loaded revision.
        if (panned) dispatch(updateViewport(now.viewport));
        setStatus("idle");
        setIssues([]);
        onSaved();
      } catch (error) {
        console.error("Failed to load the changed workflow:", error);
      } finally {
        loading.current = false;
        setFollowed((count) => count + 1);
      }
    })();
  }, [
    reloadRequest,
    projectId,
    workflowId,
    saver,
    store,
    dispatch,
    onSaved,
    followed,
    conflict,
    status,
    contentDirty,
  ]);

  const rename = useCallback(
    async (id: string, name: string) => {
      await saver.save(id, { name });
    },
    [saver]
  );

  const conflictByAssistant =
    !!conflict && reloadRequest !== undefined && conflict.revision === reloadRequest;

  return { status, issues, retry, conflict, conflictByAssistant, reload, keepMine, rename };
}
