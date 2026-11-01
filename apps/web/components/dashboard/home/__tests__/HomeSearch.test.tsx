import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { AssistantRequestError } from "@/lib/assistant/errors";
import { getDockState, peekFirstMessage, resetAssistantStore, setDockState } from "@/lib/assistant/store";

import HomeSearch from "@/components/dashboard/home/HomeSearch";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { q?: string }) => (key === "search_quoted_query" ? `“${options?.q}”` : key),
  }),
}));

const { createMock, toastMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  toastMock: { error: vi.fn() },
}));
vi.mock("@/lib/assistant/transport", () => ({ createConversation: createMock }));
vi.mock("@/lib/assistant/conversations", () => ({ refreshConversationLists: vi.fn() }));
vi.mock("react-toastify", () => ({ toast: toastMock }));

const goMock = vi.fn();
const closePreviewMock = vi.fn();
const useHomeSearchMock = vi.fn();
vi.mock("@/components/dashboard/content/ContentPreviewDialog", () => ({
  default: ({ layerId, onClose }: { layerId: string; onClose: () => void }) => (
    <button type="button" data-testid="preview-dialog" onClick={onClose}>
      preview {layerId}
    </button>
  ),
}));
vi.mock("@/hooks/dashboard/home/useHomeSearch", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/dashboard/home/useHomeSearch")>(
    "@/hooks/dashboard/home/useHomeSearch"
  );
  return { ...actual, useHomeSearch: (raw: string) => useHomeSearchMock(raw) };
});

const placeholder = "search_placeholder_short";

