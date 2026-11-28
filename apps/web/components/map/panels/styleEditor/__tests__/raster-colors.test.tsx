import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { classesFromBreaks as classesOf, equalIntervalClasses } from "@/lib/style/editor/raster";
import type { LayerStyle } from "@/lib/style/generated/types";
import { rasterColorSpec } from "@/lib/style/raster/color";
import type { RasterInfo } from "@/lib/style/raster/metadata";

import { IssuesProvider } from "@/components/map/panels/styleEditor/IssueNotice";
import { renderColors, shareText } from "@/components/map/panels/styleEditor/editors/RasterClassList";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { RasterColorSection } from "@/components/map/panels/styleEditor/sections/RasterColorSection";

import { dragRow } from "./dragRows";
import { choose, i18n, renderPanel } from "./renderPanel";

// Each class row the grid draws, counted: an edit draws only the rows it changes.
const rowRenders = vi.hoisted(() => ({ count: 0, rows: new Set<number | undefined>() }));
vi.mock("@/components/map/panels/styleEditor/editors/ClassGrid", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/map/panels/styleEditor/editors/ClassGrid")>();
  return {
    ...actual,
    ClassGridRow: (props: Parameters<typeof actual.ClassGridRow>[0]) => {
      rowRenders.count += 1;
      rowRenders.rows.add(props.index);
      return actual.ClassGridRow(props);
    },
  };
});

// Each row of a sortable list drawn, counted through its sortable hook (the rows draw it inside the grid's row).
const sortableRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("@dnd-kit/sortable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/sortable")>();
  return {
    ...actual,
    useSortable: (args: Parameters<typeof actual.useSortable>[0]) => {
      sortableRenders.count += 1;
      return actual.useSortable(args);
    },
  };
});

// The rows' eyes drawn, counted: a row's cells draw again only for that row.
const eyeRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("@p4b/ui/components/Icon", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@p4b/ui/components/Icon")>();
  return {
    ...actual,
    Icon: (props: Parameters<typeof actual.Icon>[0]) => {
      if (props.iconName === actual.ICON_NAME.EYE || props.iconName === actual.ICON_NAME.EYE_SLASH)
        eyeRenders.count += 1;
      return actual.Icon(props);
    },
  };
});

