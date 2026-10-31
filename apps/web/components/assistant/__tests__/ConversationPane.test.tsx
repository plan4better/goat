import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { refreshConversationLists } from "@/lib/assistant/conversations";
import { AssistantRequestError } from "@/lib/assistant/errors";
import {
  addPendingRun,
  getDockState,
  peekFirstMessage,
  registerSurface,
  resetAssistantStore,
  setDockState,
  setFirstMessage,
} from "@/lib/assistant/store";
import { PROJECT_SURFACE_WAIT_MS } from "@/lib/assistant/surface";
import { createAssistantTransport } from "@/lib/assistant/transport";
import type { ConversationDetail } from "@/lib/assistant/types";

import ConversationPane from "@/components/assistant/ConversationPane";
import { DockActionsContext } from "@/components/assistant/DockActions";
import { FINISH, START, dockActions, refusal, stream, text } from "@/components/assistant/__tests__/helpers";

const { sendMessages, reconnectToStream, fetchMock, pathnameMock } = vi.hoisted(() => ({
  sendMessages: vi.fn(),
  reconnectToStream: vi.fn(),
  fetchMock: vi.fn(),
  pathnameMock: vi.fn(() => "/home"),
}));

vi.mock("next/navigation", () => ({ usePathname: pathnameMock, useRouter: () => ({ push: vi.fn() }) }));

