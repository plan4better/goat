import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";
import type { RasterInfo } from "@/lib/style/raster/metadata";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { RasterGeneralSection } from "@/components/map/panels/styleEditor/sections/RasterGeneralSection";
import { RasterLayerSection } from "@/components/map/panels/styleEditor/sections/RasterLayerSection";

import { choose, renderPanel } from "./renderPanel";

const fetchRasterPoint = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
vi.mock("@/lib/api/rasters", () => ({
  fetchRasterPoint: (...args: unknown[]) => fetchRasterPoint(...args),
}));

const band = (index: number, p2: number | null, p98: number | null) => ({
  index,
  min: p2,
  max: p98,
  p2,
  p98,
  values: null,
});
const FLOAT: RasterInfo = {
  bands: 1,
  bits: [32],
  colorTable: false,
  integer: false,
  stats: [band(1, null, null)],
};
const FLOAT_VALUES: RasterInfo = { ...FLOAT, stats: [band(1, 10, 90)] };
const BYTE: RasterInfo = { bands: 1, bits: [8], colorTable: false, integer: true, stats: [] };
const RGB: RasterInfo = { bands: 4, bits: [8, 8, 8, 8], colorTable: false, integer: true, stats: [] };

/** A map whose next click lands at 11, 51. */
function clickMap() {
  let handler: ((e: { lngLat: { lng: number; lat: number } }) => void) | null = null;
  return {
    once: (_type: string, fn: typeof handler) => {
      handler = fn;
    },
    getZoom: () => 10,
    getBounds: () => ({
      toArray: () => [
        [0, 0],
        [0, 0],
      ],
    }),
    getCanvas: () => ({ style: {} as Record<string, string> }),
    click: () => handler?.({ lngLat: { lng: 11, lat: 51 } }),
  };
}

function setup(render: object, info: RasterInfo, map: unknown = null, extra: object = {}) {
  return renderPanel(
    <PopoverProvider>
      <RasterGeneralSection />
      <RasterLayerSection />
    </PopoverProvider>,
    {
      document: { version: 1, kind: "raster", render, ...extra } as LayerStyle,
      data: { raster: { dataset: "d1", info } },
      map,
    }
  );
}

const menuItems = async (label: string, current: string) => {
  const select = within(screen.getByText(label).parentElement as HTMLElement).getByRole("combobox");
  expect(select.textContent).toBe(current);
  await userEvent.click(select);
  const items = within(screen.getByRole("listbox"))
    .getAllByRole("option")
    .map((el) => el.textContent ?? "");
  await userEvent.keyboard("{Escape}");
  return items;
};

describe("raster general section", () => {
  it("Draw as offers what fits the file", async () => {
    setup({ type: "image" }, FLOAT);
    const floatItems = await menuItems("style_editor.draw_as", "style_editor.raster_type_image");
    expect(floatItems.join("|")).toContain("style_editor.raster_type_continuous");
    expect(floatItems.join("|")).not.toContain("style_editor.raster_type_categorical");
  });

  it("Color range starts with 0 to 255 on an 8-bit file; Hillshade with its defaults", async () => {
    const { store } = setup({ type: "image" }, BYTE, null, { brightness: 0.2 });
    await choose(
      "style_editor.draw_as",
      "style_editor.raster_type_image",
      "style_editor.raster_type_continuous"
    );
    expect(store.get("render")).toEqual({ type: "continuous", domain: [0, 255] });
    expect(store.get("brightness")).toBeUndefined();
    await choose(
      "style_editor.draw_as",
      "style_editor.raster_type_continuous",
      "style_editor.raster_type_terrain"
    );
    expect(store.get("render")).toEqual({ type: "terrain" });
  });

  it("Color range on a float file starts from the band's values; a band without values keeps the drawing", async () => {
    const empty = setup({ type: "terrain" }, FLOAT);
    await choose(
      "style_editor.draw_as",
      "style_editor.raster_type_terrain",
      "style_editor.raster_type_continuous"
    );
    expect(empty.store.get("render")).toEqual({ type: "terrain" });
    expect(screen.getByText("style_editor.range_nothing_found")).toBeDefined();
    empty.unmount();
    const { store } = setup({ type: "terrain" }, FLOAT_VALUES);
    await choose(
      "style_editor.draw_as",
      "style_editor.raster_type_terrain",
      "style_editor.raster_type_continuous"
    );
    await waitFor(() => expect(store.get("render.type")).toBe("continuous"));
    expect(store.get("render.domain")).toEqual([10, 90]);
  });

  it("the band combination shows only for three or more bands", async () => {
    setup({ type: "image" }, FLOAT);
    expect(screen.queryByText("style_editor.bands")).toBeNull();
  });

  it("False color writes bands 4, 1, 2; True color removes them", async () => {
    const { store } = setup({ type: "image" }, RGB);
    await choose("style_editor.bands", "style_editor.bands_true", "style_editor.bands_false");
    expect(store.get("render.bands")).toEqual([4, 1, 2]);
    await choose("style_editor.bands", "style_editor.bands_false", "style_editor.bands_true");
    expect(store.get("render.bands")).toBeUndefined();
  });

  it("Custom shows the red, green and blue bands and writes only what differs from true color", async () => {
    const { store } = setup({ type: "image" }, RGB);
    await choose("style_editor.bands", "style_editor.bands_true", "style_editor.bands_custom");
    expect(store.get("render.bands")).toBeUndefined();
    const red = within(screen.getByText("style_editor.band_red").parentElement as HTMLElement);
    await userEvent.click(red.getByRole("combobox"));
    // The menu's title is an option for the listbox too: count the menu items only.
    const bands = within(screen.getByRole("listbox"))
      .getAllByRole("option")
      .filter((el) => el.classList.contains("MuiMenuItem-root"));
    await userEvent.click(bands[3]);
    expect(store.get("render.bands")).toEqual([4, 2, 3]);
  });
});

