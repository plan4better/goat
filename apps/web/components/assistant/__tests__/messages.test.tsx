import { createTheme } from "@mui/material/styles";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DynamicToolUIPart } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { fullTime, resetArrivals } from "@/lib/assistant/messageTimes";
import { registerSurface, resetAssistantStore } from "@/lib/assistant/store";
import type { AssistantMessage } from "@/lib/assistant/types";

import { DockActionsContext } from "@/components/assistant/DockActions";
import { dockActions } from "@/components/assistant/__tests__/helpers";
import AnswerDetails from "@/components/assistant/messages/AnswerDetails";
import CaveatNote from "@/components/assistant/messages/CaveatNote";
import MessageList from "@/components/assistant/messages/MessageList";
import RunStatusNote from "@/components/assistant/messages/RunStatusNote";
import SafeMarkdown, { safeHref } from "@/components/assistant/messages/SafeMarkdown";
import StepList from "@/components/assistant/messages/StepList";

const { language } = vi.hoisted(() => ({ language: { value: "en" } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: language.value } }),
}));

// What a card loads when shown (thumbnail, owner, date) and its preview fetch nothing here.
const { itemDetails } = vi.hoisted(() => ({ itemDetails: { value: {} as Record<string, unknown> } }));
vi.mock("@/hooks/assistant/useItemDetails", () => ({ useItemDetails: () => itemDetails.value }));
vi.mock("@/components/assistant/messages/ItemPreview", () => ({
  default: ({ item }: { item: { title: string } }) => <div data-testid="item-preview">{item.title}</div>,
}));
/** The open project's layers: dataset "d-in" is shown as layer 77. */
vi.mock("@/lib/api/projects", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useProjectLayers: (projectId?: string) => ({
    layers: projectId ? [{ id: 77, layer_id: "d-in" }] : undefined,
  }),
}));

const actions = dockActions();

/** The newest answer, still running, with these parts. */
const renderRunning = (parts: AssistantMessage["parts"]) =>
  render(
    <DockActionsContext.Provider value={actions}>
      <MessageList
        messages={[{ id: "r", role: "assistant", parts }]}
        busy
        conversationId="c1"
        conversationProjectId={null}
        projectName={null}
        readOnly={false}
      />
    </DockActionsContext.Provider>
  );

beforeEach(() => {
  window.sessionStorage.clear();
  resetAssistantStore();
  resetArrivals();
});

const search: DynamicToolUIPart = {
  type: "dynamic-tool",
  toolName: "catalog_search",
  toolCallId: "c1",
  state: "output-available",
  input: { q: "rad" },
  output: {
    numberMatched: 1,
    results: [{ id: "ds-1", title: "Radverkehrsnetz", type: "feature", publisher: "Berlin" }],
  },
};

/** The datasets the answer recommends: only these become cards. */
const shown: DynamicToolUIPart = {
  type: "dynamic-tool",
  toolName: "catalog_show_records",
  toolCallId: "s1",
  state: "output-available",
  input: { groups: [{ records: [{ id: "ds-1" }] }] },
  output: {
    groups: [
      {
        title: "Radverkehr",
        records: [
          {
            id: "ds-1",
            title: "Radverkehrsnetz",
            type: "feature",
            publisher: "Berlin",
            note: "Das Radnetz der Stadt",
          },
        ],
      },
    ],
    not_found: [],
  },
};

