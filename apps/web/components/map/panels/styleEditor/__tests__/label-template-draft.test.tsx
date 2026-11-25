import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EditorStore } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type SaveResult, type StyleIssue, StyleSaver, type StyleTransport } from "@/lib/style/save";

import { StyleEditor } from "@/components/map/panels/styleEditor/StyleEditor";
import { EMPTY_DATA } from "@/components/map/panels/styleEditor/context";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { openGroup, renderWithProviders } from "./renderPanel";

// The label's Custom text box: what is typed is written when the box is left, and a template the server takes back
// stays in the box with the server's issue under it.

const FIELDS = [
  { name: "name", type: "string" as const, label: "name" },
  { name: "pop", type: "integer" as const, label: "pop" },
];

const STORED = {
  version: "1.0.0",
  kind: "vector",
  symbol: { marker: { shape: "circle", color: "#1a6b4d", size: 8 }, label: { text: "Name: {name}" } },
} as LayerStyle;

const MESSAGE = "The placeholder is not closed.";

function shell() {
  const resolvers: Array<(r: SaveResult) => void> = [];
  const transport: StyleTransport = {
    save: () => new Promise((resolve) => resolvers.push(resolve)),
    load: async () => ({ document: STORED, revision: 1 }),
  };
  const store = new EditorStore({ saver: new StyleSaver({ transport, document: STORED, revision: 1 }) });
  const result = renderWithProviders(
    <StyleEditor
      layer={{ id: "l1", name: "Towns", geometry: "point", kind: "vector" }}
      store={store}
      data={{
        ...EMPTY_DATA,
        geometry: "point",
        fields: FIELDS,
        fieldTypes: Object.fromEntries(FIELDS.map((f) => [f.name, f.type])),
        sample: { name: "Berlin", pop: 3850000 },
      }}
      map={null}
      mapZoom={12}>
      <SymbolSection />
    </StyleEditor>
  );
  /** Core's answer that takes the label text back: the stored document, with the refused text's error. */
  const refuse = async (issues: StyleIssue[]) => {
    store.saver.saveNow();
    await vi.advanceTimersByTimeAsync(0);
    resolvers.shift()?.({ ok: true, document: STORED, revision: 1, issues });
    await vi.advanceTimersByTimeAsync(0);
  };
  return { ...result, store, refuse };
}

const box = () => screen.getByRole("textbox", { name: "style_editor.template" }) as HTMLTextAreaElement;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("label template box", () => {
  it("writes the template when the box is left, not while it is typed", async () => {
    const { store } = shell();
    await openGroup("style_editor.part_label");
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: "Pop: {po" } });
    expect(store.get("symbol.label.text")).toBe("Name: {name}");
    // The preview follows what is typed.
    fireEvent.change(box(), { target: { value: "Pop: {pop}" } });
    expect(screen.getByText("Pop: 3,850,000")).toBeDefined();
    fireEvent.blur(box());
    expect(store.get("symbol.label.text")).toBe("Pop: {pop}");
  });

  it("a template the server takes back stays in the box with the server's issue under it", async () => {
    const { store, refuse } = shell();
    await openGroup("style_editor.part_label");
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: "Pop: {po" } });
    fireEvent.blur(box());
    await act(() =>
      refuse([{ level: "error", code: "template_syntax", path: "/symbol/label/text", message: MESSAGE }])
    );
    expect(store.get("symbol.label.text")).toBe("Name: {name}");
    expect(box().value).toBe("Pop: {po");
    expect(screen.getByText(MESSAGE)).toBeDefined();
  });

  it("Insert field adds to the text in the box, a refused one too", async () => {
    const { store, refuse } = shell();
    await openGroup("style_editor.part_label");
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: "Pop: {po" } });
    fireEvent.blur(box());
    await act(() =>
      refuse([{ level: "error", code: "template_syntax", path: "/symbol/label/text", message: MESSAGE }])
    );
    await userEvent.click(screen.getByRole("button", { name: "style_editor.insert_field" }));
    await userEvent.click(within(screen.getByRole("listbox")).getByText("name"));
    expect(store.get("symbol.label.text")).toBe("Pop: {po{name}");
  });

  it("picking a field after a refused template shows the field", async () => {
    const { store, refuse } = shell();
    await openGroup("style_editor.part_label");
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: "Pop: {po" } });
    fireEvent.blur(box());
    await act(() =>
      refuse([{ level: "error", code: "template_syntax", path: "/symbol/label/text", message: MESSAGE }])
    );
    const row = screen.getAllByText("style_editor.text")[0].parentElement as HTMLElement;
    await userEvent.click(within(row).getByRole("combobox"));
    await userEvent.click(within(screen.getByRole("listbox")).getByText("pop"));
    expect(store.get("symbol.label.text")).toBe("{pop}");
  });

  it("a box closed while it has the focus writes what was typed", async () => {
    const { store, unmount } = shell();
    await openGroup("style_editor.part_label");
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: "Pop: {pop}" } });
    unmount();
    expect(store.get("symbol.label.text")).toBe("Pop: {pop}");
  });
});