describe("HomeSearch", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    resetAssistantStore();
    createMock.mockReset();
    toastMock.error.mockReset();
    goMock.mockReset();
    useHomeSearchMock.mockReset();
    useHomeSearchMock.mockReturnValue({
      rows: [
        { kind: "head", label: "projects" },
        { kind: "item", id: "p1", icon: ICON_NAME.MAP, label: "Bus network", meta: "project", go: goMock },
        {
          kind: "item",
          id: "l1",
          icon: ICON_NAME.MAP,
          label: "Bus stops",
          meta: "feature_layer",
          go: goMock,
        },
      ],
      isLoading: false,
    });
  });

  it("focuses the input on Ctrl+K from anywhere on the page", () => {
    render(<HomeSearch />);

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(document.activeElement).toBe(screen.getByPlaceholderText(placeholder));
  });

  it("ArrowDown selects the first item row, Enter runs its go", () => {
    render(<HomeSearch />);
    const input = screen.getByPlaceholderText(placeholder);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "bus" } });

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(goMock).toHaveBeenCalledTimes(1);
  });

  it("ArrowDown wraps from the last item row back to the first", () => {
    render(<HomeSearch />);
    const input = screen.getByPlaceholderText(placeholder);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "bus" } });

    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(goMock).toHaveBeenCalledTimes(1);
  });

  it("Escape clears the query and blurs the input", () => {
    render(<HomeSearch />);
    const input = screen.getByPlaceholderText(placeholder) as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "bus" } });

    fireEvent.keyDown(input, { key: "Escape" });

    expect(input.value).toBe("");
    expect(document.activeElement).not.toBe(input);
  });

  it("clicking a result row runs its go", () => {
    render(<HomeSearch />);
    const input = screen.getByPlaceholderText(placeholder);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "bus" } });

    // The label is split around the highlight mark, so the row is the target.
    fireEvent.click(screen.getAllByRole("option")[0]);

    expect(goMock).toHaveBeenCalledTimes(1);
  });

  it("renders one group header per section and no tips while a query is typed", () => {
    useHomeSearchMock.mockReturnValue({
      rows: [
        { kind: "head", label: "projects" },
        { kind: "item", id: "p1", icon: ICON_NAME.MAP, label: "Bus network", meta: "project", go: goMock },
        { kind: "head", label: "catalog" },
        { kind: "item", id: "c1", icon: ICON_NAME.GLOBE, label: "Bus routes", meta: "", go: goMock },
      ],
      isLoading: false,
    });
    render(<HomeSearch />);
    const input = screen.getByPlaceholderText(placeholder);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "bus" } });

    expect(screen.getByText("projects")).toBeInTheDocument();
    expect(screen.getByText("catalog")).toBeInTheDocument();
    expect(screen.queryByText("search_tips")).not.toBeInTheDocument();
    expect(screen.queryByText("project:")).not.toBeInTheDocument();
  });

  it("never shows a group header the hook left empty", () => {
    useHomeSearchMock.mockReturnValue({ rows: [], isLoading: false });
    render(<HomeSearch />);
    fireEvent.focus(screen.getByPlaceholderText(placeholder));

    expect(screen.queryByText("recent")).not.toBeInTheDocument();
  });

  it("lists the scope prefixes as tips for the empty query", () => {
    useHomeSearchMock.mockReturnValue({ rows: [], isLoading: false });
    render(<HomeSearch />);
    fireEvent.focus(screen.getByPlaceholderText(placeholder));

    expect(screen.getByText("search_tips")).toBeInTheDocument();
    expect(screen.getByText("project:")).toBeInTheDocument();
    expect(screen.getByText("dataset:")).toBeInTheDocument();
    expect(screen.getByText("catalog:")).toBeInTheDocument();
    expect(screen.getByText("— search_scope_projects")).toBeInTheDocument();
  });

  it("clicking a tip types its prefix into the field instead of navigating", () => {
    useHomeSearchMock.mockReturnValue({ rows: [], isLoading: false });
    render(<HomeSearch />);
    const input = screen.getByPlaceholderText(placeholder) as HTMLInputElement;
    fireEvent.focus(input);

    fireEvent.click(screen.getByText("catalog:"));

    expect(input.value).toBe("catalog: ");
    expect(document.activeElement).toBe(input);
    expect(goMock).not.toHaveBeenCalled();
  });

  it("Enter on a tip types its prefix too", () => {
    useHomeSearchMock.mockReturnValue({ rows: [], isLoading: false });
    render(<HomeSearch />);
    const input = screen.getByPlaceholderText(placeholder) as HTMLInputElement;
    fireEvent.focus(input);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(input.value).toBe("dataset: ");
  });

  describe("with only a scope prefix in the field", () => {
    /** The rows the hook answers a bare `catalog:` with. */
    const scopedRows = [
      { kind: "head", label: "catalog" },
      { kind: "note", label: "search_type_to_search_catalog" },
    ];

    /** What the tip row for a prefix reports as its selected state. */
    const tipSelected = (prefix: string) =>
      screen.getByText(prefix).closest('[role="option"]')?.getAttribute("aria-selected");

    const typePrefix = (prefix: string) => {
      useHomeSearchMock.mockReturnValue({ rows: scopedRows, isLoading: false });
      render(<HomeSearch />);
      const input = screen.getByPlaceholderText(placeholder) as HTMLInputElement;
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: prefix } });
      return input;
    };

    it("shows the scoped group header and its caption instead of an empty list", () => {
      typePrefix("catalog:");

      expect(screen.getByText("catalog")).toBeInTheDocument();
      expect(screen.getByText("search_type_to_search_catalog")).toBeInTheDocument();
      expect(screen.queryByText("no_results_for")).not.toBeInTheDocument();
    });

    it("leaves the caption unselectable", () => {
      typePrefix("catalog:");

      expect(screen.getByText("search_type_to_search_catalog").closest('[role="option"]')).toBeNull();
      // The three tips are the only rows Enter can land on.
      expect(screen.getAllByRole("option")).toHaveLength(3);
    });

    it("keeps the tips up with the active prefix's row marked and the others normal", () => {
      typePrefix("catalog:");

      expect(screen.getByText("search_tips")).toBeInTheDocument();
      expect(tipSelected("catalog:")).toBe("true");
      expect(tipSelected("project:")).toBe("false");
      expect(tipSelected("dataset:")).toBe("false");
    });

    it("marks the tip that matches the prefix, whichever it is", () => {
      typePrefix("project: ");

      expect(tipSelected("project:")).toBe("true");
      expect(tipSelected("catalog:")).toBe("false");
    });

    it("picking another tip replaces the prefix in the field", () => {
      const input = typePrefix("catalog:");

      fireEvent.click(screen.getByText("project:"));

      expect(input.value).toBe("project: ");
      expect(document.activeElement).toBe(input);
    });

    it("keeps the keyboard footer", () => {
      typePrefix("catalog:");

      expect(screen.getByText("kbd_to_navigate")).toBeInTheDocument();
    });

    it("still shows the no-results row once a scoped query has actually run", () => {
      useHomeSearchMock.mockReturnValue({ rows: [], isLoading: false });
      render(<HomeSearch />);
      const input = screen.getByPlaceholderText(placeholder);
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "catalog: bus" } });

      expect(screen.getByText("no_results_for")).toBeInTheDocument();
      expect(screen.queryByText("search_tips")).not.toBeInTheDocument();
    });
  });

  it("marks the matched part of a result label", () => {
    render(<HomeSearch />);
    const input = screen.getByPlaceholderText(placeholder);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "bus" } });

    const marks = Array.from(document.querySelectorAll("mark")).map((node) => node.textContent);
    expect(marks).toContain("Bus");
  });

  it("does not mark anything for the scope prefix itself", () => {
    render(<HomeSearch />);
    const input = screen.getByPlaceholderText(placeholder);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "project: bus" } });

    const marks = Array.from(document.querySelectorAll("mark")).map((node) => node.textContent);
    expect(marks).toEqual(["Bus", "Bus"]);
  });

  it("shows the keyboard hint footer whenever the dropdown is open", () => {
    render(<HomeSearch />);
    fireEvent.focus(screen.getByPlaceholderText(placeholder));

    expect(screen.getByText("kbd_to_navigate")).toBeInTheDocument();
    expect(screen.getByText("kbd_to_select")).toBeInTheDocument();
    expect(screen.getByText("kbd_to_close")).toBeInTheDocument();
  });

  it("passes the raw query through untouched — the hook does the parsing", () => {
    render(<HomeSearch />);
    const input = screen.getByPlaceholderText(placeholder);

    fireEvent.change(input, { target: { value: "project: bus" } });

    expect(useHomeSearchMock).toHaveBeenLastCalledWith("project: bus");
  });

  it("shows the shortcut hint with no query and swaps it for a clear button once typing", () => {
    const { container } = render(<HomeSearch />);
    const input = screen.getByPlaceholderText(placeholder);

    // The label itself is per-platform (ShortcutHint); what matters here is
    // that a key badge is shown, and only while the field is empty.
    expect(container.querySelector("kbd")).not.toBeNull();

    fireEvent.change(input, { target: { value: "bus" } });

    expect(container.querySelector("kbd")).toBeNull();
    expect(screen.getByRole("button", { name: "clear" })).toBeInTheDocument();
  });

  it("opens the layer preview the hook asked for and closes it through the hook", async () => {
    useHomeSearchMock.mockReturnValue({
      rows: [],
      isLoading: false,
      previewLayerId: "l1",
      closePreview: closePreviewMock,
    });
    render(<HomeSearch />);

    // The dialog is a lazy `next/dynamic` chunk, so it lands a tick later.
    fireEvent.click(await screen.findByTestId("preview-dialog"));

    expect(screen.getByText("preview l1")).toBeInTheDocument();
    expect(closePreviewMock).toHaveBeenCalled();
  });

  it("renders no preview while the hook has no layer to show", () => {
    useHomeSearchMock.mockReturnValue({
      rows: [],
      isLoading: false,
      previewLayerId: null,
      closePreview: vi.fn(),
    });
    render(<HomeSearch />);

    expect(screen.queryByTestId("preview-dialog")).not.toBeInTheDocument();
  });
  describe("Ask AI", () => {
    const busRows = [
      { kind: "head", label: "projects" },
      { kind: "item", id: "p1", icon: ICON_NAME.MAP, label: "Bus network", meta: "project", go: goMock },
    ];

    /** The assistant is available: AssistantRoot sets this from the URL, the status and the kill switch. */
    const enableAssistant = () => setDockState({ enabled: true });

    const typeQuery = (value: string) => {
      render(<HomeSearch />);
      const input = screen.getByPlaceholderText(placeholder) as HTMLInputElement;
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value } });
      return input;
    };

    const askRow = () => screen.queryByText("“bus stops”")?.closest('[role="option"]') ?? null;

    it("is not offered while the assistant is unavailable", () => {
      useHomeSearchMock.mockReturnValue({ rows: busRows, isLoading: false });
      const input = typeQuery("ask: bus");

      expect(screen.queryByText("assistant_ask_ai")).toBeNull();
      expect(screen.queryByText("kbd_to_ask_ai")).toBeNull();
      // `ask:` is plain text then: the hook searches it like any query.
      expect(useHomeSearchMock).toHaveBeenLastCalledWith("ask: bus");
      fireEvent.keyDown(input, { key: "Tab" });
      expect(createMock).not.toHaveBeenCalled();
    });

    it("adds an Ask AI group with the quoted query after the results", () => {
      enableAssistant();
      useHomeSearchMock.mockReturnValue({ rows: busRows, isLoading: false });
      typeQuery("bus stops");

      const options = screen.getAllByRole("option");
      expect(options).toHaveLength(2);
      expect(options[1]).toBe(askRow());
      expect(options[1].textContent).toContain("assistant_ask_ai");
      // The results come first and stay the default row.
      expect(options[0].getAttribute("aria-selected")).toBe("true");
      expect(screen.getByText("kbd_to_ask_ai")).toBeTruthy();
    });

    it("scrolls the row the arrow keys reach into view, Ask AI below the results too", () => {
      enableAssistant();
      useHomeSearchMock.mockReturnValue({ rows: busRows, isLoading: false });
      const scrolled: Element[] = [];
      const scrollIntoView = vi.fn(function (this: Element) {
        scrolled.push(this);
      });
      const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
      Object.defineProperty(Element.prototype, "scrollIntoView", {
        configurable: true,
        value: scrollIntoView,
      });
      try {
        const input = typeQuery("bus stops");

        fireEvent.keyDown(input, { key: "ArrowUp" });

        expect(scrolled).toEqual([askRow()]);
        expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
      } finally {
        if (original) Object.defineProperty(Element.prototype, "scrollIntoView", original);
        else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      }
    });

    it("lists ask: among the search tips", () => {
      enableAssistant();
      useHomeSearchMock.mockReturnValue({ rows: [], isLoading: false });
      render(<HomeSearch />);
      fireEvent.focus(screen.getByPlaceholderText(placeholder));

      expect(screen.getByText("ask:")).toBeTruthy();
      expect(screen.getByText("— assistant_ask_ai")).toBeTruthy();
      expect(screen.getByText("kbd_to_ask_ai")).toBeTruthy();
      // No query, nothing to ask yet.
      expect(screen.getAllByRole("option")).toHaveLength(4);
    });

    it("with ask: shows only the Ask AI row and asks the stores nothing", () => {
      enableAssistant();
      useHomeSearchMock.mockReturnValue({ rows: busRows, isLoading: false });
      typeQuery("ask: bus stops");

      expect(useHomeSearchMock).toHaveBeenLastCalledWith("");
      expect(screen.queryByText("Bus network")).toBeNull();
      expect(screen.getAllByRole("option")).toEqual([askRow()]);
    });

    it("with a bare ask: keeps the tips up, the ask tip marked", () => {
      enableAssistant();
      useHomeSearchMock.mockReturnValue({ rows: [], isLoading: false });
      typeQuery("ask:");

      expect(screen.getByText("search_type_to_ask_ai")).toBeTruthy();
      const tip = screen.getByText("ask:").closest('[role="option"]');
      expect(tip?.getAttribute("aria-selected")).toBe("true");
      expect(screen.getByText("project:").closest('[role="option"]')?.getAttribute("aria-selected")).toBe(
        "false"
      );
    });

    it("keeps the no-results line and offers Ask AI below it", () => {
      enableAssistant();
      useHomeSearchMock.mockReturnValue({ rows: [], isLoading: false });
      typeQuery("bus stops");

      expect(screen.getByText("no_results_for")).toBeTruthy();
      expect(screen.getAllByRole("option")).toEqual([askRow()]);
    });

    it("Tab opens the dock on a new conversation that sends the query first", async () => {
      enableAssistant();
      createMock.mockResolvedValue({ id: "c7", project_id: null, origin_surface: "home", title: null });
      useHomeSearchMock.mockReturnValue({ rows: busRows, isLoading: false });
      const input = typeQuery("  bus stops ");

      const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      input.dispatchEvent(tab);

      expect(tab.defaultPrevented).toBe(true);
      expect(createMock).toHaveBeenCalledWith("home");
      await waitFor(() => expect(getDockState()).toMatchObject({ open: true, conversationId: "c7" }));
      expect(peekFirstMessage("c7")).toEqual({ conversationId: "c7", text: "bus stops", context: null });
      expect(goMock).not.toHaveBeenCalled();
      // The palette closes with an empty field.
      expect(input.value).toBe("");
      expect(document.activeElement).not.toBe(input);
    });

    it("Shift+Tab leaves the field instead of asking", () => {
      enableAssistant();
      useHomeSearchMock.mockReturnValue({ rows: busRows, isLoading: false });
      const input = typeQuery("bus");

      fireEvent.keyDown(input, { key: "Tab", shiftKey: true });

      expect(createMock).not.toHaveBeenCalled();
    });

    it("Enter and a click on the row ask too", async () => {
      enableAssistant();
      createMock.mockResolvedValue({ id: "c8", project_id: null, origin_surface: "home", title: null });
      useHomeSearchMock.mockReturnValue({ rows: [], isLoading: false });
      const input = typeQuery("ask: bus stops");

      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(getDockState().conversationId).toBe("c8"));
      expect(peekFirstMessage("c8")?.text).toBe("bus stops");

      createMock.mockResolvedValue({ id: "c9", project_id: null, origin_surface: "home", title: null });
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "bus stops" } });
      fireEvent.click(askRow() as Element);
      await waitFor(() => expect(getDockState().conversationId).toBe("c9"));
      expect(createMock).toHaveBeenCalledTimes(2);
    });

    it("reports a conversation that could not be created, and opens nothing", async () => {
      enableAssistant();
      createMock.mockRejectedValue(new AssistantRequestError(503, "assistant_unavailable"));
      useHomeSearchMock.mockReturnValue({ rows: [], isLoading: false });
      const input = typeQuery("bus stops");

      fireEvent.keyDown(input, { key: "Tab" });

      await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));
      expect(getDockState().open).toBe(false);
    });
  });
});
