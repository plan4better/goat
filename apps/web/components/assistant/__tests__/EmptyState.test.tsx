import { ThemeProvider, createTheme } from "@mui/material/styles";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerSurface, resetAssistantStore } from "@/lib/assistant/store";
import type { ConversationSummary, PageContext } from "@/lib/assistant/types";
import { STREET_NETWORK_LAYER_ID } from "@/lib/constants";

import EmptyState from "@/components/assistant/EmptyState";

const { language, privacyUrl, layers, conversations, conversationArgs } = vi.hoisted(() => ({
  language: { value: "en" as "en" | "de" },
  privacyUrl: vi.fn<(lng: string) => string | undefined>(),
  layers: { value: undefined as { name: string; locked?: boolean; layer_id?: string }[] | undefined },
  conversations: { value: [] as ConversationSummary[] },
  conversationArgs: vi.fn(),
}));

// The real `Trans` over the app's texts, so the notice renders as users read it.
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  const { commonI18n } = await import("@/i18n/__tests__/commonI18n");
  const instances = { en: commonI18n("en"), de: commonI18n("de") };
  return {
    ...actual,
    useTranslation: () => {
      const i18n = instances[language.value];
      return { t: i18n.getFixedT(language.value, "common"), i18n };
    },
  };
});
vi.mock("@/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/constants")>()),
  privacyPolicyUrl: privacyUrl,
}));
vi.mock("@/lib/api/projects", () => ({ useProjectLayers: () => ({ layers: layers.value }) }));
vi.mock("@/lib/assistant/conversations", () => ({
  useConversations: (args: unknown) => {
    conversationArgs(args);
    return { conversations: conversations.value };
  },
}));

const NOTICE_EN =
  "You are writing with an AI assistant. Your messages and the data it reads are sent to the AI model " +
  "your organization uses.";
const NOTICE_DE =
  "Sie schreiben mit einem KI-Assistenten. Ihre Nachrichten und die Daten, die er liest, werden an das " +
  "KI-Modell übermittelt, das Ihre Organisation nutzt.";

const NONE_STARTERS = [
  "Which of my projects use cycling data?",
  "Which datasets cover…",
  "Which datasets are there about population?",
  "What can the assistant do?",
];

const MAP = (extra: Partial<Extract<PageContext, { surface: "project.map" }>> = {}): PageContext => ({
  surface: "project.map",
  project_id: "p1",
  ...extra,
});

/** A project page; its editors may add to it (`uploadTo`), a viewer may not. */
function onProject(surface: "project.map" | "project.workflows" = "project.map", { editor = true } = {}) {
  registerSurface({
    surface,
    project: { id: "p1", name: "Radnetz" },
    getContext: () => ({ surface, project_id: "p1" }),
    uploadTo: editor ? { projectId: "p1" } : undefined,
  });
}

const WALK = "How many residents can walk in 10 minutes to…";
const WORKFLOW = "Build a workflow that…";

const renderEmpty = (props: Partial<ComponentProps<typeof EmptyState>> = {}) => {
  const handlers = { onPick: vi.fn(), onDraft: vi.fn() };
  render(<EmptyState context={null} {...handlers} {...props} />);
  return handlers;
};

const conversation = (n: number, over: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: `c${n}`,
  title: `Talk ${n}`,
  origin_surface: "catalog",
  project_id: null,
  project_name: null,
  project_access: null,
  first_message: null,
  running: false,
  created_at: "2026-10-30T10:00:00Z",
  updated_at: new Date(Date.now() - n * 3_600_000).toISOString(),
  ...over,
});

