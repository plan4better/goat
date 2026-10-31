import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DynamicToolUIPart, UIMessageChunk } from "ai";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { refreshConversationLists } from "@/lib/assistant/conversations";
import { AssistantRequestError } from "@/lib/assistant/errors";
import {
  getAskChoices,
  getDockState,
  getDraft,
  registerSurface,
  resetAssistantStore,
  saveDraft,
} from "@/lib/assistant/store";
import { fetchConversation } from "@/lib/assistant/transport";
import type { AssistantMessage, ConversationDetail } from "@/lib/assistant/types";

import ChatView, { type ChatViewProps, STOP_GRACE_MS } from "@/components/assistant/ChatView";
import { DockActionsContext } from "@/components/assistant/DockActions";
import {
  FINISH,
  START,
  dockActions,
  gatedStream,
  refusal,
  stream,
  text,
} from "@/components/assistant/__tests__/helpers";
import { resetHandedOverWorkflows } from "@/components/assistant/useOpenCreatedWorkflows";

const { sendMessages, reconnectToStream, cancelMock } = vi.hoisted(() => ({
  sendMessages: vi.fn(),
  reconnectToStream: vi.fn(async (_options?: unknown) => null),
  cancelMock: vi.fn(),
}));

vi.mock("@/lib/assistant/transport", () => ({
  createAssistantTransport: vi.fn(() => ({
    sendMessages: (options: unknown) => sendMessages(options),
    reconnectToStream: (options: unknown) => reconnectToStream(options),
  })),
  cancelAssistantRun: cancelMock,
  fetchConversation: vi.fn(),
  createConversation: vi.fn(),
}));
vi.mock("@/lib/assistant/conversations", () => ({ refreshConversationLists: vi.fn() }));
const { toastInfo } = vi.hoisted(() => ({ toastInfo: vi.fn() }));
vi.mock("react-toastify", () => ({
  toast: { info: toastInfo, warning: vi.fn(), success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/api/fetcher", () => ({ getAccessToken: vi.fn(), fetcher: vi.fn(), apiRequestAuth: vi.fn() }));
vi.mock("@/lib/api/projects", () => ({
  useProjects: () => ({ projects: { items: [] }, isLoading: false }),
  useProjectLayers: () => ({ layers: undefined }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

const actions = dockActions();

function renderChat(props: Partial<ChatViewProps> = {}, { strict = false } = {}) {
  const onReconnect = vi.fn();
  const onBound = vi.fn();
  const onAccessLost = vi.fn();
  const tree = (next: Partial<ChatViewProps>) => {
    const view = (
      <DockActionsContext.Provider value={actions}>
        <ChatView
          conversationId="c1"
          title=""
          projectId={null}
          projectName={null}
          initialMessages={[]}
          activeRunId={null}
          resume={false}
          readOnly={null}
          firstMessage={null}
          onReconnect={onReconnect}
          onBound={onBound}
          onAccessLost={onAccessLost}
          {...next}
        />
      </DockActionsContext.Provider>
    );
    return strict ? <StrictMode>{view}</StrictMode> : view;
  };
  const { unmount, rerender } = render(tree(props));
  /** The same chat with other props (the page's project became known, access came back). */
  const update = (next: Partial<ChatViewProps>) => rerender(tree({ ...props, ...next }));
  return { onReconnect, onBound, onAccessLost, unmount, update };
}

function type(value: string) {
  fireEvent.change(screen.getByRole("textbox"), { target: { value } });
}

function send(value: string) {
  type(value);
  fireEvent.click(screen.getByRole("button", { name: "assistant_send" }));
}

const queuedItem = () => screen.getByRole("group", { name: "assistant_queued" });

beforeEach(() => {
  window.sessionStorage.clear();
  resetAssistantStore();
  resetHandedOverWorkflows();
  vi.clearAllMocks();
  registerSurface({
    surface: "catalog",
    getContext: () => ({ surface: "catalog", q: "rad", facets: { themes: ["transportation"] } }),
  });
});

describe("ChatView", () => {
  it("sends with the page context and queues, not sends, what is sent while the answer streams", async () => {
    sendMessages.mockResolvedValue(stream([...START, ...text("Teil")], "hang"));
    renderChat();
    send("Hallo");
    await screen.findByText("Teil");
    const [options] = sendMessages.mock.calls[0] as [
      { body: unknown; messages: { parts: { type: string }[] }[] },
    ];
    expect(options.body).toEqual({
      context: { surface: "catalog", q: "rad", facets: { themes: ["transportation"] } },
    });
    expect(options.messages[0].parts.map((part) => part.type)).toEqual(["text", "data-context"]);
    // Stop stands alone while nothing is typed; Send joins it once there is something to queue.
    expect(screen.getByRole("button", { name: "stop" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "assistant_send" })).toBeNull();
    type("noch eine");
    expect(screen.getByRole("button", { name: "assistant_send" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(sendMessages).toHaveBeenCalledTimes(1);
    expect(within(queuedItem()).getByText("noch eine")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("records the newest answer known at send time with the pending run", async () => {
    sendMessages.mockResolvedValue(stream([...START], "hang"));
    renderChat({
      initialMessages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: "Erste" }] },
        { id: "a7", role: "assistant", parts: [{ type: "text", text: "Antwort" }] },
        { id: "u2", role: "user", parts: [{ type: "text", text: "Zweite" }] },
      ],
    });
    send("Dritte");
    await waitFor(() => expect(getDockState().pending).toHaveLength(1));
    expect(getDockState().pending[0]).toMatchObject({ conversationId: "c1", knownAnswerId: "a7" });
  });

  it("records no known answer for a conversation without one", async () => {
    sendMessages.mockResolvedValue(stream([...START], "hang"));
    renderChat();
    send("Erste");
    await waitFor(() => expect(getDockState().pending).toHaveLength(1));
    expect(getDockState().pending[0].knownAnswerId).toBeNull();
  });

  it("lets a stopped answer end with the server's own note", async () => {
    let release: (chunks: UIMessageChunk[]) => void = () => undefined;
    sendMessages.mockResolvedValue(
      gatedStream(
        [...START, ...text("Teil")],
        new Promise<UIMessageChunk[]>((resolve) => (release = resolve))
      )
    );
    cancelMock.mockImplementation(async () => {
      // The server cancels the run; its stream ends with the run-status part.
      release([
        { type: "finish-step" },
        { type: "data-run-status", data: { status: "cancelled", error: null, code: null } },
        { type: "abort" },
      ]);
    });
    renderChat();
    send("Hallo");
    await screen.findByText("Teil");
    fireEvent.click(screen.getByRole("button", { name: "stop" }));
    await screen.findByText("assistant_run_cancelled");
    expect(cancelMock).toHaveBeenCalledWith("c1");
    await waitFor(() => expect(screen.queryByRole("button", { name: "stop" })).toBeNull());
  });

  it("cancels again once the stream starts when Stop came before the server began the run", async () => {
    let respond: (value: ReadableStream<UIMessageChunk>) => void = () => undefined;
    let release: (chunks: UIMessageChunk[]) => void = () => undefined;
    sendMessages.mockReturnValue(new Promise((resolve) => (respond = resolve)));
    // The first cancel arrives before begin_run: 204, nothing stopped.
    cancelMock.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
      release([
        { type: "finish-step" },
        { type: "data-run-status", data: { status: "cancelled", error: null, code: null } },
        { type: "abort" },
      ]);
    });
    renderChat();
    send("Hallo");
    fireEvent.click(await screen.findByRole("button", { name: "stop" }));
    await waitFor(() => expect(cancelMock).toHaveBeenCalledTimes(1));
    respond(
      gatedStream(
        [...START, ...text("Teil")],
        new Promise<UIMessageChunk[]>((resolve) => (release = resolve))
      )
    );
    await screen.findByText("assistant_run_cancelled");
    expect(cancelMock).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole("button", { name: "stop" })).toBeNull());
  });

  it("cancels once more and drops the connection when the stream does not end in time", async () => {
    sendMessages.mockResolvedValue(stream([...START, ...text("Teil")], "hang"));
    cancelMock.mockResolvedValue(undefined);
    renderChat();
    send("Hallo");
    await screen.findByText("Teil");
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "stop" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STOP_GRACE_MS + 200);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(cancelMock).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole("button", { name: "stop" })).toBeNull());
  });

  it("sends no late cancel after the chat unmounted during a Stop", async () => {
    sendMessages.mockResolvedValue(stream([...START, ...text("Teil")], "hang"));
    cancelMock.mockResolvedValue(undefined);
    const { unmount } = renderChat();
    send("Hallo");
    await screen.findByText("Teil");
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "stop" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STOP_GRACE_MS / 2);
      });
      expect(cancelMock).toHaveBeenCalledTimes(1);
      unmount();
      await vi.advanceTimersByTimeAsync(STOP_GRACE_MS * 2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  it("drops the connection at once when the server cannot be told to stop", async () => {
    sendMessages.mockResolvedValue(stream([...START, ...text("Teil")], "hang"));
    cancelMock.mockRejectedValue(new AssistantRequestError(404, "conversation_not_found"));
    renderChat();
    send("Hallo");
    await screen.findByText("Teil");
    fireEvent.click(screen.getByRole("button", { name: "stop" }));
    await screen.findByText("assistant_error_conversation_not_found");
    await waitFor(() => expect(screen.queryByRole("button", { name: "stop" })).toBeNull());
  });

  it("puts a refused message back into the composer with the reason", async () => {
    sendMessages.mockRejectedValue(refusal(409, { code: "conversation_busy", message: "busy" }));
    renderChat();
    send("Hallo");
    await screen.findByText("assistant_error_conversation_busy");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Hallo");
    expect(screen.queryByText("Hallo", { ignore: "textarea" })).toBeNull();
  });

  it("never drops stored messages when a reconnect is refused", async () => {
    reconnectToStream.mockRejectedValueOnce(refusal(403, { code: "project_access_lost", message: "lost" }));
    const { onAccessLost } = renderChat({
      resume: true,
      activeRunId: "run-1",
      initialMessages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Gespeichert" }] }],
    });
    await screen.findByText("assistant_error_project_access_lost");
    expect(screen.getByText("Gespeichert")).toBeTruthy();
    expect(onAccessLost).toHaveBeenCalled();
  });

  it("shows a failed answer with its own note, not a second error", async () => {
    sendMessages.mockResolvedValue(
      stream([
        ...START,
        { type: "finish-step" },
        { type: "data-run-status", data: { status: "failed", error: "x", code: "goat_ai_busy" } },
        { type: "error", errorText: "x" },
      ])
    );
    renderChat();
    send("Hallo");
    await screen.findByText("assistant_run_error_goat_ai_busy");
    expect(screen.queryByText("assistant_error_generic")).toBeNull();
  });

  it("shows a failed answer without a known code with the generic note, never the server's English", async () => {
    sendMessages.mockResolvedValue(
      stream([
        ...START,
        { type: "finish-step" },
        {
          type: "data-run-status",
          data: { status: "failed", error: "Model refused the request", code: null },
        },
        { type: "error", errorText: "Model refused the request" },
      ])
    );
    renderChat();
    send("Hallo");
    await screen.findByText("assistant_run_error_unknown");
    expect(screen.queryByText(/Model refused/)).toBeNull();
    expect(screen.queryByText("assistant_error_generic")).toBeNull();
  });

  it("translates a stream error instead of showing its English text", async () => {
    sendMessages.mockResolvedValue(
      stream([...START, { type: "error", errorText: "Upstream provider overloaded" }])
    );
    renderChat();
    send("Hallo");
    await screen.findByText("assistant_error_generic");
    expect(screen.queryByText(/Upstream provider/)).toBeNull();
  });

  it("never shows the English message of a refusal", async () => {
    sendMessages.mockRejectedValue(
      refusal(429, { code: "user_run_limit", message: "Too many runs at once" })
    );
    renderChat();
    send("Hallo");
    await screen.findByText("assistant_error_user_run_limit");
    expect(screen.queryByText(/Too many runs/)).toBeNull();
  });

  it("offers a reconnect after the connection dropped, also when the browser calls it differently", async () => {
    sendMessages.mockResolvedValueOnce(stream([...START, ...text("Hallo")], new TypeError("network error")));
    const { onReconnect } = renderChat();
    send("Hallo?");
    fireEvent.click(await screen.findByRole("button", { name: "assistant_reconnect" }));
    expect(onReconnect).toHaveBeenCalled();
    expect(screen.queryByText("assistant_error_offline")).toBeNull();
    // Safari reports a dropped fetch as "Load failed".
    sendMessages.mockResolvedValueOnce(stream([...START, ...text("Zwei")], new TypeError("Load failed")));
    send("Noch einmal?");
    await screen.findByText("Zwei");
    expect(await screen.findByText("assistant_disconnected")).toBeTruthy();
  });

  it("leaves out the context the user removed", async () => {
    sendMessages.mockResolvedValue(stream([...START, ...text("ok"), ...FINISH]));
    renderChat();
    const chip = screen.getByText("assistant_chip_filters").closest(".MuiChip-root") as HTMLElement;
    fireEvent.click(chip.querySelector('[data-testid="CancelIcon"]') as Element);
    send("Hallo");
    await screen.findByText("ok");
    const [options] = sendMessages.mock.calls[0] as [{ body: unknown }];
    expect(options.body).toEqual({ context: { surface: "catalog", q: "rad" } });
    // Accepted: the next message carries the whole page context again.
    expect(screen.getAllByText("assistant_chip_filters").length).toBeGreaterThan(0);
  });

  it("keeps the chips as they were when a send is refused", async () => {
    sendMessages.mockRejectedValue(refusal(409, { code: "conversation_busy", message: "busy" }));
    renderChat();
    const chip = screen.getByText("assistant_chip_filters").closest(".MuiChip-root") as HTMLElement;
    fireEvent.click(chip.querySelector('[data-testid="CancelIcon"]') as Element);
    send("Hallo");
    await screen.findByText("assistant_error_conversation_busy");
    expect(screen.queryByText("assistant_chip_filters")).toBeNull();
    expect(screen.getByText("assistant_chip_search")).toBeTruthy();
  });

  it("reports the binding of an unbound conversation sent from a project page", async () => {
    act(() => {
      registerSurface({
        surface: "project.map",
        project: { id: "p1", name: "Eins" },
        getContext: () => ({ surface: "project.map", project_id: "p1" }),
      });
    });
    sendMessages.mockResolvedValue(stream([...START, ...text("ok"), ...FINISH]));
    const { onBound } = renderChat();
    send("Welche Layer?");
    await screen.findByText("ok");
    expect(onBound).toHaveBeenCalledWith("p1", "Eins");
  });

  it("learns the project from a refusal that names it", async () => {
    sendMessages.mockRejectedValue(
      refusal(409, { code: "conversation_bound", message: "x", project_id: "p9" })
    );
    const { onBound } = renderChat();
    send("Hallo");
    await screen.findByText("assistant_error_conversation_bound");
    expect(onBound).toHaveBeenCalledWith("p9", null);
  });

  it("shows a conversation bound to another project read only", () => {
    renderChat({ readOnly: { kind: "elsewhere", projectId: "p1", projectName: "Radnetz" } });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("assistant_readonly_elsewhere")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "assistant_open_in_project" }));
    expect(actions.openInProject).toHaveBeenCalledWith("p1");
    fireEvent.click(screen.getByRole("button", { name: "assistant_new_here" }));
    expect(actions.newConversationHere).toHaveBeenCalled();
  });

  it("shows a conversation the user lost access to without a way to continue it", () => {
    renderChat({ readOnly: { kind: "lost" } });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("assistant_lost_access")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "assistant_open_in_project" })).toBeNull();
  });

  it("keeps a reopened conversation at its end while cards load later and make it taller", () => {
    /** Each observer's callback and what it watches. */
    const observers: { callback: () => void; targets: Element[] }[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        entry: { callback: () => void; targets: Element[] };
        constructor(callback: () => void) {
          this.entry = { callback, targets: [] };
          observers.push(this.entry);
        }
        observe(target: Element) {
          this.entry.targets.push(target);
        }
        disconnect() {}
      }
    );
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const client = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    let height = 500;
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 200 });
    try {
      const stored: AssistantMessage[] = [
        { id: "u1", role: "user", parts: [{ type: "text", text: "Wie viele Radwege?" }] },
        { id: "a1", role: "assistant", parts: [{ type: "text", text: "Drei." }] },
      ];
      renderChat({ initialMessages: stored });
      const answer = screen.getByText("Drei.");
      let transcript = answer.parentElement as HTMLElement;
      while (transcript.scrollTop !== 500) transcript = transcript.parentElement as HTMLElement;
      // Its content is watched, not only the footer.
      const content = observers.find((observer) =>
        observer.targets.some((target) => target !== transcript && target.contains(answer))
      );
      expect(content).toBeTruthy();
      const grow = (to: number) => {
        height = to;
        act(() => content?.callback());
      };
      // A card's details arrive: the end stays in view.
      grow(640);
      expect(transcript.scrollTop).toBe(640);
      // Scrolled up to read: it stays where the person is.
      transcript.scrollTop = 40;
      fireEvent.scroll(transcript);
      grow(700);
      expect(transcript.scrollTop).toBe(40);
      // Back at the end, the person opens a step group: what they opened stays where it is.
      transcript.scrollTop = 700;
      fireEvent.scroll(transcript);
      fireEvent.pointerDown(answer);
      grow(900);
      expect(transcript.scrollTop).toBe(700);
      // The next scroll (by the person or a new message) decides again.
      transcript.scrollTop = 900;
      fireEvent.scroll(transcript);
      grow(960);
      expect(transcript.scrollTop).toBe(960);
    } finally {
      vi.unstubAllGlobals();
      for (const [name, descriptor] of [
        ["scrollHeight", original],
        ["clientHeight", client],
      ] as const) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
      }
    }
  });

  it("sends the first message of a new conversation once, also under StrictMode", async () => {
    sendMessages.mockResolvedValue(stream([...START, ...text("ok"), ...FINISH]));
    renderChat({ firstMessage: { text: "Erste Frage", context: null } }, { strict: true });
    await screen.findByText("ok");
    expect(sendMessages).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Erste Frage")).toBeTruthy();
  });
});