describe("assistant messages", () => {
  it("renders Markdown without images, raw HTML or unsafe links", () => {
    const { container } = render(
      <SafeMarkdown>
        {
          "Text ![tracker](https://evil.example/p.png) [docs](https://goat.example) [bad](javascript:alert(1)) <b>raw</b>"
        }
      </SafeMarkdown>
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    const docs = screen.getByRole("link", { name: "docs" });
    expect(docs.getAttribute("href")).toBe("https://goat.example");
    expect(docs.getAttribute("target")).toBe("_blank");
    expect(docs.getAttribute("rel")).toContain("noopener");
    expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
    expect(screen.getByText(/bad/)).toBeTruthy();
    expect(safeHref("/catalog/x")).toBe("/catalog/x");
    expect(safeHref("//evil.example")).toBeUndefined();
    expect(safeHref("/\\evil.example")).toBeUndefined();
    expect(safeHref("data:text/html,x")).toBeUndefined();
  });

  it("renders tables, strikethrough and bare links as GitHub does", () => {
    const { container } = render(
      <SafeMarkdown>
        {[
          "| Betriebstyp | Anzahl |",
          "|---|---:|",
          "| Fachgeschäft | 860 |",
          "| Leerstand | 218 |",
          "",
          "~~old~~ see https://goat.example/docs",
        ].join("\n")}
      </SafeMarkdown>
    );
    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    expect([...container.querySelectorAll("th")].map((th) => th.textContent)).toEqual([
      "Betriebstyp",
      "Anzahl",
    ]);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(container.querySelector("tbody td:last-child")?.getAttribute("style")).toContain("right");
    // A wide table scrolls inside the answer.
    expect(getComputedStyle(table!.parentElement!).overflowX).toBe("auto");
    expect(container.querySelector("del")?.textContent).toBe("old");
    expect(screen.getByRole("link", { name: "https://goat.example/docs" }).getAttribute("target")).toBe(
      "_blank"
    );
    expect(container.textContent).not.toContain("|");
  });

  it("right-aligns the numbers of a table in tabular figures, and lets the headers wrap", () => {
    const { container } = render(
      <SafeMarkdown>
        {[
          "| Bezirk | Bushaltestellen | Anteil A an den Haltestellen |",
          "|---|---|---|",
          "| Hamburg-Nord | 1.450 | 9,8 % |",
          "| Altona | 547 | – |",
        ].join("\n")}
      </SafeMarkdown>
    );
    const column = (index: number) =>
      [...container.querySelectorAll(`tr > :nth-child(${index})`)].map((cell) => getComputedStyle(cell));
    for (const style of [...column(2), ...column(3)]) {
      expect(style.textAlign).toBe("right");
      expect(style.fontVariantNumeric).toBe("tabular-nums");
    }
    for (const style of column(1)) expect(style.textAlign).toBe("left");
    expect(getComputedStyle(container.querySelector("th") as Element).whiteSpace).not.toBe("nowrap");
  });

  it("fades the side of a wide table that can still scroll, only while it can", () => {
    const descriptors = ["scrollWidth", "clientWidth"].map(
      (name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const
    );
    let width = 600;
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => width });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 300 });
    try {
      const table = ["| A | B |", "|---|---|", "| x | y |"].join("\n");
      const { container, unmount } = render(<SafeMarkdown>{table}</SafeMarkdown>);
      const scroller = container.querySelector("table")?.parentElement as HTMLElement;
      const edges = () => [scroller.dataset.fadeStart ?? null, scroller.dataset.fadeEnd ?? null];
      // At the start: more to the right.
      expect(edges()).toEqual([null, "true"]);
      scroller.scrollLeft = 150;
      fireEvent.scroll(scroller);
      expect(edges()).toEqual(["true", "true"]);
      scroller.scrollLeft = 300;
      fireEvent.scroll(scroller);
      expect(edges()).toEqual(["true", null]);
      unmount();
      // A table that fits shows no fade.
      width = 300;
      const fits = render(<SafeMarkdown>{table}</SafeMarkdown>).container.querySelector("table")
        ?.parentElement as HTMLElement;
      expect([fits.dataset.fadeStart, fits.dataset.fadeEnd]).toEqual([undefined, undefined]);
    } finally {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
      }
    }
  });

  it("drops javascript: and data: links, HTML and images in every spelling", () => {
    const { container } = render(
      <SafeMarkdown>
        {[
          "[js](javascript:alert(1)) [JS](JaVaScRiPt:alert(1)) [ws](  javascript:alert(1))",
          "<javascript:alert(1)> [ent](&#106;avascript:alert(1)) [hex](&#x6A;avascript:alert(1)) [ref][r]",
          "[r]: javascript:alert(1)",
          "[data](data:text/html;base64,PHNjcmlwdD4=) [vb](vbscript:x) [file](file:///etc/passwd)",
          '<a href="javascript:alert(1)">html link</a> <script>alert(1)</script> <img src=x onerror=alert(1)>',
          "![i](data:image/png;base64,AAAA) [ok](https://goat.example/x) [rel](/catalog?q=a)",
        ].join("\n\n")}
      </SafeMarkdown>
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["https://goat.example/x", "/catalog?q=a"]);
    expect(container.querySelector('a[href^="javascript" i]')).toBeNull();
    // No attribute anywhere carries a script-capable URL or an event handler.
    for (const element of container.querySelectorAll("*")) {
      for (const attr of element.attributes) {
        expect(attr.name).not.toMatch(/^on/i);
        expect(attr.value).not.toMatch(/^\s*(javascript|data|vbscript|file):/i);
      }
    }
    // The dropped links keep their text.
    expect(screen.getByText(/js/)).toBeTruthy();
  });

  it("lists the steps with what each found, and shows a step's input and result on click", () => {
    render(<StepList steps={[search]} />);
    const row = screen.getByRole("button", { name: /assistant_tool_catalog_search/ });
    expect(row.textContent).toContain("assistant_result_datasets");
    fireEvent.click(row);
    expect(screen.getByText(/"q": "rad"/)).toBeTruthy();
    expect(screen.getByText(/"numberMatched": 1/)).toBeTruthy();
  });

  it("marks a running step with GOAT's mark and no result yet", () => {
    render(
      <StepList
        steps={[{ ...search, state: "input-available", output: undefined } as DynamicToolUIPart]}
        running
      />
    );
    const row = screen.getByRole("button", { name: /assistant_tool_catalog_search/ });
    expect(row.querySelector("[data-status]")?.getAttribute("data-status")).toBe("running");
    expect(row.querySelector("svg")).toBeTruthy();
    expect(row.textContent).not.toContain("assistant_result_datasets");
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("explains how a run ended in the UI language", () => {
    render(<RunStatusNote data={{ status: "failed", error: "GOAT AI is busy.", code: "goat_ai_busy" }} />);
    expect(screen.getByText("assistant_run_error_goat_ai_busy")).toBeTruthy();
    expect(screen.queryByText("GOAT AI is busy.")).toBeNull();
  });

  it("shows a caveat in the UI language and nothing for a kind it does not know", () => {
    const { container, rerender } = render(
      <CaveatNote data={{ kind: "fallback", text: "Your provider is down." }} />
    );
    expect(screen.getByText("assistant_caveat_fallback")).toBeTruthy();
    expect(screen.queryByText("Your provider is down.")).toBeNull();
    rerender(<CaveatNote data={{ kind: "something_new", text: "English only." }} />);
    expect(container.textContent).toBe("");
  });

  it("says in the UI language that an answer could not be written after its results", () => {
    render(<CaveatNote data={{ kind: "no_answer", text: "The assistant could not write this answer." }} />);
    expect(screen.getByText("assistant_caveat_no_answer")).toBeTruthy();
    expect(screen.queryByText("The assistant could not write this answer.")).toBeNull();
  });

  it("shows no cards for search results the answer did not recommend", () => {
    render(
      <DockActionsContext.Provider value={actions}>
        <MessageList
          messages={[{ id: "a0", role: "assistant", parts: [search, { type: "text", text: "Nichts." }] }]}
          busy={false}
          conversationId="c1"
          conversationProjectId={null}
          projectName={null}
          readOnly={false}
        />
      </DockActionsContext.Provider>
    );
    expect(screen.queryByText("Radverkehrsnetz")).toBeNull();
  });

  it("shows the groups' headings and each dataset's note", () => {
    const two = {
      ...shown,
      output: {
        groups: [
          { title: "Grundlage", records: [{ id: "b", title: "Stadtbezirke", note: "Zum Ausschneiden" }] },
          {
            title: "Radverkehr",
            records: [
              { id: "r", title: "Radwege" },
              // Shown once, in its first group.
              { id: "b", title: "Stadtbezirke" },
            ],
          },
        ],
        not_found: [],
      },
    } as DynamicToolUIPart;
    render(
      <DockActionsContext.Provider value={actions}>
        <MessageList
          messages={[{ id: "g", role: "assistant", parts: [two, { type: "text", text: "Lücken: keine." }] }]}
          busy={false}
          conversationId="c1"
          conversationProjectId={null}
          projectName={null}
          readOnly={false}
        />
      </DockActionsContext.Provider>
    );
    // Each heading carries its group's count.
    expect(screen.getByRole("heading", { name: "Grundlage · 1" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Radverkehr · 1" })).toBeTruthy();
    expect(screen.getByText("Zum Ausschneiden")).toBeTruthy();
    expect(screen.getAllByText("Stadtbezirke")).toHaveLength(1);
    // Outside a project a catalog card has its preview, and Add asks for the project.
    expect(screen.getAllByRole("button", { name: "assistant_item_preview" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "assistant_result_add" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "assistant_item_add_to_project_choose" })).toHaveLength(2);
  });

  it("still shows a flat list stored before the groups, without a heading", () => {
    const flat = {
      ...shown,
      output: { shown: [{ id: "x", title: "Altbestand" }], not_found: [] },
    } as DynamicToolUIPart;
    render(
      <DockActionsContext.Provider value={actions}>
        <MessageList
          messages={[{ id: "f", role: "assistant", parts: [flat] }]}
          busy={false}
          conversationId="c1"
          conversationProjectId={null}
          projectName={null}
          readOnly={false}
        />
      </DockActionsContext.Provider>
    );
    expect(screen.getByText("Altbestand")).toBeTruthy();
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("shows only the answer's last list of recommended datasets", () => {
    const again = {
      ...shown,
      toolCallId: "s2",
      output: {
        groups: [
          { records: [{ id: "ds-2", title: "Fahrradstraßen", type: "feature", publisher: "Berlin" }] },
        ],
        not_found: [],
      },
    } as DynamicToolUIPart;
    const messages: AssistantMessage[] = [
      { id: "a1", role: "assistant", parts: [shown, { type: "text", text: "Mehr." }, again] },
    ];
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <DockActionsContext.Provider value={actions}>
        <MessageList
          messages={messages}
          busy={false}
          conversationId="c1"
          conversationProjectId={null}
          projectName={null}
          readOnly={false}
        />
      </DockActionsContext.Provider>
    );
    // The earlier list is replaced by the later one, across a text in between...
    expect(screen.queryByText("Radverkehrsnetz")).toBeNull();
    expect(screen.getAllByText("Fahrradstraßen")).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    // ...and within one group of steps.
    cleanup();
    render(
      <DockActionsContext.Provider value={actions}>
        <MessageList
          messages={[{ id: "a2", role: "assistant", parts: [shown, again] }]}
          busy={false}
          conversationId="c1"
          conversationProjectId={null}
          projectName={null}
          readOnly={false}
        />
      </DockActionsContext.Provider>
    );
    expect(screen.queryByText("Radverkehrsnetz")).toBeNull();
    expect(screen.getAllByText("Fahrradstraßen")).toHaveLength(1);
  });

  it("gives each card one button by kind and page, and opens one preview at a time", async () => {
    const own = {
      type: "dynamic-tool",
      toolName: "core_show_items",
      toolCallId: "o1",
      state: "output-available",
      input: {},
      output: {
        groups: [
          {
            title: "Radverkehr",
            items: [
              { kind: "project", id: "p2", name: "Radnetz Nord", note: "Viele Radwege" },
              { kind: "layer", id: "11", project_id: "p1", project_name: "Eins", name: "Radwege" },
              {
                kind: "layer",
                id: "40",
                project_id: "p2",
                dataset_id: "d4",
                project_name: "Radnetz Nord",
                name: "Abstellanlagen",
              },
              { kind: "dataset", id: "d1", dataset_id: "d1", name: "Fahrradständer" },
              // Already in the open project, as layer 77.
              { kind: "dataset", id: "d-in", dataset_id: "d-in", name: "Zählstellen" },
              { kind: "workflow", id: "w1", project_id: "p1", project_name: "Eins", name: "Einzugsgebiete" },
            ],
          },
        ],
        not_found: [],
        left_out: [],
      },
    } as DynamicToolUIPart;
    registerSurface({
      surface: "project.map",
      project: { id: "p1", name: "Eins" },
      uploadTo: { projectId: "p1" },
      getContext: () => ({ surface: "project.map", project_id: "p1" }),
      zoomToLayer: vi.fn(),
    });
    render(
      <DockActionsContext.Provider value={actions}>
        <MessageList
          messages={[{ id: "o", role: "assistant", parts: [own, { type: "text", text: "Treffer." }] }]}
          busy={false}
          conversationId="c1"
          conversationProjectId={null}
          projectName={null}
          readOnly={false}
        />
      </DockActionsContext.Provider>
    );
    expect(screen.getByText("Viele Radwege")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "assistant_item_open_project" }));
    expect(actions.openProject).toHaveBeenCalledWith("p2");
    // A workflow opens in its project's workflow editor.
    fireEvent.click(screen.getByRole("button", { name: "assistant_item_open_workflow" }));
    expect(actions.openInProjectMode).toHaveBeenCalledWith("p1", "workflows", "w1");
    // In the open project: Zoom only, for its own layer and for a dataset it already shows.
    const zooms = screen.getAllByRole("button", { name: "assistant_item_zoom_to_layer" });
    expect(zooms.filter((button) => button.textContent === "assistant_item_zoom")).toHaveLength(2);
    fireEvent.click(zooms.filter((button) => button.textContent === "assistant_item_zoom")[1]);
    expect(actions.zoomToLayer).toHaveBeenCalledWith(77);
    // The other layer and the dataset have a preview (a project has none), one open at a time.
    const previews = screen.getAllByRole("button", { name: "assistant_item_preview" });
    expect(previews).toHaveLength(2);
    fireEvent.click(previews[0]);
    // The preview is loaded on demand (next/dynamic): the first lands a tick after the click.
    expect((await screen.findByTestId("item-preview")).textContent).toBe("Abstellanlagen");
    fireEvent.click(screen.getAllByRole("button", { name: "assistant_item_preview" })[0]);
    expect(screen.getAllByTestId("item-preview").map((node) => node.textContent)).toEqual(["Fahrradständer"]);
    const adds = screen.getAllByRole("button", { name: "assistant_result_add" });
    expect(adds).toHaveLength(2);
    fireEvent.click(adds[1]);
    // Added: the card shows it and offers Zoom to the new layer instead of Add.
    expect(await screen.findByText("assistant_item_added")).toBeTruthy();
    expect(actions.addToProject).toHaveBeenCalledWith(expect.objectContaining({ id: "d1" }), undefined);
    expect(screen.getAllByRole("button", { name: "assistant_result_add" })).toHaveLength(1);
  });

  it("offers no Zoom on a page of the project without its map, also for a dataset just added", async () => {
    const own = {
      type: "dynamic-tool",
      toolName: "core_show_items",
      toolCallId: "o2",
      state: "output-available",
      input: {},
      output: {
        groups: [
          {
            title: null,
            items: [
              { kind: "layer", id: "11", project_id: "p1", project_name: "Eins", name: "Radwege" },
              { kind: "dataset", id: "d1", dataset_id: "d1", name: "Fahrradständer" },
            ],
          },
        ],
        not_found: [],
        left_out: [],
      },
    } as DynamicToolUIPart;
    // Workflows mode: the project is open and editable, its map is not on the page.
    registerSurface({
      surface: "project.workflows",
      project: { id: "p1", name: "Eins" },
      uploadTo: { projectId: "p1" },
      getContext: () => ({ surface: "project.workflows", project_id: "p1" }),
    });
    render(
      <DockActionsContext.Provider value={actions}>
        <MessageList
          messages={[{ id: "o", role: "assistant", parts: [own, { type: "text", text: "Treffer." }] }]}
          busy={false}
          conversationId="c1"
          conversationProjectId={null}
          projectName={null}
          readOnly={false}
        />
      </DockActionsContext.Provider>
    );
    expect(screen.queryByRole("button", { name: "assistant_item_zoom_to_layer" })).toBeNull();
    // The layer is still the project's own.
    expect(screen.getAllByText("assistant_item_layer_in_this_project")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "assistant_result_add" }));
    expect(await screen.findByText("assistant_item_added")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "assistant_item_zoom_to_layer" })).toBeNull();
    expect(screen.queryByRole("button", { name: "assistant_result_add" })).toBeNull();
    expect(screen.getAllByText("assistant_item_layer_in_this_project")).toHaveLength(2);
  });

  it("shows a placeholder in the theme's colours for an item without a picture of its own", () => {
    const shown = {
      type: "dynamic-tool",
      toolName: "core_show_items",
      toolCallId: "o3",
      state: "output-available",
      input: {},
      output: {
        groups: [
          { title: null, items: [{ kind: "dataset", id: "d1", dataset_id: "d1", name: "Fahrradständer" }] },
        ],
        not_found: [],
        left_out: [],
      },
    } as DynamicToolUIPart;
    const cards = () =>
      render(
        <DockActionsContext.Provider value={actions}>
          <MessageList
            messages={[{ id: "o", role: "assistant", parts: [shown] }]}
            busy={false}
            conversationId="c1"
            conversationProjectId={null}
            projectName={null}
            readOnly={false}
          />
        </DockActionsContext.Provider>
      ).container;
    try {
      // GOAT's default artwork is a light grey picture: the card draws its own placeholder instead.
      itemDetails.value = { thumbnail: "https://assets.example/img/goat_new_dataset_thumbnail.png" };
      let container = cards();
      expect(container.querySelector("img")).toBeNull();
      const theme = createTheme();
      // The thumbnail is the mouse's way to the preview, out of the accessibility tree.
      const icon = container.querySelector('button[aria-hidden="true"] svg') as SVGElement;
      expect(getComputedStyle(icon).color).toBe(theme.palette.text.secondary);
      expect(getComputedStyle(icon.parentElement as Element).backgroundColor).toBe(
        theme.palette.action.hover
      );
      cleanup();
      // An item's own picture shows.
      itemDetails.value = { thumbnail: "https://s3.example/thumbnails/d1.png" };
      container = cards();
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        "https://s3.example/thumbnails/d1.png"
      );
    } finally {
      itemDetails.value = {};
    }
  });

  it("does not show the server's text of a failed step", () => {
    const failed = {
      ...search,
      state: "output-error",
      output: undefined,
      errorText: "Internal English detail",
    };
    render(<StepList steps={[failed as unknown as DynamicToolUIPart]} />);
    fireEvent.click(screen.getByRole("button", { name: /assistant_tool_catalog_search/ }));
    expect(screen.getByText(/assistant_step_failed/)).toBeTruthy();
    expect(screen.queryByText(/Internal English detail/)).toBeNull();
  });

  it("shows model, provider and tokens in the answer details", () => {
    const { rerender } = render(
      <AnswerDetails
        usage={{
          model: "claude-x",
          provider: "bedrock",
          input_tokens: 606244,
          output_tokens: 5,
          cache_read_tokens: 2,
        }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "assistant_details" }));
    expect(screen.getByText("claude-x")).toBeTruthy();
    // The provider by its name, and the numbers as the UI language writes them.
    expect(screen.getByText("Amazon Bedrock")).toBeTruthy();
    expect(screen.getByText("606,244")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    // The popover stays open across the rerender: an answer without recorded usage says so.
    rerender(<AnswerDetails usage={undefined} />);
    expect(screen.getByText("assistant_details_none")).toBeTruthy();
  });

  it("names an OpenAI-compatible endpoint in the UI language, and an unknown provider as it is", () => {
    const usage = { model: "m", input_tokens: 1, output_tokens: 1, cache_read_tokens: 0 };
    const { rerender } = render(<AnswerDetails usage={{ ...usage, provider: "openai_compatible" }} />);
    fireEvent.click(screen.getByRole("button", { name: "assistant_details" }));
    expect(screen.getByText("assistant_details_provider_openai_compatible")).toBeTruthy();
    rerender(<AnswerDetails usage={{ ...usage, provider: "constructor" }} />);
    expect(screen.getByText("constructor")).toBeTruthy();
  });

  it("opens the answer details with the info icon", () => {
    const { container } = render(<Icon iconName={ICON_NAME.CIRCLEINFO} />);
    const info = container.querySelector("path")?.getAttribute("d");
    cleanup();
    render(<AnswerDetails usage={undefined} />);
    const button = screen.getByRole("button", { name: "assistant_details" });
    expect(button.querySelector("path")?.getAttribute("d")).toBe(info);
  });

  it("writes the details' numbers with the German separators in German", () => {
    language.value = "de";
    try {
      render(
        <AnswerDetails
          usage={{
            model: "m",
            provider: "openai",
            input_tokens: 606244,
            output_tokens: 4411,
            cache_read_tokens: 593536,
          }}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: "assistant_details" }));
      for (const text of ["606.244", "4.411", "593.536", "OpenAI"])
        expect(screen.getByText(text)).toBeTruthy();
    } finally {
      language.value = "en";
    }
  });

  it("writes the user's message in the text colour, at regular weight", () => {
    render(
      <MessageList
        messages={[{ id: "u1", role: "user", parts: [{ type: "text", text: "Wie viele Radwege gibt es?" }] }]}
        busy={false}
        conversationId="c1"
        conversationProjectId={null}
        projectName={null}
        readOnly={false}
      />
    );
    const style = getComputedStyle(screen.getByText("Wie viele Radwege gibt es?"));
    expect(style.color).toBe(createTheme().palette.text.primary);
    expect(style.fontWeight).toBe("400");
  });

  it("renders a conversation: context chips, text, steps, results, caveats and the run status", async () => {
    const messages: AssistantMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [
          { type: "text", text: "Radwege?" },
          { type: "data-context", data: { surface: "catalog", q: "rad" } },
        ],
      },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          search,
          shown,
          { type: "text", text: "Ein Datensatz passt." },
          { type: "data-caveat", data: { kind: "fallback", text: "English text" } },
          { type: "data-run-status", data: { status: "cancelled", error: null, code: null } },
        ],
      },
    ];
    render(
      <DockActionsContext.Provider value={actions}>
        <MessageList
          messages={messages}
          busy={false}
          conversationId="c1"
          conversationProjectId={null}
          projectName={null}
          readOnly={false}
        />
      </DockActionsContext.Provider>
    );
    expect(screen.getByText("Radwege?")).toBeTruthy();
    expect(screen.getByText("assistant_chip_search")).toBeTruthy();
    expect(screen.getByText("Ein Datensatz passt.")).toBeTruthy();
    expect(screen.getByText("Radverkehrsnetz")).toBeTruthy();
    expect(screen.getByText("assistant_caveat_fallback")).toBeTruthy();
    // The server's own (English) caveat text is never shown.
    expect(screen.queryByText("English text")).toBeNull();
    expect(screen.getByText("assistant_run_cancelled")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "assistant_item_preview" }));
    expect((await screen.findByTestId("item-preview")).textContent).toBe("Radverkehrsnetz");
  });
});

