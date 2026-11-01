import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AssistantMessage } from "@/lib/assistant/types";

import { useWorkflowRunRefresh } from "@/components/assistant/useWorkflowRunRefresh";

const { refreshJobLists, mutate } = vi.hoisted(() => ({ refreshJobLists: vi.fn(), mutate: vi.fn() }));
vi.mock("@/lib/api/processes", () => ({ refreshJobLists }));
vi.mock("swr", async (original) => ({ ...(await original<Record<string, unknown>>()), mutate }));

const answer = (status: string, saved = 0, id = "a1"): AssistantMessage =>
  ({
    id,
    role: "assistant",
    parts: [
      {
        type: "data-workflow-run",
        id: "workflow-run:j1",
        data: {
          workflow_id: "w1",
          project_id: "p1",
          job_id: "j1",
          status,
          started: true,
          card_id: null,
          done: 0,
          total: 2,
          step: null,
          started_at: null,
          saved,
        },
      },
    ],
  }) as unknown as AssistantMessage;

describe("useWorkflowRunRefresh", () => {
  beforeEach(() => {
    refreshJobLists.mockReset();
    mutate.mockReset();
  });

  it("reads the job lists when a run starts and the layers when it saved some", () => {
    const { rerender } = renderHook(({ messages }) => useWorkflowRunRefresh(messages, []), {
      initialProps: { messages: [answer("running")] },
    });
    expect(refreshJobLists).toHaveBeenCalledTimes(1);
    expect(mutate).not.toHaveBeenCalled();
    rerender({ messages: [answer("succeeded", 1)] });
    expect(refreshJobLists).toHaveBeenCalledTimes(2);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("reads the layers when a run saved some, also a run that failed later", () => {
    renderHook(() => useWorkflowRunRefresh([answer("failed", 1)], []));
    expect(refreshJobLists).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("tells apart two answers that report the same job, one waiting and one after the run", () => {
    // A later answer waits on the job an earlier one left running: both carry its part id.
    const messages = () => [answer("running", 0, "a1"), answer("succeeded", 1, "a2")];
    const { rerender } = renderHook(({ messages }) => useWorkflowRunRefresh(messages, []), {
      initialProps: { messages: messages() },
    });
    expect(refreshJobLists).toHaveBeenCalledTimes(2);
    expect(mutate).toHaveBeenCalledTimes(1);
    rerender({ messages: messages() });
    rerender({ messages: messages() });
    expect(refreshJobLists).toHaveBeenCalledTimes(2);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("does nothing for the runs of the conversation as it was opened", () => {
    const stored = [answer("succeeded", 1)];
    renderHook(() => useWorkflowRunRefresh(stored, stored));
    expect(refreshJobLists).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });
});
