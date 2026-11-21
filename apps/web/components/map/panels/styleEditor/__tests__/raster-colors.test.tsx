import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { equalIntervalClasses } from "@/lib/style/editor/raster";
import type { LayerStyle } from "@/lib/style/generated/types";
import type { RasterInfo } from "@/lib/style/raster/metadata";

import { shareText } from "@/components/map/panels/styleEditor/editors/RasterClassList";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { RasterColorSection } from "@/components/map/panels/styleEditor/sections/RasterColorSection";

import { choose, renderPanel } from "./renderPanel";

// The map's loaded description of a formula's values: its range is the formula's (0 to 50), which the panel has no
// statistics for.
vi.mock("@/lib/api/rasters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/rasters")>()),
  useLoadedRasterValues: (url?: string) =>
    url?.includes("formula=") ? { range: [0, 50], integer: false, version: "1", encoding: {} } : undefined,
}));

const MAP = {
  getBounds: () => ({
    toArray: () => [
      [10, 50],
      [12, 52],
    ],
  }),
  getZoom: () => 9,
};
const stats = (p2: number | null, p98: number | null) => [
  { index: 1, min: p2, max: p98, p2, p98, values: null },
];
const INFO: RasterInfo = {
  bands: 1,
  bits: [32],
  colorTable: false,
  integer: false,
  names: [""],
  stats: stats(3.2, 97.5),
};

function setup(render: object, extra: object = {}, info: RasterInfo | null = INFO) {
  return renderPanel(
    <PopoverProvider>
      <RasterColorSection />
    </PopoverProvider>,
    {
      document: { version: "1.0.0", kind: "raster", render, ...extra } as LayerStyle,
      data: { raster: { dataset: "d1", info: info ?? undefined } },
      map: MAP,
    }
  );
}

const rowOf = (label: string) => screen.getAllByText(label).at(-1)!.parentElement as HTMLElement;
const openColors = () => userEvent.click(within(rowOf("style_editor.colors")).getAllByRole("button")[0]);

