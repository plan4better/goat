import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearFirstMessage,
  getDockState,
  registerSurface,
  resetAssistantStore,
  setDockState,
  setFirstMessage,
} from "@/lib/assistant/store";
import appStore from "@/lib/store";
import { addPendingFeature, stopEditing } from "@/lib/store/featureEditor/slice";
import { setMapMode } from "@/lib/store/map/slice";
import { markSaved, setNodes } from "@/lib/store/workflow/slice";

import AssistantDock from "@/components/assistant/AssistantDock";

const { pushMock, toastMock, updateMock, dispatchMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  toastMock: { warning: vi.fn(), error: vi.fn() },
  updateMock: vi.fn(async () => ({})),
  dispatchMock: vi.fn(),
}));

vi.mock("@/hooks/store/ContextHooks", () => ({ useAppDispatch: () => dispatchMock }));
const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));
vi.mock("@/lib/api/workflows", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  refreshWorkflowList: refreshMock,
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }), usePathname: () => "/home" }));
vi.mock("react-toastify", () => ({ toast: toastMock }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("@/lib/assistant/conversations", () => ({
  useConversations: () => ({ conversations: [], isLoading: false }),
  updateConversation: updateMock,
  refreshConversationLists: vi.fn(),
}));
vi.mock("@/components/assistant/ConversationHistory", () => ({
  default: () => <div data-testid="history" />,
}));
vi.mock("@/components/assistant/NewConversation", () => ({ default: () => <div data-testid="new" /> }));
vi.mock("@/components/assistant/ConversationPane", async () => {
  const { useDockActions } = await import("@/components/assistant/DockActions");
  return {
    default: function Pane({ onLoaded }: { onLoaded?: (detail: unknown) => void }) {
      const actions = useDockActions();
      return (
        <>
          <button
            onClick={() => void actions.openInProject("p2", { bindConversationId: "c1", partId: "m1:1" })}>
            review
          </button>
          <button onClick={() => actions.openInProjectMode("p1", "workflows", "w9")}>open workflow</button>
          <button onClick={() => void actions.openCreatedWorkflow("p1", "w9")}>created workflow</button>
          <button onClick={() => actions.previewDataset("d1")}>preview dataset</button>
          <button onClick={() => actions.previewBundle("b1")}>preview bundle</button>
          <button
            onClick={() =>
              onLoaded?.({
                conversation: { id: "c1", project_id: null, origin_surface: "catalog", title: null },
                messages: [
                  {
                    id: "u1",
                    role: "user",
                    parts: [
                      { type: "data-context", data: { surface: "catalog" } },
                      { type: "text", text: "Wie viele " },
                      { type: "text", text: "Radwege?" },
                    ],
                  },
                  { id: "a1", role: "assistant", parts: [{ type: "text", text: "Drei." }] },
                ],
                activeRunId: null,
                access: "ok",
                projectName: null,
              })
            }>
            loaded
          </button>
        </>
      );
    },
  };
});
vi.mock("@/components/addLayer/AddLayerDialog", () => ({
  default: (props: { source: string; projectId?: string; initialFile?: File }) => (
    <div data-testid="add-layer" data-source={props.source} data-project={props.projectId ?? ""}>
      {props.initialFile?.name}
    </div>
  ),
}));

vi.mock("@/components/dashboard/content/ContentPreviewDialog", () => ({
  default: (props: { layerId: string; onClose: () => void }) => (
    <button data-testid="dataset-preview" onClick={props.onClose}>
      {props.layerId}
    </button>
  ),
}));
vi.mock("@/components/dashboard/bundle/BundlePreviewDialog", () => ({
  default: (props: { bundleId: string; onClose: () => void }) => (
    <button data-testid="bundle-preview" onClick={props.onClose}>
      {props.bundleId}
    </button>
  ),
}));

const drop = (files: File[]) =>
  fireEvent.drop(document.querySelector("[data-assistant-dock]") as Element, {
    dataTransfer: { types: ["Files"], files },
  });

beforeEach(() => {
  window.sessionStorage.clear();
  resetAssistantStore();
  vi.clearAllMocks();
  setDockState({ enabled: true, open: true });
});

describe("AssistantDock", () => {
  it("opens the upload dialog for one dropped data file, into the page's upload target", async () => {
    registerSurface({
      surface: "project.map",
      project: { id: "p1", name: "Eins" },
      uploadTo: { projectId: "p1", folderId: "f1" },
      getContext: () => ({ surface: "project.map", project_id: "p1" }),
    });
    render(<AssistantDock variant="docked" />);
    drop([new File(["{}"], "netz.geojson")]);
    // Loaded on demand (next/dynamic): it lands a tick after the drop.
    const dialog = await screen.findByTestId("add-layer");
    expect(dialog.getAttribute("data-source")).toBe("upload");
    expect(dialog.getAttribute("data-project")).toBe("p1");
    expect(dialog.textContent).toBe("netz.geojson");
  });

  it("refuses several files and files that are not data", () => {
    render(<AssistantDock variant="docked" />);
    drop([new File(["a"], "a.csv"), new File(["b"], "b.csv")]);
    expect(toastMock.warning).toHaveBeenCalledWith("drop_one_file_only");
    drop([new File(["x"], "plan.pdf")]);
    expect(toastMock.error).toHaveBeenCalledWith("assistant_drop_not_data");
    expect(screen.queryByTestId("add-layer")).toBeNull();
  });

  it("has a resize handle on the docked panel only, not in full screen", () => {
    const { unmount } = render(<AssistantDock variant="docked" />);
    const handle = screen.getByRole("separator", { name: "assistant_resize" });
    expect(handle.closest("[data-assistant-dock]")).not.toBeNull();
    unmount();

    render(<AssistantDock variant="fullscreen" />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("brings the docked content in as it opens, but not where it replaces its loading frame", () => {
    // The content column: the panel's child next to its resize handle.
    const content = () =>
      screen.getByRole("separator", { name: "assistant_resize" }).nextElementSibling as HTMLElement;
    const { unmount } = render(<AssistantDock variant="docked" />);
    expect(getComputedStyle(content()).animation).toMatch(/180ms ease-out/);
    unmount();
    render(<AssistantDock variant="docked" framed />);
    expect(getComputedStyle(content()).animation).toBe("");
  });

  it("starts a new conversation, expands and closes", () => {
    setDockState({ conversationId: "c1" });
    render(<AssistantDock variant="docked" />);
    fireEvent.click(screen.getByRole("button", { name: "assistant_new_conversation" }));
    expect(getDockState().conversationId).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "assistant_expand" }));
    expect(getDockState().expanded).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "close" }));
    expect(getDockState()).toMatchObject({ open: false, expanded: false });
  });

  it("binds an unbound conversation before it opens the project to review a proposal", async () => {
    setDockState({ conversationId: "c1" });
    render(<AssistantDock variant="docked" />);
    fireEvent.click(screen.getByRole("button", { name: "review" }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/map/p2"));
    expect(updateMock).toHaveBeenCalledWith("c1", { project_id: "p2" });
    // The open pane learns of the binding from the store (AssistantDock.bind.test.tsx).
    expect(getDockState().bound).toEqual({ conversationId: "c1", projectId: "p2", projectName: null });
    expect(getDockState().review).toEqual({ conversationId: "c1", partId: "m1:1" });
    // The map view applies in Map mode only.
    expect(dispatchMock).toHaveBeenCalledWith(setMapMode("data"));
  });

  it("titles an untitled conversation by its first message, also when the history does not list it", () => {
    // The history lists the newest 100 only; the loaded conversation knows its own first message.
    setDockState({ conversationId: "c1" });
    render(<AssistantDock variant="docked" />);
    expect(screen.getByRole("button", { name: "assistant_untitled" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "loaded" }));
    expect(screen.getByRole("button", { name: "Wie viele Radwege?" })).toBeTruthy();
  });

  it("titles a conversation just sent by its first message until the server has one", () => {
    // What the start page sent: its chat sends it and forgets it right away.
    setFirstMessage({ conversationId: "c1", text: "Wie viele\nRadwege gibt es?", context: null });
    setDockState({ conversationId: "c1" });
    render(<AssistantDock variant="docked" />);
    expect(screen.getByRole("button", { name: "Wie viele Radwege gibt es?" })).toBeTruthy();
    clearFirstMessage("c1");
    act(() => setDockState({ open: true, review: null }));
    expect(screen.getByRole("button", { name: "Wie viele Radwege gibt es?" })).toBeTruthy();
    // Once loaded, the conversation's own first message.
    fireEvent.click(screen.getByRole("button", { name: "loaded" }));
    expect(screen.getByRole("button", { name: "Wie viele Radwege?" })).toBeTruthy();
    // Another conversation does not take it over.
    act(() => setDockState({ conversationId: "c2" }));
    expect(screen.getByRole("button", { name: "assistant_untitled" })).toBeTruthy();
  });

  it("opens a dataset's and a bundle's preview, loaded when first asked for", async () => {
    setDockState({ conversationId: "c1" });
    render(<AssistantDock variant="docked" />);
    fireEvent.click(screen.getByRole("button", { name: "preview dataset" }));
    const dataset = await screen.findByTestId("dataset-preview");
    expect(dataset.textContent).toBe("d1");
    fireEvent.click(dataset);
    expect(screen.queryByTestId("dataset-preview")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "preview bundle" }));
    expect((await screen.findByTestId("bundle-preview")).textContent).toBe("b1");
  });

  it("marks the assistant as Beta after the title, outside the history button", () => {
    setDockState({ conversationId: "c1" });
    render(<AssistantDock variant="docked" />);
    const title = screen.getByRole("button", { name: "assistant_untitled" });
    const beta = screen.getByText("assistant_beta");
    expect(title.contains(beta)).toBe(false);
    expect(title.compareDocumentPosition(beta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The sparkle mark stands before the title, as decoration.
    expect(title.previousElementSibling?.getAttribute("aria-hidden")).toBe("true");
    expect(title.previousElementSibling?.querySelector("svg")).not.toBeNull();
  });

  it("marks the assistant as Beta full screen, after its name above the history", () => {
    render(<AssistantDock variant="fullscreen" />);
    const name = screen.getByText("assistant_ask_ai");
    const beta = screen.getByText("assistant_beta");
    expect(name.compareDocumentPosition(beta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(name.parentElement).toBe(beta.parentElement);
  });

  it("names the history button by the visible conversation title", () => {
    setDockState({ conversationId: "c1" });
    render(<AssistantDock variant="docked" />);
    const button = screen.getByRole("button", { name: "assistant_untitled" });
    expect(button).toHaveAccessibleDescription("assistant_history");
  });
});

describe("AssistantDock workflows", () => {
  beforeEach(() => {
    registerSurface({
      surface: "project.map",
      project: { id: "p1", name: "Eins" },
      getContext: () => ({ surface: "project.map", project_id: "p1" }),
    });
    appStore.dispatch(markSaved());
    appStore.dispatch(stopEditing());
    setDockState({ conversationId: "c1" });
  });

  it("reads the project's workflow list again before it opens a workflow there", async () => {
    let release: () => void = () => undefined;
    refreshMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    render(<AssistantDock variant="docked" />);
    fireEvent.click(screen.getByRole("button", { name: "open workflow" }));
    expect(refreshMock).toHaveBeenCalledWith("p1");
    await act(async () => undefined);
    expect(pushMock).not.toHaveBeenCalled();
    release();
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/map/p1?mode=workflows&workflow=w9"));
  });

  it("stays where the person went when they left the project while the list was read", async () => {
    let release: () => void = () => undefined;
    refreshMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    render(<AssistantDock variant="docked" />);
    fireEvent.click(screen.getByRole("button", { name: "open workflow" }));
    expect(refreshMock).toHaveBeenCalledWith("p1");
    act(() => {
      registerSurface({
        surface: "project.map",
        project: { id: "p2", name: "Zwei" },
        getContext: () => ({ surface: "project.map", project_id: "p2" }),
      });
    });
    release();
    // Every promise callback has run by the next task.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("reads the list once for a second click while it is read, and again after it opened", async () => {
    let release: () => void = () => undefined;
    refreshMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    render(<AssistantDock variant="docked" />);
    fireEvent.click(screen.getByRole("button", { name: "open workflow" }));
    fireEvent.click(screen.getByRole("button", { name: "open workflow" }));
    expect(refreshMock).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "open workflow" }));
    expect(refreshMock).toHaveBeenCalledTimes(2);
  });

  it("opens a workflow of another project in a new tab, without reading its list", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    try {
      registerSurface({
        surface: "project.map",
        project: { id: "p2", name: "Zwei" },
        getContext: () => ({ surface: "project.map", project_id: "p2" }),
      });
      render(<AssistantDock variant="docked" />);
      fireEvent.click(screen.getByRole("button", { name: "open workflow" }));
      expect(openSpy).toHaveBeenCalledWith("/map/p1?mode=workflows&workflow=w9", "_blank", "noopener");
      expect(refreshMock).not.toHaveBeenCalled();
      expect(pushMock).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });

  it("opens a workflow the assistant created only while the editor holds no unsaved changes", async () => {
    refreshMock.mockResolvedValue([]);
    render(<AssistantDock variant="docked" />);
    appStore.dispatch(setNodes([]));
    fireEvent.click(screen.getByRole("button", { name: "created workflow" }));
    await act(async () => undefined);
    expect(refreshMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();

    appStore.dispatch(markSaved());
    fireEvent.click(screen.getByRole("button", { name: "created workflow" }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/map/p1?mode=workflows&workflow=w9"));
    expect(refreshMock).toHaveBeenCalledWith("p1");
  });

  it("opens a workflow the assistant created only while no feature edits on the map wait to be saved", async () => {
    refreshMock.mockResolvedValue([]);
    render(<AssistantDock variant="docked" />);
    appStore.dispatch(
      addPendingFeature({
        id: "f1",
        drawFeatureId: null,
        geometry: { type: "Point", coordinates: [11.57, 48.14] },
        properties: { name: "Neu" },
        committed: true,
        action: "create",
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "created workflow" }));
    await act(async () => undefined);
    expect(refreshMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();

    appStore.dispatch(stopEditing());
    fireEvent.click(screen.getByRole("button", { name: "created workflow" }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/map/p1?mode=workflows&workflow=w9"));
  });
});
