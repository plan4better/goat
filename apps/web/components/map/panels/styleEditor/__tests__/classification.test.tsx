import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NO_DATA_COLOR, removeClassification } from "@/lib/style/editor/classify";
import { EditorStore } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type SaveResult, type StyleIssue, StyleSaver, type StyleTransport } from "@/lib/style/save";

import { StyleEditor } from "@/components/map/panels/styleEditor/StyleEditor";
import { EMPTY_DATA, type StyleData } from "@/components/map/panels/styleEditor/context";
import { classLabel } from "@/components/map/panels/styleEditor/editors/ClassList";
import { ClassificationEditor } from "@/components/map/panels/styleEditor/editors/ClassificationEditor";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { choose, openGroup, renderPanel, renderWithProviders } from "./renderPanel";

type Unique = { value: string; count: number };
/** What the unique values process answers: the most frequent values, and the matches of a search. */
const unique = vi.hoisted(() => ({
  values: [] as Unique[],
  total: 0,
  matches: [] as Unique[],
  searched: [] as string[],
}));
vi.mock("@/lib/api/processes", async (original) => ({
  ...(await original<typeof import("@/lib/api/processes")>()),
  useUniqueValues: (layerId: string | undefined, _field: string, options?: { filter?: string }) => {
    if (!layerId) return { data: undefined };
    if (options?.filter) {
      unique.searched.push(options.filter);
      return { data: { attribute: "", total: unique.matches.length, values: unique.matches } };
    }
    return { data: { attribute: "", total: unique.total, values: unique.values } };
  },
}));

const FIELDS = [
  { name: "land_use", type: "string" as const, label: "land_use" },
  { name: "population", type: "integer" as const, label: "population" },
];
const DATA: Partial<StyleData> = {
  geometry: "polygon",
  fields: FIELDS,
  fieldTypes: Object.fromEntries(FIELDS.map((f) => [f.name, f.type])),
};

const doc = (classify: object[], symbol: object = { fill: { color: "#cccccc" } }) =>
  ({ version: 1, kind: "vector", symbol, classify }) as unknown as LayerStyle;

const QUANTILE = {
  id: "population",
  field: "population",
  method: "quantile",
  count: 4,
  palette: "colorbrewer:OrRd",
  classes: [
    { id: "c1", to: 2800, fill: { color: "#fef0d9" } },
    { id: "c2", from: 2800, to: 3600, fill: { color: "#fdcc8a" } },
    { id: "c3", from: 3600, to: 6300, fill: { color: "#fc8d59" } },
    { id: "c4", from: 6300, fill: { color: "#b30000" } },
  ],
};

