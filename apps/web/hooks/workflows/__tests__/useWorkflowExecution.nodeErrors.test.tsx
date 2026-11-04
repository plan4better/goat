/**
 * A failed step's own error text reaches the editor through the job status's
 * `node_errors`: while the run goes on, and after it failed. A new run starts
 * without the errors of the last one.
 */
import { configureStore } from "@reduxjs/toolkit";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { Provider } from "react-redux";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Job } from "@/lib/api/processes";
import { executeWorkflow } from "@/lib/api/workflows";
import { jobsReduces } from "@/lib/store/jobs/slice";
import { workflowReducer } from "@/lib/store/workflow/slice";
import type { WorkflowNode } from "@/lib/validations/workflow";

import { useWorkflowExecution } from "@/hooks/workflows/useWorkflowExecution";

const { useJobsMock, toastMock, t } = vi.hoisted(() => ({
  useJobsMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
  // `t` is an effect dependency: a new function per render would re-run the effect forever
  t: (key: string) => key,
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t }) }));
vi.mock("react-toastify", () => ({ toast: toastMock }));
vi.mock("@/lib/api/processes", () => ({
  useJobs: () => useJobsMock(),
  dismissJob: vi.fn(),
}));
vi.mock("@/lib/api/workflows", () => ({
  executeWorkflow: vi.fn(),
  finalizeWorkflowLayer: vi.fn(),
}));

const ERROR = "Column population not found";

const toolNode = {
  id: "tool-1",
  type: "tool",
  position: { x: 0, y: 0 },
  data: { type: "tool", processId: "buffer", label: "Buffer", config: {} },
} as unknown as WorkflowNode;

const run = (status: Job["status"], nodeErrors?: Record<string, string>): Job =>
  ({
    jobID: "job-1",
    processID: "workflow_runner",
    status,
    inputs: { workflow_id: "w1" },
    message: status === "failed" ? "Node tool-1 failed" : undefined,
    ...(nodeErrors ? { node_errors: nodeErrors } : {}),
  }) as unknown as Job;

const setJobs = (jobs: Job[]) => useJobsMock.mockReturnValue({ jobs: { jobs }, mutate: vi.fn() });

const renderOpenWorkflow = () => {
  const store = configureStore({
    reducer: { workflow: workflowReducer, jobs: jobsReduces },
    preloadedState: {
      workflow: { ...workflowReducer(undefined, { type: "init" }), nodes: [toolNode] },
      jobs: { runningJobIds: [] },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;
  return renderHook(() => useWorkflowExecution({ workflow: { id: "w1" }, projectId: "p1", folderId: "f1" }), {
    wrapper,
  });
};

describe("useWorkflowExecution step errors", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("shows a step's error while the run goes on and keeps it after the run failed", async () => {
    setJobs([run("running", { "tool-1": ERROR })]);
    const { result, rerender } = renderOpenWorkflow();
    await waitFor(() => expect(result.current.nodeErrors).toEqual({ "tool-1": ERROR }));

    setJobs([run("failed", { "tool-1": ERROR })]);
    rerender();

    await waitFor(() => expect(result.current.isExecuting).toBe(false));
    expect(result.current.nodeErrors).toEqual({ "tool-1": ERROR });
    expect(result.current.nodeStatuses["tool-1"]).toBe("failed");
  });

  it("starts a new run without the errors of the last one", async () => {
    setJobs([run("running", { "tool-1": ERROR })]);
    const { result, rerender } = renderOpenWorkflow();
    await waitFor(() => expect(result.current.nodeErrors).toEqual({ "tool-1": ERROR }));
    setJobs([run("failed", { "tool-1": ERROR })]);
    rerender();
    await waitFor(() => expect(result.current.isExecuting).toBe(false));

    vi.mocked(executeWorkflow).mockResolvedValue({ job_id: "job-2", workflow_id: "w1", status: "accepted" });
    await act(async () => {
      await result.current.execute();
    });

    expect(result.current.nodeErrors).toEqual({});
  });
});
