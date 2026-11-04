import type { Edge, Node } from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";

import type { AppDispatch } from "@/lib/store";
import {
  selectCanvasVersion,
  selectEdges,
  selectNodes,
  selectSelectedWorkflowId,
} from "@/lib/store/workflow/selectors";
import { restoreCanvas } from "@/lib/store/workflow/slice";

interface HistoryState {
  nodes: Node[];
  edges: Edge[];
}

const MAX_HISTORY_SIZE = 50;

const snapshot = (nodes: Node[], edges: Edge[]): HistoryState => ({
  nodes: JSON.parse(JSON.stringify(nodes)),
  edges: JSON.parse(JSON.stringify(edges)),
});

const same = (a: HistoryState, b: HistoryState): boolean =>
  JSON.stringify(a.nodes) === JSON.stringify(b.nodes) && JSON.stringify(a.edges) === JSON.stringify(b.edges);

/**
 * Hook to manage undo/redo history for workflow canvas
 * Tracks changes to nodes and edges and provides undo/redo functionality.
 * A completed move (drag end, arrow key) is a change like any other. A stored
 * version loaded over the canvas (an assistant edit, Reload on a conflict) is
 * one step of its own, recorded at once, so an undo takes back that version
 * and nothing before it; the history only starts over for another workflow.
 */
export function useWorkflowHistory() {
  const dispatch = useDispatch<AppDispatch>();
  const nodes = useSelector(selectNodes);
  const edges = useSelector(selectEdges);
  const selectedWorkflowId = useSelector(selectSelectedWorkflowId);
  const canvasVersion = useSelector(selectCanvasVersion);

  // History stacks
  const [past, setPast] = useState<HistoryState[]>([]);
  const [future, setFuture] = useState<HistoryState[]>([]);

  // Track if we're currently applying an undo/redo to avoid recording it
  const isUndoRedoRef = useRef(false);
  // The last state recorded: the step an undo goes back to once a change follows it
  const prevStateRef = useRef<HistoryState | null>(null);
  // The steps as the canvas showed them before the latest change, and the
  // canvas version then: what a stored version loaded over it replaced
  const shownRef = useRef<{ nodes: Node[]; edges: Edge[] } | null>(null);
  const versionRef = useRef(canvasVersion);
  // Debounce timer for batching rapid changes
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  const record = useCallback((entries: HistoryState[]) => {
    if (entries.length === 0) return;
    setPast((prev) => [...prev, ...entries].slice(-MAX_HISTORY_SIZE));
    setFuture([]);
  }, []);

  // Reset history when workflow changes
  useEffect(() => {
    setPast([]);
    setFuture([]);
    prevStateRef.current = null;
    shownRef.current = null;
  }, [selectedWorkflowId]);

  // Track changes and push to history
  useEffect(() => {
    const shown = shownRef.current;
    shownRef.current = { nodes, edges };
    const loaded = canvasVersion !== versionRef.current;
    versionRef.current = canvasVersion;

    // Skip if we're applying undo/redo
    if (isUndoRedoRef.current) {
      isUndoRedoRef.current = false;
      return;
    }

    if (loaded) {
      // A stored version replaced the canvas: one step at once, after a
      // change made just before it that the debounce had not recorded yet.
      const before = prevStateRef.current;
      const replaced = shown ? snapshot(shown.nodes, shown.edges) : null;
      const current = snapshot(nodes, edges);
      const entries = before ? [before] : [];
      if (replaced && (!before || !same(replaced, before))) entries.push(replaced);
      prevStateRef.current = current;
      // A stored version equal to what the canvas showed is no step.
      if (replaced && same(replaced, current)) entries.pop();
      record(entries);
      return;
    }

    // Debounce to batch rapid changes (e.g., dragging)
    debounceTimerRef.current = setTimeout(() => {
      const current = snapshot(nodes, edges);
      // Read now: the stack's update runs later, after the ref has moved on.
      const previous = prevStateRef.current;
      prevStateRef.current = current;
      // Skip if state hasn't actually changed
      if (previous && !same(previous, current)) record([previous]);
    }, 300); // 300ms debounce

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [nodes, edges, canvasVersion, record]);

  // Undo action
  const undo = useCallback(() => {
    const current = snapshot(nodes, edges);
    const recorded = prevStateRef.current;
    if (recorded && !same(recorded, current)) {
      // A change the debounce has not recorded yet is the step to take back.
      isUndoRedoRef.current = true;
      dispatch(restoreCanvas(recorded));
      setFuture((prev) => [current, ...prev]);
      return;
    }
    if (past.length === 0) return;

    const previous = past[past.length - 1];

    // Mark that we're doing undo/redo to skip history recording
    isUndoRedoRef.current = true;

    // Update Redux state; the canvas draws it anew and the autosave saves it
    dispatch(restoreCanvas(previous));

    // Update history stacks
    setPast((prev) => prev.slice(0, -1));
    setFuture((prev) => [current, ...prev]);

    // Update prev state ref
    prevStateRef.current = previous;
  }, [past, nodes, edges, dispatch]);

  // Redo action
  const redo = useCallback(() => {
    if (future.length === 0) return;

    const next = future[0];
    const current = snapshot(nodes, edges);

    // Mark that we're doing undo/redo to skip history recording
    isUndoRedoRef.current = true;

    // Update Redux state; the canvas draws it anew and the autosave saves it
    dispatch(restoreCanvas(next));

    // Update history stacks
    setFuture((prev) => prev.slice(1));
    setPast((prev) => [...prev, current]);

    // Update prev state ref
    prevStateRef.current = next;
  }, [future, nodes, edges, dispatch]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check if we're in an input field
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        return;
      }

      // Ctrl/Cmd + Z for undo
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      }

      // Ctrl/Cmd + Shift + Z or Ctrl/Cmd + Y for redo
      if ((e.ctrlKey || e.metaKey) && ((e.key === "z" && e.shiftKey) || e.key === "y")) {
        e.preventDefault();
        redo();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [undo, redo]);

  return {
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    undo,
    redo,
    historyLength: past.length,
    futureLength: future.length,
  };
}
