import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { DynamicToolUIPart } from "ai";
import { type ReactNode, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type MapBridge, registerMapBridge } from "@/lib/assistant/mapBridge";
import type { ViewTarget } from "@/lib/assistant/mapEdits";
import {
  createSurfaceOwner,
  markOwnerLive,
  registerSurface,
  releaseOwner,
  resetAssistantStore,
} from "@/lib/assistant/store";
import type { AssistantMessage, UndoFn } from "@/lib/assistant/types";

import { DockActionsContext } from "@/components/assistant/DockActions";
import { dockActions } from "@/components/assistant/__tests__/helpers";
import MessageList from "@/components/assistant/messages/MessageList";
import { resetFollowedMapEdits, useFollowMapEdits } from "@/components/assistant/useFollowMapEdits";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("@/lib/api/users", () => ({ useFeatures: () => ({ features: { billing: false } }) }));

const actions = dockActions();
const wrapper = ({ children }: { children: ReactNode }) => (
  <StrictMode>
    <DockActionsContext.Provider value={actions}>{children}</DockActionsContext.Provider>
  </StrictMode>
);

const PROJECT = "p1";
const asked: AssistantMessage = {
  id: "u1",
  role: "user",
  parts: [{ type: "text", text: "Hide the parks and show the old town" }],
};
const VIEW: ViewTarget = { camera: { center: [11.57, 48.14], zoom: 14 } };
/** An answer with one finished `map_update` step. */
const updated = (
  id: string,
  toolCallId: string,
  output: { hidden?: boolean; view?: ViewTarget; projectId?: string }
): AssistantMessage => ({
  id,
  role: "assistant",
  parts: [
    {
      type: "dynamic-tool",
      toolName: "map_update",
      toolCallId,
      state: "output-available",
      input: {},
      output: {
        project_id: output.projectId ?? PROJECT,
        applied: [
          ...(output.hidden
            ? [{ index: 0, op: "set_layer", layer_project_id: 7, fields: ["visible"], summary: "" }]
            : []),
          ...(output.view ? [{ index: 1, op: "set_view", summary: "" }] : []),
        ],
        view: output.view ?? null,
      },
    } as DynamicToolUIPart,
  ],
});
const hidden = {
  projectId: PROJECT,
  layers: false,
  state: true,
  groups: false,
  basemap: false,
  scene: false,
};

let unregister: Array<() => void> = [];
/** An open map page of the project: its bridge, whose applied views answer `undo` (null: no way back). */
function openMap(undo: UndoFn | null = vi.fn(), projectId = PROJECT) {
  const bridge: MapBridge = {
    projectId,
    isEditor: true,
    followStyles: vi.fn(async () => undefined),
    settle: vi.fn(async () => undefined),
    followMap: vi.fn(async () => undefined),
    applyView: vi.fn(() => undo ?? undefined),
  };
  unregister.push(registerMapBridge(bridge));
  return bridge;
}
/** The page's surface with a live owner, as `useAssistantSurface` registers it. */
function openSurface(projectId = PROJECT) {
  const owner = createSurfaceOwner();
  markOwnerLive(owner);
  const remove = registerSurface(
    {
      surface: "project.map",
      project: { id: projectId, name: "Radnetz" },
      getContext: () => ({ surface: "project.map", project_id: projectId }),
    },
    owner
  );
  const close = () => {
    remove();
    releaseOwner(owner);
  };
  unregister.push(close);
  return close;
}

const mount = (messages: AssistantMessage[], initialMessages: AssistantMessage[]) =>
  renderHook(({ list }: { list: AssistantMessage[] }) => useFollowMapEdits(list, initialMessages), {
    initialProps: { list: messages },
    wrapper,
  });

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  resetAssistantStore();
  resetFollowedMapEdits();
});
afterEach(() => {
  cleanup();
  unregister.splice(0).forEach((remove) => remove());
  unregister = [];
});

