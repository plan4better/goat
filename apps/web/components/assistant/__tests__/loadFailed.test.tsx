import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetAssistantStore, setDockState } from "@/lib/assistant/store";

import AssistantDock from "@/components/assistant/AssistantDock";
import { DockActionsContext } from "@/components/assistant/DockActions";
import ResultCards from "@/components/assistant/messages/ResultCards";

import { dockActions } from "./helpers";

const { reloadMock, pane } = vi.hoisted(() => ({ reloadMock: vi.fn(), pane: { broken: false } }));

vi.mock("@/lib/utils/reloadPage", () => ({ reloadPage: reloadMock }));
vi.mock("@/hooks/store/ContextHooks", () => ({ useAppDispatch: () => vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/home" }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("@/lib/assistant/conversations", () => ({
  useConversations: () => ({ conversations: [], isLoading: false }),
  updateConversation: vi.fn(),
  refreshConversationLists: vi.fn(),
}));
vi.mock("@/components/assistant/ConversationHistory", () => ({ default: () => null }));
vi.mock("@/components/assistant/NewConversation", () => ({ default: () => <div data-testid="new" /> }));
vi.mock("@/components/assistant/ConversationPane", async () => {
  const { useDockActions } = await import("@/components/assistant/DockActions");
  return {
    default: function Pane() {
      const actions = useDockActions();
      if (pane.broken) throw new Error("A part the pane draws is gone");
      return <button onClick={() => actions.previewDataset("d1")}>preview dataset</button>;
    },
  };
});
// Code a deploy removed: every load of these fails.
vi.mock("@/components/dashboard/content/ContentPreviewDialog", () => {
  throw new Error("Failed to load chunk");
});
vi.mock("@/components/assistant/messages/ItemPreview", () => {
  throw new Error("Failed to load chunk");
});
// What a card loads when shown fetches nothing here.
vi.mock("@/hooks/assistant/useItemDetails", () => ({ useItemDetails: () => ({}) }));
vi.mock("@/lib/api/projects", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useProjectLayers: () => ({ layers: undefined }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  resetAssistantStore();
  pane.broken = false;
  setDockState({ enabled: true, open: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a part of the dock that cannot be shown", () => {
  it("shows a notice with a reload in place of a dialog whose code did not load", async () => {
    setDockState({ conversationId: "c1" });
    render(<AssistantDock variant="docked" />);
    fireEvent.click(screen.getByRole("button", { name: "preview dataset" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("assistant_part_load_failed");
    fireEvent.click(within(dialog).getByRole("button", { name: "assistant_reload_page" }));
    expect(reloadMock).toHaveBeenCalledTimes(1);
    // Closed, the dock stays as it was.
    fireEvent.click(within(dialog).getByRole("button", { name: "close" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "preview dataset" })).toBeTruthy();
  });

  it("keeps a failure in the conversation to the dock, with its header and a reload", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    pane.broken = true;
    setDockState({ conversationId: "c1" });
    render(<AssistantDock variant="docked" />);
    expect(screen.getByRole("alert")).toHaveTextContent("assistant_part_load_failed");
    fireEvent.click(screen.getByRole("button", { name: "assistant_reload_page" }));
    expect(reloadMock).toHaveBeenCalledTimes(1);
    // The header still works: a new conversation shows again.
    fireEvent.click(screen.getByRole("button", { name: "assistant_new_conversation" }));
    expect(screen.getByTestId("new")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a notice with a reload in a card whose preview's code did not load", async () => {
    render(
      <DockActionsContext.Provider value={dockActions()}>
        <ResultCards groups={[{ items: [{ kind: "catalog", id: "cat-1", title: "Radwege" }] }]} />
      </DockActionsContext.Provider>
    );
    fireEvent.click(screen.getByRole("button", { name: "assistant_item_preview" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("assistant_part_load_failed");
    fireEvent.click(screen.getByRole("button", { name: "assistant_reload_page" }));
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });
});