describe("the Answering line", () => {
  it("shows before the first step and between steps", () => {
    renderRunning([]);
    expect(screen.getByText("assistant_running")).toBeTruthy();
    cleanup();
    // Every step done, the model choosing its next one or writing its answer.
    renderRunning([search]);
    expect(screen.getByText("assistant_running")).toBeTruthy();
  });

  it("steps aside while a step runs, whose line shimmers instead, and shows while text streams in", async () => {
    const runningStep: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "catalog_search",
      toolCallId: "c2",
      state: "input-available",
      input: { q: "bus" },
    };
    renderRunning([search, runningStep]);
    await expect(screen.getByRole("status")).toHaveAttribute("data-quiet", "true");
    expect(screen.getByText("assistant_tool_catalog_search_query_running")).toBeTruthy();
    cleanup();
    renderRunning([search, { type: "text", text: "Ich habe", state: "streaming" }]);
    await expect(screen.getByRole("status")).not.toHaveAttribute("data-quiet");
  });

  it("stays mounted from step to step, so the transcript does not jump and it is not announced again", () => {
    const runningStep: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "catalog_search",
      toolCallId: "c2",
      state: "input-available",
      input: { q: "bus" },
    };
    const list = (parts: AssistantMessage["parts"]) => (
      <DockActionsContext.Provider value={actions}>
        <MessageList
          messages={[{ id: "r", role: "assistant", parts }]}
          busy
          conversationId="c1"
          conversationProjectId={null}
          projectName={null}
          readOnly={false}
        />
      </DockActionsContext.Provider>
    );
    const { rerender } = render(list([search]));
    const line = screen.getByRole("status");
    rerender(list([search, runningStep]));
    expect(screen.getByRole("status")).toBe(line);
    rerender(list([search, { ...runningStep, state: "output-available", output: { total: 1 } }]));
    expect(screen.getByRole("status")).toBe(line);
  });

  it("shows right after sending, before the answer has started", () => {
    render(
      <DockActionsContext.Provider value={actions}>
        <MessageList
          messages={[{ id: "u", role: "user", parts: [{ type: "text", text: "Hallo" }] }]}
          busy
          conversationId="c1"
          conversationProjectId={null}
          projectName={null}
          readOnly={false}
        />
      </DockActionsContext.Provider>
    );
    expect(screen.getByText("assistant_running")).toBeTruthy();
  });

  it("is gone once the answer is done", () => {
    render(
      <DockActionsContext.Provider value={actions}>
        <MessageList
          messages={[{ id: "d", role: "assistant", parts: [search] }]}
          busy={false}
          conversationId="c1"
          conversationProjectId={null}
          projectName={null}
          readOnly={false}
        />
      </DockActionsContext.Provider>
    );
    expect(screen.queryByText("assistant_running")).toBeNull();
  });
});

