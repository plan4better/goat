/**
 * A page that is open when a run of its workflow starts elsewhere (another tab,
 * the assistant) shows that run once the job list is read again: the reconnect
 * runs on every new job list, not only on mount.
 */
import { configureStore } from "@reduxjs/toolkit";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";

import { jobsReduces } from "@/lib/store/jobs/slice";
import { workflowReducer } from "@/lib/store/workflow/slice";
import type { WorkflowNode } from "@/lib/validations/workflow";

import { useWorkflowExecution } from "@/hooks/workflows/useWorkflowExecution";

const { toastMock, t, i18n } = vi.hoisted(() => ({
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
  t: (key: string) => key,
  i18n: { language: "de" },
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t, i18n }) }));
vi.mock("react-toastify", () => ({ toast: toastMock }));
// The job list as SWR hands it out: the same object until the list is read again.
const { jobsState } = vi.hoisted(() => ({ jobsState: { current: { jobs: [] as unknown[] } } }));
vi.mock("@/lib/api/processes", () => ({
  useJobs: () => ({ jobs: jobsState.current, mutate: vi.fn() }),
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

const renderExecution = (nodes: WorkflowNode[]) => {
  const store = configureStore({
    reducer: { workflow: workflowReducer, jobs: jobsReduces },
    preloadedState: {
      workflow: { ...workflowReducer(undefined, { type: "init" }), nodes, edges: [] },
      jobs: { runningJobIds: [] },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;
  return renderHook(() => useWorkflowExecution({ workflow: { id: "w1" }, projectId: "p1", folderId: "f1" }), {
    wrapper,
  });
};

describe("useWorkflowExecution reconnect", () => {
  it("shows a run that starts while the page is open, e.g. one the assistant started", () => {
    jobsState.current = { jobs: [] };
    const { result, rerender } = renderExecution([toolNode]);
    expect(result.current.isExecuting).toBe(false);
    jobsState.current = {
      jobs: [
        {
          jobID: "j1",
          processID: "workflow_runner",
          status: "running",
          inputs: { workflow_id: "w1" },
          node_status: {},
        },
      ],
    };
    rerender();
    expect(result.current.isExecuting).toBe(true);
  });
});
