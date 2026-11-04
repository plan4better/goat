/**
 * Run gate and refusals. Whether the steps are ready is the issue list's call
 * (useWorkflowIssues: an unresolved template input is its `layer_not_chosen`
 * issue); the execution hook only needs a tool step and no run going on. A
 * run processes refuses with issues (422) hands them back instead of a toast.
 */
import { configureStore } from "@reduxjs/toolkit";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import React from "react";
import { Provider } from "react-redux";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorkflowIssuesError, executeWorkflow } from "@/lib/api/workflows";
import { jobsReduces } from "@/lib/store/jobs/slice";
import { workflowReducer } from "@/lib/store/workflow/slice";
import type { WorkflowEdge, WorkflowNode } from "@/lib/validations/workflow";
import type { WorkflowIssue } from "@/lib/validations/workflowIssues";

import { useWorkflowExecution } from "@/hooks/workflows/useWorkflowExecution";

const { toastMock, t, i18n } = vi.hoisted(() => ({
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
  t: (key: string) => key,
  i18n: { language: "de" },
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t, i18n }) }));
vi.mock("react-toastify", () => ({ toast: toastMock }));
vi.mock("@/lib/api/processes", () => ({
  useJobs: () => ({ jobs: [], mutate: vi.fn() }),
  dismissJob: vi.fn(),
}));
vi.mock("@/lib/api/workflows", () => {
  class WorkflowIssuesError extends Error {
    constructor(
      public readonly issues: unknown[],
      message = "The workflow has issues."
    ) {
      super(message);
      this.name = "WorkflowIssuesError";
    }
  }
  return { WorkflowIssuesError, executeWorkflow: vi.fn(), finalizeWorkflowLayer: vi.fn() };
});

const toolNode: WorkflowNode = {
  id: "tool-1",
  type: "tool",
  position: { x: 0, y: 0 },
  data: { type: "tool", processId: "buffer", label: "Buffer", config: {} },
} as unknown as WorkflowNode;

const unresolvedDatasetNode: WorkflowNode = {
  id: "dataset-1",
  type: "dataset",
  position: { x: 0, y: 0 },
  data: { type: "dataset", label: "Dataset", unresolved: true },
} as unknown as WorkflowNode;

const resolvedDatasetNode: WorkflowNode = {
  id: "dataset-2",
  type: "dataset",
  position: { x: 0, y: 0 },
  data: { type: "dataset", label: "Dataset", layerId: "11111111-1111-1111-1111-111111111111" },
} as unknown as WorkflowNode;

const LAYER_NOT_CHOSEN: WorkflowIssue = {
  code: "layer_not_chosen",
  level: "error",
  node_ids: ["dataset-1"],
  field: null,
  message: "Dataset: no layer is chosen.",
  params: { step: "Dataset" },
  source: "check",
};

const exportNode: WorkflowNode = {
  id: "export-1",
  type: "export",
  position: { x: 0, y: 0 },
  data: { type: "export", label: "Save as dataset", datasetName: "Schulen" },
} as unknown as WorkflowNode;

const renderExecution = (nodes: WorkflowNode[], edges: WorkflowEdge[] = []) => {
  const store = configureStore({
    reducer: { workflow: workflowReducer, jobs: jobsReduces },
    preloadedState: {
      workflow: { ...workflowReducer(undefined, { type: "init" }), nodes, edges },
      jobs: { runningJobIds: [] },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;
  return renderHook(() => useWorkflowExecution({ workflow: { id: "w1" }, projectId: "p1", folderId: "f1" }), {
    wrapper,
  });
};

describe("useWorkflowExecution run gate", () => {
  it("can run a workflow with a tool step, whatever its dataset steps hold", () => {
    const { result } = renderExecution([toolNode, unresolvedDatasetNode]);
    expect(result.current.canExecute).toBe(true);
  });

  it("cannot run a workflow without a tool step", () => {
    const { result } = renderExecution([resolvedDatasetNode]);
    expect(result.current.canExecute).toBe(false);
  });

  it("can run a workflow that only saves a dataset", () => {
    const { result } = renderExecution(
      [resolvedDatasetNode, exportNode],
      [{ id: "e1", source: "dataset-2", target: "export-1" } as WorkflowEdge]
    );
    expect(result.current.canExecute).toBe(true);
  });

  it("cannot run an export with nothing connected to it", () => {
    const { result } = renderExecution([resolvedDatasetNode, exportNode]);
    expect(result.current.canExecute).toBe(false);
  });
});

describe("useWorkflowExecution run request", () => {
  it("submits the steps in the UI language", async () => {
    vi.mocked(executeWorkflow).mockResolvedValue({ job_id: "job-1", workflow_id: "w1", status: "accepted" });
    const { result } = renderExecution([toolNode, resolvedDatasetNode]);

    let refused: WorkflowIssue[] | null = [];
    await act(async () => {
      refused = await result.current.execute();
    });

    expect(executeWorkflow).toHaveBeenCalledWith(
      "w1",
      expect.objectContaining({ project_id: "p1", folder_id: "f1" }),
      "de"
    );
    expect(refused).toBeNull();
  });
});

describe("useWorkflowExecution refusals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hands back the issues of a run refused with 422, without a toast", async () => {
    vi.mocked(executeWorkflow).mockRejectedValue(new WorkflowIssuesError([LAYER_NOT_CHOSEN]));
    const { result } = renderExecution([toolNode, unresolvedDatasetNode]);

    let refused: WorkflowIssue[] | null = null;
    await act(async () => {
      refused = await result.current.execute();
    });

    expect(refused).toEqual([LAYER_NOT_CHOSEN]);
    expect(result.current.isExecuting).toBe(false);
    expect(result.current.nodeStatuses).toEqual({});
    expect(result.current.nodeExecutionInfo).toEqual({});
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("reports any other failure in a toast and hands back nothing", async () => {
    vi.mocked(executeWorkflow).mockRejectedValue(new Error("Failed to execute workflow: Internal Server Error"));
    const { result } = renderExecution([toolNode]);

    let refused: WorkflowIssue[] | null = [];
    await act(async () => {
      refused = await result.current.execute();
    });

    expect(refused).toBeNull();
    expect(result.current.error).toBe("Failed to execute workflow: Internal Server Error");
    expect(toastMock.error).toHaveBeenCalledWith("workflow_failed: Failed to execute workflow: Internal Server Error");
  });
});