/** The editor inside the full shell, over a transport whose replies the test gives. */
function shell(
  document: LayerStyle,
  editor: { ci: number; id?: string } = { ci: 0 },
  data: Partial<StyleData> = {}
) {
  const saves: LayerStyle[] = [];
  const resolvers: Array<(r: SaveResult) => void> = [];
  const transport: StyleTransport = {
    save: (body) => {
      saves.push(body.document);
      return new Promise((resolve) => resolvers.push(resolve));
    },
    load: async () => ({ document, revision: 1 }),
  };
  const store = new EditorStore({ saver: new StyleSaver({ transport, document, revision: 1 }) });
  const answer = async (reply: LayerStyle, issues: StyleIssue[] = []) => {
    resolvers.shift()?.({ ok: true, document: reply, revision: saves.length + 1, issues });
    await vi.advanceTimersByTimeAsync(0);
  };
  renderWithProviders(
    <StyleEditor
      layer={{ id: "l1", name: "Districts", geometry: "polygon", kind: "vector" }}
      store={store}
      data={{ ...EMPTY_DATA, ...DATA, ...data }}
      map={null}
      mapZoom={12}>
      <ClassificationEditor ci={editor.ci} id={editor.id} />
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

describe("adding a classification", () => {
  const panel = (symbol: object) =>
    renderPanel(
      <PopoverProvider>
        <SymbolSection />
      </PopoverProvider>,
      { document: { version: 1, kind: "vector", symbol } as LayerStyle, data: DATA }
    );

  async function byClasses(part: string, row: string, field: string) {
    await openGroup(part);
    await userEvent.click(within(rowOf(row)).getByRole("button", { name: "style_editor.value_mode_aria" }));
    await userEvent.click(within(screen.getByRole("menu")).getByText("style_editor.mode_classes"));
    await userEvent.click(screen.getByText(field));
  }

  it("adding from By classes on fill color writes a categories classification without target", async () => {
    const { store } = panel({ fill: { color: "#cccccc" } });
    await byClasses("style_editor.part_fill", "style_editor.color", "land_use");
    expect(store.get("classify")).toEqual([
      {
        id: "land_use",
        field: "land_use",
        method: "categories",
        count: 8,
        no_data: { fill: { color: NO_DATA_COLOR } },
      },
    ]);
    expect(screen.getByText("style_editor.by_classes_title")).toBeDefined();
  });

  it("the row is active while the classification it opened from the mode menu shows", async () => {
    panel({ fill: { color: "#cccccc" } });
    await byClasses("style_editor.part_fill", "style_editor.color", "land_use");
    expect(screen.getByText("style_editor.by_classes_title")).toBeDefined();
    // The panel's row (the class list's head names the property too, in the popover after it).
    const row = screen.getAllByText("style_editor.color")[0].parentElement as HTMLElement;
    expect(row.hasAttribute("data-active")).toBe(true);
  });

  it("adding on outline width for a number field writes quantile, count 5 and the target, no range", async () => {
    const { store } = panel({ fill: {}, outline: { width: 1 } });
    await byClasses("style_editor.part_outline", "style_editor.width", "population");
    expect(store.get("classify")).toEqual([
      { id: "population", field: "population", method: "quantile", count: 5, target: "outline.width" },
    ]);
  });
});

describe("classification editor", () => {
  it("a method change saves at once and shows Computing classes", async () => {
    const { saves } = shell(doc([QUANTILE]));
    expect(screen.queryByText("style_editor.computing_classes")).toBeNull();
    await choose("style_editor.method", "style_editor.method_quantile", "style_editor.method_equal_interval");
    expect(saves).toHaveLength(1);
    expect(screen.getByText("style_editor.computing_classes")).toBeDefined();
  });

  it("All values asks for the most categories the format allows, so the server computes them", async () => {
    const categories = { id: "land_use", field: "land_use", method: "categories", count: 8 };
    const { store, saves } = shell(doc([categories]));
    await choose("style_editor.classes", "style_editor.count_top", "style_editor.count_all");
    expect(store.get("classify.0.count")).toBe(100);
    expect(saves).toHaveLength(1);
    expect(within(rowOf("style_editor.classes")).getByRole("combobox").textContent).toBe(
      "style_editor.count_all"
    );
  });

  it("an open editor follows its classification by id when another is removed", () => {
    const categories = { id: "land_use", field: "land_use", method: "categories", count: 8 };
    const { store } = shell(doc([categories, QUANTILE]), { ci: 1, id: "population" });
    expect(within(rowOf("style_editor.field")).getByText("population")).toBeDefined();
    act(() => store.update((d) => removeClassification(d, 0)));
    expect(within(rowOf("style_editor.field")).getByText("population")).toBeDefined();
    expect(screen.queryByText("style_editor.not_classified")).toBeNull();
  });

  it("Head/tail breaks is offered", async () => {
    shell(doc([QUANTILE]));
    await userEvent.click(within(rowOf("style_editor.method")).getByRole("combobox"));
    expect(
      within(screen.getByRole("listbox")).getByText("style_editor.method_heads_and_tails")
    ).toBeDefined();
  });

  it("a hand-picked class color keeps the palette", async () => {
    const { store } = shell(doc([QUANTILE]));
    await userEvent.click(screen.getAllByRole("button", { name: "style_editor.class_color" })[0]);
    await userEvent.click(screen.getByRole("button", { name: "#11a5c9" }));
    expect(store.get("classify.0.classes.0.fill.color")).toBe("#11a5c9");
    expect(store.get("classify.0.palette")).toBe("colorbrewer:OrRd");
  });

  it("a manual bound sets the previous class's to", () => {
    const { store } = shell(
      doc([
        {
          id: "p",
          field: "population",
          method: "manual",
          classes: [{ to: 10 }, { from: 10, to: 20 }, { from: 20 }],
        },
      ])
    );
    const bounds = screen.getAllByRole("textbox", { name: "style_editor.lower_bound" });
    expect(bounds).toHaveLength(2);
    fireEvent.change(bounds[1], { target: { value: "15" } });
    expect(store.get("classify.0.classes")).toEqual([{ to: 10 }, { from: 10, to: 15 }, { from: 15 }]);
  });

  it("automatic labels read under 2,800, 2,800 to 3,600, 6,300 and more", () => {
    shell(doc([QUANTILE]));
    const names = screen.getAllByRole("textbox", { name: "style_editor.class_name" }) as HTMLInputElement[];
    expect(names.map((n) => n.placeholder)).toEqual([
      "style_editor.range_under 2,800",
      "2,800 style_editor.range_to 3,600",
      "3,600 style_editor.range_to 6,300",
      "6,300 style_editor.range_and_more",
    ]);
  });

  it("with the data's minimum and maximum computed, the open classes read them", () => {
    const STAMP = { at: "2026-10-27T14:28:39Z", data: "ducklake:1", scope: "dataset" };
    shell(doc([{ ...QUANTILE, computed: { ...STAMP, domain: [1000, 9000] } }]));
    const names = screen.getAllByRole("textbox", { name: "style_editor.class_name" }) as HTMLInputElement[];
    expect(names.map((n) => n.placeholder)).toEqual([
      "1,000 style_editor.range_to 2,800",
      "2,800 style_editor.range_to 3,600",
      "3,600 style_editor.range_to 6,300",
      "6,300 style_editor.range_to 9,000",
    ]);
  });

  it("the conflict note shows the server's message", async () => {
    const message = 'Hidden: the classification on "land_use" also sets fill color and comes later.';
    const { store, answer } = shell(
      doc([QUANTILE, { id: "land_use", field: "land_use", method: "categories", count: 8 }])
    );
    await choose("style_editor.method", "style_editor.method_quantile", "style_editor.method_natural_breaks");
    await act(() =>
      answer(store.document, [
        { level: "warning", code: "classify_target_conflict", path: "/classify/population", message },
      ])
    );
    expect(screen.getByText(message)).toBeDefined();
  });
});

describe("class values", () => {
  const WIDTHS = {
    id: "population",
    field: "population",
    method: "quantile",
    count: 3,
    target: "outline.width",
    classes: [
      { id: "a", to: 10, outline: { width: 1 } },
      { id: "b", from: 10, to: 20, outline: { width: 4 } },
      { id: "c", from: 20, outline: { width: 8 } },
    ],
  };
  const values = () =>
    screen.getAllByRole("textbox", { name: "style_editor.class_value" }) as HTMLInputElement[];
  const reserveOf = (input: HTMLElement) => input.closest("[data-reserve]")?.getAttribute("data-reserve");

  it("number values are one column: each keeps room for the longest value of the property's range", () => {
    shell(doc([WIDTHS]));
    // Outline width runs 0 to 8 by 1: one digit.
    expect(values().map(reserveOf)).toEqual(["1", "1", "1"]);
  });

  it("a value longer than the range widens the whole column", () => {
    const wide = {
      ...WIDTHS,
      classes: [...WIDTHS.classes.slice(0, 2), { id: "c", from: 20, outline: { width: 12 } }],
    };
    shell(doc([wide]));
    expect(values().map(reserveOf)).toEqual(["2", "2", "2"]);
  });

  it("a head names the columns: the property the classes set, the field, the features", () => {
    shell(doc([WIDTHS]));
    // Outline width's row label in the panel, the field's label, the count.
    expect(screen.getByText("style_editor.width")).toBeDefined();
    expect(screen.getAllByText("population").length).toBeGreaterThan(0);
    expect(screen.getByText("features")).toBeDefined();
  });

  it("No data without a value of its own shows the layer's value it draws with", () => {
    shell(doc([{ ...WIDTHS, no_data: {} }], { fill: { color: "#cccccc" }, outline: { width: 3 } }));
    const noData = values()[3];
    expect(noData.value).toBe("");
    expect(noData.placeholder).toBe("3");
  });

  it("without a layer value, No data shows the default", () => {
    shell(doc([{ ...WIDTHS, no_data: {} }]));
    expect(values()[3].placeholder).toBe("1");
  });

  it("manual lower bounds are one column too", () => {
    shell(
      doc([
        {
          id: "p",
          field: "population",
          method: "manual",
          classes: [{ to: 10 }, { from: 10, to: 2000.5 }, { from: 2000.5 }],
        },
      ])
    );
    const bounds = screen.getAllByRole("textbox", { name: "style_editor.lower_bound" });
    expect(bounds.map(reserveOf)).toEqual(["6", "6"]);
  });

  it("with manual breaks a class's picker is titled with its whole range", async () => {
    shell(
      doc([
        {
          id: "p",
          field: "population",
          method: "manual",
          classes: [
            { to: 10, fill: { color: "#fef0d9" } },
            { from: 10, fill: { color: "#b30000" } },
          ],
        },
      ])
    );
    await userEvent.click(screen.getAllByRole("button", { name: "style_editor.class_color" })[1]);
    expect(screen.getByText("10 style_editor.range_and_more")).toBeDefined();
  });

  it("with manual breaks the range reads on from the typed bound: the first class keeps its whole range", () => {
    shell(
      doc([
        {
          id: "p",
          field: "population",
          method: "manual",
          classes: [{ to: 10 }, { from: 10, to: 20 }, { from: 20 }],
        },
      ])
    );
    const names = screen.getAllByRole("textbox", { name: "style_editor.class_name" }) as HTMLInputElement[];
    expect(names.map((n) => n.placeholder)).toEqual([
      "style_editor.range_under 10",
      "style_editor.range_to 20",
      "style_editor.range_and_more",
    ]);
  });

  describe("with the field's minimum and maximum computed", () => {
    const computed = { at: "t", data: "f", scope: "dataset", domain: [0.73, 100] };
    const MANUAL = {
      id: "p",
      field: "population",
      method: "manual",
      classes: [{ to: 10 }, { from: 10, to: 20 }, { from: 20 }],
      computed,
    };

    it("manual breaks read them: the last class runs to the maximum", async () => {
      shell(doc([MANUAL]));
      const names = screen.getAllByRole("textbox", { name: "style_editor.class_name" }) as HTMLInputElement[];
      expect(names.map((n) => n.placeholder)).toEqual([
        "0.73 style_editor.range_to 10",
        "style_editor.range_to 20",
        "style_editor.range_to 100",
      ]);
      await userEvent.click(screen.getAllByRole("button", { name: "style_editor.class_color" })[2]);
      expect(screen.getByText("20 style_editor.range_to 100")).toBeDefined();
    });

    it("a last bound at the maximum keeps and more", () => {
      shell(doc([{ ...MANUAL, classes: [{ to: 10 }, { from: 10, to: 100 }, { from: 100 }] }]));
      const names = screen.getAllByRole("textbox", { name: "style_editor.class_name" }) as HTMLInputElement[];
      expect(names.map((n) => n.placeholder).at(-1)).toBe("style_editor.range_and_more");
    });
  });
});

describe("categories picked by hand", () => {
  const LAND_USE = {
    id: "land_use",
    field: "land_use",
    method: "categories",
    count: 8,
    classes: [
      { id: "c1", values: ["home"], fill: { color: "#66c2a5" } },
      { id: "c2", values: ["shop"], fill: { color: "#fc8d62" } },
    ],
    computed: { at: "2026-10-27T14:28:39Z", data: "ducklake:1", scope: "dataset" },
  };
  const withValues = { layerId: "l1", featureCount: 160 };
  beforeEach(() => {
    unique.values = [
      { value: "home", count: 100 },
      { value: "shop", count: 50 },
      { value: "forest", count: 10 },
    ];
    unique.total = 3;
    unique.matches = [];
    unique.searched = [];
  });

  it("a class's values open beside it; ticking another class's value moves it, and the classes are picked by hand", async () => {
    const { store } = shell(doc([LAND_USE]), { ci: 0 }, withValues);
    await userEvent.click(screen.getByRole("button", { name: "home" }));
    expect(screen.getByText("style_editor.in_this_class · 1")).toBeDefined();
    await userEvent.click(screen.getByRole("menuitem", { name: /shop/ }));
    expect(store.get("classify.0.classes")).toEqual([
      { id: "c1", values: ["home", "shop"], fill: { color: "#66c2a5" } },
      { id: "c2", values: [], fill: { color: "#fc8d62" } },
    ]);
    expect(store.get("classify.0.count")).toBeUndefined();
    expect(store.get("classify.0.computed")).toBeUndefined();
    expect(screen.getByText("style_editor.pick_values")).toBeDefined();
    expect(within(rowOf("style_editor.classes")).getByRole("combobox").textContent).toBe(
      "style_editor.count_by_hand"
    );
  });

  it("Add class takes the first palette color no class has and opens its values", async () => {
    const { store } = shell(doc([LAND_USE]), { ci: 0 }, withValues);
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_class" }));
    expect(store.get("classify.0.classes.2")).toEqual({ id: "c3", values: [], fill: { color: "#8da0cb" } });
    expect(screen.getByText("style_editor.no_values_yet")).toBeDefined();
    await userEvent.click(screen.getByRole("menuitem", { name: /forest/ }));
    expect(store.get("classify.0.classes.2.values")).toEqual(["forest"]);
  });

  it("the class's bin removes it; its values fall to Other", async () => {
    const { store } = shell(doc([LAND_USE]), { ci: 0 }, withValues);
    await userEvent.click(screen.getByRole("button", { name: "shop" }));
    await userEvent.click(screen.getByRole("button", { name: "style_editor.remove_class" }));
    expect(store.get("classify.0.classes")).toEqual([
      { id: "c1", values: ["home"], fill: { color: "#66c2a5" } },
    ]);
  });

  it("only the class list scrolls: the settings above it stay in view", () => {
    shell(doc([LAND_USE]), { ci: 0 }, withValues);
    expect(screen.getByRole("button", { name: "home" }).closest("[data-popover-scroll]")).not.toBeNull();
    expect(screen.getByText("style_editor.method").closest("[data-popover-scroll]")).toBeNull();
  });

  it("Other counts the features of values in no class", () => {
    shell(doc([LAND_USE]), { ci: 0 }, withValues);
    const other = screen.getByPlaceholderText("style_editor.other").closest("div")
      ?.parentElement as HTMLElement;
    expect(within(other).getByText("10")).toBeDefined();
  });

  it("a search asks the server for matches across all values", async () => {
    unique.matches = [{ value: "forest", count: 10 }];
    shell(doc([LAND_USE]), { ci: 0 }, withValues);
    await userEvent.click(screen.getByRole("button", { name: "home" }));
    await userEvent.type(screen.getByRole("textbox", { name: "style_editor.search_values" }), "for");
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(screen.getByText("style_editor.value_matches")).toBeDefined();
    expect(unique.searched.at(-1)).toBe(
      JSON.stringify({ op: "like", args: [{ property: "land_use" }, "%for%"] })
    );
    expect(screen.getByRole("menuitem", { name: /forest/ })).toBeDefined();
  });

  it("a search that only finds the class's own values narrows them and says nothing else matches", async () => {
    unique.matches = [{ value: "home", count: 100 }];
    const document = doc([{ ...LAND_USE, classes: [{ id: "c1", values: ["home", "shop"] }] }]);
    shell(document, { ci: 0 }, withValues);
    await userEvent.click(screen.getByRole("button", { name: "home, shop" }));
    await userEvent.type(screen.getByRole("textbox", { name: "style_editor.search_values" }), "hom");
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(screen.getByText("style_editor.in_this_class · 1")).toBeDefined();
    expect(screen.getByText("style_editor.no_other_matches")).toBeDefined();
  });

  it("a field whose values nearly all differ says each class colors one feature", () => {
    unique.total = 158;
    shell(doc([LAND_USE]), { ci: 0 }, withValues);
    expect(screen.getByText("style_editor.id_field_hint")).toBeDefined();
  });
});

describe("classLabel", () => {
  it("a category's values read with the classification's unit, as the legend writes them", () => {
    const c = { field: "share", method: "categories", target: "marker.size", unit: "pixels", classes: [] };
    expect(classLabel(c, { values: [100] }, (key) => key, "en")).toBe("100 pixels");
    expect(classLabel({ ...c, unit: undefined }, { values: [16.67] }, (key) => key, "en")).toBe("16.67");
    expect(classLabel(c, { values: [100], name: "Large" }, (key) => key, "en")).toBe("Large");
  });
});