describe("ChatView drafts (ruling 22)", () => {
  const removeFilters = () => {
    const chip = screen.getByText("assistant_chip_filters").closest(".MuiChip-root") as HTMLElement;
    fireEvent.click(chip.querySelector('[data-testid="CancelIcon"]') as Element);
  };

  it("keeps the typed text and the removed chips across a remount (expand or collapse)", () => {
    const { unmount } = renderChat();
    removeFilters();
    type("Noch nicht gesendet");
    unmount();
    renderChat();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Noch nicht gesendet");
    expect(screen.queryByText("assistant_chip_filters")).toBeNull();
    expect(screen.getByText("assistant_chip_search")).toBeTruthy();
  });

  it("clears the draft when the send is accepted, and refreshes the history", async () => {
    sendMessages.mockResolvedValue(stream([...START, ...text("ok"), ...FINISH]));
    const { unmount } = renderChat();
    removeFilters();
    send("Hallo");
    await screen.findByText("ok");
    expect(getDraft("c1")).toBeNull();
    expect(refreshConversationLists).toHaveBeenCalled();
    unmount();
    renderChat();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByText("assistant_chip_filters")).toBeTruthy();
  });

  it("keeps the draft when the send is refused", async () => {
    sendMessages.mockRejectedValue(refusal(409, { code: "conversation_busy", message: "busy" }));
    const { unmount } = renderChat();
    send("Hallo");
    await screen.findByText("assistant_error_conversation_busy");
    expect(getDraft("c1")?.text).toBe("Hallo");
    unmount();
    renderChat();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Hallo");
  });
});