describe("raster colors", () => {
  it("Manual with four classes over 0 to 100 breaks at 25, 50 and 75; a hidden class writes visible false", async () => {
    const { store } = setup({ type: "continuous", palette: "goat:elevation", domain: [0, 100] });
    await openColors();
    await choose(
      "style_editor.method",
      "style_editor.raster_method_continuous",
      "style_editor.method_manual"
    );
    await choose("style_editor.classes", "5", "4");
    expect(store.get("render.classify")).toEqual({
      method: "manual",
      classes: [{ to: 25 }, { from: 25, to: 50 }, { from: 50, to: 75 }, { from: 75 }],
    });
    const eyes = screen.getAllByRole("button", { name: "style_editor.hide_class" });
    await userEvent.click(eyes[1]);
    expect(store.get("render.classify.classes.1.visible")).toBe(false);
  });

  it("classes offer 2 to 12; a file with more classes shows its count", async () => {
    const classes = Array.from({ length: 15 }, (_, i) => ({
      ...(i ? { from: i } : {}),
      ...(i < 14 ? { to: i + 1 } : {}),
    }));
    const { store } = setup({
      type: "continuous",
      palette: "goat:elevation",
      domain: [0, 15],
      classify: { method: "manual", classes },
    });
    await openColors();
    await choose("style_editor.classes", "15", "2");
    expect(store.get("render.classify.classes")).toEqual([{ to: 7.5 }, { from: 7.5 }]);
    await choose("style_editor.classes", "2", "12");
    expect((store.get("render.classify.classes") as unknown[]).length).toBe(12);
  });

  it("a palette picked for classes takes every class, also a color picked by hand", async () => {
    const { store } = setup({
      type: "continuous",
      palette: "goat:elevation",
      domain: [0, 100],
      classify: {
        method: "manual",
        palette: "colorbrewer:Greys",
        classes: [{ to: 50, color: "#ff0000" }, { from: 50 }],
      },
    });
    await openColors();
    await userEvent.click(screen.getByText("Elevation"));
    await userEvent.click(screen.getByRole("button", { name: "Blues" }));
    expect(store.get("render.palette")).toBe("colorbrewer:Blues");
    expect(store.get("render.classify")).toEqual({ method: "manual", classes: [{ to: 50 }, { from: 50 }] });
    await userEvent.click(screen.getByRole("button", { name: "style_editor.reverse" }));
    expect(store.get("render.reverse")).toBe(true);
  });

  it("From the data writes the band's 2nd to 98th percentile; a band without values says so", async () => {
    const { store, unmount } = setup({ type: "continuous", palette: "goat:elevation", domain: [0, 1] });
    await openColors();
    // The button says which values it takes.
    expect(screen.getByText("style_editor.range_from_data_note")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "style_editor.range_from_data" }));
    expect(store.get("render.domain")).toEqual([3, 98]);
    unmount();
    const empty = setup(
      { type: "continuous", palette: "goat:elevation", domain: [0, 1] },
      {},
      {
        ...INFO,
        stats: stats(null, null),
      }
    );
    await openColors();
    await userEvent.click(screen.getByRole("button", { name: "style_editor.range_from_data" }));
    expect(empty.store.get("render.domain")).toEqual([0, 1]);
    expect(screen.getByText("style_editor.range_nothing_found")).toBeDefined();
  });

  it("typing the range writes it", async () => {
    const { store } = setup({ type: "continuous", palette: "goat:elevation", domain: [0, 100] });
    await openColors();
    fireEvent.change(screen.getByRole("textbox", { name: "style_editor.range_lowest" }), {
      target: { value: "10" },
    });
    fireEvent.blur(screen.getByRole("textbox", { name: "style_editor.range_lowest" }));
    expect(store.get("render.domain")).toEqual([10, 100]);
  });

  it("own colors start as five stops over the range; back to a palette keeps their ends as the range", async () => {
    const { store } = setup({ type: "continuous", palette: "goat:elevation", domain: [0, 100] });
    await openColors();
    await choose("style_editor.colors_kind", "style_editor.colors_palette", "style_editor.colors_stops");
    const stops = store.get("render.stops") as Array<{ value: number }>;
    expect(stops.map((s) => s.value)).toEqual([0, 25, 50, 75, 100]);
    expect(store.get("render.palette")).toBeUndefined();
    await choose("style_editor.colors_kind", "style_editor.colors_stops", "style_editor.colors_palette");
    expect(store.get("render.stops")).toBeUndefined();
    expect(store.get("render.domain")).toEqual([0, 100]);
  });

  it("typing a stop value keeps the row under the cursor; the stops sort when the box is left", async () => {
    const stops = [180, 260, 340, 440].map((value) => ({ value, color: "#111111" }));
    const { store } = setup({ type: "continuous", stops });
    await openColors();
    const third = () => screen.getAllByRole("textbox", { name: "style_editor.stop_value" })[2];
    for (const value of ["3", "30", "300"]) fireEvent.change(third(), { target: { value } });
    expect((store.get("render.stops") as Array<{ value: number }>).map((s) => s.value)).toEqual([
      180, 260, 300, 440,
    ]);
    const first = screen.getAllByRole("textbox", { name: "style_editor.stop_value" })[0];
    fireEvent.change(first, { target: { value: "500" } });
    expect((store.get("render.stops") as Array<{ value: number }>)[0].value).toBe(500);
    fireEvent.blur(first);
    expect((store.get("render.stops") as Array<{ value: number }>).map((s) => s.value)).toEqual([
      260, 300, 440, 500,
    ]);
  });

  it("own colors say what cells outside the stops do: Transparent hides them, End colors draws them again", async () => {
    const stops = [0, 100].map((value) => ({ value, color: "#111111" }));
    const { store } = setup({ type: "continuous", stops });
    await openColors();
    await choose("style_editor.outside", "style_editor.outside_clamp", "style_editor.outside_hide");
    expect(store.get("render.outside")).toBe("hide");
    await choose("style_editor.outside", "style_editor.outside_hide", "style_editor.outside_clamp");
    expect(store.get("render.outside")).toBeUndefined();
  });

  it("a palette over a range keeps its Outside row", async () => {
    setup({ type: "continuous", palette: "goat:elevation", domain: [0, 100], outside: "hide" });
    await openColors();
    expect(within(rowOf("style_editor.outside")).getByRole("combobox").textContent).toBe(
      "style_editor.outside_hide"
    );
  });

  it("a palette in classes has no Outside row", async () => {
    setup({
      type: "continuous",
      palette: "goat:elevation",
      domain: [0, 100],
      classify: { method: "manual", classes: [{ to: 50 }, { from: 50 }] },
    });
    await openColors();
    expect(screen.queryByText("style_editor.outside")).toBeNull();
  });

  it("hillshade colors start from the band's values; a band without values keeps them off and says so", async () => {
    const empty = setup({ type: "hillshade" }, {}, { ...INFO, stats: stats(null, null) });
    await openColors();
    await userEvent.click(within(rowOf("style_editor.hillshade_colors")).getByRole("checkbox"));
    expect(empty.store.get("render.palette")).toBeUndefined();
    expect(screen.getByText("style_editor.range_nothing_found")).toBeDefined();
    empty.unmount();
    const { store } = setup({ type: "hillshade" });
    await openColors();
    await userEvent.click(within(rowOf("style_editor.hillshade_colors")).getByRole("checkbox"));
    await waitFor(() => expect(store.get("render.domain")).toEqual([3, 98]));
    expect(store.get("render.palette")).toBe("goat:elevation");
  });

  it("hillshade on flat terrain says under Strength that it is raised; steep terrain has no note", () => {
    // 3.2 to 97.5: raised 8 times (the largest power of two that keeps the relief within 1000).
    const { unmount } = setup({ type: "hillshade", exaggeration: 0.8 });
    const note = within(rowOf("style_editor.hillshade_strength").parentElement as HTMLElement);
    expect(note.getByText("style_editor.hillshade_raised")).toBeDefined();
    unmount();
    setup({ type: "hillshade" }, {}, { ...INFO, stats: stats(0, 2500) });
    expect(screen.queryByText("style_editor.hillshade_raised")).toBeNull();
  });

  it("a hillshade of a band formula takes the range of the map's values description for the note", () => {
    setup(
      { type: "hillshade", band: { name: "Twice", expression: "b1 * 2" } },
      {},
      { ...INFO, stats: stats(0, 2500) }
    );
    // 0 to 50: raised 16 times, although band 1's statistics are steep.
    expect(screen.getByText("style_editor.hillshade_raised")).toBeDefined();
  });

  it("hillshade shows the accent only for the standard method", async () => {
    const { store } = setup({ type: "hillshade" });
    expect(screen.getByText("style_editor.hillshade_accent")).toBeDefined();
    await choose(
      "style_editor.hillshade_method",
      "style_editor.hillshade_method_standard",
      "style_editor.hillshade_method_igor"
    );
    expect(store.get("render.method")).toBe("igor");
    expect(screen.queryByText("style_editor.hillshade_accent")).toBeNull();
  });

  it("a new category on a file with a color table takes the file's color for its value", async () => {
    const { store } = renderPanel(
      <PopoverProvider>
        <RasterColorSection />
      </PopoverProvider>,
      {
        document: {
          version: "1.0.0",
          kind: "raster",
          render: { type: "categorical", classes: [{ value: 1, color: "#ff0000" }] },
        } as LayerStyle,
        data: {
          raster: {
            dataset: "d1",
            info: {
              bands: 1,
              bits: [8],
              colorTable: true,
              integer: true,
              tableColors: { 0: "#000000", 1: "#ff0000", 2: "#228b22" },
              stats: [],
            },
          },
        },
      }
    );
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_category" }));
    expect((store.get("render.classes") as Array<{ value: number }>).at(-1)).toEqual({
      value: 2,
      color: "#228b22",
    });
  });

  it("a new category takes the next value; other values in gray or not drawn", async () => {
    const classes = [1, 2, 3, 4, 5, 6].map((value) => ({ value, color: "#4a90c2" }));
    const { store } = setup({ type: "categorical", classes });
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_category" }));
    expect((store.get("render.classes") as Array<{ value: number }>).at(-1)).toEqual({
      value: 7,
      color: "#9aa3ad",
    });
    await act(async () => {});
    await choose(
      "style_editor.other_values",
      "style_editor.other_values_transparent",
      "style_editor.other_values_gray"
    );
    expect(store.get("render.other_color")).toBe("#cccccc");
    await choose(
      "style_editor.other_values",
      "style_editor.other_values_gray",
      "style_editor.other_values_transparent"
    );
    expect(store.get("render.other_color")).toBeUndefined();
  });

  it("the palette row names the palette, reversed in words", async () => {
    setup({ type: "continuous", palette: "colorbrewer:Spectral", reverse: true, domain: [0, 100] });
    await openColors();
    expect(within(rowOf("style_editor.palette")).getByRole("button").textContent).toBe(
      "Spectral, style_editor.reversed"
    );
    expect(screen.queryByText(/colorbrewer:/)).toBeNull();
  });

  it("the colours section is called Colors; hillshade and categories keep their names", () => {
    const { unmount } = setup({ type: "continuous", palette: "goat:elevation", domain: [0, 100] });
    expect(screen.getByRole("heading").textContent).toBe("style_editor.colors");
    unmount();
    const hillshade = setup({ type: "hillshade" });
    expect(screen.getByRole("heading").textContent).toBe("style_editor.raster_type_hillshade");
    hillshade.unmount();
    setup({ type: "categorical", classes: [{ value: 1, color: "#ff0000" }] });
    expect(screen.getByRole("heading").textContent).toBe("style_editor.raster_type_categorical");
  });

  it("stops and manual classes have distinct names", async () => {
    setup({
      type: "continuous",
      palette: "goat:elevation",
      domain: [0, 100],
      classify: { method: "manual", classes: [{ to: 50 }, { from: 50 }] },
    });
    expect(within(rowOf("style_editor.colors")).getByRole("button").textContent).toBe(
      "style_editor.raster_manual_n"
    );
    await openColors();
    // Manual classes carry the vectors' name for manual breaks; own colors at values are a kind of colors.
    expect(within(rowOf("style_editor.method")).getByRole("combobox").textContent).toBe(
      "style_editor.method_manual"
    );
    await userEvent.click(within(rowOf("style_editor.colors_kind")).getByRole("combobox"));
    const kinds = within(screen.getByRole("listbox"))
      .getAllByRole("option")
      .map((el) => el.textContent ?? "");
    expect(kinds.join("|")).toContain("style_editor.colors_stops");
    expect(kinds.join("|")).not.toContain("style_editor.palette_custom");
  });

  it("a new category waits for the file's info", () => {
    setup({ type: "categorical", classes: [{ value: 1, color: "#ff0000" }] }, {}, null);
    expect(
      (screen.getByRole("button", { name: "style_editor.add_category" }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("rows wait for the file's info", () => {
    // The raster service has not answered yet.
    setup({ type: "continuous", palette: "goat:elevation", domain: [0, 100] }, {}, null);
    expect((within(rowOf("style_editor.colors")).getByRole("button") as HTMLButtonElement).disabled).toBe(
      true
    );
  });
});

// A band of 0 to 100 with one cell sample per bin (50 bins of 2), and the breaks the raster service computed for it.
const BREAKS = {
  quantile: { "3": [33, 66], "5": [20, 40, 60, 80] },
  natural_breaks: { "5": [10, 30, 50, 90] },
  std_dev: { "5": [30, 70] },
};
const CLASSED: RasterInfo = {
  ...INFO,
  stats: [
    {
      index: 1,
      min: 0,
      max: 100,
      p2: 3.2,
      p98: 97.5,
      values: null,
      histogram: {
        counts: Array.from({ length: 50 }, () => 1),
        edges: Array.from({ length: 51 }, (_, i) => i * 2),
      },
      breaks: BREAKS,
    },
  ],
};
const QUANTILES = {
  type: "continuous",
  palette: "goat:elevation",
  classify: {
    method: "quantile",
    count: 5,
    classes: [{ to: 20 }, { from: 20, to: 40 }, { from: 40, to: 60 }, { from: 60, to: 80 }, { from: 80 }],
  },
};
const classRows = () => Array.from(document.querySelectorAll<HTMLElement>("[data-class-row]"));
const optionOf = (label: string) =>
  within(screen.getByRole("listbox")).getByText(label).closest("li") as HTMLElement;

describe("raster classes and categories on the shared grid", () => {
  it("raster classes render on the shared grid", async () => {
    setup(QUANTILES, {}, CLASSED);
    await openColors();
    const rows = classRows();
    expect(rows).toHaveLength(5);
    // The columns of the vector class list: the color, a rule, the range as the name's placeholder, the share, the eye;
    // a raster class has no style of its own, so no column for it.
    const grid = rows[0].parentElement as HTMLElement;
    expect(getComputedStyle(grid).gridTemplateColumns).toBe("auto 1px minmax(0, 1fr) auto auto");
    const head = grid.firstElementChild as HTMLElement;
    expect(Array.from(head.children).map((el) => el.textContent)).toEqual([
      "style_editor.color",
      "",
      "style_editor.band_n",
      "style_editor.share",
      "",
    ]);
    for (const row of rows) {
      expect(row.children).toHaveLength(5);
      expect(within(row).getByRole("button", { name: "style_editor.class_color" })).toBeDefined();
      expect(within(row).getByRole("textbox", { name: "style_editor.class_name" })).toBeDefined();
      expect(within(row).getByRole("button", { name: "style_editor.hide_class" })).toBeDefined();
      // Ten of the fifty bins in each class.
      expect(within(row).getByText("20%")).toBeDefined();
    }
    const names = screen.getAllByRole("textbox", { name: "style_editor.class_name" }) as HTMLInputElement[];
    // Open ends read the band's minimum and maximum, as the legend writes them.
    expect(names.map((n) => n.placeholder)).toEqual([
      "0 style_editor.range_to 20",
      "20 style_editor.range_to 40",
      "40 style_editor.range_to 60",
      "60 style_editor.range_to 80",
      "80 style_editor.range_to 100",
    ]);
  });

  it("a histogram shows the band with the breaks", async () => {
    setup(QUANTILES, {}, CLASSED);
    await openColors();
    const svg = Array.from(document.querySelectorAll("svg")).find((el) =>
      el.querySelector("rect")
    ) as SVGElement;
    expect(svg.querySelectorAll("rect")).toHaveLength(50);
    expect(svg.querySelectorAll("line[stroke-dasharray]")).toHaveLength(4);
  });

  it("switching to quantiles uses the precomputed breaks without a request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { store } = setup({ type: "continuous", palette: "goat:elevation", domain: [3, 98] }, {}, CLASSED);
    await openColors();
    await choose(
      "style_editor.method",
      "style_editor.raster_method_continuous",
      "style_editor.method_quantile"
    );
    const classes = store.get("render.classify.classes") as Array<{ from?: number; to?: number }>;
    expect(classes.slice(1).map((c) => c.from)).toEqual(BREAKS.quantile["5"]);
    expect(classes.slice(0, -1).map((c) => c.to)).toEqual(BREAKS.quantile["5"]);
    expect(store.get("render.classify.method")).toBe("quantile");
    expect(store.get("render.classify.count")).toBe(5);
    // The style check classifies the band's values without a range as the service did, so the classes stay.
    expect(store.get("render.domain")).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("equal intervals need no breaks from the server", async () => {
    const none: RasterInfo = { ...CLASSED, stats: [{ ...CLASSED.stats[0], breaks: {} }] };
    const { store } = setup({ type: "continuous", palette: "goat:elevation", domain: [0, 90] }, {}, none);
    await openColors();
    await choose(
      "style_editor.method",
      "style_editor.raster_method_continuous",
      "style_editor.method_equal_interval"
    );
    expect(store.get("render.classify")).toEqual({
      method: "equal_interval",
      count: 5,
      classes: equalIntervalClasses([0, 90], 5),
    });
    expect(store.get("render.domain")).toEqual([0, 90]);
  });

  it("methods without breaks for the band are disabled with a note", async () => {
    const none: RasterInfo = { ...CLASSED, stats: [{ ...CLASSED.stats[0], breaks: {} }] };
    setup({ type: "continuous", palette: "goat:elevation", domain: [0, 90] }, {}, none);
    await openColors();
    await userEvent.click(within(rowOf("style_editor.method")).getByRole("combobox"));
    for (const method of ["quantile", "natural_breaks", "std_dev"]) {
      const option = optionOf(`style_editor.method_${method}`);
      expect(option.getAttribute("aria-disabled")).toBe("true");
      expect(within(option).getByText("style_editor.no_breaks_for_band")).toBeDefined();
    }
    for (const method of ["equal_interval", "manual"])
      expect(optionOf(`style_editor.method_${method}`).getAttribute("aria-disabled")).toBeNull();
    // What used to wait for the raster service is there now.
    expect(screen.queryByText("style_editor.needs_raster_service")).toBeNull();
  });

  it("a band formula has no precomputed breaks: its computed methods are disabled", async () => {
    setup(
      {
        type: "continuous",
        palette: "goat:elevation",
        domain: [0, 50],
        band: { name: "Twice", expression: "b1 * 2" },
      },
      {},
      CLASSED
    );
    await openColors();
    await userEvent.click(within(rowOf("style_editor.method")).getByRole("combobox"));
    expect(optionOf("style_editor.method_quantile").getAttribute("aria-disabled")).toBe("true");
    // The histogram is band 1's, not the formula's: none.
    await userEvent.keyboard("{Escape}");
    expect(document.querySelector("svg[viewBox] rect")).toBeNull();
  });

  it("the classes offer the counts the service computed breaks for", async () => {
    const { store } = setup(QUANTILES, {}, CLASSED);
    await openColors();
    await userEvent.click(within(rowOf("style_editor.classes")).getByRole("combobox"));
    const counts = within(screen.getByRole("listbox"))
      .getAllByRole("option")
      .filter((el) => el.classList.contains("MuiMenuItem-root"));
    // 3 and 5: the fixture's lists.
    expect(counts).toHaveLength(2);
    await userEvent.click(counts[0]);
    expect(store.get("render.classify.count")).toBe(3);
    expect(store.get("render.classify.classes")).toEqual([{ to: 33 }, { from: 33, to: 66 }, { from: 66 }]);
  });

  it("the colors row names the method and the number of classes", () => {
    setup(QUANTILES, {}, CLASSED);
    expect(within(rowOf("style_editor.colors")).getByRole("button").textContent).toBe(
      "style_editor.raster_classes_n"
    );
  });

  it("categories are offered from the file's values", async () => {
    const codes: RasterInfo = {
      bands: 1,
      bits: [8],
      colorTable: true,
      integer: true,
      tableColors: { 1: "#ff0000", 2: "#00ff00", 5: "#0000ff" },
      stats: [
        {
          index: 1,
          min: 1,
          max: 5,
          p2: 1,
          p98: 5,
          values: [1, 2, 5],
          histogram: { counts: [10, 30, 0, 0, 60], edges: [1, 1.8, 2.6, 3.4, 4.2, 5] },
        },
      ],
    };
    const { store } = setup({ type: "categorical", classes: [{ value: 1, color: "#ff0000" }] }, {}, codes);
    // The class on the grid with its share.
    const [row] = classRows();
    expect(within(row).getByText("10%")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_category" }));
    const menu = screen.getByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    // The codes not used yet, each with its share.
    expect(items.map((el) => el.textContent)).toEqual(["230%", "560%"]);
    await userEvent.click(within(menu).getByText("5"));
    expect(store.get("render.classes")).toEqual([
      { value: 1, color: "#ff0000" },
      { value: 5, color: "#0000ff" },
    ]);
  });

  it("every category shows its share from the file's cell counts", async () => {
    // A paletted file whose codes 0, 1 and 2 fall in one histogram bin: the service counts each code.
    const paletted: RasterInfo = {
      bands: 1,
      bits: [8],
      colorTable: true,
      integer: true,
      tableColors: { 0: "#ffffff", 1: "#ff0000", 2: "#00ff00", 205: "#0000ff" },
      stats: [
        {
          index: 1,
          min: 0,
          max: 205,
          p2: 0,
          p98: 205,
          values: [0, 1, 2, 205],
          counts: [50, 25, 15, 10],
          histogram: { counts: [90, 10], edges: [0, 102.5, 205] },
        },
      ],
    };
    const classes = [0, 1, 2].map((value) => ({ value, color: "#cccccc" }));
    setup({ type: "categorical", classes }, {}, paletted);
    expect(classRows().map((row) => row.textContent)).toEqual(["050%", "125%", "215%"]);
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_category" }));
    expect(
      within(screen.getByRole("menu"))
        .getAllByRole("menuitem")
        .map((el) => el.textContent)
    ).toEqual(["20510%"]);
  });

  it("a share above nothing but under a thousandth reads as under 0.1 %", () => {
    expect(shareText(0.000066, "en")).toBe("< 0.1%");
    expect(shareText(0.000066, "de")).toBe("< 0,1\u00a0%");
    expect(shareText(0, "en")).toBe("0%");
    expect(shareText(0.004, "en")).toBe("0.4%");
    expect(shareText(undefined, "en")).toBeUndefined();
  });

  it("a stored heads and tails classification names its method and has no range of its own", async () => {
    setup(
      {
        type: "continuous",
        palette: "goat:elevation",
        domain: [0, 100],
        classify: {
          method: "heads_and_tails",
          count: 3,
          classes: [{ to: 30 }, { from: 30, to: 60 }, { from: 60 }],
        },
      },
      {},
      CLASSED
    );
    await openColors();
    expect(within(rowOf("style_editor.method")).getByRole("combobox").textContent).toBe(
      "style_editor.method_heads_and_tails"
    );
    expect(screen.queryByText("style_editor.range")).toBeNull();
    expect(screen.queryByRole("button", { name: "style_editor.range_from_data" })).toBeNull();
  });

  it("a category's editor and a new category are titled with its code, as its row and the legend", async () => {
    const codes: RasterInfo = {
      bands: 1,
      bits: [8],
      colorTable: false,
      integer: true,
      stats: [{ index: 1, min: 1, max: 15, p2: 1, p98: 15, values: null }],
    };
    setup({ type: "categorical", classes: [{ value: 15, color: "#ff0000" }] }, {}, codes);
    await userEvent.click(screen.getByRole("button", { name: "15" }));
    expect(
      (screen.getByRole("textbox", { name: "style_editor.category_name" }) as HTMLInputElement).placeholder
    ).toBe("15");
    await userEvent.keyboard("{Escape}");
    // Without the band's codes, Add a class starts the next value and opens its editor, titled with it.
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_category" }));
    expect(screen.getAllByText("16").length).toBeGreaterThan(0);
    expect(screen.queryByText("style_editor.value_n")).toBeNull();
  });

  it("back to Continuous after quantiles, the range starts from the band's 2nd to 98th percentile again", async () => {
    const { store } = setup({ type: "continuous", palette: "goat:elevation", domain: [3, 98] }, {}, CLASSED);
    await openColors();
    await choose(
      "style_editor.method",
      "style_editor.raster_method_continuous",
      "style_editor.method_quantile"
    );
    expect(store.get("render.domain")).toBeUndefined();
    await choose(
      "style_editor.method",
      "style_editor.method_quantile",
      "style_editor.raster_method_continuous"
    );
    // 3.2 to 97.5, in whole numbers around them: not the band's minimum and maximum (0 to 100).
    expect(store.get("render.domain")).toEqual([3, 98]);
    expect(
      (screen.getByRole("textbox", { name: "style_editor.range_lowest" }) as HTMLInputElement).value
    ).toBe("3");
  });
});
