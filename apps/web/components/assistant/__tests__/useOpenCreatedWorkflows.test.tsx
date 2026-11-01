import { renderHook } from "@testing-library/react";
import type { DynamicToolUIPart } from "ai";
import { type ReactNode, StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AssistantMessage } from "@/lib/assistant/types";

import { DockActionsContext } from "@/components/assistant/DockActions";
import { dockActions } from "@/components/assistant/__tests__/helpers";
import {
  resetHandedOverWorkflows,
  useOpenCreatedWorkflows,
} from "@/components/assistant/useOpenCreatedWorkflows";

const actions = dockActions();
const wrapper = ({ children }: { children: ReactNode }) => (
  <StrictMode>
    <DockActionsContext.Provider value={actions}>{children}</DockActionsContext.Provider>
  </StrictMode>
);
const asked: AssistantMessage = { id: "u1", role: "user", parts: [{ type: "text", text: "Build it" }] };
const answer = (id: string, workflowId: string, toolCallId = `call-${workflowId}`): AssistantMessage => ({
  id,
  role: "assistant",
  parts: [
    {
      type: "dynamic-tool",
      toolName: "workflow_create",
      toolCallId,
      state: "output-available",
      input: {},
      output: {
        workflow: { id: workflowId, name: "Schools", project_id: "p1" },
        open_issues: [],
        groups: [],
      },
    } as DynamicToolUIPart,
  ],
});
const mount = (messages: AssistantMessage[], initialMessages: AssistantMessage[]) =>
  renderHook(({ list }: { list: AssistantMessage[] }) => useOpenCreatedWorkflows(list, initialMessages), {
    initialProps: { list: messages },
    wrapper,
  });

beforeEach(() => {
  vi.clearAllMocks();
  resetHandedOverWorkflows();
});

describe("useOpenCreatedWorkflows", () => {
  it("hands a workflow the running answer creates to the dock once, also under StrictMode", () => {
    const view = mount([asked], [asked]);
    expect(actions.openCreatedWorkflow).not.toHaveBeenCalled();
    view.rerender({ list: [asked, answer("a1", "w-live")] });
    view.rerender({
      list: [
        asked,
        answer("a1", "w-live"),
        { id: "u2", role: "user", parts: [{ type: "text", text: "Thanks" }] },
      ],
    });
    expect(actions.openCreatedWorkflow).toHaveBeenCalledTimes(1);
    expect(actions.openCreatedWorkflow).toHaveBeenCalledWith("p1", "w-live");
  });

  it("never opens a workflow of the conversation as it was loaded", () => {
    const stored = [asked, answer("a0", "w-stored")];
    mount(stored, stored);
    expect(actions.openCreatedWorkflow).not.toHaveBeenCalled();
  });

  it("does not open a workflow again in a remounted chat, or for a repeated create", () => {
    const live = [asked, answer("a1", "w-once")];
    const first = mount([asked], [asked]);
    first.rerender({ list: live });
    first.unmount();
    // The dock expanded: a new chat replays the running answer from its start.
    mount(live, [asked]);
    // A repeated create answers with the first workflow again, under a new call id.
    mount([...live, answer("a2", "w-once", "call-again")], [asked]);
    expect(actions.openCreatedWorkflow).toHaveBeenCalledTimes(1);
  });
});
