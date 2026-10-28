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
const INFO: RasterInfo = { bands: 1, bits: [32], colorTable: false, integer: false, stats: stats(3.2, 97.5) };

function setup(render: object, extra: object = {}, info: RasterInfo = INFO) {
  return renderPanel(
    <PopoverProvider>
      <RasterColorSection />
    </PopoverProvider>,
    {
      document: { version: 1, kind: "raster", render, ...extra } as LayerStyle,
      data: { raster: { dataset: "d1", info } },
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
      "style_editor.raster_method_manual"
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

  it("From the data writes the band's 2nd to 98th percentile; a band without values says so", async () => {
    const { store, unmount } = setup({ type: "continuous", palette: "goat:elevation", domain: [0, 1] });
    await openColors();
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

  it("hillshade colors start from the band's values; a band without values keeps them off and says so", async () => {
    const empty = setup({ type: "terrain" }, {}, { ...INFO, stats: stats(null, null) });
    await openColors();
    await userEvent.click(within(rowOf("style_editor.hillshade_colors")).getByRole("checkbox"));
    expect(empty.store.get("render.palette")).toBeUndefined();
    expect(screen.getByText("style_editor.range_nothing_found")).toBeDefined();
    empty.unmount();
    const { store } = setup({ type: "terrain" });
    await openColors();
    await userEvent.click(within(rowOf("style_editor.hillshade_colors")).getByRole("checkbox"));
    await waitFor(() => expect(store.get("render.domain")).toEqual([3, 98]));
    expect(store.get("render.palette")).toBe("goat:elevation");
  });

  it("hillshade shows the accent only for the standard method", async () => {
    const { store } = setup({ type: "terrain" });
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
});
