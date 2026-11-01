import { configureStore } from "@reduxjs/toolkit";
import { act, renderHook } from "@testing-library/react";
import type { Node } from "@xyflow/react";
import type { ReactNode } from "react";
import React from "react";
import { Provider } from "react-redux";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { workflowReducer } from "@/lib/store/workflow/slice";
import type { WorkflowIssue } from "@/lib/validations/workflowIssues";

import { useIssueFocus } from "@/hooks/workflows/useIssueFocus";

const flow = vi.hoisted(() => ({
  getInternalNode: vi.fn(),
  getZoom: vi.fn(),
  setCenter: vi.fn(),
  setNodes: vi.fn(),
}));

vi.mock("@xyflow/react", () => ({ useReactFlow: () => flow }));

const NODES: Node[] = [
  { id: "dataset-1", type: "dataset", position: { x: 0, y: 0 }, data: { type: "dataset", label: "Schools" } },
  {
    id: "tool-1",
    type: "tool",
    position: { x: 300, y: 100 },
    data: { type: "tool", processId: "buffer", label: "buffer", config: {} },
  },
  {
    id: "tool-2",
    type: "tool",
    position: { x: 600, y: 100 },
    data: { type: "tool", processId: "clip", label: "clip", config: {} },
  },
];

const issue = (code: string, nodeIds: string[], field: string | null = null): WorkflowIssue => ({
  code,
  level: "error",
  node_ids: nodeIds,
  field,
  message: code,
  params: {},
  source: "check",
});

const setup = () => {
  const store = configureStore({
    reducer: { workflow: workflowReducer },
    preloadedState: { workflow: { ...workflowReducer(undefined, { type: "init" }), nodes: NODES } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;
  return { store, ...renderHook(() => useIssueFocus(), { wrapper }) };
};

/** The steps selected after the hook's last setNodes update, starting from the dataset step selected. */
const selectedAfterUpdate = () => {
  const update = flow.setNodes.mock.calls.at(-1)?.[0] as (nodes: Node[]) => Node[];
  return update(NODES.map((node) => ({ ...node, selected: node.id === "dataset-1" })))
    .filter((node) => node.selected)
    .map((node) => node.id);
};

describe("useIssueFocus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    flow.getZoom.mockReturnValue(0.4);
    flow.setCenter.mockResolvedValue(true);
    flow.getInternalNode.mockImplementation((id: string) => {
      const node = NODES.find((n) => n.id === id);
      return (
        node && {
          ...node,
          measured: { width: 200, height: 80 },
          internals: { positionAbsolute: node.position },
        }
      );
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("selects the step, centres the canvas on it and asks its settings for the field", () => {
    const { store, result } = setup();

    act(() => result.current.focus(issue("setting_required", ["tool-1"], "distance")));

    expect(store.getState().workflow.selectedNodeId).toBe("tool-1");
    expect(flow.setCenter).toHaveBeenCalledWith(400, 140, { zoom: 1, duration: 300 });
    expect(result.current.focusRequest).toEqual({ nodeId: "tool-1", field: "distance", seq: 1 });
    act(() => void vi.advanceTimersByTime(0));
    expect(selectedAfterUpdate()).toEqual(["tool-1"]);
  });

  it("numbers every request, so the same step and field can be asked for again", () => {
    const { result } = setup();
    const missing = issue("setting_required", ["tool-1"], "distance");

    act(() => result.current.focus(missing));
    act(() => result.current.focus(missing));

    expect(result.current.focusRequest).toEqual({ nodeId: "tool-1", field: "distance", seq: 2 });
  });

  it("selects every step of a loop and centres on the first one on the canvas", () => {
    const { store, result } = setup();

    act(() => result.current.focus(issue("loop", ["tool-2", "tool-1"])));

    expect(store.getState().workflow.selectedNodeId).toBe("tool-1");
    expect(flow.setCenter).toHaveBeenCalledWith(400, 140, expect.objectContaining({ zoom: 1 }));
    expect(result.current.focusRequest).toEqual({ nodeId: "tool-1", field: null, seq: 1 });
    act(() => void vi.advanceTimersByTime(0));
    expect(selectedAfterUpdate()).toEqual(["tool-1", "tool-2"]);
  });

  it("does nothing for an issue of the whole workflow or of a step that is gone", () => {
    const { store, result } = setup();

    act(() => result.current.focus(issue("connection_to_removed_step", [])));
    act(() => result.current.focus(issue("tool_removed", ["tool-9"])));

    expect(store.getState().workflow.selectedNodeId).toBeNull();
    expect(flow.setCenter).not.toHaveBeenCalled();
    expect(result.current.focusRequest).toBeNull();
  });
});
