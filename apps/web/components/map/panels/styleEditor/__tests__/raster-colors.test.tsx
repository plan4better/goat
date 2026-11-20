import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";
import type { RasterInfo } from "@/lib/style/raster/metadata";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { RasterColorSection } from "@/components/map/panels/styleEditor/sections/RasterColorSection";

import { choose, renderPanel } from "./renderPanel";

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
      document: { version: 1, kind: "raster", render, ...extra } as LayerStyle,
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
          version: 1,
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