describe("card tooltips", () => {
  /** jsdom lays nothing out: these sizes stand in for a clamped (cut) or a fitting text. */
  const sizes = (scroll: number, client: number) => {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => scroll });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => client });
  };
  afterEach(() => {
    delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  });

  const renderCard = () =>
    render(
      <DockActionsContext.Provider value={actions}>
        <MessageList
          messages={[{ id: "t", role: "assistant", parts: [search, shown, { type: "text", text: "Hier." }] }]}
          busy={false}
          conversationId="c1"
          conversationProjectId={null}
          projectName={null}
          readOnly={false}
        />
      </DockActionsContext.Provider>
    );
  const hover = (element: HTMLElement) => {
    fireEvent.mouseEnter(element);
    fireEvent.mouseOver(element);
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

  it("repeats a title or note on hover only when it is cut", async () => {
    sizes(40, 40);
    renderCard();
    hover(screen.getByText("Radverkehrsnetz"));
    hover(screen.getByText("Das Radnetz der Stadt"));
    await settle();
    expect(screen.queryByRole("tooltip")).toBeNull();
    cleanup();

    sizes(80, 40);
    renderCard();
    hover(screen.getByText("Radverkehrsnetz"));
    expect((await screen.findByRole("tooltip")).textContent).toBe("Radverkehrsnetz");
  });

  it("keeps a meta tooltip that adds a label to the words on the card", async () => {
    sizes(20, 20);
    renderCard();
    hover(screen.getByText("Berlin"));
    expect((await screen.findByRole("tooltip")).textContent).toBe("assistant_item_publisher: Berlin");
  });
});

