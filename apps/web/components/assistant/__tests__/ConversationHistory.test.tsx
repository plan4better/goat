import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  addPendingRun,
  getDockState,
  getDraft,
  registerSurface,
  resetAssistantStore,
  saveDraft,
  setDockState,
} from "@/lib/assistant/store";
import type { ConversationSummary } from "@/lib/assistant/types";

import ConversationHistory from "@/components/assistant/ConversationHistory";

const { useConversationsMock, deleteMock } = vi.hoisted(() => ({
  useConversationsMock: vi.fn(),
  deleteMock: vi.fn(async () => undefined),
}));

vi.mock("@/lib/assistant/conversations", () => ({
  useConversations: useConversationsMock,
  updateConversation: vi.fn(),
  deleteConversation: deleteMock,
  refreshConversationLists: vi.fn(),
}));
vi.mock("react-toastify", () => ({ toast: { error: vi.fn() } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

const today = new Date().toISOString();
const rows: ConversationSummary[] = [
  {
    id: "c1",
    title: "Radwege",
    origin_surface: "project.map",
    project_id: "p1",
    project_name: "Berlin cycling study",
    project_access: true,
    first_message: null,
    running: false,
    created_at: today,
    updated_at: today,
  },
  {
    id: "c2",
    title: null,
    origin_surface: "catalog",
    project_id: null,
    project_name: null,
    project_access: null,
    first_message: "Grünflächen?",
    running: false,
    created_at: "2026-01-02T10:00:00Z",
    updated_at: "2026-01-02T10:00:00Z",
  },
];

beforeEach(() => {
  window.sessionStorage.clear();
  resetAssistantStore();
  vi.clearAllMocks();
  useConversationsMock.mockReturnValue({ conversations: rows, isLoading: false, error: undefined });
});

describe("ConversationHistory", () => {
  it("lists today and earlier with origin labels and opens a conversation", () => {
    render(<ConversationHistory />);
    expect(screen.getByText("assistant_group_today")).toBeTruthy();
    expect(screen.getByText("assistant_group_earlier")).toBeTruthy();
    expect(screen.getByText("Berlin cycling study · map")).toBeTruthy();
    expect(screen.getByText("Grünflächen?")).toBeTruthy();
    fireEvent.click(screen.getByText("Radwege"));
    expect(getDockState().conversationId).toBe("c1");
  });

  it("shows This project inside a project by default and All on request", () => {
    registerSurface({
      surface: "project.map",
      project: { id: "p1", name: "Berlin cycling study" },
      getContext: () => ({ surface: "project.map", project_id: "p1" }),
    });
    render(<ConversationHistory />);
    expect(useConversationsMock).toHaveBeenLastCalledWith({ projectId: "p1", q: "" });
    fireEvent.click(screen.getByText("all"));
    expect(useConversationsMock).toHaveBeenLastCalledWith({ projectId: null, q: "" });
  });

  it("lists all conversations outside a project, without the scope chips", () => {
    render(<ConversationHistory />);
    expect(screen.queryByText("assistant_scope_this_project")).toBeNull();
    expect(useConversationsMock).toHaveBeenLastCalledWith({ projectId: null, q: "" });
  });

  it("searches after a short pause", async () => {
    render(<ConversationHistory />);
    fireEvent.change(screen.getByRole("textbox", { name: "assistant_search_conversations" }), {
      target: { value: "rad" },
    });
    await waitFor(() => expect(useConversationsMock).toHaveBeenLastCalledWith({ projectId: null, q: "rad" }));
  });

  it("deletes after confirmation and leaves the deleted conversation", async () => {
    setDockState({ conversationId: "c1" });
    render(<ConversationHistory />);
    fireEvent.click(screen.getAllByRole("button", { name: "assistant_conversation_actions" })[0]);
    fireEvent.click(screen.getByRole("menuitem", { name: "delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "delete" }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("c1"));
    expect(getDockState().conversationId).toBeNull();
  });

  it("forgets the unsent draft and the pending run of a deleted conversation", async () => {
    saveDraft("c1", { text: "Noch nicht gesendet" });
    saveDraft("c2", { text: "Bleibt" });
    addPendingRun({ conversationId: "c1", title: "Radwege", since: Date.now() });
    render(<ConversationHistory />);
    fireEvent.click(screen.getAllByRole("button", { name: "assistant_conversation_actions" })[0]);
    fireEvent.click(screen.getByRole("menuitem", { name: "delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "delete" }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("c1"));
    await waitFor(() => expect(getDraft("c1")).toBeNull());
    expect(getDraft("c2")?.text).toBe("Bleibt");
    expect(getDockState().pending).toEqual([]);
  });

  it("keeps the draft when the delete fails", async () => {
    deleteMock.mockRejectedValueOnce(new Error("offline"));
    saveDraft("c1", { text: "Noch nicht gesendet" });
    render(<ConversationHistory />);
    fireEvent.click(screen.getAllByRole("button", { name: "assistant_conversation_actions" })[0]);
    fireEvent.click(screen.getByRole("menuitem", { name: "delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "delete" }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("c1"));
    expect(getDraft("c1")?.text).toBe("Noch nicht gesendet");
  });
});
