import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AssistantRequestError } from "@/lib/assistant/errors";
import {
  NEW_CONVERSATION_DRAFT,
  getDockState,
  getDraft,
  peekFirstMessage,
  registerSurface,
  resetAssistantStore,
  setDockState,
} from "@/lib/assistant/store";
import { PROJECT_SURFACE_WAIT_MS } from "@/lib/assistant/surface";

import NewConversation from "@/components/assistant/NewConversation";

const { createMock, pathnameMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  pathnameMock: vi.fn(() => "/home"),
}));

vi.mock("@/lib/assistant/transport", () => ({
  createAssistantTransport: vi.fn(),
  cancelAssistantRun: vi.fn(),
  fetchConversation: vi.fn(),
  createConversation: createMock,
}));
vi.mock("@/lib/assistant/conversations", () => ({
  refreshConversationLists: vi.fn(),
  useConversations: () => ({ conversations: [] }),
}));
vi.mock("@/lib/api/projects", () => ({
  useProjects: () => ({ projects: { items: [] }, isLoading: false }),
  useProjectLayers: () => ({ layers: undefined }),
}));
vi.mock("@/components/support/SupportMenu", () => ({ useReportProblemHref: () => null }));
// The start page's AI notice links the privacy policy only with NEXT_PUBLIC_WEBSITE_URL, through
// `Trans`, which this i18n mock has not: without the link, these tests do not depend on that variable.
vi.mock("@/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  privacyPolicyUrl: () => undefined,
}));
vi.mock("next/navigation", () => ({ usePathname: pathnameMock }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

function send(value: string) {
  fireEvent.change(screen.getByRole("textbox"), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "assistant_send" }));
}

beforeEach(() => {
  window.sessionStorage.clear();
  resetAssistantStore();
  vi.clearAllMocks();
  pathnameMock.mockReturnValue("/home");
});