describe("ask cards in the transcript", () => {
  const card = {
    card_id: "ask-call-3",
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
  /** The ask step as the server streams and stores it: the card goes out while it runs, its id comes back. */
  const askStep = (
    state: "input-available" | "output-available" = "output-available",
    cardId = "ask-call-3"
  ): DynamicToolUIPart =>
    state === "output-available"
      ? {
          type: "dynamic-tool",
          toolName: "ask_user",
          toolCallId: "t-ask",
          state,
          input: { questions: [] },
          output: { card_id: cardId, status: "asked" },
        }
      : { type: "dynamic-tool", toolName: "ask_user", toolCallId: "t-ask", state, input: { questions: [] } };
  const asked: AssistantMessage = {
    id: "a1",
    role: "assistant",
    parts: [
      askStep(),
      { type: "data-ask", id: "ask-call-3", data: card },
      { type: "text", text: "Please choose." },
    ],
  };
  const answered: AssistantMessage = {
    id: "u2",
    role: "user",
    metadata: { answer: { card_id: "ask-call-3", answers: [{ question: 0, options: [0], other: null }] } },
    parts: [{ type: "text", text: "Schools: Schools (catalog)" }],
  };
  const list = (
    messages: AssistantMessage[],
    {
      panelAskId = null,
      heldAskId = null,
      onShowAsk,
      readOnly = false,
      busy = false,
    }: {
      panelAskId?: string | null;
      heldAskId?: string | null;
      onShowAsk?: (cardId: string) => void;
      readOnly?: boolean;
      busy?: boolean;
    } = {}
  ) =>
    render(
      <DockActionsContext.Provider value={actions}>
        <MessageList
          messages={messages}
          busy={busy}
          conversationId="c1"
          conversationProjectId={null}
          projectName={null}
          readOnly={readOnly}
          panelAskId={panelAskId}
          heldAskId={heldAskId}
          onShowAsk={onShowAsk}
        />
      </DockActionsContext.Provider>
    );

  it("shows the stored answer of a reloaded conversation, without fields or Send", () => {
    list([{ id: "u1", role: "user", parts: [{ type: "text", text: "Build it" }] }, asked, answered]);
    expect(screen.getByText("assistant_ask_answered")).toBeTruthy();
    expect(screen.getByText("Schools (catalog)")).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button", { name: "assistant_ask_send" })).toBeNull();
  });

  it("holds the open card's place with a line: the panel at the dock's foot asks its questions", () => {
    list([asked], { panelAskId: "ask-call-3" });
    expect(screen.getByText("assistant_ask_waiting")).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button", { name: "assistant_ask_send" })).toBeNull();
    // The rest of the answer stays.
    expect(screen.getByText("Please choose.")).toBeTruthy();
  });

  it("is no longer sent once a typed reply followed it", () => {
    list([asked, { id: "u2", role: "user", parts: [{ type: "text", text: "Use the layer I uploaded" }] }]);
    expect(screen.getByText("assistant_ask_not_answered")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "assistant_ask_send" })).toBeNull();
  });

  it("offers no Send in a read-only conversation", () => {
    list([asked], { readOnly: true });
    expect(screen.getByRole("form", { name: "assistant_ask_label" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "assistant_ask_send" })).toBeNull();
  });

  it("shows a card that is not open with its questions, disabled and without Send", async () => {
    const withStep = (step: DynamicToolUIPart | null): AssistantMessage => ({
      ...asked,
      parts: [...asked.parts.filter((part) => part.type !== "dynamic-tool"), ...(step ? [step] : [])],
    });
    // The run stopped while the step ran, before it returned; no step at all; another card's
    // step: the server knows no such card (the open card is ChatView's, see `openAskCard`).
    for (const message of [
      withStep(askStep("input-available")),
      withStep(null),
      withStep(askStep("output-available", "ask-other")),
    ]) {
      list([message]);
      expect(screen.getByRole("form", { name: "assistant_ask_label" })).toBeTruthy();
      await expect(screen.getByRole("radio", { name: /Schools \(catalog\)/ })).toBeDisabled();
      expect(screen.queryByRole("button", { name: "assistant_ask_send" })).toBeNull();
      expect(screen.queryByText("assistant_ask_waiting")).toBeNull();
      cleanup();
    }
    // The panel asks another card, or none: the composer holds this one, whose questions are read here.
    for (const panelAskId of ["ask-other", null]) {
      list([withStep(askStep())], { panelAskId });
      await expect(screen.getByRole("radio", { name: /Schools \(catalog\)/ })).toBeDisabled();
      expect(screen.queryByText("assistant_ask_waiting")).toBeNull();
      cleanup();
    }
  });

  it("hands the waiting line of the open card the way to the panel, also under a card the composer holds", async () => {
    const onShowAsk = vi.fn();
    list([asked], { panelAskId: "ask-call-3", onShowAsk });
    fireEvent.click(screen.getByRole("button", { name: "assistant_ask_waiting · Schools" }));
    expect(onShowAsk).toHaveBeenCalledWith("ask-call-3");
    cleanup();
    list([asked], { heldAskId: "ask-call-3", onShowAsk });
    await expect(screen.getByRole("radio", { name: /Schools \(catalog\)/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "assistant_ask_waiting · Schools" }));
    expect(onShowAsk).toHaveBeenCalledTimes(2);
  });

  it("holds the place of a card still coming in the running answer with the line", () => {
    const coming: AssistantMessage = {
      ...asked,
      parts: [askStep("input-available"), { type: "data-ask", id: "ask-call-3", data: card }],
    };
    list([coming], { busy: true });
    expect(screen.getByText("assistant_ask_waiting")).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("shows nothing for a card it cannot read, and the rest of the answer", () => {
    const broken = {
      id: "a9",
      role: "assistant",
      parts: [
        { type: "data-ask", id: "ask-x", data: { card_id: "ask-x", questions: "broken" } },
        { type: "text", text: "Weiter." },
      ],
    } as unknown as AssistantMessage;
    list([broken]);
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.getByText("Weiter.")).toBeTruthy();
  });
});