describe("useFollowMapEdits", () => {
  it("hands each map change to the page once, those of the stored conversation too", () => {
    const stored = [asked, updated("a0", "c0", { hidden: true })];
    mount(stored, stored).unmount();
    const again = mount(stored, stored);
    again.rerender({ list: [...stored, updated("a1", "c1", { hidden: true, view: VIEW })] });
    again.rerender({ list: [...stored, updated("a1", "c1", { hidden: true, view: VIEW })] });
    expect(vi.mocked(actions.followMapChange).mock.calls).toEqual([[hidden], [hidden]]);
  });

  it("hands the steps that come in together to the page as one change per project", () => {
    const basemap = (id: string, toolCallId: string, projectId = PROJECT): AssistantMessage => ({
      id,
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "map_update",
          toolCallId,
          state: "output-available",
          input: {},
          output: { project_id: projectId, applied: [{ index: 0, op: "set_basemap", summary: "" }] },
        } as DynamicToolUIPart,
      ],
    });
    const stored = [
      asked,
      updated("a0", "c0", { hidden: true }),
      basemap("a1", "c1"),
      basemap("a2", "c2", "p2"),
    ];
    mount(stored, stored);
    expect(vi.mocked(actions.followMapChange).mock.calls).toEqual([
      [{ ...hidden, basemap: true }],
      [{ ...hidden, projectId: "p2", state: false, basemap: true }],
    ]);
  });

  it("hands over nothing for a step that only moved the view", () => {
    openMap();
    const view = mount([asked], [asked]);
    view.rerender({ list: [asked, updated("a1", "c1", { view: VIEW })] });
    expect(actions.followMapChange).not.toHaveBeenCalled();
  });

  it("a view is applied once per tool call and never for stored messages", () => {
    const page = openMap();
    const view = mount([asked], [asked]);
    view.rerender({ list: [asked, updated("a1", "c1", { view: VIEW })] });
    view.rerender({ list: [asked, updated("a1", "c1", { view: VIEW }), asked] });
    expect(page.applyView).toHaveBeenCalledTimes(1);
    expect(page.applyView).toHaveBeenCalledWith(VIEW);
    view.unmount();
    // The chat mounts again and the running answer replays from its start, under another message id.
    const replay = mount([asked], [asked]);
    replay.rerender({ list: [asked, updated("a1-replayed", "c1", { view: VIEW })] });
    expect(page.applyView).toHaveBeenCalledTimes(1);
    replay.unmount();

    // A conversation loaded with a view in it: a fresh tab, nothing applied yet.
    resetFollowedMapEdits();
    const stored = [asked, updated("a1", "c1", { view: VIEW })];
    const reopened = mount(stored, stored);
    reopened.rerender({ list: [...stored, asked] });
    expect(page.applyView).toHaveBeenCalledTimes(1);
    // A view of the answer that follows is applied.
    reopened.rerender({ list: [...stored, asked, updated("a2", "c2", { view: { mode: "3d" } })] });
    expect(page.applyView).toHaveBeenCalledTimes(2);
    expect(page.applyView).toHaveBeenLastCalledWith({ mode: "3d" });
  });

  it("applies a view only on the map page of its project, and not later when that page opens", () => {
    const other = openMap(undefined, "p2");
    const view = mount([asked], [asked]);
    view.rerender({ list: [asked, updated("a1", "c1", { view: VIEW })] });
    expect(other.applyView).not.toHaveBeenCalled();
    // The user comes to the project's map with the chat still open: the view is no longer live.
    const page = openMap();
    view.rerender({ list: [asked, updated("a1", "c1", { view: VIEW }), asked] });
    expect(page.applyView).not.toHaveBeenCalled();
    view.unmount();
    // It was not applied, so a replay of the running answer on the map page applies it.
    const replay = mount([asked], [asked]);
    replay.rerender({ list: [asked, updated("a1", "c1", { view: VIEW })] });
    expect(page.applyView).toHaveBeenCalledTimes(1);
  });

  it("does not count a view as applied that the page could not show", () => {
    // The map page is open but its map is not drawn: it answers no way back.
    const page = openMap(null);
    const view = mount([asked], [asked]);
    view.rerender({ list: [asked, updated("a1", "c1", { view: VIEW })] });
    view.rerender({ list: [asked, updated("a1", "c1", { view: VIEW }), asked] });
    expect(page.applyView).toHaveBeenCalledTimes(1);
    view.unmount();
    const replay = mount([asked], [asked]);
    replay.rerender({ list: [asked, updated("a1", "c1", { view: VIEW })] });
    expect(page.applyView).toHaveBeenCalledTimes(2);
  });
});

function Chat({ messages }: { messages: AssistantMessage[] }) {
  useFollowMapEdits(messages, [asked]);
  return (
    <MessageList
      messages={messages}
      busy={false}
      conversationId="c1"
      conversationProjectId={PROJECT}
      projectName="Radnetz"
      readOnly={false}
    />
  );
}
const chat = (messages: AssistantMessage[]) => (
  <DockActionsContext.Provider value={actions}>
    <Chat messages={messages} />
  </DockActionsContext.Provider>
);
const back = () => screen.queryByRole("button", { name: "assistant_view_back" });