describe("NewConversation", () => {
  it("waits on a project page until the project registered, so the conversation starts there", async () => {
    pathnameMock.mockReturnValue("/map/p1");
    createMock.mockResolvedValue({ id: "c9", project_id: null, origin_surface: "project.map", title: null });
    render(<NewConversation />);
    // Loading instead of the starters of a page without context.
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(screen.queryByText("assistant_empty_heading_none")).toBeNull();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Welche Layer?" } });
    const sendButton = screen.getByRole("button", { name: "assistant_send" });
    expect((sendButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(createMock).not.toHaveBeenCalled();
    // The project registers before the wait ends: the conversation starts with its context.
    vi.useFakeTimers();
    act(() => vi.advanceTimersByTime(PROJECT_SURFACE_WAIT_MS - 500));
    vi.useRealTimers();
    expect(screen.getByRole("progressbar")).toBeTruthy();
    act(() => {
      registerSurface({
        surface: "project.map",
        project: { id: "p1", name: "Eins" },
        getContext: () => ({ surface: "project.map", project_id: "p1" }),
      });
    });
    expect(screen.getByText("assistant_empty_heading_project")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "assistant_send" }));
    await waitFor(() => expect(createMock).toHaveBeenCalledWith("project.map"));
    expect(peekFirstMessage("c9")?.context).toEqual({ surface: "project.map", project_id: "p1" });
  });

  it("stops waiting after a bounded wait and starts without page context", async () => {
    // No surface ever registers (e.g. the page stayed in public mode): never an endless spinner.
    vi.useFakeTimers();
    pathnameMock.mockReturnValue("/map/p1");
    createMock.mockResolvedValue({ id: "c9", project_id: null, origin_surface: "none", title: null });
    render(<NewConversation />);
    expect(screen.getByRole("progressbar")).toBeTruthy();
    act(() => vi.advanceTimersByTime(PROJECT_SURFACE_WAIT_MS));
    vi.useRealTimers();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText("assistant_empty_heading_none")).toBeTruthy();
    send("Welche Layer?");
    await waitFor(() => expect(createMock).toHaveBeenCalledWith("none"));
    expect(peekFirstMessage("c9")?.context).toBeNull();
  });

  it("stops waiting at once when the page reports that its project has no surface", () => {
    pathnameMock.mockReturnValue("/map/p1");
    render(<NewConversation />);
    expect(screen.getByRole("progressbar")).toBeTruthy();
    act(() => setDockState({ noSurfaceProject: "p1" }));
    expect(screen.queryByRole("progressbar")).toBeNull();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Hallo" } });
    expect((screen.getByRole("button", { name: "assistant_send" }) as HTMLButtonElement).disabled).toBe(
      false
    );
  });

  it("creates a conversation on a project page unbound and opens it with the first message", async () => {
    // The server binds it when it accepts the first run (a refused run never binds).
    registerSurface({
      surface: "project.map",
      project: { id: "p1", name: "Eins" },
      getContext: () => ({ surface: "project.map", project_id: "p1" }),
    });
    createMock.mockResolvedValue({ id: "c9", project_id: null, origin_surface: "project.map", title: null });
    render(<NewConversation />);
    send("Welche Layer?");
    await waitFor(() => expect(getDockState().conversationId).toBe("c9"));
    expect(createMock).toHaveBeenCalledWith("project.map");
    expect(createMock.mock.calls[0]).toHaveLength(1);
    expect(peekFirstMessage("c9")).toEqual({
      conversationId: "c9",
      text: "Welche Layer?",
      context: { surface: "project.map", project_id: "p1" },
    });
  });

  it("records the page as the origin where no surface is registered", async () => {
    createMock.mockResolvedValue({ id: "c8", project_id: null, origin_surface: "home", title: null });
    render(<NewConversation />);
    fireEvent.click(screen.getByText("assistant_starter_help"));
    await waitFor(() => expect(getDockState().conversationId).toBe("c8"));
    expect(createMock).toHaveBeenCalledWith("home");
    expect(peekFirstMessage("c8")?.text).toBe("assistant_starter_help");
  });

  it("puts a sentence start into the composer, focused, without sending it", () => {
    render(<NewConversation />);
    fireEvent.click(screen.getByText("assistant_starter_datasets…"));
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(box.value).toBe("assistant_starter_datasets ");
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe(box.value.length);
    expect(createMock).not.toHaveBeenCalled();
    expect(getDraft(NEW_CONVERSATION_DRAFT)?.text).toBe("assistant_starter_datasets ");
  });

  it("puts a sentence start in front of what the user already typed", () => {
    render(<NewConversation />);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Berlin Hauptbahnhof" } });
    fireEvent.click(screen.getByText("assistant_starter_datasets…"));
    expect(box.value).toBe("assistant_starter_datasets Berlin Hauptbahnhof");
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe(box.value.length);
    expect(getDraft(NEW_CONVERSATION_DRAFT)?.text).toBe("assistant_starter_datasets Berlin Hauptbahnhof");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("shows a refused creation translated and keeps the draft", async () => {
    createMock.mockRejectedValue(new AssistantRequestError(503, "shutting_down", "Service is shutting down"));
    render(<NewConversation />);
    send("Hallo");
    await screen.findByText("assistant_error_shutting_down");
    expect(screen.queryByText(/shutting down/)).toBeNull();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Hallo");
    expect(getDockState().conversationId).toBeNull();
  });
});

describe("NewConversation drafts (ruling 22)", () => {
  it("keeps the typed text across a remount and drops it once the conversation exists", async () => {
    const first = render(<NewConversation />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Radwege?" } });
    first.unmount();
    render(<NewConversation />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Radwege?");
    createMock.mockResolvedValue({ id: "c7", project_id: null, origin_surface: "home", title: null });
    fireEvent.click(screen.getByRole("button", { name: "assistant_send" }));
    await waitFor(() => expect(getDockState().conversationId).toBe("c7"));
    expect(getDraft(NEW_CONVERSATION_DRAFT)).toBeNull();
  });

  it("keeps the draft when the creation is refused", async () => {
    createMock.mockRejectedValue(new AssistantRequestError(503, "shutting_down", "Service is shutting down"));
    render(<NewConversation />);
    send("Hallo");
    await screen.findByText("assistant_error_shutting_down");
    expect(getDraft(NEW_CONVERSATION_DRAFT)?.text).toBe("Hallo");
  });
});
