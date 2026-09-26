/**
 * A workflow open in two tabs: both pick up the same run, and only one of them
 * tells the user it ended. The other still updates its canvas.
 */
import { configureStore } from "@reduxjs/toolkit";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { Provider } from "react-redux";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Job } from "@/lib/api/processes";
import { jobsReduces } from "@/lib/store/jobs/slice";
import { workflowReducer } from "@/lib/store/workflow/slice";
import { claimJobAnnouncement } from "@/lib/utils/jobAnnouncement";
import type { WorkflowNode } from "@/lib/validations/workflow";

import { useWorkflowExecution } from "@/hooks/workflows/useWorkflowExecution";

const { useJobsMock, toastMock, t } = vi.hoisted(() => ({
  useJobsMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
  // `t` is an effect dependency: a new function per render would re-run the effect forever
  t: (key: string) => key,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t }),
}));
vi.mock("react-toastify", () => ({ toast: toastMock }));
vi.mock("@/lib/api/processes", () => ({
  useJobs: () => useJobsMock(),
  dismissJob: vi.fn(),
}));
vi.mock("@/lib/api/workflows", () => ({
  executeWorkflow: vi.fn(),
  finalizeWorkflowLayer: vi.fn(),
  cleanupWorkflowTemp: vi.fn(),
}));

const toolNode = {
  id: "tool-1",
  type: "tool",
  position: { x: 0, y: 0 },
  data: { type: "tool", processId: "buffer", label: "Buffer", config: {} },
} as unknown as WorkflowNode;

const run = (status: Job["status"]): Job =>
  ({
    jobID: "job-1",
    processID: "workflow_runner",
    status,
    inputs: { workflow_id: "w1" },
    message: status === "failed" ? "boom" : undefined,
  }) as unknown as Job;

const setJobs = (jobs: Job[]) => useJobsMock.mockReturnValue({ jobs: { jobs }, mutate: vi.fn() });

const renderOpenWorkflow = () => {
  const store = configureStore({
    reducer: { workflow: workflowReducer, jobs: jobsReduces },
    preloadedState: {
      workflow: {
        workflows: [],
        selectedWorkflowId: null,
        selectedNodeId: null,
        nodes: [toolNode],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        variables: [],
        isDirty: false,
        requestMapView: false,
        requestTableView: false,
        activeDataPanelView: null,
      },
      jobs: { runningJobIds: [] },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;
  return renderHook(() => useWorkflowExecution({ workflow: { id: "w1" }, projectId: "p1", folderId: "f1" }), {
    wrapper,
  });
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("useWorkflowExecution end-of-run announcement", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("announces a run it picked up while open", async () => {
    setJobs([run("running")]);
    const { result, rerender } = renderOpenWorkflow();
    await waitFor(() => expect(result.current.isExecuting).toBe(true));

    setJobs([run("successful")]);
    rerender();

    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith("workflow_completed"));
  });

  it("finishes quietly when another tab announced the completed run", async () => {
    setJobs([run("running")]);
    const { result, rerender } = renderOpenWorkflow();
    await waitFor(() => expect(result.current.isExecuting).toBe(true));

    await claimJobAnnouncement("job-1");
    setJobs([run("successful")]);
    rerender();

    await waitFor(() => expect(result.current.isExecuting).toBe(false));
    await flush();
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("fails quietly when another tab announced the failed run", async () => {
    setJobs([run("running")]);
    const { result, rerender } = renderOpenWorkflow();
    await waitFor(() => expect(result.current.isExecuting).toBe(true));

    await claimJobAnnouncement("job-1");
    setJobs([run("failed")]);
    rerender();

    await waitFor(() => expect(result.current.error).toBe("boom"));
    await flush();
    expect(toastMock.error).not.toHaveBeenCalled();
  });
});
