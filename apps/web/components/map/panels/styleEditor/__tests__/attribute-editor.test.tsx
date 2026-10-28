import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EditorStore } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type SaveResult, type StyleIssue, StyleSaver, type StyleTransport } from "@/lib/style/save";

import { StyleEditor } from "@/components/map/panels/styleEditor/StyleEditor";
import { EMPTY_DATA } from "@/components/map/panels/styleEditor/context";
import { AttributeEditor } from "@/components/map/panels/styleEditor/editors/AttributeEditor";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { choose, openGroup, renderPanel, renderWithProviders } from "./renderPanel";

const FIELDS = [
  { name: "traffic", type: "number" as const, label: "traffic" },
  { name: "count", type: "integer" as const, label: "count" },
];

function setup(width: object) {
  const doc = { version: 1, kind: "vector", symbol: { line: { width } } } as LayerStyle;
  const saves: LayerStyle[] = [];
  const resolvers: Array<(r: SaveResult) => void> = [];
  const transport: StyleTransport = {
    save: (body) => {
      saves.push(body.document);
      return new Promise((resolve) => resolvers.push(resolve));
    },
    load: async () => ({ document: doc, revision: 1 }),
  };
  const store = new EditorStore({ saver: new StyleSaver({ transport, document: doc, revision: 1 }) });
  const answer = async (document: LayerStyle, issues: StyleIssue[] = []) => {
    resolvers.shift()?.({ ok: true, document, revision: saves.length + 1, issues });
    await vi.advanceTimersByTimeAsync(0);
  };
  renderWithProviders(
    <StyleEditor
      layer={{ id: "l1", name: "Routes", geometry: "line", kind: "vector" }}
      store={store}
      data={{
        ...EMPTY_DATA,
        geometry: "line",
        fields: FIELDS,
        fieldTypes: Object.fromEntries(FIELDS.map((f) => [f.name, f.type])),
      }}
      map={null}
      mapZoom={12}>
      <AttributeEditor path="symbol.line.width" />
    </StyleEditor>
  );
  return { store, saves, answer };
}

const rowOf = (label: string) => screen.getByText(label).parentElement as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("attribute editor", () => {
  it("changing the field saves at once and shows Values pending", async () => {
    const { store, saves, answer } = setup({
      field: "traffic",
      range: [1, 8],
      computed: { domain: [0, 500] },
    });
    expect(screen.getByText("style_editor.values_map")).toBeDefined();
    await userEvent.click(within(rowOf("style_editor.field")).getByRole("button"));
    await userEvent.click(screen.getByText("count"));
    expect(store.get("symbol.line.width.field")).toBe("count");
    expect(saves).toHaveLength(1);
    expect(screen.getByText("style_editor.values_pending")).toBeDefined();
    await act(() =>
      answer({
        version: 1,
        kind: "vector",
        symbol: { line: { width: { field: "count", range: [1, 8], computed: { domain: [2, 40] } } } },
      } as LayerStyle)
    );
    expect(screen.getByText("style_editor.values_map")).toBeDefined();
  });

  it("a slider drag and typing a range are one undo step each", () => {
    const { store } = setup({ field: "traffic", range: [1, 8], domain: [0, 500] });
    const smallest = within(rowOf("style_editor.range_smallest")).getByRole("slider");
    for (const value of [2, 3, 4, 5]) fireEvent.change(smallest, { target: { value } });
    expect(store.get("symbol.line.width.range")).toEqual([5, 8]);
    const from = screen.getByRole("textbox", { name: "style_editor.domain_from" });
    for (const value of ["1", "10", "100"]) fireEvent.change(from, { target: { value } });
    expect(store.get("symbol.line.width.domain")).toEqual([100, 500]);
    act(() => store.undo());
    expect(store.get("symbol.line.width.domain")).toEqual([0, 500]);
    act(() => store.undo());
    expect(store.get("symbol.line.width.range")).toEqual([1, 8]);
  });

  it("the range sliders keep the fixed value's bounds while dragged to the end", () => {
    const { store } = setup({ field: "traffic", range: [1, 8], domain: [0, 500] });
    const largest = () => within(rowOf("style_editor.range_largest")).getByRole("slider");
    expect(largest().getAttribute("aria-valuemax")).toBe("14");
    fireEvent.change(largest(), { target: { value: 14 } });
    expect(store.get("symbol.line.width.range")).toEqual([1, 14]);
    expect(largest().getAttribute("aria-valuemax")).toBe("14");
    // Both ends start at 0: the smallest value may draw nothing, so sizes stay proportional.
    for (const row of ["style_editor.range_smallest", "style_editor.range_largest"])
      expect(within(rowOf(row)).getByRole("slider").getAttribute("aria-valuemin")).toBe("0");
  });

  it("Fixed range writes and removes domain", async () => {
    const { store } = setup({ field: "traffic", range: [1, 8], computed: { domain: [0, 500] } });
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.fixed_range" }));
    expect(store.get("symbol.line.width.domain")).toEqual([0, 500]);
    fireEvent.change(screen.getByRole("textbox", { name: "style_editor.domain_from" }), {
      target: { value: "10" },
    });
    expect(store.get("symbol.line.width.domain")).toEqual([10, 500]);
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.fixed_range" }));
    expect(store.get("symbol.line.width.domain")).toBeUndefined();
  });

  it("log scale with a domain starting at 0 shows the domain issue's message", async () => {
    const message = "A log scale needs a domain that starts above 0.";
    const { store, answer } = setup({ field: "traffic", range: [1, 8], domain: [0, 100] });
    await choose("style_editor.scale", "style_editor.scale_linear", "style_editor.scale_log");
    expect(store.get("symbol.line.width.scale")).toBe("log");
    await act(() => vi.advanceTimersByTimeAsync(1100));
    await act(() =>
      answer(store.document, [
        { level: "error", code: "domain_invalid", path: "/symbol/line/width", message },
      ])
    );
    expect(screen.getByText(message)).toBeDefined();
  });

  it("a form that no longer follows a field says so", () => {
    setup({
      zoom: [
        [10, 1],
        [14, 4],
      ],
    });
    expect(screen.getByText("style_editor.not_by_attribute")).toBeDefined();
  });
});