vi.mock("@/lib/assistant/transport", () => ({
  createAssistantTransport: vi.fn(() => ({
    sendMessages: (options: unknown) => sendMessages(options),
    reconnectToStream: (options: unknown) => reconnectToStream(options),
  })),
  cancelAssistantRun: vi.fn(),
  fetchConversation: fetchMock,
  createConversation: vi.fn(),
}));
vi.mock("@/lib/assistant/conversations", () => ({ refreshConversationLists: vi.fn() }));
vi.mock("@/lib/api/fetcher", () => ({ getAccessToken: vi.fn(), fetcher: vi.fn(), apiRequestAuth: vi.fn() }));
vi.mock("@/lib/api/projects", () => ({
  useProjects: () => ({ projects: { items: [] }, isLoading: false }),
  useProjectLayers: () => ({ layers: undefined }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

const actions = dockActions();

const detail = (patch: Partial<ConversationDetail> = {}): ConversationDetail => ({
  conversation: { id: "c1", project_id: null, origin_surface: "catalog", title: "Radwege" },
  messages: [],
  activeRunId: null,
  access: "ok",
  projectName: null,
  ...patch,
});

const paneFor = (conversationId: string, onLoaded?: (detail: ConversationDetail) => void) => (
  <DockActionsContext.Provider value={actions}>
    <ConversationPane conversationId={conversationId} onLoaded={onLoaded} />
  </DockActionsContext.Provider>
);
const pane = (onLoaded?: (detail: ConversationDetail) => void) => render(paneFor("c1", onLoaded));

/** The text of the newest user message the transport was asked to send. */
const sentText = (call: number) => {
  const [options] = sendMessages.mock.calls[call] as [
    { messages: { parts: { type: string; text?: string }[] }[] },
  ];
  return options.messages[options.messages.length - 1].parts.find((part) => part.type === "text")?.text;
};

async function send(value: string) {
  fireEvent.change(await screen.findByRole("textbox"), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "assistant_send" }));
}

beforeEach(() => {
  window.sessionStorage.clear();
  resetAssistantStore();
  vi.clearAllMocks();
  pathnameMock.mockReturnValue("/home");
});

describe("ConversationPane", () => {
  it("reconnects by remounting the chat, never by resuming the live one", async () => {
    // Review Focus 1: the replay starts at the beginning of the run, so only a
    // fresh chat may receive it.
    fetchMock.mockResolvedValueOnce(detail()).mockResolvedValueOnce(
      detail({
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Hallo?" }] }],
        activeRunId: "run-1",
      })
    );
    sendMessages.mockResolvedValue(
      stream(
        [...START, { type: "text-start", id: "t1" }, { type: "text-delta", id: "t1", delta: "Hallo " }],
        new TypeError("network error")
      )
    );
    reconnectToStream.mockResolvedValue(
      stream([
        ...START,
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Hallo " },
        { type: "text-delta", id: "t1", delta: "Welt" },
        { type: "text-end", id: "t1" },
        ...FINISH,
      ])
    );
    const onLoaded = vi.fn();
    pane(onLoaded);
    await send("Hallo?");
    fireEvent.click(await screen.findByRole("button", { name: "assistant_reconnect" }));
    await screen.findByText("Hallo Welt");
    expect(screen.getAllByText("Hallo Welt")).toHaveLength(1);
    expect(screen.getAllByText("Hallo?")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(createAssistantTransport).toHaveBeenCalledTimes(2);
    expect(reconnectToStream).toHaveBeenCalledTimes(1);
    expect(onLoaded).toHaveBeenLastCalledWith(expect.objectContaining({ activeRunId: "run-1" }));
  });

  it("forgets a pending run that ended before it loaded (a reload kept it), and keeps a running one", async () => {
    // The answer is on screen now: closing the dock later must not announce it.
    addPendingRun({ conversationId: "c1", title: "Radwege", since: Date.now(), knownAnswerId: null });
    fetchMock.mockResolvedValueOnce(detail());
    const { unmount } = pane();
    await screen.findByRole("textbox");
    expect(getDockState().pending).toEqual([]);
    // The history may still mark it as running.
    expect(refreshConversationLists).toHaveBeenCalledTimes(1);
    unmount();
    addPendingRun({ conversationId: "c1", title: "Radwege", since: Date.now(), knownAnswerId: null });
    fetchMock.mockResolvedValueOnce(detail({ activeRunId: "run-1" }));
    reconnectToStream.mockResolvedValue(stream([...START], "hang"));
    pane();
    await waitFor(() => expect(reconnectToStream).toHaveBeenCalled());
    expect(getDockState().pending).toHaveLength(1);
    expect(refreshConversationLists).toHaveBeenCalledTimes(1);
  });

  it("shows a load error with a retry and a way to a new conversation", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(detail());
    pane();
    await screen.findByText("assistant_error_offline");
    expect(screen.getByText("assistant_load_failed_title")).toBeTruthy();
    expect(screen.getByRole("button", { name: "assistant_new_conversation" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "assistant_retry" }));
    await screen.findByRole("textbox");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("starts a new conversation when the open one no longer exists for this user", async () => {
    setDockState({ conversationId: "c1" });
    fetchMock.mockRejectedValueOnce(new AssistantRequestError(404, "conversation_not_found"));
    pane();
    await waitFor(() => expect(getDockState().conversationId).toBeNull());
    expect(screen.queryByText("assistant_load_failed_title")).toBeNull();
  });

  it("opens a conversation of another project read only", async () => {
    registerSurface({
      surface: "project.map",
      project: { id: "p2", name: "Zwei" },
      getContext: () => ({ surface: "project.map", project_id: "p2" }),
    });
    fetchMock.mockResolvedValue(
      detail({
        conversation: { id: "c1", project_id: "p1", origin_surface: "project.map", title: "x" },
        projectName: "Eins",
      })
    );
    pane();
    await screen.findByText("assistant_readonly_elsewhere");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows loading on a project page until its project registered, never the other-project notice", async () => {
    pathnameMock.mockReturnValue("/map/p1");
    // Coming from project p0: its surface is still registered for a moment.
    const previous = registerSurface({
      surface: "project.map",
      project: { id: "p0", name: "Null" },
      getContext: () => ({ surface: "project.map", project_id: "p0" }),
    });
    fetchMock.mockResolvedValue(
      detail({
        conversation: { id: "c1", project_id: "p1", origin_surface: "project.map", title: "x" },
        projectName: "Eins",
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Frage" }] }],
      })
    );
    pane();
    // The conversation shows; only its footer waits.
    await screen.findByText("Frage");
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(screen.queryByText("assistant_readonly_elsewhere")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    act(() => previous());
    expect(screen.queryByText("assistant_readonly_elsewhere")).toBeNull();
    act(() => {
      registerSurface({
        surface: "project.map",
        project: { id: "p1", name: "Eins" },
        getContext: () => ({ surface: "project.map", project_id: "p1" }),
      });
    });
    await screen.findByRole("textbox");
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("offers the composer after a bounded wait when the project never registers", async () => {
    vi.useFakeTimers();
    pathnameMock.mockReturnValue("/map/p1");
    fetchMock.mockResolvedValue(
      detail({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Frage" }] }] })
    );
    pane();
    await act(() => vi.advanceTimersByTimeAsync(0));
    // Loaded; only the footer waits.
    expect(screen.getByText("Frage")).toBeTruthy();
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(PROJECT_SURFACE_WAIT_MS));
    vi.useRealTimers();
    expect(screen.getByRole("textbox", { name: "assistant_composer_placeholder" })).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("treats a conversation it just bound as bound, without a reload", async () => {
    const unregister = registerSurface({
      surface: "project.map",
      project: { id: "p1", name: "Eins" },
      getContext: () => ({ surface: "project.map", project_id: "p1" }),
    });
    fetchMock.mockResolvedValue(detail());
    sendMessages.mockResolvedValue(stream([...START, ...text("ok"), ...FINISH]));
    pane();
    await send("Welche Layer?");
    await screen.findByText("ok");
    // The user goes to Home: a page without a surface adapter.
    act(() => unregister());
    await screen.findByText("assistant_readonly_elsewhere");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a conversation a refusal names as bound to that project", async () => {
    registerSurface({ surface: "catalog", getContext: () => ({ surface: "catalog" }) });
    fetchMock.mockResolvedValue(detail());
    sendMessages.mockRejectedValue(
      refusal(409, { code: "conversation_bound", message: "x", project_id: "p9" })
    );
    pane();
    await send("Hallo");
    await screen.findByText("assistant_readonly_elsewhere_unnamed");
    // The refused text stays readable; the notice explains the refusal, no second note.
    expect(screen.getByText("assistant_draft_not_sent")).toBeTruthy();
    expect(screen.getByText("Hallo")).toBeTruthy();
    expect(screen.queryByText("assistant_error_conversation_bound")).toBeNull();
  });

  it("switches to the lost-access state when a send is refused for it", async () => {
    fetchMock.mockResolvedValue(detail());
    sendMessages.mockRejectedValue(refusal(403, { code: "project_access_lost", message: "lost" }));
    pane();
    await send("Hallo");
    await screen.findByText("assistant_lost_access");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("Hallo")).toBeTruthy();
    expect(screen.queryByText("assistant_error_project_access_lost")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hides the answers already on screen once a refusal says access was lost", async () => {
    // The same rule as the server's reload (spec §10): the user's own words only.
    fetchMock.mockResolvedValue(
      detail({
        conversation: { id: "c1", project_id: "p1", origin_surface: "project.map", title: "x" },
        messages: [
          {
            id: "u1",
            role: "user",
            parts: [
              { type: "text", text: "Erste Frage" },
              { type: "data-context", data: { surface: "catalog" } },
            ],
          },
          { id: "a1", role: "assistant", parts: [{ type: "text", text: "Antwort eins" }] },
        ],
      })
    );
    registerSurface({
      surface: "project.map",
      project: { id: "p1", name: "Eins" },
      getContext: () => ({ surface: "project.map", project_id: "p1" }),
    });
    sendMessages.mockRejectedValue(refusal(403, { code: "project_access_lost", message: "lost" }));
    pane();
    await screen.findByText("Antwort eins");
    expect(screen.getByText("catalog")).toBeTruthy();
    await send("Hallo");
    await screen.findByText("assistant_lost_access");
    expect(screen.queryByText("Antwort eins")).toBeNull();
    // The page context chip of the user's message goes as well.
    expect(screen.queryByText("catalog")).toBeNull();
    expect(screen.getByText("Erste Frage")).toBeTruthy();
    // The refused text stays readable.
    expect(screen.getByText("Hallo")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the words sent this session when a later refusal says access was lost", async () => {
    fetchMock.mockResolvedValue(detail());
    sendMessages
      .mockResolvedValueOnce(stream([...START, ...text("Antwort eins"), ...FINISH]))
      .mockRejectedValueOnce(refusal(403, { code: "project_access_lost", message: "lost" }));
    pane();
    await send("Erste Frage");
    await screen.findByText("Antwort eins");
    await waitFor(() => expect(screen.getByRole("button", { name: "assistant_send" })).toBeTruthy());
    await send("Zweite Frage");
    await screen.findByText("assistant_lost_access");
    // Sent earlier in this session, so not in what the pane loaded: still shown.
    expect(screen.getByText("Erste Frage")).toBeTruthy();
    expect(screen.queryByText("Antwort eins")).toBeNull();
    // The refused one stays readable once, as the text that was not sent.
    expect(screen.getAllByText("Zweite Frage")).toHaveLength(1);
    expect(screen.getByText("assistant_draft_not_sent")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends the first message after a load error and a retry, once", async () => {
    setFirstMessage({ conversationId: "c1", text: "Erste Frage", context: null });
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(detail());
    sendMessages.mockResolvedValue(stream([...START, ...text("ok"), ...FINISH]));
    pane();
    fireEvent.click(await screen.findByRole("button", { name: "assistant_retry" }));
    await screen.findByText("ok");
    expect(sendMessages).toHaveBeenCalledTimes(1);
    expect(sentText(0)).toBe("Erste Frage");
    expect(peekFirstMessage("c1")).toBeNull();
  });

  it("never sends a first message into another conversation when reused for it", async () => {
    setFirstMessage({ conversationId: "c1", text: "Erste Frage", context: null });
    // c1 is still loading (its first message not sent yet) when the pane switches to c2.
    fetchMock.mockImplementation((id: string) =>
      id === "c1"
        ? new Promise<ConversationDetail>(() => undefined)
        : Promise.resolve(
            detail({ conversation: { id, project_id: null, origin_surface: "catalog", title: id } })
          )
    );
    sendMessages.mockResolvedValue(stream([...START, ...text("ok"), ...FINISH]));
    const { rerender } = render(paneFor("c1"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("c1"));
    rerender(paneFor("c2"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("c2"));
    await screen.findByRole("textbox");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sendMessages).not.toHaveBeenCalled();
    expect(peekFirstMessage("c1")).not.toBeNull();
  });

  it("never sends a first message stored for another conversation", async () => {
    setFirstMessage({ conversationId: "c1", text: "Erste Frage", context: null });
    fetchMock.mockResolvedValue(
      detail({ conversation: { id: "c2", project_id: null, origin_surface: "catalog", title: "x" } })
    );
    render(paneFor("c2"));
    await screen.findByRole("textbox");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sendMessages).not.toHaveBeenCalled();
    expect(peekFirstMessage("c1")).not.toBeNull();
  });
});
