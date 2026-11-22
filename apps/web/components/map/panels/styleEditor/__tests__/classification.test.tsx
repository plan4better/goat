import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
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

import { dragRow } from "./dragRows";
import { choose, i18n, openGroup, renderPanel, renderWithProviders } from "./renderPanel";

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
  ({ version: "1.0.0", kind: "vector", symbol, classify }) as unknown as LayerStyle;

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
  computed: {
    generated: {
      target: "fill.color",
      values: { c1: "#fef0d9", c2: "#fdcc8a", c3: "#fc8d59", c4: "#b30000" },
    },
  },
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
      { document: { version: "1.0.0", kind: "vector", symbol } as LayerStyle, data: DATA }
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
    // As many as an 8-bit raster band holds codes: one limit for vectors and rasters.
    expect(store.get("classify.0.count")).toBe(256);
    expect(saves).toHaveLength(1);
    expect(within(rowOf("style_editor.classes")).getByRole("combobox").textContent).toBe(
      "style_editor.count_all"
    );
  });

  /** The Classes menu's options, and which one is selected. */
  async function countMenu() {
    await userEvent.click(within(rowOf("style_editor.classes")).getByRole("combobox"));
    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    return { options, selected: options.findIndex((o) => o.getAttribute("aria-selected") === "true") };
  }

  it("numeric classes offer 2 to 13; a stored count outside them shows and stays", async () => {
    const { store } = shell(doc([{ ...QUANTILE, count: 15 }]));
    const { options, selected } = await countMenu();
    // 2 to 13, then the stored 15.
    expect(options).toHaveLength(13);
    expect(selected).toBe(12);
    expect(store.get("classify.0.count")).toBe(15);
    await userEvent.click(options[0]);
    expect(store.get("classify.0.count")).toBe(2);
  });

  it("numeric classes show a stored 10 as picked", async () => {
    shell(doc([{ ...QUANTILE, count: 10 }]));
    const { options, selected } = await countMenu();
    expect(options).toHaveLength(12);
    expect(selected).toBe(8);
  });

  it("numeric classes show a stored 256 as picked, not as All values", async () => {
    const { store } = shell(doc([{ ...QUANTILE, count: 256 }]));
    expect(within(rowOf("style_editor.classes")).getByRole("combobox").textContent).toBe(
      "style_editor.count_classes"
    );
    const { options, selected } = await countMenu();
    // 2 to 13, then the stored 256.
    expect(options).toHaveLength(13);
    expect(selected).toBe(12);
    expect(store.get("classify.0.count")).toBe(256);
  });

  it("categories show a stored top count the menu lacks as picked", async () => {
    const categories = { id: "land_use", field: "land_use", method: "categories", count: 10 };
    shell(doc([categories]));
    const { options, selected } = await countMenu();
    // All values, top 3, 5, 8, the stored 10, 12.
    expect(options).toHaveLength(6);
    expect(selected).toBe(4);
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

  /** The field's profile: its minimum (and a maximum). */
  const profiled = (min: number): Partial<StyleData> => {
    const profile = { min, max: 9000 };
    return { profiles: { get: () => profile, load: () => {}, subscribe: () => () => {} } };
  };
  const geometricOption = async () => {
    await userEvent.click(within(rowOf("style_editor.method")).getByRole("combobox"));
    return within(screen.getByRole("listbox"))
      .getByText("style_editor.method_geometric_interval")
      .closest("li") as HTMLElement;
  };

  it("Geometric intervals are offered for a field whose values lie above 0", async () => {
    const { store } = shell(doc([QUANTILE]), { ci: 0 }, profiled(12));
    const option = await geometricOption();
    expect(option.getAttribute("aria-disabled")).toBeNull();
    await userEvent.click(option);
    expect(store.get("classify.0.method")).toBe("geometric_interval");
  });

  it("Geometric intervals are disabled with a note for a field reaching 0 or below", async () => {
    shell(doc([QUANTILE]), { ci: 0 }, profiled(0));
    const option = await geometricOption();
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(within(option).getByText("style_editor.geometric_field_below")).toBeDefined();
  });

  it("the note names the field's lowest value", async () => {
    i18n.addResource("en", "common", "style_editor.geometric_field_below", "down to {{min}}");
    try {
      shell(doc([QUANTILE]), { ci: 0 }, profiled(-12.5));
      expect(within(await geometricOption()).getByText("down to -12.5")).toBeDefined();
    } finally {
      i18n.removeResourceBundle("en", "common");
    }
  });

  it("a hand-picked class color keeps the palette", async () => {
    const { store } = shell(doc([QUANTILE]));
    await userEvent.click(screen.getAllByRole("button", { name: "style_editor.class_color" })[0]);
    await userEvent.click(screen.getByRole("button", { name: "#11a5c9" }));
    expect(store.get("classify.0.classes.0.fill.color")).toBe("#11a5c9");
    expect(store.get("classify.0.palette")).toBe("colorbrewer:OrRd");
  });

  it("a class color picked by hand makes the palette row read Your own colors", async () => {
    const { store } = shell(doc([QUANTILE]));
    expect(screen.getByText("OrRd")).toBeDefined();
    act(() => store.set("classify.0.classes.1.fill.color", "#11a5c9"));
    expect(screen.queryByText("OrRd")).toBeNull();
    expect(screen.getByText("style_editor.palette_custom")).toBeDefined();
  });

  it("a palette picked for computed classes takes every class, also a color picked by hand", async () => {
    const { store, saves } = shell(doc([QUANTILE]));
    await userEvent.click(screen.getByText("OrRd"));
    await userEvent.click(screen.getByRole("button", { name: "Blues" }));
    expect(store.get("classify.0.palette")).toBe("colorbrewer:Blues");
    expect(store.get("classify.0.classes.0.fill")).toBeUndefined();
    expect(saves).toHaveLength(1);
  });

  it("widths typed into the classes read as your own values; a picked range takes every class again", async () => {
    const widths = {
      ...QUANTILE,
      target: "outline.width",
      classes: QUANTILE.classes.map((k, i) => ({ ...k, outline: { width: i + 1 } })),
    };
    const { store, saves } = shell(doc([widths]));
    const select = within(rowOf("style_editor.range")).getByRole("combobox");
    expect(select.textContent).toBe("style_editor.range_own");
    await userEvent.click(select);
    const preset = within(screen.getByRole("listbox")).getAllByRole("option")[1];
    const label = preset.textContent;
    await userEvent.click(preset);
    expect(store.get("classify.0.range")).toHaveLength(2);
    expect(within(rowOf("style_editor.range")).getByRole("combobox").textContent).toBe(label);
    expect(store.get("classify.0.classes.0.outline")).toBeUndefined();
    expect(store.get("classify.0.classes.0.fill.color")).toBe("#fef0d9");
    expect(saves).toHaveLength(1);
  });

  it("the panel's popovers close when its tab is left: they draw outside it", async () => {
    const document = doc([QUANTILE]);
    const transport: StyleTransport = {
      save: () => new Promise(() => undefined),
      load: async () => ({ document, revision: 1 }),
    };
    const store = new EditorStore({ saver: new StyleSaver({ transport, document, revision: 1 }) });
    function StyleTab() {
      const [shown, setShown] = useState(true);
      return (
        <>
          <button onClick={() => setShown(false)}>other tab</button>
          <StyleEditor
            layer={{ id: "l1", name: "Districts", geometry: "polygon", kind: "vector" }}
            store={store}
            data={{ ...EMPTY_DATA, ...DATA }}
            map={null}
            mapZoom={12}
            shown={shown}>
            <ClassificationEditor ci={0} />
          </StyleEditor>
        </>
      );
    }
    renderWithProviders(<StyleTab />);
    await userEvent.click(screen.getByText("OrRd"));
    expect(screen.getByRole("button", { name: "Blues" })).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "other tab" }));
    expect(screen.queryByRole("button", { name: "Blues" })).toBeNull();
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
    // Outline width runs 0 to 8 by 0.5: "7.5", three characters.
    expect(values().map(reserveOf)).toEqual(["3", "3", "3"]);
  });

  it("a value longer than the range widens the whole column", () => {
    const wide = {
      ...WIDTHS,
      classes: [...WIDTHS.classes.slice(0, 2), { id: "c", from: 20, outline: { width: 12.25 } }],
    };
    shell(doc([wide]));
    expect(values().map(reserveOf)).toEqual(["5", "5", "5"]);
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

  it("vector classes look as before", () => {
    // The list's grid: the value, a rule, the lower bound (manual breaks), the label, the count, show or hide, and
    // style this class; the head and every row are rows of it.
    const MANUAL = {
      id: "p",
      field: "population",
      method: "manual",
      classes: [{ to: 10 }, { from: 10, to: 20 }, { from: 20 }],
    };
    shell(doc([MANUAL]));
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-class-row]"));
    const grid = rows[0].parentElement as HTMLElement;
    expect(getComputedStyle(grid).gridTemplateColumns).toBe("auto 1px auto minmax(0, 1fr) auto auto auto");
    const head = grid.firstElementChild as HTMLElement;
    expect(head.hasAttribute("data-class-row")).toBe(false);
    for (const row of [head, ...rows]) {
      expect(getComputedStyle(row).gridTemplateColumns).toBe("subgrid");
      expect(getComputedStyle(row).gridColumn.replace(/ /g, "")).toBe("1/-1");
    }
    // The head: the property, a rule, the field over the bound and label columns, the count, two empty cells.
    expect(Array.from(head.children).map((el) => el.textContent)).toEqual([
      "style_editor.color",
      "",
      "population",
      "features",
      "",
      "",
    ]);
    expect(getComputedStyle(head.children[2]).gridColumn).toBe("span 2");
    // The first class has no bound: its label takes the bound's column too; the others have seven cells.
    expect(rows[0].children.length).toBe(6);
    expect(getComputedStyle(rows[0].children[2]).gridColumn).toBe("span 2");
    expect((rows[0].children[2].querySelector("input") as HTMLInputElement).placeholder).toBe(
      "style_editor.range_under 10"
    );
    expect(rows[1].children.length).toBe(7);
    expect(rows[1].children[2].querySelector("input")?.getAttribute("aria-label")).toBe(
      "style_editor.lower_bound"
    );
    expect(getComputedStyle(rows[1].children[3]).gridColumn).not.toBe("span 2");
    expect(within(rows[1]).getByRole("button", { name: "style_editor.style_this_class" })).toBeDefined();
    expect(within(rows[1]).getByRole("button", { name: "style_editor.hide_class" })).toBeDefined();
  });

  it("a computed classification's grid has no bound column", () => {
    shell(doc([QUANTILE]));
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-class-row]"));
    const grid = rows[0].parentElement as HTMLElement;
    expect(getComputedStyle(grid).gridTemplateColumns).toBe("auto 1px minmax(0, 1fr) auto auto auto");
    expect(rows.map((row) => row.children.length)).toEqual([6, 6, 6, 6]);
    expect(getComputedStyle(rows[0].children[2]).gridColumn).not.toBe("span 2");
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

  it("a class dragged to another row's place moves there; the classes are picked by hand from then on", async () => {
    const { store } = shell(doc([LAND_USE]), { ci: 0 }, withValues);
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-class-row]"));
    await dragRow(rows[1], rows[0]);
    expect((store.get("classify.0.classes") as Array<{ id: string }>).map((c) => c.id)).toEqual(["c2", "c1"]);
    expect(store.get("classify.0.count")).toBeUndefined();
  });

  const dragSecondOntoFirst = async () => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-class-row]"));
    await dragRow(rows[1], rows[0]);
  };

  it("a class's open values go on with that class when another class is dragged beside it", async () => {
    const { store } = shell(doc([LAND_USE]), { ci: 0 }, withValues);
    await userEvent.click(screen.getByRole("button", { name: "home" }));
    await dragSecondOntoFirst();
    expect((store.get("classify.0.classes") as Array<{ id: string }>).map((c) => c.id)).toEqual(["c2", "c1"]);
    await userEvent.click(screen.getByRole("menuitem", { name: /forest/ }));
    expect(store.get("classify.0.classes")).toEqual([
      { id: "c2", values: ["shop"], fill: { color: "#fc8d62" } },
      { id: "c1", values: ["home", "forest"], fill: { color: "#66c2a5" } },
    ]);
  });

  it("Escape during a drag puts the class back and leaves its open values open", async () => {
    const { store } = shell(doc([LAND_USE]), { ci: 0 }, withValues);
    await userEvent.click(screen.getByRole("button", { name: "home" }));
    expect(screen.getByText("style_editor.in_this_class · 1")).toBeDefined();
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-class-row]"));
    await dragRow(rows[1], rows[0], () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape", code: "Escape" });
    });
    expect((store.get("classify.0.classes") as Array<{ id: string }>).map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(screen.getByText("style_editor.in_this_class · 1")).toBeDefined();
    // Escape with no drag closes it as before.
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    await act(async () => {});
    expect(screen.queryByText("style_editor.in_this_class · 1")).toBeNull();
  });

  it("classes without ids: a class's open values close when another class is dragged beside it", async () => {
    const plain = { ...LAND_USE, classes: LAND_USE.classes.map(({ id: _id, ...rest }) => rest) };
    shell(doc([plain]), { ci: 0 }, withValues);
    await userEvent.click(screen.getByRole("button", { name: "home" }));
    expect(screen.getByText("style_editor.in_this_class · 1")).toBeDefined();
    await dragSecondOntoFirst();
    expect(screen.queryByText("style_editor.in_this_class · 1")).toBeNull();
  });

  it("a class's color picker never writes to the class dragged into its place", async () => {
    const { store } = shell(doc([LAND_USE]), { ci: 0 }, withValues);
    await userEvent.click(screen.getAllByRole("button", { name: "style_editor.class_color" })[0]);
    expect(screen.getByRole("button", { name: "#d7301f" })).toBeDefined();
    await dragSecondOntoFirst();
    const pick = screen.queryByRole("button", { name: "#d7301f" });
    if (pick) await userEvent.click(pick);
    // Class c2, now first, keeps its color.
    expect(store.get("classify.0.classes.0")).toEqual({
      id: "c2",
      values: ["shop"],
      fill: { color: "#fc8d62" },
    });
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

  it("Other and No data the data has none of stand back, with a count of 0", () => {
    // Every value of the field is in a class, and the server found no feature without a value.
    unique.values = unique.values.slice(0, 2);
    unique.total = 2;
    const stored = {
      ...LAND_USE,
      other: { fill: { color: "#aaaaaa" } },
      no_data: { fill: { color: "#cccccc" } },
      computed: { ...LAND_USE.computed, no_data: false, other: false },
    };
    shell(doc([stored]), { ci: 0 }, withValues);
    for (const key of ["style_editor.other", "style_editor.no_data"]) {
      const row = screen.getByPlaceholderText(key).closest("[data-class-row]") as HTMLElement;
      expect(row.getAttribute("data-absent"), key).toBe("true");
      expect(within(row).getByText("0")).toBeDefined();
    }
  });

  it("they stay as they are while the data has such features", () => {
    const stored = {
      ...LAND_USE,
      other: { fill: { color: "#aaaaaa" } },
      no_data: { fill: { color: "#cccccc" } },
      computed: { ...LAND_USE.computed, no_data: true, other: true },
    };
    shell(doc([stored]), { ci: 0 }, withValues);
    for (const key of ["style_editor.other", "style_editor.no_data"]) {
      const row = screen.getByPlaceholderText(key).closest("[data-class-row]") as HTMLElement;
      expect(row.getAttribute("data-absent"), key).toBeNull();
    }
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
