"use client";

import { useReactFlow } from "@xyflow/react";
import { useCallback, useRef, useState } from "react";
import { useDispatch, useStore } from "react-redux";

import type { AppDispatch, RootState } from "@/lib/store";
import { selectNode } from "@/lib/store/workflow/slice";
import type { WorkflowIssue } from "@/lib/validations/workflowIssues";

import type { FocusRequest } from "@/components/workflows/issues/WorkflowIssuesContext";

/** The canvas zooms in to at least this when it moves to a step, so the step can be read. */
const FOCUS_MIN_ZOOM = 1;
const FOCUS_DURATION_MS = 300;

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;

/**
 * Takes the editor to the steps of an issue: selects them (the side panel
 * then shows the first one's settings), centres the canvas on the first one
 * in canvas order and publishes a focus request the settings use to reach
 * `field`. Use inside the ReactFlowProvider and the Redux store.
 */
export function useIssueFocus(): {
  focus: (issue: WorkflowIssue) => void;
  focusRequest: FocusRequest | null;
} {
  const dispatch = useDispatch<AppDispatch>();
  const store = useStore<RootState>();
  const { getInternalNode, getZoom, setCenter, setNodes } = useReactFlow();
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const seqRef = useRef(0);

  const focus = useCallback(
    (issue: WorkflowIssue) => {
      const ids = new Set(issue.node_ids);
      const steps = store.getState().workflow.nodes.filter((node) => ids.has(node.id));
      const first = steps[0];
      if (!first) return;

      dispatch(selectNode(first.id));
      // WorkflowCanvas mirrors selectedNodeId onto React Flow's selection in an
      // effect that leaves only that step selected; the issue's other steps (a
      // loop) are selected once that effect has run.
      window.setTimeout(() => {
        setNodes((current) =>
          current.map((node) =>
            node.selected === ids.has(node.id) ? node : { ...node, selected: ids.has(node.id) }
          )
        );
      }, 0);

      const internal = getInternalNode(first.id);
      const position = internal?.internals.positionAbsolute ?? first.position;
      const width = internal?.measured.width ?? 0;
      const height = internal?.measured.height ?? 0;
      void setCenter(position.x + width / 2, position.y + height / 2, {
        zoom: Math.max(getZoom(), FOCUS_MIN_ZOOM),
        duration: prefersReducedMotion() ? 0 : FOCUS_DURATION_MS,
      });

      seqRef.current += 1;
      setFocusRequest({ nodeId: first.id, field: issue.field, seq: seqRef.current });
    },
    [dispatch, store, getInternalNode, getZoom, setCenter, setNodes]
  );

  return { focus, focusRequest };
}