describe("raster layer section", () => {
  it("adjustments write a value and Reset removes all four", async () => {
    const { store } = setup({ type: "image" }, RGB, null, { contrast: 0.3 });
    await userEvent.click(
      within(screen.getByText("style_editor.adjustments").parentElement as HTMLElement).getAllByRole(
        "button"
      )[0]
    );
    const brightness = within(
      screen.getByText("style_editor.brightness").parentElement as HTMLElement
    ).getByRole("slider");
    fireEvent.change(brightness, { target: { value: 0.1 } });
    expect(store.get("brightness")).toBe(0.1);
    await userEvent.click(screen.getByRole("button", { name: "style_editor.reset_adjustments" }));
    expect(store.get("brightness")).toBeUndefined();
    expect(store.get("contrast")).toBeUndefined();
  });

  it("a cell picked on the map becomes a no-data value; a click outside changes nothing", async () => {
    const map = clickMap();
    const { store } = setup({ type: "continuous", domain: [0, 9] }, FLOAT, map);
    fetchRasterPoint.mockResolvedValueOnce({ values: [null], styled: null });
    await userEvent.click(screen.getByRole("button", { name: "style_editor.no_data_pick" }));
    await act(async () => map.click());
    expect(store.get("render.no_data")).toBeUndefined();
    expect(await screen.findByText("style_editor.no_data_outside")).toBeDefined();
    expect(fetchRasterPoint).toHaveBeenCalledWith("d1", { lng: 11, lat: 51 });
    fetchRasterPoint.mockResolvedValueOnce({ values: [-9999], styled: null });
    await userEvent.click(screen.getByRole("button", { name: "style_editor.no_data_pick" }));
    await act(async () => map.click());
    await waitFor(() => expect(store.get("render.no_data")).toEqual({ values: [-9999] }));
  });

  it("typed no-data values are written once they read as numbers", () => {
    const { store } = setup({ type: "continuous", domain: [0, 9] }, FLOAT);
    const input = screen.getByRole("textbox", { name: "style_editor.no_data" });
    fireEvent.change(input, { target: { value: "-" } });
    expect(store.get("render.no_data")).toBeUndefined();
    fireEvent.change(input, { target: { value: "-9999, 0" } });
    expect(store.get("render.no_data")).toEqual({ values: [-9999, 0] });
    expect((input as HTMLInputElement).value).toBe("-9999, 0");
  });

  it("No data shows only where it changes the drawing", () => {
    const paletted: RasterInfo = { bands: 1, bits: [8], colorTable: true, integer: true, stats: [] };
    setup({ type: "categorical" }, paletted);
    expect(screen.queryByText("style_editor.no_data")).toBeNull();
  });

  it("categories default to nearest resampling", () => {
    setup({ type: "categorical" }, BYTE);
    expect(screen.getByRole("combobox", { name: "style_editor.resampling" }).textContent).toBe(
      "style_editor.resampling_nearest"
    );
  });
});

describe("a raster file that cannot be read", () => {
  it("says so in the panel, and why when its address is refused", () => {
    const { unmount } = renderPanel(
      <PopoverProvider>
        <RasterGeneralSection />
      </PopoverProvider>,
      {
        document: { version: 1, kind: "raster", render: { type: "image" } } as LayerStyle,
        data: { raster: { dataset: "d1", error: "unavailable" } },
      }
    );
    expect(screen.getByText("style_editor.raster_unavailable")).toBeDefined();
    unmount();
    renderPanel(
      <PopoverProvider>
        <RasterGeneralSection />
      </PopoverProvider>,
      {
        document: { version: 1, kind: "raster", render: { type: "image" } } as LayerStyle,
        data: { raster: { dataset: "d1", error: "refused" } },
      }
    );
    expect(screen.getByText("style_editor.raster_refused")).toBeDefined();
  });
});