// The map's loaded description of a formula's values: its range is the formula's (0 to 50), which the panel has no
// statistics for.
vi.mock("@/lib/api/rasters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/rasters")>()),
  useLoadedRasterValues: (url?: string) =>
    url?.includes("formula=") ? { range: [0, 50], integer: false, version: "1", encoding: {} } : undefined,
  loadFormulaSample: async () => ({ min: 0.4, max: 49.6, values: [], formula: true }),
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

  it("classes offer 2 to 13; a file with more classes shows its count", async () => {
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
    await choose("style_editor.classes", "2", "13");
    expect((store.get("render.classify.classes") as unknown[]).length).toBe(13);
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

  it("From the data on a band formula takes the formula's values, not band 1's", async () => {
    const { store } = setup({
      type: "continuous",
      band: { name: "Half", expression: "b1 / 2" },
      palette: "goat:elevation",
      domain: [0, 1],
    });
    await openColors();
    await userEvent.click(screen.getByRole("button", { name: "style_editor.range_from_data" }));
    await waitFor(() => expect(store.get("render.domain")).toEqual([0, 50]));
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

  it("a stop's open color picker closes when a stop is removed, added or sorted: it never writes to another stop", async () => {
    const colors = ["#111111", "#222222", "#333333", "#444444"];
    const stops = [100, 200, 300, 400].map((value, i) => ({ value, color: colors[i] }));
    const { store } = setup({ type: "continuous", stops });
    await openColors();
    const values = () => (store.get("render.stops") as Array<{ value: number }>).map((s) => s.value);
    const picker = () => screen.queryByRole("textbox", { name: "color_value" });
    const valueBoxes = () => screen.getAllByRole("textbox", { name: "style_editor.stop_value" });
    // A stop's color button in its row (read while no picker is open: the picker's title is the stop's label too).
    const colorButton = (i: number) =>
      within(screen.getAllByText("style_editor.stop_n")[i].parentElement as HTMLElement).getByRole("button", {
        name: "style_editor.pick_color",
      });
    const open = async (i: number) => {
      await userEvent.click(colorButton(i));
      expect(picker()).not.toBeNull();
    };
    await open(1);
    await userEvent.click(screen.getAllByRole("button", { name: "style_editor.remove_stop" })[0]);
    expect(values()).toEqual([200, 300, 400]);
    expect(picker()).toBeNull();
    await open(1);
    fireEvent.change(valueBoxes()[0], { target: { value: "500" } });
    fireEvent.blur(valueBoxes()[0]);
    expect(values()).toEqual([300, 400, 500]);
    expect(picker()).toBeNull();
    await open(0);
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_stop" }));
    expect(values()).toEqual([300, 400, 500, 501]);
    expect(picker()).toBeNull();
    // Opened again, the picker writes its own stop's color.
    await open(1);
    const box = screen.getAllByRole("textbox", { name: "color_value" }).at(-1) as HTMLElement;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "#abcdef" } });
    expect(store.get("render.stops.1")).toEqual({ value: 400, color: "#abcdef" });
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

  it("a palette in classes has an Outside row too", async () => {
    const { store } = setup({
      type: "continuous",
      palette: "goat:elevation",
      domain: [0, 100],
      classify: { method: "manual", classes: [{ to: 50 }, { from: 50 }] },
    });
    await openColors();
    await choose("style_editor.outside", "style_editor.outside_clamp", "style_editor.outside_hide");
    expect(store.get("render.outside")).toBe("hide");
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
    await openColors();
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_class" }));
    expect((store.get("render.classes") as Array<{ value: number }>).at(-1)).toEqual({
      value: 2,
      color: "#228b22",
    });
  });

  it("a new category takes the next value; other values in gray or not drawn", async () => {
    const classes = [1, 2, 3, 4, 5, 6].map((value) => ({ value, color: "#4a90c2" }));
    const { store } = setup({ type: "categorical", classes });
    await openColors();
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_class" }));
    expect((store.get("render.classes") as Array<{ value: number }>).at(-1)).toEqual({
      value: 7,
      color: "#9aa3ad",
    });
    await act(async () => {});
    await userEvent.keyboard("{Escape}");
    // The Other values row: its eye draws the values without a class in gray, or leaves them out.
    const other = within(
      screen.getByText("style_editor.other_values").closest("[data-class-row]") as HTMLElement
    );
    await userEvent.click(other.getByRole("button", { name: "style_editor.show_class" }));
    expect(store.get("render.other_color")).toBe("#cccccc");
    await userEvent.click(other.getByRole("button", { name: "style_editor.hide_class" }));
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

  it("each colours section is named after what it draws, as Draw as names it; its row is Colors", () => {
    const { unmount } = setup({ type: "continuous", palette: "goat:elevation", domain: [0, 100] });
    expect(screen.getByRole("heading").textContent).toBe("style_editor.raster_type_continuous");
    // No section and row of one name: the row alone is Colors.
    expect(screen.getAllByText("style_editor.colors")).toHaveLength(1);
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

  it("categories wait for the file's info", () => {
    setup({ type: "categorical", classes: [{ value: 1, color: "#ff0000" }] }, {}, null);
    expect((within(rowOf("style_editor.colors")).getByRole("button") as HTMLButtonElement).disabled).toBe(
      true
    );
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

  it("open ends read the band's minimum and maximum over a narrower colour range, or the range with values outside left out", async () => {
    const band: RasterInfo = {
      ...INFO,
      stats: [{ ...INFO.stats[0], min: -38.94, max: 189.14, p2: 32, p98: 119 }],
    };
    const render = {
      type: "continuous",
      palette: "goat:elevation",
      domain: [32, 119],
      classify: { method: "equal_interval", count: 5, classes: equalIntervalClasses([32, 119], 5) },
    };
    const ends = () => {
      const names = screen.getAllByRole("textbox", { name: "style_editor.class_name" }) as HTMLInputElement[];
      return [names[0].placeholder, names[names.length - 1].placeholder];
    };
    const clamped = setup(render, {}, band);
    await openColors();
    expect(ends()).toEqual(["-38.94 style_editor.range_to 49.4", "101.6 style_editor.range_to 189.14"]);
    clamped.unmount();
    // Values outside left out: the classes end at the colour range.
    setup({ ...render, outside: "hide" }, {}, band);
    await openColors();
    expect(ends()).toEqual(["32 style_editor.range_to 49.4", "101.6 style_editor.range_to 119"]);
  });

  it("classes whose two ends read the same number read with the decimals the legend reads them with", async () => {
    const tiny: RasterInfo = { ...INFO, stats: stats(0.00003, 0.00012) };
    setup(
      {
        type: "continuous",
        palette: "goat:elevation",
        classify: {
          method: "quantile",
          count: 3,
          classes: [{ to: 0.00005 }, { from: 0.00005, to: 0.00007 }, { from: 0.00007 }],
        },
      },
      {},
      tiny
    );
    await openColors();
    const names = screen.getAllByRole("textbox", { name: "style_editor.class_name" }) as HTMLInputElement[];
    expect(names.map((n) => n.placeholder)).toEqual([
      "0.00003 style_editor.range_to 0.00005",
      "0.00005 style_editor.range_to 0.00007",
      "0.00007 style_editor.range_to 0.00012",
    ]);
  });

  it("class colors, the strip and the bars take a classification's own palette, as the map draws them", async () => {
    const render = {
      type: "continuous",
      palette: "colorbrewer:Spectral",
      domain: [0, 100],
      classify: { method: "manual", palette: "colorbrewer:Blues", classes: [{ to: 50 }, { from: 50 }] },
    };
    const drawn = (spec: ReturnType<typeof rasterColorSpec>) =>
      spec?.kind === "classes" ? spec.classes.map((c) => c.color) : [];
    expect(drawn(rasterColorSpec(render))).toEqual(["#f7fbff", "#08306b"]);
    expect(renderColors(render).colors).toEqual(["#f7fbff", "#08306b"]);
    // Its own reverse too; a class's own color stays.
    const reversed = { ...render, classify: { ...render.classify, reverse: true } };
    expect(renderColors(reversed).colors).toEqual(drawn(rasterColorSpec(reversed)));
    expect(renderColors(reversed).colors).toEqual(["#08306b", "#f7fbff"]);
    const picked = {
      ...render,
      classify: { ...render.classify, classes: [{ to: 50, color: "#ff0000" }, { from: 50 }] },
    };
    expect(renderColors(picked).colors).toEqual(["#ff0000", "#08306b"]);
    setup(render);
    await openColors();
    const swatches = screen.getAllByRole("button", { name: "style_editor.class_color" });
    expect(swatches.map((s) => getComputedStyle(s).backgroundColor)).toEqual([
      "rgb(247, 251, 255)",
      "rgb(8, 48, 107)",
    ]);
  });

  it("a class color with its own transparency lies over the swatch checkerboard", async () => {
    setup({
      type: "continuous",
      palette: ["#08306b80", "#f7fbff"],
      domain: [0, 100],
      classify: { method: "manual", classes: [{ to: 50 }, { from: 50 }] },
    });
    await openColors();
    const [clear, opaque] = screen
      .getAllByRole("button", { name: "style_editor.class_color" })
      .map((s) => getComputedStyle(s).backgroundImage);
    expect(clear.match(/linear-gradient/g)).toHaveLength(3);
    expect(opaque).toBe("none");
  });

  it("a histogram shows the band with the breaks", async () => {
    setup(QUANTILES, {}, CLASSED);
    await openColors();
    const svg = Array.from(document.querySelectorAll("svg")).find((el) =>
      el.querySelector("rect")
    ) as SVGElement;
    expect(svg.querySelectorAll("rect")).toHaveLength(50);
    // The breaks stand on it as handles to drag; quantiles have no range of their own, so no ends.
    const handles = screen.getAllByRole("slider");
    expect(handles.map((h) => [h.getAttribute("data-handle"), h.getAttribute("aria-valuenow")])).toEqual([
      ["break", "20"],
      ["break", "40"],
      ["break", "60"],
      ["break", "80"],
    ]);
  });

  it("the histogram marks the range: its ends move as the range boxes type them", async () => {
    const { store } = setup({ type: "continuous", palette: "goat:elevation", domain: [10, 90] }, {}, CLASSED);
    await openColors();
    const [lowest, highest] = screen.getAllByRole("slider");
    expect(lowest.getAttribute("aria-label")).toBe("style_editor.range_lowest");
    expect([lowest.getAttribute("aria-valuenow"), highest.getAttribute("aria-valuenow")]).toEqual([
      "10",
      "90",
    ]);
    expect([lowest.getAttribute("data-handle"), highest.getAttribute("data-handle")]).toEqual(["end", "end"]);
    // A step is a hundredth of the band's span (0 to 100).
    fireEvent.keyDown(lowest, { key: "ArrowRight" });
    expect(store.get("render.domain")).toEqual([11, 90]);
    fireEvent.keyDown(screen.getAllByRole("slider")[1], { key: "PageDown" });
    expect(store.get("render.domain")).toEqual([11, 80]);
    const boxes = screen.getAllByRole("textbox", {
      name: /style_editor.range_(lowest|highest)/,
    }) as HTMLInputElement[];
    expect(boxes.map((b) => b.value)).toEqual(["11", "80"]);
  });

  it("equal intervals split the dragged range again; a dragged break makes them manual and keeps the others", async () => {
    const equal = {
      type: "continuous",
      palette: "goat:elevation",
      domain: [0, 100],
      classify: { method: "equal_interval", count: 4, classes: equalIntervalClasses([0, 100], 4) },
    };
    const { store } = setup(equal, {}, CLASSED);
    await openColors();
    expect(screen.getAllByRole("slider").map((h) => h.getAttribute("data-handle"))).toEqual([
      "end",
      "end",
      "break",
      "break",
      "break",
    ]);
    fireEvent.keyDown(screen.getAllByRole("slider")[1], { key: "PageDown" });
    expect(store.get("render.domain")).toEqual([0, 90]);
    expect(store.get("render.classify")).toEqual({
      method: "equal_interval",
      count: 4,
      classes: equalIntervalClasses([0, 90], 4),
    });
    // The middle break (45) one step down: manual breaks, the others where they were.
    const middle = screen.getAllByRole("slider")[3];
    expect(middle.getAttribute("aria-label")).toBe("style_editor.class_break_n");
    fireEvent.keyDown(middle, { key: "ArrowLeft" });
    expect(store.get("render.classify")).toEqual({
      method: "manual",
      classes: [{ to: 22.5 }, { from: 22.5, to: 44 }, { from: 44, to: 67.5 }, { from: 67.5 }],
    });
    expect(store.get("render.domain")).toEqual([0, 90]);
  });

  it("a break of a computed method dragged on the histogram makes the classes manual", async () => {
    const { store } = setup(QUANTILES, {}, CLASSED);
    await openColors();
    fireEvent.keyDown(screen.getAllByRole("slider")[0], { key: "ArrowRight", shiftKey: true });
    expect(store.get("render.classify")).toEqual({
      method: "manual",
      classes: [{ to: 30 }, { from: 30, to: 40 }, { from: 40, to: 60 }, { from: 60, to: 80 }, { from: 80 }],
    });
    // Manual breaks cover a range, as the Range row: its ends join the breaks on the histogram.
    const handles = screen.getAllByRole("slider");
    expect(handles.map((h) => h.getAttribute("data-handle"))).toEqual([
      "end",
      "end",
      "break",
      "break",
      "break",
      "break",
    ]);
    // A break stops a step short of its neighbour.
    fireEvent.keyDown(handles[2], { key: "End" });
    expect(store.get("render.classify.classes.0")).toEqual({ to: 39 });
  });

  it("a byte band's range of 0 to 255 over bars of 7 to 107: a step away from the bars leaves an end where it is", async () => {
    const byte: RasterInfo = {
      ...INFO,
      bits: [8],
      integer: true,
      stats: [
        {
          index: 1,
          min: 7,
          max: 107,
          p2: 10,
          p98: 100,
          values: null,
          histogram: {
            counts: Array.from({ length: 50 }, () => 1),
            edges: Array.from({ length: 51 }, (_, i) => 7 + i * 2),
          },
        },
      ],
    };
    const { store } = setup({ type: "continuous", palette: "goat:elevation", domain: [0, 255] }, {}, byte);
    await openColors();
    const [lowest, highest] = screen.getAllByRole("slider");
    fireEvent.keyDown(lowest, { key: "ArrowLeft" });
    fireEvent.keyDown(lowest, { key: "Home" });
    fireEvent.keyDown(highest, { key: "ArrowRight" });
    fireEvent.keyDown(highest, { key: "End" });
    expect(store.get("render.domain")).toEqual([0, 255]);
    fireEvent.keyDown(screen.getAllByRole("slider")[0], { key: "ArrowRight" });
    expect(store.get("render.domain")).toEqual([1, 255]);
  });

  it("a computed break stepped with the keys keeps the focus and moves the same break again", async () => {
    const { store } = setup(QUANTILES, {}, CLASSED);
    await openColors();
    const third = screen.getAllByRole("slider").filter((h) => h.getAttribute("data-handle") === "break")[2];
    third.focus();
    fireEvent.keyDown(third, { key: "ArrowRight" });
    // Manual now: the range's ends join in front, the focused break stays the one stepped.
    expect(store.get("render.classify.method")).toBe("manual");
    expect(document.activeElement?.getAttribute("aria-valuenow")).toBe("61");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowRight" });
    expect(store.get("render.classify.classes.3.from")).toBe(62);
    expect(store.get("render.classify.classes.1.from")).toBe(20);
  });

  it("with values outside left out, the histogram's ends are the classes' outer ends", async () => {
    const { store } = setup({ ...QUANTILES, outside: "hide" }, {}, CLASSED);
    await openColors();
    const [lowest, highest] = screen.getAllByRole("slider");
    expect([lowest.getAttribute("aria-valuenow"), highest.getAttribute("aria-valuenow")]).toEqual([
      "0",
      "100",
    ]);
    fireEvent.keyDown(lowest, { key: "ArrowRight", shiftKey: true });
    expect(store.get("render.classify.method")).toBe("manual");
    expect(store.get("render.classify.classes.0")).toEqual({ from: 10, to: 20 });
    // An outer end stays outside the classes' breaks.
    fireEvent.keyDown(screen.getAllByRole("slider")[1], { key: "Home" });
    expect(store.get("render.classify.classes.4")).toEqual({ from: 80, to: 81 });
    expect(store.get("render.domain")).toBeUndefined();
  });

  it("with values outside left out, equal intervals' histogram ends split the range again, as their boxes do", async () => {
    const equal = {
      type: "continuous",
      palette: "goat:elevation",
      domain: [0, 100],
      outside: "hide",
      classify: { method: "equal_interval", count: 4, classes: equalIntervalClasses([0, 100], 4) },
    };
    const { store } = setup(equal, {}, CLASSED);
    await openColors();
    fireEvent.keyDown(screen.getAllByRole("slider")[0], { key: "PageUp" });
    expect(store.get("render.domain")).toEqual([10, 100]);
    expect(store.get("render.classify")).toEqual({
      method: "equal_interval",
      count: 4,
      classes: equalIntervalClasses([10, 100], 4),
    });
  });

  it("equal intervals with values outside left out: a dragged break stays inside the range's ends", async () => {
    const { store } = setup(
      {
        type: "continuous",
        palette: "goat:elevation",
        domain: [20, 80],
        outside: "hide",
        classify: { method: "equal_interval", count: 4, classes: equalIntervalClasses([20, 80], 4) },
      },
      {},
      CLASSED
    );
    await openColors();
    const breaks = () =>
      screen.getAllByRole("slider").filter((h) => h.getAttribute("data-handle") === "break");
    expect(breaks().map((h) => h.getAttribute("aria-valuenow"))).toEqual(["35", "50", "65"]);
    // The first and last break keep a step from the range's ends, as from a neighbouring break.
    expect(breaks()[0].getAttribute("aria-valuemin")).toBe("21");
    expect(breaks()[2].getAttribute("aria-valuemax")).toBe("79");
    // One drag from 35 to 10, over bars 200 px wide for 0 to 100.
    const box = document.querySelector("[data-histogram]") as HTMLElement;
    box.getBoundingClientRect = () =>
      ({ left: 0, right: 200, width: 200, top: 0, bottom: 50, height: 50, x: 0, y: 0 }) as DOMRect;
    const first = breaks()[0];
    fireEvent.pointerDown(first, { clientX: 70, pointerId: 1 });
    fireEvent.pointerMove(first, { clientX: 20, pointerId: 1 });
    fireEvent.pointerUp(first, { clientX: 20, pointerId: 1 });
    expect(store.get("render.domain")).toEqual([20, 80]);
    expect(store.get("render.classify")).toEqual({
      method: "manual",
      classes: [{ to: 21 }, { from: 21, to: 50 }, { from: 50, to: 65 }, { from: 65 }],
    });
    // The first class reads from the range's end up to the break.
    const names = screen.getAllByRole("textbox", { name: "style_editor.class_name" }) as HTMLInputElement[];
    expect(names[0].placeholder).toBe("20 style_editor.range_to 21");
  });

  it("a band of whole numbers steps its breaks and ends by whole numbers; a scaled one by a hundredth of its span", async () => {
    // Bars over 0 to 50: a hundredth of the span is half a unit.
    const small = (over: Partial<RasterInfo>): RasterInfo => ({
      ...INFO,
      bits: [8],
      integer: true,
      ...over,
      stats: [
        {
          index: 1,
          min: 0,
          max: 50,
          p2: 1,
          p98: 49,
          values: null,
          histogram: {
            counts: Array.from({ length: 25 }, () => 1),
            edges: Array.from({ length: 26 }, (_, i) => i * 2),
          },
        },
      ],
    });
    const manual = {
      type: "continuous",
      palette: "goat:elevation",
      domain: [0, 50],
      classify: { method: "manual", classes: [{ to: 20 }, { from: 20 }] },
    };
    const whole = setup(manual, {}, small({}));
    await openColors();
    const cut = () => screen.getAllByRole("slider").find((h) => h.getAttribute("data-handle") === "break")!;
    fireEvent.keyDown(cut(), { key: "ArrowRight" });
    expect(whole.store.get("render.classify.classes.1.from")).toBe(21);
    fireEvent.keyDown(screen.getAllByRole("slider")[0], { key: "ArrowRight" });
    expect(whole.store.get("render.domain")).toEqual([1, 50]);
    whole.unmount();
    const scaled = setup(manual, {}, small({ scaled: true }));
    await openColors();
    fireEvent.keyDown(cut(), { key: "ArrowRight" });
    expect(scaled.store.get("render.classify.classes.1.from")).toBe(20.5);
  });

  it("the histogram's end labels read as the range boxes do", async () => {
    const wide: RasterInfo = {
      ...INFO,
      stats: [
        {
          index: 1,
          min: -38.935,
          max: 189.141,
          p2: 32,
          p98: 119,
          values: null,
          histogram: { counts: [5, 1], edges: [-38.935, 75.103, 189.141] },
        },
      ],
    };
    setup({ type: "continuous", palette: "goat:elevation", domain: [32, 119] }, {}, wide);
    await openColors();
    const svg = Array.from(document.querySelectorAll("svg")).find((el) =>
      el.querySelector("rect")
    ) as SVGElement;
    expect(Array.from(svg.querySelectorAll("text")).map((t) => t.textContent)).toEqual(["-38.94", "189.14"]);
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

  it("a band formula the info describes has its histogram and its computed classes", async () => {
    const twice = { name: "Twice", expression: "b1 * 2" };
    const described: RasterInfo = {
      ...CLASSED,
      formula: {
        ...CLASSED.stats[0],
        index: 0,
        expression: twice.expression,
        breaks: { quantile: { "3": [70, 130] } },
      },
    };
    const { store } = setup(
      { type: "continuous", palette: "goat:elevation", domain: [0, 200], band: twice },
      {},
      described
    );
    await openColors();
    expect(document.querySelector("svg[viewBox] rect")).not.toBeNull();
    await userEvent.click(within(rowOf("style_editor.method")).getByRole("combobox"));
    expect(optionOf("style_editor.method_quantile").getAttribute("aria-disabled")).not.toBe("true");
    await userEvent.click(optionOf("style_editor.method_quantile"));
    expect(store.get("render.classify")).toEqual({
      method: "quantile",
      count: 3,
      classes: [{ to: 70 }, { from: 70, to: 130 }, { from: 130 }],
    });
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

  it("with values outside left out, the classes' outer ends are a range to type; typing one makes them manual", async () => {
    // Without it, quantiles have no range of their own.
    const clamped = setup(QUANTILES, {}, CLASSED);
    await openColors();
    expect(screen.queryByRole("textbox", { name: "style_editor.range_lowest" })).toBeNull();
    clamped.unmount();
    const { store } = setup({ ...QUANTILES, outside: "hide" }, {}, CLASSED);
    await openColors();
    const lowest = () =>
      screen.getByRole("textbox", { name: "style_editor.range_lowest" }) as HTMLInputElement;
    const highest = () =>
      screen.getByRole("textbox", { name: "style_editor.range_highest" }) as HTMLInputElement;
    // Open ends: the band's minimum and maximum.
    expect([lowest().value, highest().value]).toEqual(["0", "100"]);
    fireEvent.change(lowest(), { target: { value: "10" } });
    fireEvent.blur(lowest());
    expect(store.get("render.classify")).toEqual({
      method: "manual",
      classes: [
        { from: 10, to: 20 },
        { from: 20, to: 40 },
        { from: 40, to: 60 },
        { from: 60, to: 80 },
        { from: 80 },
      ],
    });
    fireEvent.change(highest(), { target: { value: "90" } });
    fireEvent.blur(highest());
    expect(store.get("render.classify.classes.4")).toEqual({ from: 80, to: 90 });
    expect(store.get("render.domain")).toBeUndefined();
    // The first class reads its own end; the bars beyond the ends stand back.
    const names = screen.getAllByRole("textbox", { name: "style_editor.class_name" }) as HTMLInputElement[];
    expect(names[0].placeholder).toBe("10 style_editor.range_to 20");
    const bars = Array.from(document.querySelectorAll("svg rect")).map((r) => r.getAttribute("fill"));
    expect(bars.slice(0, 5).every((fill) => fill === bars[49])).toBe(true);
    expect(bars[5]).not.toBe(bars[0]);
  });

  it("an outer end is written when its box is left or Enter is pressed, never a digit typed on the way", async () => {
    const { store } = setup({ ...QUANTILES, outside: "hide" }, {}, CLASSED);
    await openColors();
    const lowest = () =>
      screen.getByRole("textbox", { name: "style_editor.range_lowest" }) as HTMLInputElement;
    await userEvent.clear(lowest());
    await userEvent.type(lowest(), "30");
    // The 3 on the way to 30 lies below the first break (20) but is not written: the classes stay quantiles.
    expect(store.get("render.classify.method")).toBe("quantile");
    await userEvent.tab();
    // 30 lies past the first break: refused, and the box shows the end there is.
    expect(store.get("render.classify.method")).toBe("quantile");
    expect(store.get("render.classify.classes.0")).toEqual({ to: 20 });
    expect(lowest().value).toBe("0");
    await userEvent.clear(lowest());
    await userEvent.type(lowest(), "15{Enter}");
    expect(store.get("render.classify.method")).toBe("manual");
    expect(store.get("render.classify.classes.0")).toEqual({ from: 15, to: 20 });
    expect(lowest().value).toBe("15");
  });

  it("equal intervals with values outside left out split the typed range again: it is their domain", async () => {
    const { store } = setup(
      {
        type: "continuous",
        palette: "goat:elevation",
        domain: [0, 100],
        outside: "hide",
        classify: { method: "equal_interval", count: 4, classes: equalIntervalClasses([0, 100], 4) },
      },
      {},
      CLASSED
    );
    await openColors();
    const lowest = screen.getByRole("textbox", { name: "style_editor.range_lowest" });
    fireEvent.change(lowest, { target: { value: "20" } });
    fireEvent.blur(lowest);
    expect(store.get("render.domain")).toEqual([20, 100]);
    expect(store.get("render.classify")).toEqual({
      method: "equal_interval",
      count: 4,
      classes: equalIntervalClasses([20, 100], 4),
    });
  });

  it("with classes the range is written when its box is left, never a digit typed on the way: the classes keep their names", async () => {
    for (const method of ["equal_interval", "manual"]) {
      const classes = equalIntervalClasses([100, 255], 5).map((c, i) => ({ ...c, name: `Class ${i + 1}` }));
      const view = setup({
        type: "continuous",
        palette: "goat:elevation",
        domain: [100, 255],
        classify: { method, ...(method === "manual" ? {} : { count: 5 }), classes },
      });
      await openColors();
      const box = screen.getByRole("textbox", { name: "style_editor.range_highest" });
      await userEvent.clear(box);
      await userEvent.type(box, "30");
      // 3 and 30 lie below the range's low end: neither is written.
      expect(view.store.get("render.domain"), method).toEqual([100, 255]);
      await userEvent.type(box, "0{Enter}");
      expect(view.store.get("render.domain"), method).toEqual([100, 300]);
      const names = (view.store.get("render.classify.classes") as Array<{ name?: string }>).map(
        (c) => c.name
      );
      expect(names, method).toEqual(["Class 1", "Class 2", "Class 3", "Class 4", "Class 5"]);
      view.unmount();
    }
  });

  it("a continuous palette's range is written as it is typed", async () => {
    const { store } = setup({ type: "continuous", palette: "goat:elevation", domain: [0, 100] });
    await openColors();
    await userEvent.type(screen.getByRole("textbox", { name: "style_editor.range_highest" }), "5");
    expect(store.get("render.domain")).toEqual([0, 1005]);
  });

  it("the classes' note from the check shows in the colours editor", async () => {
    const issue = {
      code: "classes_merged",
      level: "info" as const,
      path: "/render/classify",
      message: "Geometric intervals need values above 0: 1 class instead of 5.",
    };
    renderPanel(
      <IssuesProvider issues={[issue]}>
        <PopoverProvider>
          <RasterColorSection />
        </PopoverProvider>
      </IssuesProvider>,
      {
        document: {
          version: "1.0.0",
          kind: "raster",
          render: {
            type: "continuous",
            palette: "goat:elevation",
            classify: { method: "geometric_interval", count: 5, classes: [{}] },
          },
        } as LayerStyle,
        data: { raster: { dataset: "d1", info: CLASSED } },
        map: MAP,
      }
    );
    await openColors();
    expect(screen.getByText(issue.message)).toBeDefined();
  });

  it("with the end colors outside, outer ends a class carries are open again", async () => {
    const render = {
      type: "continuous",
      palette: "goat:elevation",
      domain: [0, 100],
      classify: {
        method: "manual",
        classes: [
          { from: 10, to: 50 },
          { from: 50, to: 90 },
        ],
      },
    };
    const ends = () => {
      const names = screen.getAllByRole("textbox", { name: "style_editor.class_name" }) as HTMLInputElement[];
      return [names[0].placeholder, names[1].placeholder];
    };
    const clamped = setup(render, {}, CLASSED);
    await openColors();
    expect(ends()).toEqual(["0 style_editor.range_to 50", "style_editor.range_to 100"]);
    clamped.unmount();
    setup({ ...render, outside: "hide" }, {}, CLASSED);
    await openColors();
    expect(ends()).toEqual(["10 style_editor.range_to 50", "style_editor.range_to 90"]);
  });

  it("a band formula's geometric intervals read as not available for the band, as the other computed methods", async () => {
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
    const option = optionOf("style_editor.method_geometric_interval");
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(within(option).getByText("style_editor.no_breaks_for_band")).toBeDefined();
  });

  it("the note of geometric intervals on a band reaching below 0 names its lowest value", async () => {
    i18n.addResource("en", "common", "style_editor.geometric_band_below", "down to {{min}}");
    try {
      const dem: RasterInfo = { ...CLASSED, stats: [{ ...CLASSED.stats[0], min: -38.935 }] };
      setup({ type: "continuous", palette: "goat:elevation", domain: [3, 98] }, {}, dem);
      await openColors();
      await userEvent.click(within(rowOf("style_editor.method")).getByRole("combobox"));
      // As the range boxes write numbers.
      expect(
        within(optionOf("style_editor.method_geometric_interval")).getByText("down to -38.94")
      ).toBeDefined();
    } finally {
      i18n.removeResourceBundle("en", "common");
    }
  });

  it("geometric intervals need a band whose values lie above 0: else disabled with a note", async () => {
    const { unmount } = setup(
      { type: "continuous", palette: "goat:elevation", domain: [3, 98] },
      {},
      CLASSED
    );
    await openColors();
    await userEvent.click(within(rowOf("style_editor.method")).getByRole("combobox"));
    const option = optionOf("style_editor.method_geometric_interval");
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(within(option).getByText("style_editor.geometric_band_below")).toBeDefined();
    await userEvent.keyboard("{Escape}");
    unmount();
    const positive: RasterInfo = {
      ...CLASSED,
      stats: [
        {
          ...CLASSED.stats[0],
          min: 1,
          breaks: { ...BREAKS, geometric_interval: { "5": [2.5, 6.3, 15.8, 39.8] } },
        },
      ],
    };
    const { store } = setup({ type: "continuous", palette: "goat:elevation", domain: [3, 98] }, {}, positive);
    await openColors();
    await choose(
      "style_editor.method",
      "style_editor.raster_method_continuous",
      "style_editor.method_geometric_interval"
    );
    expect(store.get("render.classify")).toEqual({
      method: "geometric_interval",
      count: 5,
      classes: classesOf([2.5, 6.3, 15.8, 39.8]),
    });
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
    await openColors();
    // The class on the grid with its share.
    const [row] = classRows();
    expect(within(row).getByText("10%")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_class" }));
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
    await openColors();
    // Then the Other values row: code 205 has no class.
    expect(classRows().map((row) => row.textContent)).toEqual([
      "050%",
      "125%",
      "215%",
      "style_editor.other_values10%",
    ]);
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_class" }));
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
    await openColors();
    await userEvent.click(screen.getByRole("button", { name: "15" }));
    expect(
      (screen.getByRole("textbox", { name: "style_editor.category_name" }) as HTMLInputElement).placeholder
    ).toBe("15");
    await userEvent.keyboard("{Escape}");
    // Without the band's codes, Add a class starts the next value and opens its editor, titled with it.
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_class" }));
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

  // An 8-bit band without a color table: 30 codes, code 30 the most common, then 29, and so on.
  const THIRTY: RasterInfo = {
    bands: 1,
    bits: [8],
    colorTable: false,
    integer: true,
    stats: [
      {
        index: 1,
        min: 1,
        max: 30,
        p2: 1,
        p98: 30,
        values: Array.from({ length: 30 }, (_, i) => i + 1),
        counts: Array.from({ length: 30 }, (_, i) => i + 1),
      },
    ],
  };
  const values = (store: { get: (path: string) => unknown }) =>
    (store.get("render.classes") as Array<{ value: number }>).map((c) => c.value);
  const top = (n: number) => Array.from({ length: n }, (_, i) => ({ value: 30 - i, color: "#cccccc" }));

  it("filled categories list ten codes and the rest as one Other values row with its share", async () => {
    setup({ type: "categorical", classes: top(10), other_color: "#cccccc" }, {}, THIRTY);
    await openColors();
    const rows = classRows();
    expect(rows).toHaveLength(11);
    // Codes 1 to 20 hold 210 of the 465 cells.
    const other = rows.at(-1) as HTMLElement;
    expect(within(other).getByText("style_editor.other_values")).toBeDefined();
    expect(within(other).getByText("45%")).toBeDefined();
    expect(within(classRows()[0]).getByText("6.5%")).toBeDefined();
  });

  it("Classes shows the ten, twenty or all most common codes, and by hand once the list is edited", async () => {
    const { store } = setup({ type: "categorical", classes: top(10), other_color: "#cccccc" }, {}, THIRTY);
    await openColors();
    const select = within(rowOf("style_editor.classes")).getByRole("combobox");
    expect(select.textContent).toBe("style_editor.count_top");
    await userEvent.click(select);
    const options = () =>
      within(screen.getByRole("listbox"))
        .getAllByRole("option")
        .filter((el) => el.classList.contains("MuiMenuItem-root"));
    // All values first, as a classification's categories offer them, then Top 10 and 20: 30 and 50 do not show fewer
    // codes than the band holds.
    expect(options().map((el) => el.textContent)).toEqual([
      "style_editor.count_all",
      "style_editor.count_top",
      "style_editor.count_top",
    ]);
    await userEvent.click(options()[2]);
    expect(values(store)).toEqual(Array.from({ length: 20 }, (_, i) => 30 - i));
    await userEvent.click(within(rowOf("style_editor.classes")).getByRole("combobox"));
    await userEvent.click(options()[0]);
    expect(values(store)).toHaveLength(30);
    store.set("render.classes", top(9));
    await act(async () => {});
    expect(within(rowOf("style_editor.classes")).getByRole("combobox").textContent).toBe(
      "style_editor.count_by_hand"
    );
  });

  it("a long list shows ten rows and Show N more", async () => {
    setup({ type: "categorical", classes: top(30) }, {}, THIRTY);
    await openColors();
    expect(classRows()).toHaveLength(11);
    await userEvent.click(screen.getByRole("button", { name: "show_more_count" }));
    expect(classRows()).toHaveLength(31);
  });

  it("a long list that shows ten rows sorts those ten: a drag below them, or Alt+ArrowDown on the last, goes no further", async () => {
    const { store } = setup({ type: "categorical", classes: top(30) }, {}, THIRTY);
    await openColors();
    const before = values(store);
    // Let go on the Other values row, under the ten shown.
    await dragRow(classRows()[0], classRows()[10]);
    expect(values(store)).toEqual([...before.slice(1, 10), before[0], ...before.slice(10)]);
    const now = values(store);
    within(classRows()[9]).getByRole("button", { name: "style_editor.class_color" }).focus();
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(values(store)).toEqual(now);
  });

  it("a class added to a list of ten shows: the list opens to it", async () => {
    const { store } = setup({ type: "categorical", classes: top(10), other_color: "#cccccc" }, {}, THIRTY);
    await openColors();
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_class" }));
    await userEvent.click(within(screen.getByRole("menu")).getByText("20"));
    expect(values(store)).toHaveLength(11);
    expect(screen.queryByRole("button", { name: "show_more_count" })).toBeNull();
    // Its row, then Other values.
    expect(classRows()).toHaveLength(12);
    expect(within(classRows()[10]).getByRole("button", { name: "20" })).toBeDefined();
  });

  it("refilled with the twenty most common codes after a sort by value, the list stays by value", async () => {
    const { store } = setup({ type: "categorical", classes: top(10), other_color: "#cccccc" }, {}, THIRTY);
    await openColors();
    await choose(
      "style_editor.category_order",
      "style_editor.category_order_share",
      "style_editor.category_order_value"
    );
    await userEvent.click(within(rowOf("style_editor.classes")).getByRole("combobox"));
    await userEvent.click(within(screen.getByRole("listbox")).getAllByRole("option")[2]);
    expect(values(store)).toEqual(Array.from({ length: 20 }, (_, i) => 11 + i));
    expect(within(rowOf("style_editor.category_order")).getByRole("combobox").textContent).toBe(
      "style_editor.category_order_value"
    );
  });

  it("Order sorts the categories by value, by name or most common first", async () => {
    const { store } = setup({ type: "categorical", classes: top(10), other_color: "#cccccc" }, {}, THIRTY);
    await openColors();
    await choose(
      "style_editor.category_order",
      "style_editor.category_order_share",
      "style_editor.category_order_value"
    );
    expect(values(store)).toEqual([21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
    await choose(
      "style_editor.category_order",
      "style_editor.category_order_value",
      "style_editor.category_order_share"
    );
    expect(values(store)).toEqual([30, 29, 28, 27, 26, 25, 24, 23, 22, 21]);
  });

  it("a category dragged to another row's place moves there; the order reads as own", async () => {
    const { store } = setup({ type: "categorical", classes: top(10), other_color: "#cccccc" }, {}, THIRTY);
    await openColors();
    const rows = classRows();
    await dragRow(rows[0], rows[2]);
    expect(values(store).slice(0, 3)).toEqual([29, 28, 30]);
    await act(async () => {});
    expect(within(rowOf("style_editor.category_order")).getByRole("combobox").textContent).toBe(
      "style_editor.category_order_custom"
    );
    // The Other values row stays where it is: no key moves it either.
    expect(classRows().at(-1)?.getAttribute("aria-keyshortcuts")).toBeNull();
    expect(classRows()[0].getAttribute("aria-keyshortcuts")).toBe("Alt+ArrowUp Alt+ArrowDown");
    // Alt and an arrow from a category's swatch move it one place; the focus stays on its swatch.
    within(classRows()[2]).getByRole("button", { name: "style_editor.class_color" }).focus();
    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(values(store).slice(0, 3)).toEqual([29, 30, 28]);
    expect(document.activeElement).toBe(
      within(classRows()[1]).getByRole("button", { name: "style_editor.class_color" })
    );
  });

  const nameBox = () =>
    screen.queryByRole("textbox", { name: "style_editor.category_name" }) as HTMLInputElement | null;
  const sortByValue = async (from = "share") => {
    await choose(
      "style_editor.category_order",
      `style_editor.category_order_${from}`,
      "style_editor.category_order_value"
    );
    await act(async () => {});
  };
  const typeHex = (hex: string) => {
    const box = screen.getAllByRole("textbox", { name: "color_value" }).at(-1) as HTMLElement;
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: hex } });
  };
  const named = (store: { get: (path: string) => unknown }, key: "name" | "color", value: string) =>
    (store.get("render.classes") as Array<Record<string, unknown>>)
      .filter((c) => c[key] === value)
      .map((c) => c.value);

  it("a category's open editor stays with its category when the list is put in another order", async () => {
    const { store } = setup({ type: "categorical", classes: top(10), other_color: "#cccccc" }, {}, THIRTY);
    await openColors();
    // Code 30's editor: the first row, most common first.
    await userEvent.click(screen.getByRole("button", { name: "30" }));
    expect(nameBox()?.placeholder).toBe("30");
    // By value, 21 comes first and 30 last.
    await sortByValue();
    expect(values(store)[0]).toBe(21);
    expect(nameBox()?.placeholder).toBe("30");
    fireEvent.change(nameBox() as HTMLElement, { target: { value: "Forest" } });
    expect(named(store, "name", "Forest")).toEqual([30]);
    // A row dragged beside it: still code 30's.
    const rows = classRows();
    await dragRow(rows[9], rows[0]);
    expect(values(store)[0]).toBe(30);
    expect(nameBox()?.value).toBe("Forest");
    // Remove class removes code 30, wherever it is now.
    await sortByValue("custom");
    await userEvent.click(screen.getByRole("button", { name: "style_editor.remove_class" }));
    expect(values(store)).toEqual([21, 22, 23, 24, 25, 26, 27, 28, 29]);
    expect(nameBox()).toBeNull();
  });

  it("a category's open editor follows the value typed into it, and closes when its category goes", async () => {
    const { store } = setup(
      {
        type: "categorical",
        classes: [
          { value: 2, color: "#111111" },
          { value: 5, color: "#555555" },
        ],
      },
      {},
      THIRTY
    );
    await openColors();
    await userEvent.click(screen.getByRole("button", { name: "5" }));
    const cell = screen.getByRole("textbox", { name: "style_editor.cell_value" });
    // 25 typed over 5: the 2 on the way is the other class's code.
    await userEvent.clear(cell);
    await userEvent.type(cell, "25");
    expect(values(store)).toEqual([2, 25]);
    expect(nameBox()?.placeholder).toBe("25");
    fireEvent.change(nameBox() as HTMLElement, { target: { value: "Lake" } });
    expect(named(store, "name", "Lake")).toEqual([25]);
    // The category is no longer listed (another count of classes, an undo): its editor closes.
    store.set("render.classes", [{ value: 2, color: "#111111" }]);
    await act(async () => {});
    expect(nameBox()).toBeNull();
    // The level itself closes, its Remove class with it.
    expect(screen.queryByRole("button", { name: "style_editor.remove_class" })).toBeNull();
  });

  it("the color picker of a category's open editor closes when the list is put in another order", async () => {
    const { store } = setup({ type: "categorical", classes: top(10), other_color: "#cccccc" }, {}, THIRTY);
    await openColors();
    await userEvent.click(screen.getByRole("button", { name: "30" }));
    await userEvent.click(screen.getByRole("button", { name: "style_editor.pick_color" }));
    expect(screen.getAllByRole("textbox", { name: "color_value" }).length).toBeGreaterThan(0);
    await sortByValue();
    // The picker was opened for the class's place in the list: it closes; the editor goes on with code 30.
    expect(screen.queryByRole("textbox", { name: "color_value" })).toBeNull();
    expect(nameBox()?.placeholder).toBe("30");
    await userEvent.click(screen.getByRole("button", { name: "style_editor.pick_color" }));
    typeHex("#123456");
    expect(named(store, "color", "#123456")).toEqual([30]);
  });

  it("a category's swatch picker goes on with its category, or closes, when the list is put in another order", async () => {
    const { store } = setup({ type: "categorical", classes: top(10), other_color: "#cccccc" }, {}, THIRTY);
    await openColors();
    await userEvent.click(within(classRows()[0]).getByRole("button", { name: "style_editor.class_color" }));
    expect(screen.getAllByRole("textbox", { name: "color_value" }).length).toBeGreaterThan(0);
    await sortByValue();
    if (screen.queryByRole("textbox", { name: "color_value" })) typeHex("#123456");
    expect(named(store, "color", "#123456").filter((v) => v !== 30)).toEqual([]);
    // Opened again on code 30's row, now the last, it writes code 30's color.
    const last = classRows()[9];
    await userEvent.click(within(last).getByRole("button", { name: "style_editor.class_color" }));
    typeHex("#abcdef");
    expect(named(store, "color", "#abcdef")).toEqual([30]);
  });

  it("categories open from a row of their own: what they show and their colors; the list is in the popover", async () => {
    setup({ type: "categorical", classes: top(30) }, {}, THIRTY);
    expect(classRows()).toHaveLength(0);
    expect(within(rowOf("style_editor.colors")).getByRole("button").textContent).toBe(
      "style_editor.raster_categories_all"
    );
    await openColors();
    // Classes and Order above the list, as a classification's editor has them.
    expect(screen.getByText("style_editor.classes")).toBeDefined();
    expect(screen.getByText("style_editor.category_order")).toBeDefined();
    expect(classRows()).toHaveLength(11);
    expect(screen.getByRole("button", { name: "style_editor.add_class" })).toBeDefined();
    expect(screen.getAllByText("style_editor.raster_type_categorical").length).toBeGreaterThan(1);
  });

  it("the row reads Top 10 for the ten most common codes", () => {
    setup({ type: "categorical", classes: top(10), other_color: "#cccccc" }, {}, THIRTY);
    expect(within(rowOf("style_editor.colors")).getByRole("button").textContent).toBe(
      "style_editor.count_top"
    );
  });

  it("an edit draws only the class it changes, also in a long list", async () => {
    const { store } = setup({ type: "categorical", classes: top(30) }, {}, THIRTY);
    await openColors();
    await userEvent.click(screen.getByRole("button", { name: "show_more_count" }));
    expect(classRows()).toHaveLength(31);
    rowRenders.count = 0;
    rowRenders.rows.clear();
    sortableRenders.count = 0;
    eyeRenders.count = 0;
    await userEvent.click(within(classRows()[5]).getByRole("button", { name: "style_editor.hide_class" }));
    expect(store.get("render.classes.5.visible")).toBe(false);
    // Only the class hidden, and the Other values row (no index) whose share follows the list; none of the other 29.
    expect([...rowRenders.rows]).toEqual(expect.arrayContaining([5]));
    expect([...rowRenders.rows].filter((i) => i !== 5 && i !== undefined)).toEqual([]);
    expect(rowRenders.count).toBeLessThanOrEqual(4);
    // Pressed with the pointer: the cells of the other rows do not draw again either (their eyes).
    expect(eyeRenders.count).toBeLessThanOrEqual(3);
    // Shown again by keyboard: the sortable rows likewise, none of the other 29 draws again. (A press of the pointer
    // anywhere in the list draws every row's sortable state, as a drag may start; their memoised cells do not draw.)
    sortableRenders.count = 0;
    within(classRows()[5]).getByRole("button", { name: "style_editor.show_class" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(store.get("render.classes.5.visible")).toBeUndefined();
    expect(sortableRenders.count).toBeLessThanOrEqual(3);
  });
});
