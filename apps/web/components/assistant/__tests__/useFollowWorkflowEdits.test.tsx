import { renderHook } from "@testing-library/react";
import type { DynamicToolUIPart } from "ai";
import { type ReactNode, StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AssistantMessage } from "@/lib/assistant/types";

import { DockActionsContext } from "@/components/assistant/DockActions";
import { dockActions } from "@/components/assistant/__tests__/helpers";
import {
  resetFollowedWorkflowEdits,
  useFollowWorkflowEdits,
} from "@/components/assistant/useFollowWorkflowEdits";

const actions = dockActions();
const wrapper = ({ children }: { children: ReactNode }) => (
  <StrictMode>
    <DockActionsContext.Provider value={actions}>{children}</DockActionsContext.Provider>
  </StrictMode>
);
const asked: AssistantMessage = {
  id: "u1",
  role: "user",
  parts: [{ type: "text", text: "Make it 10 minutes" }],
};
const edited = (
  id: string,
  before: number,
  after: number,
  toolCallId = `call-${after}`
): AssistantMessage => ({
  id,
  role: "assistant",
  parts: [
    {
      type: "dynamic-tool",
      toolName: "workflow_update",
      toolCallId,
      state: "output-available",
      input: {},
      output: { workflow_id: "wf-1", revision_before: before, revision_after: after, changed_steps: [] },
    } as DynamicToolUIPart,
  ],
});
const mount = (messages: AssistantMessage[], initialMessages: AssistantMessage[]) =>
  renderHook(({ list }: { list: AssistantMessage[] }) => useFollowWorkflowEdits(list, initialMessages), {
    initialProps: { list: messages },
    wrapper,
  });

beforeEach(() => {
  vi.clearAllMocks();
  resetFollowedWorkflowEdits();
});

describe("useFollowWorkflowEdits", () => {
  it("hands each edit of the running answer to the page once, also under StrictMode", () => {
    const view = mount([asked], [asked]);
    view.rerender({ list: [asked, edited("a1", 4, 5)] });
    view.rerender({ list: [asked, edited("a1", 4, 5)] });
    const calls = vi.mocked(actions.followWorkflowChanges).mock.calls.filter(([changes]) => changes.length);
    expect(calls).toEqual([[[{ workflowId: "wf-1", revision: 5 }]]]);
  });

  it("hands the edits of the conversation as it was loaded to the page once per tab", () => {
    // Read again right after the answer: the editor may not have its edit yet.
    // The editor ignores a revision it holds already.
    const stored = [asked, edited("a0", 4, 5)];
    mount(stored, stored).unmount();
    mount(stored, stored);
    const calls = vi.mocked(actions.followWorkflowChanges).mock.calls.filter(([changes]) => changes.length);
    expect(calls).toEqual([[[{ workflowId: "wf-1", revision: 5 }]]]);
  });
});