describe("ChatView queue", () => {
  // A reply a test did not use must not answer the next test's send.
  beforeEach(() => {
    sendMessages.mockReset();
    cancelMock.mockReset();
  });

  const START2: UIMessageChunk[] = [{ type: "start", messageId: "a2" }, { type: "start-step" }];
  const FAILED: UIMessageChunk[] = [
    { type: "finish-step" },
    { type: "data-run-status", data: { status: "failed", error: "x", code: "goat_ai_busy" } },
    { type: "error", errorText: "x" },
  ];
  const CANCELLED: UIMessageChunk[] = [
    { type: "finish-step" },
    { type: "data-run-status", data: { status: "cancelled", error: null, code: null } },
    { type: "abort" },
  ];
  const CONTEXT = { surface: "catalog", q: "rad", facets: { themes: ["transportation"] } };

  /** An answer that streams "Teil" and ends with the chunks passed to `end`. */
  function runningAnswer() {
    let release: (chunks: UIMessageChunk[]) => void = () => undefined;
    const body = gatedStream(
      [...START, ...text("Teil")],
      new Promise<UIMessageChunk[]>((resolve) => (release = resolve))
    );
    // A copy: the stream takes its chunks off the array it gets.
    return {
      body,
      /** For a mock the chat calls itself (it is inside React's updates already). */
      release: (chunks: UIMessageChunk[]) => release([...chunks]),
      end: (chunks: UIMessageChunk[]) => act(async () => release([...chunks])),
    };
  }

  /** The text of the user message the `index`th request carried. */
  const sentText = (index: number) => {
    const [options] = sendMessages.mock.calls[index] as [
      { messages: { role: string; parts: { type: string; text?: string }[] }[] },
    ];
    const user = options.messages.filter((message) => message.role === "user").at(-1);
    return user?.parts.find((part) => part.type === "text")?.text;
  };
  const composerText = () => (screen.getByRole("textbox") as HTMLTextAreaElement).value;
  const noQueue = () => expect(screen.queryByRole("group", { name: "assistant_queued" })).toBeNull();

  it("sends the queued message by itself once the answer ended normally, with the page context", async () => {
    const run = runningAnswer();
    sendMessages
      .mockResolvedValueOnce(run.body)
      .mockResolvedValueOnce(stream([...START2, ...text("Zwei"), ...FINISH]));
    renderChat();
    send("Eins");
    await screen.findByText("Teil");
    send("Zweite Frage");
    expect(within(queuedItem()).getByText("Zweite Frage")).toBeTruthy();
    expect(sendMessages).toHaveBeenCalledTimes(1);
    await run.end(FINISH);
    await screen.findByText("Zwei");
    expect(sendMessages).toHaveBeenCalledTimes(2);
    expect(sentText(1)).toBe("Zweite Frage");
    expect((sendMessages.mock.calls[1] as [{ body: unknown }])[0].body).toEqual({ context: CONTEXT });
    noQueue();
    expect(getDraft("c1")?.queued ?? null).toBeNull();
  });

  it("keeps the queued message when the answer failed", async () => {
    const run = runningAnswer();
    sendMessages.mockResolvedValueOnce(run.body);
    renderChat();
    send("Eins");
    await screen.findByText("Teil");
    send("Zweite Frage");
    await run.end(FAILED);
    await screen.findByText("assistant_run_error_goat_ai_busy");
    await waitFor(() => expect(screen.queryByRole("button", { name: "stop" })).toBeNull());
    expect(within(queuedItem()).getByText("Zweite Frage")).toBeTruthy();
    expect(within(queuedItem()).getByRole("button", { name: "assistant_send_now" })).toBeTruthy();
    expect(sendMessages).toHaveBeenCalledTimes(1);
  });

  it("keeps the queued message when the answer was stopped", async () => {
    const run = runningAnswer();
    sendMessages.mockResolvedValueOnce(run.body);
    cancelMock.mockImplementation(async () => run.release(CANCELLED));
    renderChat();
    send("Eins");
    await screen.findByText("Teil");
    send("Zweite Frage");
    fireEvent.click(screen.getByRole("button", { name: "stop" }));
    await screen.findByText("assistant_run_cancelled");
    await waitFor(() => expect(screen.queryByRole("button", { name: "stop" })).toBeNull());
    // Long enough for the Stop to have settled.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(within(queuedItem()).getByText("Zweite Frage")).toBeTruthy();
    expect(sendMessages).toHaveBeenCalledTimes(1);
  });

  it("Send now stops the answer the way Stop does, then sends the queued message", async () => {
    // Time runs, and can be skipped past the Stop's grace period at the end.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const run = runningAnswer();
      sendMessages
        .mockResolvedValueOnce(run.body)
        .mockResolvedValueOnce(stream([...START2, ...text("Zwei")], "hang"));
      cancelMock.mockImplementation(async () => run.release(CANCELLED));
      renderChat();
      send("Eins");
      await screen.findByText("Teil");
      send("Zweite Frage");
      fireEvent.click(within(queuedItem()).getByRole("button", { name: "assistant_send_now" }));
      await screen.findByText("Zwei");
      expect(screen.getByText("assistant_run_cancelled")).toBeTruthy();
      expect(sentText(1)).toBe("Zweite Frage");
      noQueue();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STOP_GRACE_MS + 200);
      });
      // The Stop had ended before the send: no late cancel stops the new run, nor forgets it.
      expect(cancelMock).toHaveBeenCalledTimes(1);
      expect(getDockState().pending).toHaveLength(1);
      expect(screen.getByRole("button", { name: "stop" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Remove puts the queued text back into the composer, ahead of what was typed since", async () => {
    const run = runningAnswer();
    sendMessages.mockResolvedValueOnce(run.body);
    renderChat();
    send("Eins");
    await screen.findByText("Teil");
    send("Zweite Frage");
    type("Dritte");
    fireEvent.click(within(queuedItem()).getByRole("button", { name: "remove" }));
    noQueue();
    expect(composerText()).toBe("Zweite Frage\nDritte");
    await run.end(FINISH);
    await waitFor(() => expect(screen.queryByRole("button", { name: "stop" })).toBeNull());
    expect(sendMessages).toHaveBeenCalledTimes(1);
    expect(composerText()).toBe("Zweite Frage\nDritte");
  });

  it("adds a further message to the queued one on a new line", async () => {
    const run = runningAnswer();
    sendMessages
      .mockResolvedValueOnce(run.body)
      .mockResolvedValueOnce(stream([...START2, ...text("Zwei"), ...FINISH]));
    renderChat();
    send("Eins");
    await screen.findByText("Teil");
    send("Zweite");
    send("Dritte");
    expect(screen.getAllByRole("group", { name: "assistant_queued" })).toHaveLength(1);
    expect(getDraft("c1")?.queued?.text).toBe("Zweite\nDritte");
    await run.end(FINISH);
    await screen.findByText("Zwei");
    expect(sendMessages).toHaveBeenCalledTimes(2);
    expect(sentText(1)).toBe("Zweite\nDritte");
  });

  it("joins and sends at once what is sent while a message is queued and nothing runs", async () => {
    saveDraft("c1", { queued: { text: "Zweite", reason: "assistant_error_conversation_busy" } });
    sendMessages.mockResolvedValueOnce(stream([...START2, ...text("Zwei"), ...FINISH]));
    renderChat();
    expect(within(queuedItem()).getByText("assistant_error_conversation_busy")).toBeTruthy();
    send("Dritte");
    await screen.findByText("Zwei");
    expect(sendMessages).toHaveBeenCalledTimes(1);
    expect(sentText(0)).toBe("Zweite\nDritte");
    noQueue();
  });

  it("keeps the queued message across a remount, and sends it only on request then", async () => {
    sendMessages
      .mockResolvedValueOnce(stream([...START, ...text("Teil")], "hang"))
      .mockResolvedValueOnce(stream([...START2, ...text("Zwei"), ...FINISH]));
    const { unmount } = renderChat();
    send("Eins");
    await screen.findByText("Teil");
    send("Zweite Frage");
    unmount();
    expect(getDraft("c1")?.queued).toEqual({ text: "Zweite Frage", reason: null });
    renderChat();
    expect(within(queuedItem()).getByText("Zweite Frage")).toBeTruthy();
    // How the answer ended is not known here: nothing goes by itself.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(sendMessages).toHaveBeenCalledTimes(1);
    fireEvent.click(within(queuedItem()).getByRole("button", { name: "assistant_send_now" }));
    await screen.findByText("Zwei");
    expect(sentText(1)).toBe("Zweite Frage");
  });

  it("puts a refused queued message back into the queue with the translated reason", async () => {
    const run = runningAnswer();
    sendMessages
      .mockResolvedValueOnce(run.body)
      .mockRejectedValueOnce(refusal(409, { code: "conversation_busy", message: "Conversation is busy" }));
    renderChat();
    send("Eins");
    await screen.findByText("Teil");
    send("Zweite");
    type("Tippe weiter");
    await run.end(FINISH);
    await screen.findByText("assistant_error_conversation_busy");
    expect(sendMessages).toHaveBeenCalledTimes(2);
    expect(within(queuedItem()).getByText("Zweite")).toBeTruthy();
    expect(within(queuedItem()).getByText("assistant_error_conversation_busy")).toBeTruthy();
    // Said once, in the item, and never in the server's English.
    expect(screen.getAllByText("assistant_error_conversation_busy")).toHaveLength(1);
    expect(screen.queryByText(/Conversation is busy/)).toBeNull();
    // Not part of the conversation, and what the user typed meanwhile stays.
    expect(screen.getAllByText("Zweite")).toHaveLength(1);
    expect(composerText()).toBe("Tippe weiter");
    expect(getDraft("c1")?.queued).toEqual({ text: "Zweite", reason: "assistant_error_conversation_busy" });
  });

  it("sends the queued message once under StrictMode", async () => {
    const run = runningAnswer();
    sendMessages
      .mockResolvedValueOnce(run.body)
      .mockResolvedValueOnce(stream([...START2, ...text("Zwei"), ...FINISH]));
    renderChat({}, { strict: true });
    send("Eins");
    await screen.findByText("Teil");
    send("Zweite Frage");
    await run.end(FINISH);
    await screen.findByText("Zwei");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(sendMessages).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText("Zweite Frage")).toHaveLength(1);
  });

  it("shows a queued message of a read-only conversation as not sent", () => {
    saveDraft("c1", { queued: { text: "Wartet noch", reason: null } });
    renderChat({ readOnly: { kind: "lost" } });
    expect(screen.getByText("assistant_draft_not_sent")).toBeTruthy();
    expect(screen.getByText("Wartet noch")).toBeTruthy();
    noQueue();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(sendMessages).not.toHaveBeenCalled();
  });
});

