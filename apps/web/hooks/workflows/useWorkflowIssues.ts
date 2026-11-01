"use client";

import type { Edge, Node } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { checkWorkflow } from "@/lib/api/workflows";
import { stepName } from "@/lib/utils/workflowIssueText";
import type { WorkflowNode, WorkflowVariable } from "@/lib/validations/workflow";
import type { WorkflowIssue } from "@/lib/validations/workflowIssues";

/** Quiet time after the last edit before the steps are checked again. */
export const CHECK_DEBOUNCE_MS = 500;

const NO_ISSUES: WorkflowIssue[] = [];

export interface UseWorkflowIssuesArgs {
  projectId?: string;
  workflowId?: string;
  nodes: Node[];
  edges: Edge[];
  variables: WorkflowVariable[];
  /** Error text of each step that failed in the current or last run (useWorkflowExecution). */
  nodeErrors: Record<string, string>;
  enabled: boolean;
}

export interface UseWorkflowIssuesResult {
  issues: WorkflowIssue[];
  isChecking: boolean;
  /** The check of the current steps failed: `issues` may not describe them. */
  checkFailed: boolean;
  /** Checks the current steps again at once. */
  recheck: () => void;
  /** Shows these issues until the next check, such as the issues of a refused run. */
  replaceIssues: (issues: WorkflowIssue[]) => void;
}

/**
 * What the check needs of the editor's state: the steps' ids, types and data,
 * the connections and the variables as a run sends them. Positions, sizes and
 * selection are left out, so moving a step does not start a check.
 */
const checkPayload = (nodes: Node[], edges: Edge[], variables: WorkflowVariable[]) => ({
  nodes: nodes.map((node) => ({ id: node.id, type: node.type, data: node.data })),
  edges: edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    sourceHandle: edge.sourceHandle ?? undefined,
    target: edge.target,
    targetHandle: edge.targetHandle ?? undefined,
  })),
  variables: variables.map((variable) => ({
    name: variable.name,
    type: variable.type,
    defaultValue: variable.defaultValue,
  })),
});

type CheckPayload = ReturnType<typeof checkPayload>;

/** A step's data as text, to tell whether the step changed since its run error arrived. */
const dataKey = (node: Node | undefined): string => (node ? JSON.stringify(node.data) : "");

interface RunSnapshot {
  /** `nodeErrors` as text, to notice a new set of errors. */
  key: string;
  errors: Record<string, string>;
  /** Each failed step's data when its error arrived. */
  data: Record<string, string>;
}

const snapshotOf = (nodeErrors: Record<string, string>, nodes: Node[]): RunSnapshot => ({
  key: JSON.stringify(nodeErrors),
  errors: nodeErrors,
  data: Object.fromEntries(
    Object.keys(nodeErrors).map((id) => [id, dataKey(nodes.find((node) => node.id === id))])
  ),
});

/**
 * The issue list of the open workflow: processes' check of the steps as the
 * editor holds them (saved or not), plus a `run_failed` issue for each step
 * that failed in the last run. A workflow is checked once when it opens and
 * again 500 ms after the last edit; an answer to an older state is dropped.
 * A failed check keeps the list and sets `checkFailed` until a check succeeds.
 * A step's run error goes when the next run starts or when the step's data
 * changes.
 */
export function useWorkflowIssues({
  projectId,
  workflowId,
  nodes,
  edges,
  variables,
  nodeErrors,
  enabled,
}: UseWorkflowIssuesArgs): UseWorkflowIssuesResult {
  const { t, i18n } = useTranslation("common");
  const language = i18n?.language || "en";
  const active = enabled && !!projectId && !!workflowId;

  const [checked, setChecked] = useState<WorkflowIssue[]>(NO_ISSUES);
  const [isChecking, setIsChecking] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  // Bumped by recheck: the same steps are checked again, without the debounce.
  const [retry, setRetry] = useState(0);
  const retryRef = useRef(0);
  // Every state of the steps takes the next number, and so does replaceIssues;
  // an answer is applied only while its number is still the latest.
  const latestRef = useRef(0);
  const openedRef = useRef<string | null>(null);

  const payloadKey = useMemo(
    () => JSON.stringify(checkPayload(nodes, edges, variables)),
    [nodes, edges, variables]
  );
  const payload = useMemo(() => JSON.parse(payloadKey) as CheckPayload, [payloadKey]);

  useEffect(() => {
    const seq = ++latestRef.current;
    if (!active || !projectId || !workflowId) {
      openedRef.current = null;
      setChecked(NO_ISSUES);
      setIsChecking(false);
      setCheckFailed(false);
      return;
    }
    const workflowKey = `${projectId}/${workflowId}`;
    const opened = openedRef.current !== workflowKey;
    openedRef.current = workflowKey;
    if (opened) {
      setChecked(NO_ISSUES);
      setCheckFailed(false);
    }
    const retried = retryRef.current !== retry;
    retryRef.current = retry;

    const send = () => {
      if (seq !== latestRef.current) return;
      setIsChecking(true);
      checkWorkflow({ projectId, language, ...payload })
        .then((issues) => {
          if (seq !== latestRef.current) return;
          setChecked(issues);
          setCheckFailed(false);
        })
        // A failed check keeps the list as it is; processes checks a run again anyway.
        .catch(() => {
          if (seq === latestRef.current) setCheckFailed(true);
        })
        .finally(() => {
          if (seq === latestRef.current) setIsChecking(false);
        });
    };

    if (opened || retried) {
      send();
      return;
    }
    const timer = setTimeout(send, CHECK_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [active, projectId, workflowId, payload, language, retry]);

  const [runSnapshot, setRunSnapshot] = useState<RunSnapshot>(() => snapshotOf(nodeErrors, nodes));
  if (runSnapshot.key !== JSON.stringify(nodeErrors)) {
    // A new set of run errors: remember the failed steps' data now, so an
    // error goes once its step is edited.
    setRunSnapshot(snapshotOf(nodeErrors, nodes));
  }

  const runIssues = useMemo(
    () =>
      Object.entries(runSnapshot.errors).flatMap(([nodeId, error]): WorkflowIssue[] => {
        const node = nodes.find((candidate) => candidate.id === nodeId);
        if (!node || dataKey(node) !== runSnapshot.data[nodeId]) return [];
        return [
          {
            code: "run_failed",
            level: "error",
            node_ids: [nodeId],
            field: null,
            message: error,
            params: { step: stepName(t, node as unknown as WorkflowNode), error },
            source: "run",
          },
        ];
      }),
    [runSnapshot, nodes, t]
  );

  const issues = useMemo(
    () => (active ? [...checked, ...runIssues] : NO_ISSUES),
    [active, checked, runIssues]
  );

  const replaceIssues = useCallback((next: WorkflowIssue[]) => {
    latestRef.current += 1;
    setChecked(next);
    setIsChecking(false);
    setCheckFailed(false);
  }, []);

  const recheck = useCallback(() => setRetry((count) => count + 1), []);

  return { issues, isChecking, checkFailed: active && checkFailed, recheck, replaceIssues };
}