beforeEach(() => {
  resetAssistantStore();
  language.value = "en";
  privacyUrl.mockReset();
  layers.value = undefined;
  conversations.value = [];
  conversationArgs.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("EmptyState AI notice", () => {
  it("says it is an AI and links the privacy policy in a new tab", () => {
    privacyUrl.mockReturnValue("https://www.example.org/en/about-us/privacy");
    // The app's theme underlines links on hover only (packages/js/ui/theme/overrides/link.ts).
    const theme = createTheme({ components: { MuiLink: { defaultProps: { underline: "hover" } } } });
    render(
      <ThemeProvider theme={theme}>
        <EmptyState context={null} onPick={vi.fn()} onDraft={vi.fn()} />
      </ThemeProvider>
    );
    const link = screen.getByRole("link", { name: "privacy policy" });
    expect(link.getAttribute("href")).toBe("https://www.example.org/en/about-us/privacy");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.closest("p")?.textContent).toBe(`${NOTICE_EN} Details are in the privacy policy.`);
    expect(privacyUrl).toHaveBeenCalledWith("en");
    // Recognisable as a link in the muted notice: underlined, in the notice's colour.
    expect(link.className).toContain("MuiLink-underlineAlways");
  });

  it("leaves the privacy sentence out without a privacy policy to link", () => {
    privacyUrl.mockReturnValue(undefined);
    renderEmpty();
    expect(screen.getByText(NOTICE_EN)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText(/privacy policy/)).toBeNull();
  });

  it("links the German privacy policy in German", () => {
    language.value = "de";
    privacyUrl.mockReturnValue("https://www.example.org/de/about-us/datenschutz");
    renderEmpty({ big: true });
    const link = screen.getByRole("link", { name: "Datenschutzerklärung" });
    expect(link.getAttribute("href")).toBe("https://www.example.org/de/about-us/datenschutz");
    expect(link.closest("p")?.textContent).toBe(
      `${NOTICE_DE} Details finden Sie in der Datenschutzerklärung.`
    );
    expect(privacyUrl).toHaveBeenCalledWith("de");
  });

  it("comes after the starters", () => {
    privacyUrl.mockReturnValue(undefined);
    renderEmpty();
    const starter = screen.getByRole("button", { name: "Which of my projects use cycling data?" });
    const notice = screen.getByText(NOTICE_EN);
    expect(starter.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("EmptyState starters", () => {
  it("offers the suggestions of a page without context under their label", () => {
    renderEmpty();
    expect(screen.getByRole("heading", { name: "What would you like to know?" })).toBeTruthy();
    expect(screen.getByText("Suggestions")).toBeTruthy();
    for (const text of NONE_STARTERS) expect(screen.getByRole("button", { name: text })).toBeTruthy();
  });

  it("sends a question at once", () => {
    const { onPick, onDraft } = renderEmpty();
    fireEvent.click(screen.getByRole("button", { name: "What can the assistant do?" }));
    expect(onPick).toHaveBeenCalledWith("What can the assistant do?");
    expect(onDraft).not.toHaveBeenCalled();
  });

  it("puts a sentence start into the composer instead of sending it", () => {
    const { onPick, onDraft } = renderEmpty();
    fireEvent.click(screen.getByRole("button", { name: "Which datasets cover…" }));
    expect(onDraft).toHaveBeenCalledWith("Which datasets cover ");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("offers nothing a project without layers, selection or map view lacks", () => {
    onProject();
    layers.value = [];
    for (const value of [0, 0.2, 0.4, 0.6, 0.8, 0.99]) {
      vi.spyOn(Math, "random").mockReturnValue(value);
      const { unmount } = render(<EmptyState context={MAP()} onPick={vi.fn()} onDraft={vi.fn()} />);
      expect(screen.getByRole("heading", { name: "Ask about this project" })).toBeTruthy();
      expect(screen.getAllByRole("button", { name: /\?|…$/ }).length).toBe(4);
      expect(screen.queryByText("Which layers does this project contain?")).toBeNull();
      expect(screen.queryByText("What does the selected layer contain?")).toBeNull();
      expect(screen.queryByText("Which catalog data is there for the current map view?")).toBeNull();
      expect(screen.queryByText(/^Which fields does/)).toBeNull();
      unmount();
    }
  });

  it("offers a viewer of the project no starter that creates a workflow", () => {
    for (const surface of ["project.map", "project.workflows"] as const) {
      onProject(surface, { editor: false });
      layers.value = [{ name: "Radwege" }];
      for (const value of [0, 0.2, 0.4, 0.6, 0.8, 0.99]) {
        vi.spyOn(Math, "random").mockReturnValue(value);
        const { unmount } = render(<EmptyState context={MAP()} onPick={vi.fn()} onDraft={vi.fn()} />);
        expect(screen.getAllByRole("button").length, `${surface} ${value}`).toBeGreaterThan(0);
        expect(screen.queryByRole("button", { name: WALK }), `${surface} ${value}`).toBeNull();
        expect(screen.queryByRole("button", { name: WORKFLOW }), `${surface} ${value}`).toBeNull();
        unmount();
      }
    }
  });

  it("offers an editor the workflow starters, also when the edit right arrives after the start page", () => {
    onProject("project.map", { editor: false });
    layers.value = [];
    // Always the first: an empty project leaves the sentence starts and the help question.
    vi.spyOn(Math, "random").mockReturnValue(0);
    render(<EmptyState context={MAP()} onPick={vi.fn()} onDraft={vi.fn()} />);
    expect(screen.queryByRole("button", { name: WALK })).toBeNull();
    // The project's role is known: the page registers again, now with somewhere to add to.
    act(() => onProject("project.map"));
    expect(screen.getByRole("button", { name: WALK })).toBeTruthy();
    expect(screen.getByRole("button", { name: WORKFLOW })).toBeTruthy();
  });

  it("offers the selected layer, the map view and a layer's fields where the page has them", () => {
    onProject();
    layers.value = [{ name: "Radwege" }];
    const seen = new Set<string>();
    for (const value of [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 0.99]) {
      vi.spyOn(Math, "random").mockReturnValue(value);
      const { unmount } = render(
        <EmptyState
          context={MAP({ selected_layer_project_id: 4, viewport: { center: [9, 53], zoom: 12 } })}
          onPick={vi.fn()}
          onDraft={vi.fn()}
        />
      );
      for (const button of screen.getAllByRole("button")) seen.add(button.textContent ?? "");
      unmount();
    }
    expect([...seen]).toEqual(
      expect.arrayContaining([
        "What does the selected layer contain?",
        "Which catalog data is there for the current map view?",
        "Which fields does “Radwege” have?",
      ])
    );
  });

  it("keeps the starters it picked while the start page shows", () => {
    onProject();
    layers.value = [{ name: "A" }, { name: "B" }];
    const random = vi.spyOn(Math, "random").mockReturnValue(0.1);
    const view = render(<EmptyState context={MAP()} onPick={vi.fn()} onDraft={vi.fn()} />);
    const before = screen.getAllByRole("button").map((button) => button.textContent);
    random.mockReturnValue(0.9);
    view.rerender(<EmptyState context={MAP()} onPick={vi.fn()} onDraft={vi.fn()} />);
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(before);
  });

  it("drops a starter whose context went away and keeps the others as drawn", () => {
    onProject();
    layers.value = [{ name: "Radwege" }];
    // Always the first: the draw takes the layer's fields, the selected layer, the map view and the walk.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const full = MAP({ selected_layer_project_id: 4, viewport: { center: [9, 53], zoom: 12 } });
    const view = render(<EmptyState context={full} onPick={vi.fn()} onDraft={vi.fn()} />);
    const texts = () => screen.getAllByRole("button").map((button) => button.textContent);
    expect(texts()).toEqual([
      "Which fields does “Radwege” have?",
      "What does the selected layer contain?",
      "Which catalog data is there for the current map view?",
      "How many residents can walk in 10 minutes to…",
    ]);
    // The layer deselected and the map view chip removed.
    view.rerender(<EmptyState context={MAP()} onPick={vi.fn()} onDraft={vi.fn()} />);
    expect(texts()).toEqual([
      "Which fields does “Radwege” have?",
      "How many residents can walk in 10 minutes to…",
    ]);
    // Selected again: it comes back, still the one drawn.
    view.rerender(<EmptyState context={full} onPick={vi.fn()} onDraft={vi.fn()} />);
    expect(texts()).toHaveLength(4);
  });

  it("shows the drawn starters in the language the user switches to", () => {
    const view = render(<EmptyState context={null} onPick={vi.fn()} onDraft={vi.fn()} />);
    for (const text of NONE_STARTERS) expect(screen.getByRole("button", { name: text })).toBeTruthy();
    language.value = "de";
    view.rerender(<EmptyState context={null} onPick={vi.fn()} onDraft={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Welche meiner Projekte nutzen Radverkehrsdaten?" })
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Wobei kann der Assistent helfen?" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "What can the assistant do?" })).toBeNull();
  });

  it("never names a layer the user cannot read, or a system layer", () => {
    onProject();
    layers.value = [
      { name: "Gesperrt", locked: true },
      { name: "Straßennetz", layer_id: STREET_NETWORK_LAYER_ID },
      { name: "Radwege" },
    ];
    const seen = new Set<string>();
    for (const value of [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 0.99]) {
      vi.spyOn(Math, "random").mockReturnValue(value);
      const { unmount } = render(<EmptyState context={MAP()} onPick={vi.fn()} onDraft={vi.fn()} />);
      for (const button of screen.getAllByRole("button")) seen.add(button.textContent ?? "");
      unmount();
    }
    expect([...seen].filter((text) => text.startsWith("Which fields"))).toEqual([
      "Which fields does “Radwege” have?",
    ]);
  });

  it("offers no layer starter where every layer is locked or a system layer", () => {
    onProject();
    layers.value = [
      { name: "Gesperrt", locked: true },
      { name: "Straßennetz", layer_id: STREET_NETWORK_LAYER_ID },
    ];
    for (const value of [0, 0.3, 0.6, 0.99]) {
      vi.spyOn(Math, "random").mockReturnValue(value);
      const { unmount } = render(<EmptyState context={MAP()} onPick={vi.fn()} onDraft={vi.fn()} />);
      expect(screen.queryByText("Which layers does this project contain?")).toBeNull();
      expect(screen.queryByText(/^Which fields does/)).toBeNull();
      unmount();
    }
  });

  it("lays the starters out in two columns full screen, in one docked", () => {
    const columns = () =>
      getComputedStyle(
        screen.getByRole("button", { name: "What can the assistant do?" }).parentElement as HTMLElement
      ).gridTemplateColumns;
    const { unmount } = render(<EmptyState context={null} onPick={vi.fn()} onDraft={vi.fn()} big />);
    expect(columns()).toBe("repeat(2, minmax(0, 1fr))");
    unmount();
    renderEmpty();
    expect(columns()).toBe("minmax(0, 1fr)");
  });
});

describe("EmptyState recent conversations", () => {
  it("lists the project's latest three in the docked dock, with how long ago", () => {
    onProject();
    conversations.value = [1, 2, 3, 4].map((n) =>
      conversation(n, {
        project_id: "p1",
        project_name: "Radnetz",
        project_access: true,
        origin_surface: "project.map",
      })
    );
    renderEmpty({ context: MAP() });
    expect(conversationArgs).toHaveBeenCalledWith({ projectId: "p1" });
    expect(screen.getByText("Recent in this project")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Talk 1/ }).textContent).toBe("Talk 11 hour ago");
    expect(screen.getByRole("button", { name: /Talk 3/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Talk 4/ })).toBeNull();
  });

  it("lists all conversations with where they started elsewhere", () => {
    conversations.value = [conversation(1)];
    renderEmpty();
    expect(conversationArgs).toHaveBeenCalledWith({ projectId: null });
    expect(screen.getByText("Recent")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Talk 1/ }).textContent).toBe("Talk 1Catalog");
  });

  it("shows nothing without conversations, and none full screen (the sidebar lists them)", () => {
    renderEmpty();
    expect(screen.queryByText("Recent")).toBeNull();
    conversations.value = [conversation(1)];
    renderEmpty({ big: true });
    expect(screen.queryByText("Recent")).toBeNull();
    expect(screen.queryByRole("button", { name: /Talk 1/ })).toBeNull();
  });
});