describe("ChatView ask cards", () => {
  // A reply or a stored conversation a test did not use must not reach the next test.
  beforeEach(() => {
    sendMessages.mockReset();
    vi.mocked(fetchConversation).mockReset();
  });

  const card = {
    card_id: "ask-call-4",
    questions: [
      {
        question: "Which layer holds the schools?",
        header: "Schools",
        multi_select: false,
        options: [
          { label: "Schools (catalog)", description: "Adds it to the project", recommended: true },
          { label: "Leave it open", description: "", recommended: false },
        ],
      },
    ],
  };
  const asked: AssistantMessage[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "Build a 15 minute workflow" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        // The ask step returned the card's id: the server knows the card.
        {
          type: "dynamic-tool",
          toolName: "ask_user",
          toolCallId: "t-ask",
          state: "output-available",
          input: { questions: [] },
          output: { card_id: "ask-call-4", status: "asked" },
        },
        { type: "data-ask", id: "ask-call-4", data: card },
      ],
    },
  ];
  const answer = { card_id: "ask-call-4", answers: [{ question: 0, options: [0], other: null }] };
  const stored = (messages: AssistantMessage[]): ConversationDetail => ({
    conversation: { id: "c1", project_id: null, origin_surface: "catalog", title: null },
    messages,
    activeRunId: null,
    access: "ok",
    projectName: null,
  });
  /** The start of the next answer, under an id the transcript does not hold yet. */
  const REPLY: UIMessageChunk[] = [{ type: "start", messageId: "a2" }, { type: "start-step" }];
  const composerBox = () =>
    screen.getByRole("textbox", { name: "assistant_composer_placeholder" }) as HTMLTextAreaElement;
  const cardSend = () => screen.getByRole("button", { name: "assistant_ask_send" }) as HTMLButtonElement;
  /** The panel at the dock's foot: only it offers "Reply in text instead". */
  const panelShown = () => !!screen.queryByRole("button", { name: "assistant_ask_reply_in_text" });
  const pickAndSend = () => {
    fireEvent.click(screen.getByRole("radio", { name: /Schools \(catalog\)/ }));
    fireEvent.click(cardSend());
  };

  it("sends the answer as the next message, with the answer in its metadata, and keeps the composer's draft", async () => {
    vi.mocked(fetchConversation).mockResolvedValue(stored(asked));
    sendMessages.mockResolvedValue(stream([...START, ...text("Thanks"), ...FINISH]));
    // Typed before the card came: the panel takes the composer's place, the draft waits.
    saveDraft("c1", { text: "Something else" });
    renderChat({ initialMessages: asked });
    pickAndSend();
    await waitFor(() => expect(sendMessages).toHaveBeenCalledTimes(1));
    const [options] = sendMessages.mock.calls[0] as [{ messages: AssistantMessage[] }];
    const message = options.messages.at(-1);
    expect(message?.metadata).toEqual({ answer });
    expect(message?.parts[0]).toEqual({ type: "text", text: "Schools: Schools (catalog)" });
    await screen.findByText("assistant_ask_answered");
    expect(composerBox().value).toBe("Something else");
  });

  it("shows an answer another tab sent instead of sending a second one", async () => {
    const elsewhere: AssistantMessage = {
      id: "u2",
      role: "user",
      metadata: { answer },
      parts: [{ type: "text", text: "Schools: Schools (catalog)" }],
    };
    vi.mocked(fetchConversation).mockResolvedValue(stored([...asked, elsewhere]));
    const { onReconnect } = renderChat({ initialMessages: asked });
    pickAndSend();
    await waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(1));
    expect(sendMessages).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledWith("assistant_ask_already_answered");
  });

  it("opens the card again when the answer is refused, with its picks, and leaves the composer alone", async () => {
    vi.mocked(fetchConversation).mockResolvedValue(stored(asked));
    sendMessages.mockRejectedValue(refusal(409, { code: "conversation_busy", message: "busy" }));
    renderChat({ initialMessages: asked });
    pickAndSend();
    await screen.findByText("assistant_error_conversation_busy");
    await waitFor(() => expect(cardSend().disabled).toBe(false));
    await expect(screen.getByRole("radio", { name: /Schools \(catalog\)/ })).toBeChecked();
    expect(getAskChoices("ask-call-4")).not.toBeNull();
    expect(screen.queryByText("Schools: Schools (catalog)")).toBeNull();
    // The composer, behind the panel, is as it was.
    expect(getDraft("c1")?.text ?? "").toBe("");
    fireEvent.click(screen.getByRole("button", { name: "assistant_ask_reply_in_text" }));
    expect(composerBox().value).toBe("");
  });

  it("loads the conversation again when the server refuses an answer that no longer fits its card", async () => {
    vi.mocked(fetchConversation).mockResolvedValue(stored(asked));
    sendMessages.mockRejectedValue(
      refusal(422, { code: "invalid_answer", message: "This card was answered already." })
    );
    const { onReconnect } = renderChat({ initialMessages: asked });
    pickAndSend();
    await waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(1));
    expect(toastInfo).toHaveBeenCalledWith("assistant_ask_cannot_answer");
  });

  it("shows the card answered while its answer is on the way, never as not answered", async () => {
    vi.mocked(fetchConversation).mockResolvedValue(stored(asked));
    sendMessages.mockResolvedValue(stream([...REPLY], "hang"));
    renderChat({ initialMessages: asked });
    pickAndSend();
    await waitFor(() => expect(sendMessages).toHaveBeenCalledTimes(1));
    expect(screen.getByText("assistant_ask_answered")).toBeTruthy();
    expect(screen.queryByText("assistant_ask_not_answered")).toBeNull();
  });

  it("keeps the focus on the card when its Send gives way to the answer", async () => {
    vi.mocked(fetchConversation).mockResolvedValue(stored(asked));
    sendMessages.mockResolvedValue(stream([...REPLY], "hang"));
    renderChat({ initialMessages: asked });
    fireEvent.click(screen.getByRole("radio", { name: /Schools \(catalog\)/ }));
    act(() => cardSend().focus());
    fireEvent.click(cardSend());
    const answered = await screen.findByText("assistant_ask_answered");
    await expect(answered.closest("form")).toHaveFocus();
  });

  it("puts the focus back into the panel when a refused answer opens it again", async () => {
    vi.mocked(fetchConversation).mockResolvedValue(stored(asked));
    sendMessages.mockRejectedValue(refusal(409, { code: "conversation_busy", message: "busy" }));
    renderChat({ initialMessages: asked });
    fireEvent.click(screen.getByRole("radio", { name: /Schools \(catalog\)/ }));
    act(() => cardSend().focus());
    fireEvent.click(cardSend());
    await screen.findByText("assistant_error_conversation_busy");
    await waitFor(() => expect(cardSend().disabled).toBe(false));
    // The panel opened again with the focus on its first option (one question: no tabs).
    await expect(screen.getByRole("radio", { name: /Schools \(catalog\)/ })).toHaveFocus();
  });

  it("sends one answer when Send is pressed twice before the card shows that it waits", async () => {
    vi.mocked(fetchConversation).mockResolvedValue(stored(asked));
    sendMessages.mockResolvedValue(stream([...REPLY, ...text("Thanks"), ...FINISH]));
    renderChat({ initialMessages: asked });
    fireEvent.click(screen.getByRole("radio", { name: /Schools \(catalog\)/ }));
    const button = cardSend();
    // Both presses in one update: the second meets the card as the first left it, Send still enabled.
    act(() => {
      button.click();
      button.click();
    });
    await screen.findByText("Thanks");
    expect(fetchConversation).toHaveBeenCalledTimes(1);
    expect(sendMessages).toHaveBeenCalledTimes(1);
  });

  /** The stored conversation's read, held until the test lets it answer. */
  const heldRead = () => {
    let respond: (detail: ConversationDetail) => void = () => undefined;
    vi.mocked(fetchConversation).mockReturnValue(new Promise((resolve) => (respond = resolve)));
    return (messages: AssistantMessage[]) => act(async () => respond(stored(messages)));
  };
  const answeredElsewhere: AssistantMessage = {
    id: "u2",
    role: "user",
    metadata: { answer },
    parts: [{ type: "text", text: "Schools: Schools (catalog)" }],
  };
  const typedElsewhere: AssistantMessage = {
    id: "u2",
    role: "user",
    parts: [{ type: "text", text: "Never mind, use my own layer" }],
  };
  const lastSent = (index: number) =>
    (sendMessages.mock.calls[index] as [{ messages: AssistantMessage[] }])[0].messages.at(-1);

  it("queues a message typed while the stored conversation is read behind the answer, also on Send now", async () => {
    const respond = heldRead();
    sendMessages
      .mockResolvedValueOnce(stream([...REPLY, ...text("Thanks"), ...FINISH]))
      .mockResolvedValueOnce(
        stream([{ type: "start", messageId: "a3" }, { type: "start-step" }, ...text("Zwei", "t2"), ...FINISH])
      );
    renderChat({ initialMessages: asked });
    pickAndSend();
    // The panel waits for the read with its Send off; the composer is one click away.
    fireEvent.click(screen.getByRole("button", { name: "assistant_ask_reply_in_text" }));
    fireEvent.change(composerBox(), { target: { value: "Something else" } });
    fireEvent.click(screen.getByRole("button", { name: "assistant_send" }));
    expect(within(queuedItem()).getByText("Something else")).toBeTruthy();
    expect(sendMessages).not.toHaveBeenCalled();
    // Nothing runs yet that "Send now" could stop: the queued message still waits for the answer.
    fireEvent.click(within(queuedItem()).getByRole("button", { name: "assistant_send_now" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(sendMessages).not.toHaveBeenCalled();
    await respond(asked);
    await screen.findByText("Zwei");
    expect(sendMessages).toHaveBeenCalledTimes(2);
    expect(lastSent(0)?.metadata).toEqual({ answer });
    expect(lastSent(1)?.parts[0]).toEqual({ type: "text", text: "Something else" });
    expect(screen.getByText("assistant_ask_answered")).toBeTruthy();
  });

  it.each([
    ["still open", asked],
    ["answered in another tab", [...asked, answeredElsewhere]],
  ])(
    "does nothing once the chat closed while the stored conversation was read (%s)",
    async (_case, messages) => {
      const respond = heldRead();
      const { unmount, onReconnect } = renderChat({ initialMessages: asked });
      pickAndSend();
      await waitFor(() => expect(fetchConversation).toHaveBeenCalledTimes(1));
      unmount();
      await respond(messages);
      expect(sendMessages).not.toHaveBeenCalled();
      expect(toastInfo).not.toHaveBeenCalled();
      expect(onReconnect).not.toHaveBeenCalled();
    }
  );

  it("loads the conversation again when a typed reply in another tab passed over the card", async () => {
    vi.mocked(fetchConversation).mockResolvedValue(stored([...asked, typedElsewhere]));
    const { onReconnect } = renderChat({ initialMessages: asked });
    pickAndSend();
    await waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(1));
    expect(sendMessages).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledWith("assistant_ask_passed_over");
  });

  it("sends the answer with the page's context and leaves the draft, its sources and its chips alone", async () => {
    // The composer's filters chip was removed before the card came.
    saveDraft("c1", {
      text: "Draft text",
      sources: [{ kind: "project", id: "p7", name: "Radnetz" }],
      removed: ["filters"],
      surfaceKey: "catalog:",
    });
    vi.mocked(fetchConversation).mockResolvedValue(stored(asked));
    // Still running: only the acceptance, not the end of the run, reads the history again.
    sendMessages.mockResolvedValue(stream([...REPLY, ...text("Thanks")], "hang"));
    renderChat({ initialMessages: asked });
    pickAndSend();
    await screen.findByText("Thanks");
    const [options] = sendMessages.mock.calls[0] as [{ body: unknown }];
    expect(options.body).toEqual({
      context: { surface: "catalog", q: "rad", facets: { themes: ["transportation"] } },
    });
    // Accepted: the history is read again, and the draft is as it was.
    expect(refreshConversationLists).toHaveBeenCalled();
    expect(composerBox().value).toBe("Draft text");
    // The composer's own chips; the answer's message shows the page's chips in the transcript.
    const composerChips = within(screen.getByRole("group", { name: "assistant_context_label" }));
    expect(composerChips.getByText("assistant_chip_source")).toBeTruthy();
    expect(composerChips.queryByText("assistant_chip_filters")).toBeNull();
    expect(getDraft("c1")?.sources).toEqual([{ kind: "project", id: "p7", name: "Radnetz" }]);
  });

  it("shows no error of its own for an answer the server no longer takes, only the reload", async () => {
    vi.mocked(fetchConversation).mockResolvedValue(stored(asked));
    sendMessages.mockRejectedValue(refusal(422, { code: "invalid_answer", message: "x" }));
    const { onReconnect } = renderChat({ initialMessages: asked });
    pickAndSend();
    await waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(1));
    // Settled: the dropped answer opened the card again.
    await waitFor(() => expect(cardSend().disabled).toBe(false));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("asks at the dock's foot in place of the composer, and gives the composer back once answered", async () => {
    vi.mocked(fetchConversation).mockResolvedValue(stored(asked));
    sendMessages.mockResolvedValue(stream([...REPLY], "hang"));
    renderChat({ initialMessages: asked });
    expect(screen.getByRole("form", { name: "assistant_ask_label" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "assistant_composer_placeholder" })).toBeNull();
    // The transcript holds the card's place.
    expect(screen.getByText("assistant_ask_waiting")).toBeTruthy();
    pickAndSend();
    await screen.findByText("assistant_ask_answered");
    expect(composerBox()).toBeTruthy();
    expect(screen.queryByRole("button", { name: "assistant_ask_send" })).toBeNull();
    expect(screen.queryByText("assistant_ask_waiting")).toBeNull();
  });

  it("is answered on a page without a project as on the catalog", async () => {
    vi.mocked(fetchConversation).mockResolvedValue(stored(asked));
    sendMessages.mockResolvedValue(stream([...REPLY], "hang"));
    // No page registered: no project, no context.
    resetAssistantStore();
    renderChat({ initialMessages: asked });
    pickAndSend();
    await waitFor(() => expect(sendMessages).toHaveBeenCalledTimes(1));
    const [options] = sendMessages.mock.calls[0] as [{ body: unknown; messages: AssistantMessage[] }];
    expect(options.body).toEqual({ context: null });
    expect(options.messages.at(-1)?.metadata).toEqual({ answer });
  });

  it("gives the composer the card's place on Reply in text instead or Esc, and offers the card again", async () => {
    renderChat({ initialMessages: asked });
    fireEvent.click(screen.getByRole("button", { name: "assistant_ask_reply_in_text" }));
    expect(panelShown()).toBe(false);
    await expect(composerBox()).toHaveFocus();
    // The card is still open: the transcript shows its questions to reply to, with the waiting
    // line at their foot; the way back is above the composer.
    await expect(screen.getByRole("radio", { name: /Schools \(catalog\)/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "assistant_ask_waiting · Schools" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "assistant_ask_return" }));
    expect(screen.getByText("assistant_ask_waiting")).toBeTruthy();
    await expect(screen.getByRole("radio", { name: /Schools \(catalog\)/ })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("radio", { name: /Schools \(catalog\)/ }), { key: "Escape" });
    expect(panelShown()).toBe(false);
    await expect(composerBox()).toHaveFocus();
    // A draft keeps the way back: the draft waits behind the panel.
    fireEvent.change(composerBox(), { target: { value: "Use my own layer" } });
    expect(screen.getByRole("button", { name: "assistant_ask_return" })).toBeTruthy();
  });

  it("keeps a card the person replies to in text in the composer when the dock mounts the chat again", () => {
    const first = renderChat({ initialMessages: asked });
    fireEvent.click(screen.getByRole("button", { name: "assistant_ask_reply_in_text" }));
    // Expanding or collapsing the dock mounts the chat again.
    first.unmount();
    renderChat({ initialMessages: asked });
    expect(panelShown()).toBe(false);
    expect(composerBox()).toBeTruthy();
    expect(screen.getByRole("button", { name: "assistant_ask_return" })).toBeTruthy();
  });

  it("passes the card over with a message typed instead, and opens the panel again for a newer card", async () => {
    const newer = { ...card, card_id: "ask-call-5" };
    sendMessages.mockResolvedValue(
      stream([
        ...REPLY,
        {
          type: "tool-input-available",
          toolCallId: "t-ask-2",
          toolName: "ask_user",
          input: {},
          dynamic: true,
        },
        { type: "data-ask", id: "ask-call-5", data: newer },
        {
          type: "tool-output-available",
          toolCallId: "t-ask-2",
          output: { card_id: "ask-call-5", status: "asked" },
          dynamic: true,
        },
        ...FINISH,
      ] as UIMessageChunk[])
    );
    renderChat({ initialMessages: asked });
    fireEvent.click(screen.getByRole("button", { name: "assistant_ask_reply_in_text" }));
    // The transcript shows the card's questions (with its disabled Other field): the composer's own box.
    fireEvent.change(composerBox(), { target: { value: "Use the layer I uploaded" } });
    fireEvent.click(screen.getByRole("button", { name: "assistant_send" }));
    await screen.findByText("assistant_ask_not_answered");
    // The newer card asks at the dock's foot again.
    await screen.findByRole("form", { name: "assistant_ask_label" });
    expect(screen.queryByRole("textbox", { name: "assistant_composer_placeholder" })).toBeNull();
    expect(screen.getAllByText("assistant_ask_waiting")).toHaveLength(1);
  });

  it("leaves a person typing in the composer to it when a card comes, and moves an idle focus into the panel", async () => {
    const cardChunks: UIMessageChunk[] = [
      { type: "tool-input-available", toolCallId: "t-ask", toolName: "ask_user", input: {}, dynamic: true },
      { type: "data-ask", id: "ask-call-4", data: card },
      {
        type: "tool-output-available",
        toolCallId: "t-ask",
        output: { card_id: "ask-call-4", status: "asked" },
        dynamic: true,
      },
      ...FINISH,
    ] as UIMessageChunk[];
    const first = asked.slice(0, 1);
    for (const typing of [true, false]) {
      let release: (chunks: UIMessageChunk[]) => void = () => undefined;
      sendMessages.mockResolvedValueOnce(
        gatedStream([...START], new Promise<UIMessageChunk[]>((resolve) => (release = resolve)))
      );
      const view = renderChat({ initialMessages: [] });
      send(first[0].parts[0].type === "text" ? first[0].parts[0].text : "");
      await screen.findByText("assistant_running");
      act(() => composerBox().focus());
      if (typing) fireEvent.change(composerBox(), { target: { value: "and count the resid" } });
      // A copy: the stream takes the chunks out of the array it gets.
      await act(async () => release([...cardChunks]));
      await screen.findByText("Build a 15 minute workflow");
      await waitFor(() => expect(screen.queryByText("assistant_running")).toBeNull());
      if (typing) {
        // The composer stays, with the text and the focus; the transcript shows the questions,
        // and the way back is offered whatever the draft holds.
        await expect(composerBox()).toHaveFocus();
        expect(composerBox().value).toBe("and count the resid");
        expect(panelShown()).toBe(false);
        await expect(screen.getByRole("radio", { name: /Schools \(catalog\)/ })).toBeDisabled();
        fireEvent.click(screen.getByRole("button", { name: "assistant_ask_return" }));
        expect(panelShown()).toBe(true);
        await expect(screen.getByRole("radio", { name: /Schools \(catalog\)/ })).toHaveFocus();
        // The draft waits behind the panel; back in the composer, the way back is still offered.
        fireEvent.keyDown(screen.getByRole("radio", { name: /Schools \(catalog\)/ }), { key: "Escape" });
        expect(composerBox().value).toBe("and count the resid");
        expect(screen.getByRole("button", { name: "assistant_ask_return" })).toBeTruthy();
      } else {
        expect(screen.getByText("assistant_ask_waiting")).toBeTruthy();
        await expect(screen.getByRole("radio", { name: /Schools \(catalog\)/ })).toHaveFocus();
      }
      view.unmount();
      resetAssistantStore();
    }
  });

  it("leaves the focus where it is when the chat mounts with an open card, or gets the page's project", async () => {
    const { unmount } = renderChat({ initialMessages: asked });
    expect(panelShown()).toBe(true);
    await expect(document.body).toHaveFocus();
    unmount();
    // The page's project became known: the same card, not a new one.
    const { update } = renderChat({ initialMessages: asked, waiting: true });
    expect(panelShown()).toBe(false);
    update({ waiting: false });
    expect(panelShown()).toBe(true);
    await expect(document.body).toHaveFocus();
  });

  it("offers Stop in the panel while the answer that asks still runs", async () => {
    cancelMock.mockResolvedValue(undefined);
    sendMessages.mockResolvedValue(
      stream(
        [
          ...START,
          {
            type: "tool-input-available",
            toolCallId: "t-ask",
            toolName: "ask_user",
            input: {},
            dynamic: true,
          },
          { type: "data-ask", id: "ask-call-4", data: card },
          {
            type: "tool-output-available",
            toolCallId: "t-ask",
            output: { card_id: "ask-call-4", status: "asked" },
            dynamic: true,
          },
        ] as UIMessageChunk[],
        "hang"
      )
    );
    renderChat({ initialMessages: [] });
    send("Build a 15 minute workflow");
    await waitFor(() => expect(panelShown()).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "stop" }));
    await waitFor(() => expect(cancelMock).toHaveBeenCalledWith("c1"));
  });

  it("keeps the newest message in view when the panel grows, if the transcript was at its end", () => {
    const observers: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          observers.push(callback);
        }
        observe() {}
        disconnect() {}
      }
    );
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const client = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 500 });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 200 });
    try {
      renderChat({ initialMessages: asked });
      let transcript = screen.getByText("Build a 15 minute workflow").parentElement as HTMLElement;
      while (transcript.scrollTop !== 500) transcript = transcript.parentElement as HTMLElement;
      const grow = () => act(() => observers.forEach((callback) => callback()));
      // At its end: a taller question keeps the newest message in view.
      transcript.scrollTop = 300;
      fireEvent.scroll(transcript);
      grow();
      expect(transcript.scrollTop).toBe(500);
      // Scrolled up to read: it stays where the person is.
      transcript.scrollTop = 40;
      fireEvent.scroll(transcript);
      grow();
      expect(transcript.scrollTop).toBe(40);
    } finally {
      vi.unstubAllGlobals();
      for (const [name, descriptor] of [
        ["scrollHeight", original],
        ["clientHeight", client],
      ] as const) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
      }
    }
  });

  /** The card's chunks: the ask step, the card, the step's result. */
  const cardChunks = (): UIMessageChunk[] =>
    [
      { type: "tool-input-available", toolCallId: "t-ask", toolName: "ask_user", input: {}, dynamic: true },
      { type: "data-ask", id: "ask-call-4", data: card },
      {
        type: "tool-output-available",
        toolCallId: "t-ask",
        output: { card_id: "ask-call-4", status: "asked" },
        dynamic: true,
      },
    ] as UIMessageChunk[];
  /** A running answer: `first`, then `rest` once released, then it stays open. */
  const heldRun = (first: UIMessageChunk[]) => {
    let release: (rest: UIMessageChunk[]) => void = () => undefined;
    const rest = new Promise<UIMessageChunk[]>((resolve) => (release = resolve));
    let queue = [...first];
    let waited = false;
    const body = new ReadableStream<UIMessageChunk>({
      async pull(controller) {
        if (!queue.length && !waited) {
          waited = true;
          queue = [...(await rest)];
        }
        const chunk = queue.shift();
        if (chunk) controller.enqueue(chunk);
        else return new Promise<void>(() => undefined);
        return undefined;
      },
    });
    return { body, release: (chunks: UIMessageChunk[]) => act(async () => release(chunks)) };
  };
  const wayBack = () => screen.queryByRole("button", { name: "assistant_ask_return" });
  /** The transcript's waiting line under the held card: the same way back. */
  const waitingLine = () => screen.queryByRole("button", { name: "assistant_ask_waiting · Schools" });

  it("offers the way back while the composer holds the card, and hides it while a message is queued", async () => {
    // A card that came while the person typed.
    const typed = heldRun([...START]);
    sendMessages.mockResolvedValueOnce(typed.body);
    const first = renderChat({ initialMessages: [] });
    send("Build a 15 minute workflow");
    await screen.findByText("assistant_running");
    act(() => composerBox().focus());
    fireEvent.change(composerBox(), { target: { value: "and count the residents" } });
    await typed.release(cardChunks());
    await waitFor(() => expect(wayBack()).toBeTruthy());
    expect(waitingLine()).toBeTruthy();
    // The answer still runs: the typed message waits in the queue, and passes the card over once it goes.
    fireEvent.click(screen.getByRole("button", { name: "assistant_send" }));
    expect(within(queuedItem()).getByText("and count the residents")).toBeTruthy();
    expect(wayBack()).toBeNull();
    expect(waitingLine()).toBeNull();
    first.unmount();
    resetAssistantStore();

    // "Reply in text instead".
    const replied = heldRun([...START, ...cardChunks()]);
    sendMessages.mockResolvedValueOnce(replied.body);
    renderChat({ initialMessages: [] });
    send("Build a 15 minute workflow");
    await waitFor(() => expect(panelShown()).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "assistant_ask_reply_in_text" }));
    fireEvent.change(composerBox(), { target: { value: "Use my own layer" } });
    expect(wayBack()).toBeTruthy();
    expect(waitingLine()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "assistant_send" }));
    expect(within(queuedItem()).getByText("Use my own layer")).toBeTruthy();
    expect(wayBack()).toBeNull();
    expect(waitingLine()).toBeNull();
  });

  it("leaves the focus be when a page load or reconnect resumes the run that asks", async () => {
    const replay = heldRun([...START]);
    reconnectToStream.mockResolvedValueOnce(replay.body as never);
    renderChat({
      resume: true,
      activeRunId: "run-1",
      initialMessages: [asked[0]],
    });
    await screen.findByText("assistant_running");
    // The replay brings the card and its step's result after the mount.
    await replay.release([...cardChunks(), ...FINISH]);
    await waitFor(() => expect(panelShown()).toBe(true));
    await expect(document.body).toHaveFocus();
  });

  it("moves the focus into the panel for a card that comes after the resumed run ended", async () => {
    // The resumed run replays and ends without a card.
    reconnectToStream.mockResolvedValueOnce(stream([...START, ...text("Erledigt"), ...FINISH]) as never);
    renderChat({ resume: true, activeRunId: "run-1", initialMessages: [asked[0]] });
    await screen.findByText("Erledigt");
    await waitFor(() => expect(screen.queryByText("assistant_running")).toBeNull());
    sendMessages.mockResolvedValueOnce(
      stream([{ type: "start", messageId: "a2" }, { type: "start-step" }, ...cardChunks(), ...FINISH])
    );
    send("Build a 15 minute workflow");
    await waitFor(() => expect(panelShown()).toBe(true));
    await expect(screen.getByRole("radio", { name: /Schools \(catalog\)/ })).toHaveFocus();
  });

  it("takes Stop out of the panel when the run ends", async () => {
    // The answer ends (its stream closes) once released.
    let release: (rest: UIMessageChunk[]) => void = () => undefined;
    sendMessages.mockResolvedValueOnce(
      gatedStream(
        [...START, ...cardChunks()],
        new Promise<UIMessageChunk[]>((resolve) => (release = resolve))
      )
    );
    renderChat({ initialMessages: [] });
    send("Build a 15 minute workflow");
    await waitFor(() => expect(panelShown()).toBe(true));
    expect(screen.getByRole("button", { name: "stop" })).toBeTruthy();
    await act(async () => release([...FINISH]));
    await waitFor(() => expect(screen.queryByRole("button", { name: "stop" })).toBeNull());
    expect(panelShown()).toBe(true);
  });

  it("stops watching the footer's size when the chat closes", () => {
    /** Each observer, what it watches, and whether it stopped (descriptions measure themselves too). */
    const observers: { targets: Element[]; disconnected: boolean }[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        entry = { targets: [] as Element[], disconnected: false };
        constructor() {
          observers.push(this.entry);
        }
        observe(target: Element) {
          this.entry.targets.push(target);
        }
        disconnect() {
          this.entry.disconnected = true;
        }
      }
    );
    try {
      const { unmount } = renderChat({ initialMessages: asked });
      const panel = screen.getByRole("form", { name: "assistant_ask_label" });
      const footer = observers.find((observer) => observer.targets.some((target) => target.contains(panel)));
      expect(footer?.disconnected).toBe(false);
      unmount();
      expect(footer?.disconnected).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("moves the focus into the panel from the waiting line, and opens it from the line under a held card", async () => {
    renderChat({ initialMessages: asked });
    const line = () => screen.getByRole("button", { name: "assistant_ask_waiting · Schools" });
    fireEvent.click(line());
    await expect(screen.getByRole("radio", { name: /Schools \(catalog\)/ })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "assistant_ask_reply_in_text" }));
    expect(panelShown()).toBe(false);
    fireEvent.click(line());
    expect(panelShown()).toBe(true);
    await expect(screen.getByRole("radio", { name: /Schools \(catalog\)/ })).toHaveFocus();
  });

  it("shows a read-only conversation's card with its questions, and no panel", async () => {
    renderChat({ initialMessages: asked, readOnly: { kind: "lost" } });
    await expect(screen.getByRole("radio", { name: /Schools \(catalog\)/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "assistant_ask_send" })).toBeNull();
    expect(screen.queryByRole("button", { name: "assistant_ask_reply_in_text" })).toBeNull();
    expect(screen.queryByText("assistant_ask_waiting")).toBeNull();
  });

  it("forgets the picks once the server took the answer", async () => {
    vi.mocked(fetchConversation).mockResolvedValue(stored(asked));
    sendMessages.mockResolvedValue(stream([...REPLY, ...text("Thanks")], "hang"));
    renderChat({ initialMessages: asked });
    fireEvent.click(screen.getByRole("radio", { name: /Schools \(catalog\)/ }));
    expect(getAskChoices("ask-call-4")).not.toBeNull();
    fireEvent.click(cardSend());
    await screen.findByText("Thanks");
    expect(getAskChoices("ask-call-4")).toBeNull();
  });

  it("keeps the newest message in view when the panel takes or gives back the composer's place", () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 500 });
    try {
      renderChat({ initialMessages: asked });
      // The transcript: the message's ancestor the chat scrolled to the bottom on mount.
      let transcript = screen.getByText("Build a 15 minute workflow").parentElement as HTMLElement;
      while (transcript.scrollTop !== 500) transcript = transcript.parentElement as HTMLElement;
      transcript.scrollTop = 0;
      fireEvent.click(screen.getByRole("button", { name: "assistant_ask_reply_in_text" }));
      expect(transcript.scrollTop).toBe(500);
      transcript.scrollTop = 0;
      fireEvent.click(screen.getByRole("button", { name: "assistant_ask_return" }));
      expect(transcript.scrollTop).toBe(500);
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "scrollHeight", original);
      else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    }
  });

  it("announces the answered card where the focus sits", async () => {
    vi.mocked(fetchConversation).mockResolvedValue(stored(asked));
    sendMessages.mockResolvedValue(stream([...REPLY], "hang"));
    renderChat({ initialMessages: asked });
    pickAndSend();
    const answered = await screen.findByText("assistant_ask_answered");
    const form = answered.closest("form") as HTMLElement;
    await expect(form).toHaveFocus();
    await expect(within(form).getByRole("status")).toHaveTextContent("assistant_ask_answered");
  });
});