describe("created workflows in the transcript", () => {
  it("show the workflow a create step made with Open, after its step", () => {
    const created = {
      type: "dynamic-tool",
      toolName: "workflow_create",
      toolCallId: "wc1",
      state: "output-available",
      input: { draft: {} },
      output: {
        workflow: { id: "w-new", name: "Schulen: 15 Minuten", project_id: "p1" },
        open_issues: [],
        groups: [
          {
            title: null,
            items: [
              { kind: "workflow", id: "w-new", project_id: "p1", name: "Schulen: 15 Minuten", detail: null },
            ],
          },
        ],
      },
    } as DynamicToolUIPart;
    render(
      <DockActionsContext.Provider value={actions}>
        <MessageList
          messages={[{ id: "w", role: "assistant", parts: [created, { type: "text", text: "Fertig." }] }]}
          busy={false}
          conversationId="c1"
          conversationProjectId="p1"
          projectName="Eins"
          readOnly={false}
        />
      </DockActionsContext.Provider>
    );
    const step = screen.getByText("assistant_tool_workflow_create_name");
    const card = screen.getByText("Schulen: 15 Minuten");
    expect(step.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    fireEvent.click(screen.getByRole("button", { name: "assistant_item_open_workflow" }));
    expect(actions.openInProjectMode).toHaveBeenCalledWith("p1", "workflows", "w-new");
  });

  /** A finished create step that made workflow `id` in project p1. */
  const create = (toolCallId: string, id: string, name: string, extra: Record<string, unknown> = {}) =>
    ({
      type: "dynamic-tool",
      toolName: "workflow_create",
      toolCallId,
      state: "output-available",
      input: { draft: { name } },
      output: {
        workflow: { id, name, project_id: "p1" },
        open_issues: [],
        groups: [{ title: null, items: [{ kind: "workflow", id, project_id: "p1", name, detail: null }] }],
        ...extra,
      },
    }) as DynamicToolUIPart;
  const answer = (parts: AssistantMessage["parts"]) =>
    render(
      <DockActionsContext.Provider value={actions}>
        <MessageList
          messages={[{ id: "w", role: "assistant", parts }]}
          busy={false}
          conversationId="c1"
          conversationProjectId="p1"
          projectName="Eins"
          readOnly={false}
        />
      </DockActionsContext.Provider>
    );

  it("give each workflow the answer created its own card, in order", () => {
    answer([
      create("wc1", "w-a", "Schulen: 15 Minuten"),
      create("wc2", "w-b", "Kitas: 10 Minuten"),
      { type: "text", text: "Fertig." },
    ]);
    const first = screen.getByText("Schulen: 15 Minuten");
    const second = screen.getByText("Kitas: 10 Minuten");
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(screen.getAllByRole("button", { name: "assistant_item_open_workflow" })).toHaveLength(2);
  });

  it("draw a workflow once when a repeated create returns it again", () => {
    answer([
      create("wc1", "w-a", "Schulen: 15 Minuten"),
      { type: "text", text: "Noch einmal." },
      create("wc2", "w-a", "Schulen: 15 Minuten", { repeated_call: "Nothing was created again." }),
      { type: "text", text: "Fertig." },
    ]);
    expect(screen.getAllByText("Schulen: 15 Minuten")).toHaveLength(1);
  });

  it("draw a workflow once when core_show_items names it again, with the list's other items", () => {
    const shownAgain = {
      type: "dynamic-tool",
      toolName: "core_show_items",
      toolCallId: "o2",
      state: "output-available",
      input: {},
      output: {
        groups: [
          {
            title: null,
            items: [
              { kind: "workflow", id: "w-a", project_id: "p1", name: "Schulen: 15 Minuten" },
              { kind: "project", id: "p2", name: "Radnetz Nord" },
            ],
          },
        ],
        not_found: [],
        left_out: [],
      },
    } as DynamicToolUIPart;
    answer([create("wc1", "w-a", "Schulen: 15 Minuten"), shownAgain, { type: "text", text: "Fertig." }]);
    expect(screen.getAllByText("Schulen: 15 Minuten")).toHaveLength(1);
    expect(screen.getByText("Radnetz Nord")).toBeTruthy();
  });
});

describe("step groups in the transcript", () => {
  const other: DynamicToolUIPart = { ...search, toolCallId: "c9", input: { q: "bus" } } as DynamicToolUIPart;
  const runningStep: DynamicToolUIPart = {
    type: "dynamic-tool",
    toolName: "catalog_search",
    toolCallId: "c3",
    state: "input-available",
    input: { q: "tram" },
  };
  const list = (parts: AssistantMessage["parts"], busy: boolean) => (
    <DockActionsContext.Provider value={actions}>
      <MessageList
        messages={[{ id: "r", role: "assistant", parts }]}
        busy={busy}
        conversationId="c1"
        conversationProjectId={null}
        projectName={null}
        readOnly={false}
      />
    </DockActionsContext.Provider>
  );
  const summary = () => screen.queryByRole("button", { name: /assistant_steps_catalog_search/i });
  const stepRow = () => screen.queryAllByRole("button", { name: /assistant_tool_catalog_search/ });

  it("shows every group of a stored answer closed into its summary", () => {
    render(list([search, other, { type: "text", text: "Zwei Treffer." }], false));
    expect(summary()?.getAttribute("aria-expanded")).toBe("false");
    expect(stepRow()).toHaveLength(0);
  });

  it("keeps the group still receiving steps open, and closes it when text follows", () => {
    const { rerender } = render(list([search, runningStep], true));
    expect(summary()).toBeNull();
    expect(stepRow()).toHaveLength(2);
    // The running step says what it does.
    expect(screen.getByText("assistant_tool_catalog_search_query_running")).toBeTruthy();
    const done = {
      ...runningStep,
      state: "output-available",
      output: { numberMatched: 0 },
    } as DynamicToolUIPart;
    rerender(list([search, done, { type: "text", text: "Ich habe", state: "streaming" }], true));
    expect(summary()?.getAttribute("aria-expanded")).toBe("false");
    expect(stepRow()).toHaveLength(0);
  });

  it("closes the last group when the answer ends", () => {
    const { rerender } = render(list([search, other], true));
    expect(stepRow()).toHaveLength(2);
    rerender(list([search, other], false));
    expect(summary()?.getAttribute("aria-expanded")).toBe("false");
    expect(stepRow()).toHaveLength(0);
  });
});

describe("message times", () => {
  const MINUTE = 60_000;
  const view = (messages: AssistantMessage[], busy = false) => (
    <DockActionsContext.Provider value={actions}>
      <MessageList
        messages={messages}
        busy={busy}
        conversationId="c1"
        conversationProjectId={null}
        projectName={null}
        readOnly={false}
      />
    </DockActionsContext.Provider>
  );
  const text = (value: string) => [{ type: "text" as const, text: value }];
  const times = () => [...document.querySelectorAll("time")];

  it("shows how long ago an answer was given in its actions, with the full date on hover", async () => {
    const created = new Date(Date.now() - 2 * MINUTE - 5_000);
    render(
      view([
        { id: "a", role: "assistant", parts: text("Hier."), metadata: { created_at: created.toISOString() } },
      ])
    );
    const [time] = times();
    expect(time.textContent).toBe("2 minutes ago");
    expect(time.getAttribute("dateTime")).toBe(created.toISOString());
    expect(time.closest(".answer-actions")).not.toBeNull();
    // The visible words stay its name; the full date describes it.
    expect(time.getAttribute("aria-label")).toBeNull();
    expect(time.getAttribute("title")).toBe(fullTime(created.getTime(), "en"));
    fireEvent.mouseEnter(time);
    fireEvent.mouseOver(time);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toBe(fullTime(created.getTime(), "en"));
    await expect(time).toHaveAttribute("aria-describedby", tooltip.id);
    expect(time.getAttribute("aria-label")).toBeNull();
  });

  it("shows the time of the user's own message, reachable by keyboard", () => {
    const created = new Date(Date.now() - 3 * MINUTE);
    render(
      view([
        { id: "u", role: "user", parts: text("Radwege?"), metadata: { created_at: created.toISOString() } },
      ])
    );
    const [time] = times();
    expect(time.textContent).toBe("3 minutes ago");
    expect(time.getAttribute("tabindex")).toBe("0");
    // Out of the flow: the question stays as close to its answer as without a time.
    expect(getComputedStyle(time.closest(".message-time")!).position).toBe("absolute");
  });

  it("keeps room in the list for the time of a last question, so what follows the list does not cover it", () => {
    const created = new Date(Date.now() - 3 * MINUTE).toISOString();
    const question: AssistantMessage = {
      id: "u",
      role: "user",
      parts: text("Radwege?"),
      metadata: { created_at: created },
    };
    const answer: AssistantMessage = {
      id: "a",
      role: "assistant",
      parts: text("Hier."),
      metadata: { created_at: created },
    };
    const { container, rerender } = render(view([question]));
    const room = () => getComputedStyle(container.firstElementChild!).paddingBottom;
    // The request dropped before an answer: an alert follows the list.
    expect(room()).toBe("20px");
    // The Answering line follows the question inside the list, and so does an answer.
    rerender(view([question], true));
    expect(room()).not.toBe("20px");
    rerender(view([question, answer]));
    expect(room()).not.toBe("20px");
  });

  it("gives a message of the live stream the time it arrived, and none to one it cannot date", () => {
    // Shown at mount without a stored time: when it was written is not known.
    const old: AssistantMessage = { id: "old", role: "assistant", parts: text("Früher.") };
    const { rerender } = render(view([old]));
    expect(times()).toHaveLength(0);
    rerender(
      view([
        old,
        { id: "u-live", role: "user", parts: text("Und jetzt?") },
        { id: "a-live", role: "assistant", parts: text("Jetzt.") },
      ])
    );
    expect(times().map((time) => time.textContent)).toEqual([
      "assistant_time_just_now",
      "assistant_time_just_now",
    ]);
  });

  it("dates a live answer when it stops running, also when the dock mounted again during the run", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const start = new Date(2026, 9, 19, 10, 0).getTime();
      const iso = (time: number) => new Date(time).toISOString();
      const dated = () => times().map((time) => time.getAttribute("dateTime"));
      vi.setSystemTime(start);
      const question: AssistantMessage = {
        id: "u-run",
        role: "user",
        parts: text("Bauen Sie den Workflow."),
      };
      const answer = (value: string): AssistantMessage => ({
        id: "a-run",
        role: "assistant",
        parts: text(value),
      });
      const { rerender } = render(view([], false));
      rerender(view([question, answer("Ich baue")], true));
      expect(dated()).toEqual([iso(start)]);
      vi.setSystemTime(start + 3 * MINUTE);
      rerender(view([question, answer("Fertig.")], false));
      expect(dated()).toEqual([iso(start), iso(start + 3 * MINUTE)]);
      cleanup();
      // Mounted again while the run went on: the question is not dated, the answer is, when it ends.
      const again: AssistantMessage = { id: "u-again", role: "user", parts: text("Noch einer?") };
      const later = (value: string): AssistantMessage => ({
        id: "a-again",
        role: "assistant",
        parts: text(value),
      });
      const remounted = render(view([again, later("Ich")], true));
      vi.setSystemTime(start + 5 * MINUTE);
      remounted.rerender(view([again, later("Fertig.")], false));
      expect(dated()).toEqual([iso(start + 5 * MINUTE)]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("whole answers in the transcript", () => {
  let id = 0;
  const step = (
    toolName: string,
    input: unknown,
    output?: unknown,
    state: "output-available" | "output-error" | "input-available" = output === undefined
      ? "input-available"
      : "output-available"
  ): DynamicToolUIPart =>
    ({
      type: "dynamic-tool",
      toolName,
      toolCallId: `w${(id += 1)}`,
      state,
      input,
      ...(state === "output-available" ? { output } : {}),
      ...(state === "output-error" ? { errorText: "Internal English detail" } : {}),
    }) as DynamicToolUIPart;
  const say = (value: string) => ({ type: "text" as const, text: value });
  const searchFor = (q: string) => step("catalog_search", { q }, { numberMatched: 2 });
  const record = () => step("catalog_get_record", { item_id: "ds-1" }, { title: "Radverkehrsnetz" });
  const region = () => step("catalog_find_region", { name: "Bonn" }, { regions: [] });
  const count = () => step("project_count_features", { layer_project_id: 1 }, { layer: "A", count: 3 });
  const create = () =>
    step(
      "workflow_create",
      { draft: {} },
      {
        workflow: { id: "w-new", name: "Schulen: 15 Minuten", project_id: "p1" },
        open_issues: [],
        groups: [
          {
            title: null,
            items: [
              { kind: "workflow", id: "w-new", project_id: "p1", name: "Schulen: 15 Minuten", detail: null },
            ],
          },
        ],
      }
    );
  const answer = (parts: AssistantMessage["parts"], busy: boolean) => (
    <DockActionsContext.Provider value={actions}>
      <MessageList
        messages={[{ id: "whole", role: "assistant", parts }]}
        busy={busy}
        conversationId="c1"
        conversationProjectId="p1"
        projectName="Eins"
        readOnly={false}
      />
    </DockActionsContext.Provider>
  );
  const summaries = () => screen.queryAllByRole("button", { name: /^Assistant_steps_/ });
  const before = (first: Node, second: Node) =>
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );

  it("names a changed workflow from a read in an earlier run of steps", () => {
    const read = step(
      "workflow_get",
      { workflow_id: "w1" },
      { workflow_id: "w1", name: "Kitas", revision: 2 }
    );
    const edit = step(
      "workflow_update",
      { workflow_id: "w1", operations: [] },
      { workflow_id: "w1", revision_before: 2, revision_after: 3, changed_steps: [] }
    );
    render(answer([read, say("Ich ändere den Puffer."), edit, say("Fertig.")], false));
    expect(screen.getByText("assistant_tool_workflow_update_name")).toBeTruthy();
  });

  it("folds each run of steps between texts on its own, and keeps the last one open while it runs", () => {
    const parts = [
      say("Ich suche."),
      searchFor("rad"),
      record(),
      say("Jetzt die Region."),
      region(),
      count(),
    ];
    render(answer(parts, false));
    const [first, second] = summaries();
    expect(summaries()).toHaveLength(2);
    expect(first.textContent).toBe("Assistant_steps_catalog_search, assistant_steps_catalog_record");
    expect(second.textContent).toBe("Assistant_steps_region, assistant_steps_counts");
    before(screen.getByText("Ich suche."), first);
    before(first, screen.getByText("Jetzt die Region."));
    before(screen.getByText("Jetzt die Region."), second);
    cleanup();
    render(answer(parts, true));
    expect(summaries().map((button) => button.textContent)).toEqual([
      "Assistant_steps_catalog_search, assistant_steps_catalog_record",
    ]);
    expect(screen.getAllByText("assistant_tool_catalog_find_region_name")).toHaveLength(1);
    expect(screen.getAllByText("assistant_tool_project_count_features_layer")).toHaveLength(1);
  });

  it("shows a failure and its retry as two lines while the retry runs, then as one folded step", () => {
    const rejected = step("catalog_search", { q: "" }, undefined, "output-error");
    const retry = searchFor("rad");
    render(
      answer([rejected, { ...retry, state: "input-available", output: undefined } as DynamicToolUIPart], true)
    );
    expect(screen.getByText(/assistant_step_failed/)).toBeTruthy();
    expect(screen.getByText("assistant_tool_catalog_search_query_running")).toBeTruthy();
    cleanup();
    render(answer([rejected, retry, record(), say("Gefunden.")], false));
    const [summary] = summaries();
    expect(summary.textContent).toBe("Assistant_steps_catalog_search, assistant_steps_catalog_record");
    expect(screen.queryByText(/assistant_step_failed/)).toBeNull();
    fireEvent.click(summary);
    expect(screen.getByRole("button", { name: /assistant_tool_catalog_search_query/ }).textContent).toContain(
      "assistant_step_retried"
    );
  });

  it("keeps an ask card and a created workflow's card in their places between the groups", () => {
    const asking = step("ask_user", { questions: [] }, { card_id: "ask-w", status: "asked" });
    const card = {
      card_id: "ask-w",
      questions: [
        {
          question: "Welcher Layer?",
          header: "Layer",
          multi_select: false,
          options: [{ label: "Schulen", description: "", recommended: true }],
        },
      ],
    };
    render(
      answer(
        [
          searchFor("schule"),
          record(),
          asking,
          { type: "data-ask", id: "ask-w", data: card },
          say("Bitte wählen Sie."),
          count(),
          region(),
          create(),
          say("Fertig."),
        ],
        false
      )
    );
    const [first, second] = summaries();
    expect(first.textContent).toBe(
      "Assistant_steps_catalog_search, assistant_steps_catalog_record, assistant_steps_ask"
    );
    expect(second.textContent).toBe("Assistant_steps_counts, assistant_steps_region");
    const form = screen.getByRole("form", { name: "assistant_ask_label" });
    const created = screen.getByText("assistant_tool_workflow_create_name");
    const workflowCard = screen.getByText("Schulen: 15 Minuten");
    before(first, form);
    before(form, screen.getByText("Bitte wählen Sie."));
    before(screen.getByText("Bitte wählen Sie."), second);
    before(second, created);
    before(created, workflowCard);
    before(workflowCard, screen.getByText("Fertig."));
  });

  it("shows a stopped answer's unreturned step as stopped, outside the fold", () => {
    const unreturned = step("catalog_get_record", { item_id: "ds-9" });
    render(
      answer(
        [
          searchFor("a"),
          searchFor("b"),
          unreturned,
          { type: "data-run-status", data: { status: "cancelled", error: null, code: null } },
        ],
        false
      )
    );
    expect(summaries().map((button) => button.textContent)).toEqual(["Assistant_steps_catalog_search"]);
    const line = screen.getByRole("button", { name: /assistant_tool_catalog_get_record_title_running/ });
    expect(line.textContent).toContain("assistant_step_stopped");
    expect(line.querySelector("[data-status]")?.getAttribute("data-status")).toBe("stopped");
    expect(screen.getByText("assistant_run_cancelled")).toBeTruthy();
  });

  it("draws every step exactly once, open, closed and opened again", () => {
    const steps = [
      searchFor("rad"),
      record(),
      region(),
      step("core_find", { query: "x" }, undefined, "output-error"),
      create(),
    ];
    const labels = [
      "assistant_tool_catalog_search_query",
      "assistant_tool_catalog_get_record_title",
      "assistant_tool_catalog_find_region_name",
      "assistant_tool_core_find_query",
      "assistant_tool_workflow_create_name",
    ];
    const drawn = () => labels.map((label) => screen.queryAllByText(label).length);
    render(answer(steps, true));
    expect(drawn()).toEqual([1, 1, 1, 1, 1]);
    cleanup();
    render(answer([...steps, say("Fertig.")], false));
    // Closed: the failure and the write stay, the rest is behind the summary.
    expect(drawn()).toEqual([0, 0, 0, 1, 1]);
    fireEvent.click(summaries()[0]);
    expect(drawn()).toEqual([1, 1, 1, 1, 1]);
  });
});

describe("workflow runs", () => {
  const run = (data: Partial<Record<string, unknown>>) =>
    ({
      type: "data-workflow-run",
      id: "workflow-run:j1",
      data: {
        workflow_id: "w1",
        project_id: "p1",
        job_id: "j1",
        status: "running",
        started: true,
        card_id: null,
        done: 2,
        total: 7,
        step: "Einzugsgebiet",
        started_at: null,
        saved: 0,
        ...data,
      },
    }) as unknown as AssistantMessage["parts"][number];

  it("shows the running step and opens the workflow in the Workflows view", () => {
    renderRunning([run({})]);
    expect(screen.getByText("assistant_workflow_run_step")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "assistant_workflow_run_open" }));
    expect(actions.openInProjectMode).toHaveBeenCalledWith("p1", "workflows", "w1");
  });

  it("says how the run ended", () => {
    renderRunning([run({ status: "failed", step: null })]);
    expect(screen.getByText("assistant_workflow_run_failed")).toBeTruthy();
  });

  it("leaves opening the workflow to its card when the answer shows one", () => {
    const created = (id: string) =>
      ({
        type: "dynamic-tool",
        toolName: "workflow_create",
        toolCallId: `wc-${id}`,
        state: "output-available",
        input: { draft: {} },
        output: {
          workflow: { id, name: `Kitas ${id}`, project_id: "p1" },
          open_issues: [],
          groups: [{ title: null, items: [{ kind: "workflow", id, project_id: "p1", name: `Kitas ${id}` }] }],
        },
      }) as DynamicToolUIPart;
    renderRunning([created("w1"), run({ status: "succeeded", step: null })]);
    expect(screen.getByText("assistant_workflow_run_succeeded")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "assistant_workflow_run_open" })).toBeNull();
    expect(screen.getByRole("button", { name: "assistant_item_open_workflow" })).toBeTruthy();
    cleanup();
    // The card of another workflow is no way to this run's.
    renderRunning([created("w2"), run({ status: "succeeded", step: null })]);
    expect(screen.getByRole("button", { name: "assistant_workflow_run_open" })).toBeTruthy();
    cleanup();
    // Named past the cards one result shows: no card, so the line keeps its Open.
    const items = [
      ...Array.from({ length: 10 }, (_, index) => ({
        kind: "project",
        id: `p${index + 2}`,
        name: `P${index}`,
      })),
      { kind: "workflow", id: "w1", project_id: "p1", name: "Kitas" },
    ];
    const listed = {
      type: "dynamic-tool",
      toolName: "core_show_items",
      toolCallId: "o-many",
      state: "output-available",
      input: {},
      output: { groups: [{ title: null, items }], not_found: [], left_out: [] },
    } as DynamicToolUIPart;
    renderRunning([listed, run({ status: "succeeded", step: null })]);
    expect(screen.queryByRole("button", { name: "assistant_item_open_workflow" })).toBeNull();
    expect(screen.getByRole("button", { name: "assistant_workflow_run_open" })).toBeTruthy();
  });

  it("offers Open as the dock's outlined pill", () => {
    renderRunning([run({})]);
    const open = screen.getByRole("button", { name: "assistant_workflow_run_open" });
    expect(open.className).toContain("MuiButton-outlined");
    expect(getComputedStyle(open).borderRadius).toBe("999px");
  });

  it("says in the past tense that a run was still going when a stored answer ended", () => {
    // Stopped, or ended with the run still going: the part never says how the run ended.
    render(
      <DockActionsContext.Provider value={actions}>
        <MessageList
          messages={[
            {
              id: "r",
              role: "assistant",
              parts: [run({ started_at: new Date(Date.now() - 65_000).toISOString() })],
            },
          ]}
          busy={false}
          conversationId="c1"
          conversationProjectId={null}
          projectName={null}
          readOnly={false}
        />
      </DockActionsContext.Provider>
    );
    expect(screen.getByText("assistant_workflow_run_ended_running")).toBeTruthy();
    expect(screen.queryByText("assistant_workflow_run_step")).toBeNull();
    expect(screen.queryByText(/^· \d+:\d\d$/)).toBeNull();
    actions.openInProjectMode.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "assistant_workflow_run_open" }));
    expect(actions.openInProjectMode).toHaveBeenCalledWith("p1", "workflows", "w1");
  });

  it("announces the step, not the ticking time or the button", () => {
    renderRunning([run({ started_at: new Date(Date.now() - 65_000).toISOString() })]);
    const status = screen
      .getAllByRole("status")
      .find((element) => element.textContent?.includes("assistant_workflow_run_step"));
    expect(status?.textContent).toBe("assistant_workflow_run_step");
    const timer = screen.getByText(/^· 1:0\d$/);
    expect(timer.closest("[aria-hidden='true']")).toBeTruthy();
    expect(status?.contains(screen.getByRole("button", { name: "assistant_workflow_run_open" }))).toBe(false);
  });
});

