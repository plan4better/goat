import { renderHook } from "@testing-library/react";
import type { DynamicToolUIPart } from "ai";
import { type ReactNode, StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetFollowedCalls } from "@/lib/assistant/mapBridge";
import type { AssistantMessage } from "@/lib/assistant/types";

import { DockActionsContext } from "@/components/assistant/DockActions";
import { dockActions } from "@/components/assistant/__tests__/helpers";
import { resetFollowedStyleEdits, useFollowStyleEdits } from "@/components/assistant/useFollowStyleEdits";

const actions = dockActions();
const wrapper = ({ children }: { children: ReactNode }) => (
  <StrictMode>
    <DockActionsContext.Provider value={actions}>{children}</DockActionsContext.Provider>
  </StrictMode>
);
const asked: AssistantMessage = {
  id: "u1",
  role: "user",
  parts: [{ type: "text", text: "Make the parks green" }],
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
      toolName: "style_update",
      toolCallId,
      state: "output-available",
      input: {},
      output: {
        project_id: "p1",
        layer_project_id: 7,
        style_id: "s1",
        name: "Default",
        created: false,
        active: true,
        made_active: false,
        revision_before: before,
        revision_after: after,
      },
    } as DynamicToolUIPart,
  ],
});
const change = (revision: number) => ({
  projectId: "p1",
  layerProjectId: 7,
  styleId: "s1",
  revision,
  listChanged: false,
});
const mount = (messages: AssistantMessage[], initialMessages: AssistantMessage[]) =>
  renderHook(({ list }: { list: AssistantMessage[] }) => useFollowStyleEdits(list, initialMessages), {
    initialProps: { list: messages },
    wrapper,
  });
const handed = () => vi.mocked(actions.followStyleChanges).mock.calls.filter(([changes]) => changes.length);

beforeEach(() => {
  vi.clearAllMocks();
  resetFollowedStyleEdits();
  resetFollowedCalls();
});
const reread = { projectId: "p1", layers: false, state: true, groups: false, basemap: false, scene: false };
const rereads = () => vi.mocked(actions.followMapChange).mock.calls;

describe("useFollowStyleEdits", () => {
  it("hands each edit of the running answer to the page once, also under StrictMode", () => {
    const view = mount([asked], [asked]);
    view.rerender({ list: [asked, edited("a1", 4, 5)] });
    view.rerender({ list: [asked, edited("a1", 4, 5)] });
    expect(handed()).toEqual([[[change(5)]]]);
  });

  it("does not follow the edits of the conversation as the chat mounted with it, also across a remount", () => {
    // No style is read for an old edit.
    const stored = [asked, edited("a0", 4, 5)];
    mount(stored, stored).unmount();
    const again = mount(stored, stored);
    again.rerender({ list: [...stored, edited("a1", 5, 6)] });
    expect(handed()).toEqual([[[change(6)]]]);
  });

  it("reads the page's map once when the newest answer's edits came in while no chat followed them", () => {
    // Ten edits of an answer that ran with the dock closed, or in another tab.
    const tenEdits: AssistantMessage = {
      ...edited("a1", 4, 5),
      parts: Array.from(
        { length: 10 },
        (_, index) => edited("a1", 4 + index, 5 + index, `c-${index}`).parts[0]
      ),
    };
    const stored = [asked, edited("a0", 3, 4, "old"), asked, tenEdits];
    const view = mount(stored, stored);
    view.rerender({ list: [...stored] });
    view.unmount();
    mount(stored, stored).rerender({ list: [...stored] });
    expect(handed()).toEqual([]);
    expect(rereads()).toEqual([[reread]]);
  });

  it("reads nothing when this tab followed the newest answer's edits as they came in", () => {
    const view = mount([asked], [asked]);
    view.rerender({ list: [asked, edited("a1", 4, 5)] });
    view.unmount();
    // Stored under another message id than it streamed under.
    const stored = [asked, edited("a1-stored", 4, 5)];
    mount(stored, stored);
    expect(handed()).toEqual([[[change(5)]]]);
    expect(rereads()).toEqual([]);
  });

  it("follows the edits of a running answer that replays after a remount", () => {
    // A resumed run replays under a message id of its own.
    const stored = [asked, edited("a1", 4, 5, "call-5")];
    const view = mount(stored, stored);
    view.rerender({ list: [asked, edited("a1-replay", 4, 5, "call-5")] });
    expect(handed()).toEqual([[[change(5)]]]);
  });
});