describe("ChatView created workflows", () => {
  const createdOutput = (id: string) => ({
    workflow: { id, name: id, project_id: "p1" },
    open_issues: [],
    // No cards here: this suite renders without the project hooks a card reads.
    groups: [],
  });
  const loaded: AssistantMessage[] = [
    { id: "u0", role: "user", parts: [{ type: "text", text: "Erste" }] },
    {
      id: "a0",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "workflow_create",
          toolCallId: "call-old",
          state: "output-available",
          input: {},
          output: createdOutput("w-old"),
        } as DynamicToolUIPart,
      ],
    },
  ];

  it("hands the dock a workflow the running answer creates, and none the conversation held before", async () => {
    sendMessages.mockResolvedValue(
      stream([
        ...START,
        { type: "tool-input-available", toolCallId: "call-new", toolName: "workflow_create", input: {}, dynamic: true },
        { type: "tool-output-available", toolCallId: "call-new", output: createdOutput("w-new"), dynamic: true },
        ...text("Created."),
        ...FINISH,
      ])
    );
    renderChat({ initialMessages: loaded });
    send("Noch einen");
    await screen.findByText("Created.");
    await waitFor(() => expect(actions.openCreatedWorkflow).toHaveBeenCalledWith("p1", "w-new"));
    expect(actions.openCreatedWorkflow).toHaveBeenCalledTimes(1);
  });
});