describe("the previous-view button", () => {
  it("the previous-view button calls the undo once and disappears", () => {
    const undo = vi.fn();
    openMap(undo);
    openSurface();
    const view = render(chat([asked]));
    expect(back()).toBeNull();
    view.rerender(chat([asked, updated("a1", "c1", { hidden: true, view: VIEW })]));
    expect(back()).toBeTruthy();
    fireEvent.click(back()!);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(back()).toBeNull();
  });

  it("shows under the newest applied view only", () => {
    const first = vi.fn();
    const second = vi.fn();
    const page = openMap(first);
    openSurface();
    const view = render(chat([asked]));
    const one = updated("a1", "c1", { view: VIEW });
    view.rerender(chat([asked, one]));
    vi.mocked(page.applyView).mockReturnValue(second);
    view.rerender(chat([asked, one, asked, updated("a2", "c2", { view: { mode: "3d" } })]));
    expect(screen.getAllByRole("button", { name: "assistant_view_back" })).toHaveLength(1);
    fireEvent.click(back()!);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("stays under a line that stands for several moves of the view, for the newest one", () => {
    const first = vi.fn();
    const second = vi.fn();
    const page = openMap();
    vi.mocked(page.applyView).mockReturnValueOnce(first).mockReturnValueOnce(second);
    openSurface();
    const view = render(chat([asked]));
    const moved = (toolCallId: string, target: ViewTarget) =>
      updated("a1", toolCallId, { view: target }).parts[0] as DynamicToolUIPart;
    const answer: AssistantMessage = {
      id: "a1",
      role: "assistant",
      parts: [moved("c1", VIEW), moved("c2", { mode: "3d" })],
    };
    view.rerender(chat([asked, answer]));
    // One line for both steps, with their count.
    expect(screen.getAllByRole("button", { name: /^assistant_tool_map_update/ })).toHaveLength(1);
    expect(screen.getByText(/assistant_step_times/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "assistant_view_back" })).toHaveLength(1);
    fireEvent.click(back()!);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("stays under a line that took in a refused attempt and a read between the moves", () => {
    const first = vi.fn();
    const second = vi.fn();
    const page = openMap();
    vi.mocked(page.applyView).mockReturnValueOnce(first).mockReturnValueOnce(second);
    openSurface();
    const view = render(chat([asked]));
    const moved = (toolCallId: string, target: ViewTarget) =>
      updated("a1", toolCallId, { view: target }).parts[0] as DynamicToolUIPart;
    const refused = {
      type: "dynamic-tool",
      toolName: "map_update",
      toolCallId: "c-refused",
      state: "output-error",
      input: {},
      errorText: "Too large",
    } as DynamicToolUIPart;
    const read = {
      type: "dynamic-tool",
      toolName: "project_get_layers",
      toolCallId: "c-read",
      state: "output-available",
      input: {},
      output: { layers: [] },
    } as DynamicToolUIPart;
    const answer: AssistantMessage = {
      id: "a1",
      role: "assistant",
      parts: [moved("c1", VIEW), refused, read, moved("c2", { mode: "3d" })],
    };
    view.rerender(chat([asked, answer]));
    expect(screen.getAllByRole("button", { name: /^assistant_tool_map_update/ })).toHaveLength(1);
    expect(screen.queryByText(/assistant_step_failed/)).toBeNull();
    expect(screen.getAllByRole("button", { name: "assistant_view_back" })).toHaveLength(1);
    fireEvent.click(back()!);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("a view the map refuses leaves no button, and the step's change is still handed over", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new Error("Invalid LngLat latitude value: must be between -90 and 90");
    const page = openMap();
    vi.mocked(page.applyView).mockImplementation(() => {
      throw failure;
    });
    openSurface();
    const view = render(chat([asked]));
    view.rerender(chat([asked, updated("a1", "c1", { hidden: true, view: VIEW })]));
    expect(page.applyView).toHaveBeenCalledTimes(1);
    expect(back()).toBeNull();
    expect(actions.followMapChange).toHaveBeenCalledWith(hidden);
    expect(logged.mock.calls[0]).toContain(failure);
    logged.mockRestore();
    // The transcript still stands, and the refused view is not tried again.
    const thanks: AssistantMessage = { id: "u2", role: "user", parts: [{ type: "text", text: "Thanks" }] };
    view.rerender(chat([asked, updated("a1", "c1", { hidden: true, view: VIEW }), thanks]));
    expect(page.applyView).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Thanks")).toBeTruthy();
  });

  it("shows no button for a view the page gave no way back from, nor for a stored one", () => {
    openMap(null);
    openSurface();
    const stored = updated("a0", "c0", { view: VIEW });
    const view = render(
      <DockActionsContext.Provider value={actions}>
        <MessageList
          messages={[asked, stored]}
          busy={false}
          conversationId="c1"
          conversationProjectId={PROJECT}
          projectName="Radnetz"
          readOnly={false}
        />
      </DockActionsContext.Provider>
    );
    expect(back()).toBeNull();
    view.unmount();
    const live = render(chat([asked]));
    live.rerender(chat([asked, updated("a1", "c1", { view: VIEW })]));
    expect(back()).toBeNull();
  });

  it("goes away with the map page that applied the view", () => {
    const undo = vi.fn();
    openMap(undo);
    const close = openSurface();
    const view = render(chat([asked]));
    view.rerender(chat([asked, updated("a1", "c1", { view: VIEW })]));
    expect(back()).toBeTruthy();
    act(() => close());
    expect(back()).toBeNull();
    expect(undo).not.toHaveBeenCalled();
  });
});