describe("the Undo of an answer's workflow edits", () => {
  const update = (before: number, after: number, state: DynamicToolUIPart["state"] = "output-available") =>
    ({
      type: "dynamic-tool",
      toolName: "workflow_update",
      toolCallId: `u-${after}`,
      state,
      input: { workflow_id: "wf-1", operations: [] },
      output: { workflow_id: "wf-1", revision_before: before, revision_after: after, changed_steps: [] },
    }) as DynamicToolUIPart;
  const answer = (
    parts: AssistantMessage["parts"],
    metadata: AssistantMessage["metadata"] = { run_id: "run-1" }
  ): AssistantMessage => ({ id: "a1", role: "assistant", metadata, parts });
  const show = (message: AssistantMessage, { readOnly = false, busy = false } = {}) =>
    render(
      <DockActionsContext.Provider value={actions}>
        <MessageList
          messages={[message]}
          busy={busy}
          conversationId="c1"
          conversationProjectId="p1"
          projectName="Walk"
          readOnly={readOnly}
        />
      </DockActionsContext.Provider>
    );
  const text = { type: "text", text: "I set the walking time to 10 minutes." } as const;

  it("shows on an answer that saved a workflow edit", () => {
    show(answer([update(4, 5), text]));
    expect(screen.getByRole("button", { name: "assistant_undo" })).toBeTruthy();
  });

  it("shows on an answer that edited and then failed without a word", () => {
    show(
      answer([
        update(4, 5),
        { type: "data-run-status", data: { status: "failed", error: "slow", code: "run_timeout" } },
      ] as AssistantMessage["parts"])
    );
    expect(screen.getByRole("button", { name: "assistant_undo" })).toBeTruthy();
  });

  it("does not show without an edit, for an edit that changed nothing, or without the answer's run", () => {
    show(answer([text]));
    show(answer([update(4, 4), text]));
    show(answer([update(4, 5), text], {}));
    expect(screen.queryByRole("button", { name: "assistant_undo" })).toBeNull();
  });

  it("does not show in a read-only conversation, nor while the answer runs", () => {
    show(answer([update(4, 5), text]), { readOnly: true });
    show(answer([update(4, 5), text]), { busy: true });
    expect(screen.queryByRole("button", { name: "assistant_undo" })).toBeNull();
  });

  it("reads Undone for an answer whose edits were undone", () => {
    show(answer([update(4, 5), text], { run_id: "run-2", undone: true }));
    expect(screen.queryByRole("button", { name: "assistant_undo" })).toBeNull();
    expect(screen.getByText("assistant_undone")).toBeTruthy();
  });
});