describe("opening the attribute editor", () => {
  it("a row by attribute opens its editor one level deeper", async () => {
    renderPanel(
      <PopoverProvider>
        <SymbolSection />
      </PopoverProvider>,
      {
        document: {
          version: 1,
          kind: "vector",
          symbol: { line: { width: { field: "traffic", range: [1, 8] } } },
        } as LayerStyle,
        data: { geometry: "line", fields: FIELDS },
      }
    );
    await openGroup("style_editor.part_line");
    await userEvent.click(within(rowOf("style_editor.width")).getAllByRole("button")[0]);
    expect(screen.getByText("style_editor.by_attribute_title")).toBeDefined();
    expect(screen.getByText("style_editor.scale")).toBeDefined();
  });
});

describe("color by attribute", () => {
  it("says the palette is reversed in its row; Reverse itself is in the palette picker only", () => {
    renderPanel(
      <PopoverProvider>
        <AttributeEditor path="symbol.line.color" />
      </PopoverProvider>,
      {
        document: {
          version: 1,
          kind: "vector",
          symbol: { line: { color: { field: "traffic", palette: "goat:green", reverse: true } } },
        } as LayerStyle,
        data: { geometry: "line", fields: FIELDS },
      }
    );
    expect(screen.getByText("GOAT green, style_editor.reversed")).toBeDefined();
    expect(screen.queryByText("style_editor.reverse")).toBeNull();
  });

  it("offers a scale for colors too: square root spreads the low values over more of the palette", async () => {
    const { store } = renderPanel(
      <PopoverProvider>
        <AttributeEditor path="symbol.line.color" />
      </PopoverProvider>,
      {
        document: {
          version: 1,
          kind: "vector",
          symbol: { line: { color: { field: "traffic", palette: "goat:green" } } },
        } as LayerStyle,
        data: { geometry: "line", fields: FIELDS },
      }
    );
    await userEvent.click(within(rowOf("style_editor.scale")).getByRole("combobox"));
    expect(screen.getByText("style_editor.scale_sqrt_sub_color")).toBeDefined();
    await userEvent.click(screen.getByText("style_editor.scale_sqrt"));
    expect(store.get("symbol.line.color.scale")).toBe("sqrt");
  });
});
