import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerSurface, resetAssistantStore, setDockState } from "@/lib/assistant/store";
import type { ConversationDetail, Proposal } from "@/lib/assistant/types";

import AssistantDock from "@/components/assistant/AssistantDock";

// The real dock, pane, chat and proposal card; only the network, the router and the history are stubbed.
const { fetchMock, updateMock, pushMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  updateMock: vi.fn(async () => ({})),
  pushMock: vi.fn(),
}));
vi.mock("@/hooks/store/ContextHooks", () => ({ useAppDispatch: () => vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }), usePathname: () => "/home" }));
vi.mock("react-toastify", () => ({ toast: { warning: vi.fn(), error: vi.fn() } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("@/lib/assistant/conversations", () => ({
  useConversations: () => ({ conversations: [], isLoading: false }),
  updateConversation: updateMock,
  refreshConversationLists: vi.fn(),
}));
vi.mock("@/lib/assistant/transport", () => ({
  createAssistantTransport: vi.fn(() => ({
    sendMessages: vi.fn(),
    reconnectToStream: vi.fn(async () => null),
  })),
  cancelAssistantRun: vi.fn(),
  fetchConversation: fetchMock,
  createConversation: vi.fn(),
}));
vi.mock("@/lib/api/projects", () => ({
  useProjects: () => ({ projects: { items: [] }, isLoading: false }),
  useProjectLayers: () => ({ layers: undefined }),
}));
vi.mock("@/components/assistant/ConversationHistory", () => ({
  default: () => <div data-testid="history" />,
}));
// The composer's Feedback link reads the support summary; not under test here.
vi.mock("@/components/support/SupportMenu", () => ({ useReportProblemHref: () => null }));
vi.mock("@/components/addLayer/AddLayerDialog", () => ({ default: () => null }));

const view: Proposal = {
  version: 1,
  kind: "map.view",
  surface: "project.map",
  target: { project_id: "p2", name: "Radnetz" },
  title: "Innenstadt",
  rows: [{ k: "bbox", v: "13.1, 52.3, 13.8, 52.7" }],
  payload: { project_id: "p2", camera: null, bbox: [13.1, 52.3, 13.8, 52.7], layer_project_id: null },
};

const unbound: ConversationDetail = {
  conversation: { id: "c1", project_id: null, origin_surface: "home", title: "Radwege" },
  messages: [
    { id: "u1", role: "user", parts: [{ type: "text", text: "Zeig die Innenstadt" }] },
    { id: "a1", role: "assistant", parts: [{ type: "data-proposal", id: "a1:0", data: view }] },
  ],
  activeRunId: null,
  access: "ok",
  projectName: null,
};

beforeEach(() => {
  window.sessionStorage.clear();
  resetAssistantStore();
  vi.clearAllMocks();
  setDockState({ enabled: true, open: true, conversationId: "c1" });
});

describe("AssistantDock binding through Open in project to review", () => {
  it("makes the open conversation read only elsewhere at once, without a reload", async () => {
    fetchMock.mockResolvedValue(unbound);
    render(<AssistantDock variant="docked" />);
    // Home: no surface, so the card offers to open the project.
    fireEvent.click(await screen.findByRole("button", { name: "assistant_proposal_open_in_project" }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/map/p2"));
    expect(updateMock).toHaveBeenCalledWith("c1", { project_id: "p2" });
    // In the project the conversation continues.
    const unregister = registerSurface({
      surface: "project.map",
      project: { id: "p2", name: "Radnetz" },
      getContext: () => ({ surface: "project.map", project_id: "p2" }),
    });
    await screen.findByRole("textbox", { name: "assistant_composer_placeholder" });
    // Back on Home (a page without a surface): read only, named, no second load.
    act(() => unregister());
    await screen.findByText("assistant_readonly_elsewhere");
    expect(screen.queryByRole("textbox", { name: "assistant_composer_placeholder" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves the conversation as it was when the binding fails", async () => {
    fetchMock.mockResolvedValue(unbound);
    updateMock.mockRejectedValueOnce(new Error("refused"));
    render(<AssistantDock variant="docked" />);
    fireEvent.click(await screen.findByRole("button", { name: "assistant_proposal_open_in_project" }));
    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    expect(pushMock).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "assistant_composer_placeholder" })).toBeTruthy();
    expect(screen.queryByText("assistant_readonly_elsewhere")).toBeNull();
  });
});
