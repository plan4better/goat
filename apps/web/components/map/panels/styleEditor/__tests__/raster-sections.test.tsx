import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import type { LayerStyle } from "@/lib/style/generated/types";
import type { RasterInfo } from "@/lib/style/raster/metadata";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { RasterColorSection } from "@/components/map/panels/styleEditor/sections/RasterColorSection";
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
  names: [""],
  stats: [band(1, null, null)],
};
const FLOAT_VALUES: RasterInfo = { ...FLOAT, stats: [band(1, 10, 90)] };
const BYTE: RasterInfo = { bands: 1, bits: [8], colorTable: false, integer: true, names: [""], stats: [] };
const RGB: RasterInfo = {
  bands: 4,
  bits: [8, 8, 8, 8],
  colorTable: false,
  integer: true,
  names: ["", "", "", ""],
  stats: [],
};

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

function setup(
  render: object,
  info: RasterInfo | undefined,
  map: unknown = null,
  extra: object = {},
  wrap: (ui: ReactNode) => ReactNode = (ui) => ui
) {
  return renderPanel(
    <>
      {wrap(
        <PopoverProvider>
          <RasterGeneralSection />
          <RasterLayerSection />
        </PopoverProvider>
      )}
    </>,
    {
      document: { version: "1.0.0", kind: "raster", render, ...extra } as LayerStyle,
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
      "style_editor.raster_type_hillshade"
    );
    expect(store.get("render")).toEqual({ type: "hillshade" });
  });

  it("Color range on a float file starts from the band's values; a band without values keeps the drawing", async () => {
    const empty = setup({ type: "hillshade" }, FLOAT);
    await choose(
      "style_editor.draw_as",
      "style_editor.raster_type_hillshade",
      "style_editor.raster_type_continuous"
    );
    expect(empty.store.get("render")).toEqual({ type: "hillshade" });
    expect(screen.getByText("style_editor.range_nothing_found")).toBeDefined();
    empty.unmount();
    const { store } = setup({ type: "hillshade" }, FLOAT_VALUES);
    await choose(
      "style_editor.draw_as",
      "style_editor.raster_type_hillshade",
      "style_editor.raster_type_continuous"
    );
    await waitFor(() => expect(store.get("render.type")).toBe("continuous"));
    expect(store.get("render.domain")).toEqual([10, 90]);
  });

  it("bands are named as the file names them, else Band n", async () => {
    setup({ type: "continuous", domain: [0, 9] }, { ...RGB, names: ["Rot", "", "", "NIR"] });
    const items = await menuItems("style_editor.band", "Rot");
    expect(items.filter((item) => item !== "style_editor.band")).toEqual([
      "Rot",
      "style_editor.band_n",
      "style_editor.band_n",
      "NIR",
    ]);
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

  it("a file marked blue, green, red: true color is the bands it marks, and bands 1, 2, 3 are written", async () => {
    // goatlib draws such a file red from its third band (`image_bands`): Custom starts from the bands it draws.
    const bgr: RasterInfo = {
      ...RGB,
      bands: 3,
      bits: [8, 8, 8],
      names: ["B", "G", "R"],
      colorInterp: ["blue", "green", "red"],
    };
    const row = (channel: string) =>
      within(screen.getByText(`style_editor.band_${channel}`).parentElement as HTMLElement).getByRole(
        "combobox"
      );
    const view = setup({ type: "image" }, bgr);
    await choose("style_editor.bands", "style_editor.bands_true", "style_editor.bands_custom");
    expect(["red", "green", "blue"].map((c) => row(c).textContent)).toEqual(["R", "G", "B"]);
    view.unmount();
    const { store } = setup({ type: "image", bands: [1, 2, 1] }, bgr);
    await userEvent.click(row("blue"));
    const bands = within(screen.getByRole("listbox"))
      .getAllByRole("option")
      .filter((el) => el.classList.contains("MuiMenuItem-root"));
    await userEvent.click(bands[2]);
    // Not true color for this file: written as chosen.
    expect(store.get("render.bands")).toEqual([1, 2, 3]);
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

  it("the no-data placeholder names the file's value", () => {
    const german = (ui: ReactNode) => <I18nextProvider i18n={commonI18n("de")}>{ui}</I18nextProvider>;
    const placeholder = () =>
      screen.getByRole("textbox", { name: "Keine Daten" }).getAttribute("placeholder");
    const { unmount } = setup(
      { type: "continuous", domain: [0, 9] },
      { ...FLOAT, noData: -9999 },
      null,
      {},
      german
    );
    expect(placeholder()).toBe("aus der Datei: -9999");
    unmount();
    // A float file's lowest value as its no-data value, shortened.
    const float = setup(
      { type: "continuous", domain: [0, 9] },
      { ...FLOAT, noData: -3.4028234663852886e38 },
      null,
      {},
      german
    );
    expect(placeholder()).toBe("aus der Datei: -3.4e+38");
    float.unmount();
    setup({ type: "continuous", domain: [0, 9] }, FLOAT, null, {}, german);
    expect(placeholder()).toBe("keiner");
  });

  it("rows wait for the file's info", async () => {
    setup({ type: "continuous", domain: [0, 9] }, undefined, clickMap());
    // Draw as lists no types until the file answered.
    const drawAs = within(screen.getByText("style_editor.draw_as").parentElement as HTMLElement).getByRole(
      "combobox"
    ) as HTMLButtonElement;
    expect(drawAs.disabled).toBe(true);
    await userEvent.click(drawAs);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect((screen.getByRole("textbox", { name: "style_editor.no_data" }) as HTMLInputElement).disabled).toBe(
      true
    );
    expect(
      (screen.getByRole("button", { name: "style_editor.no_data_pick" }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("No data shows only where it changes the drawing", () => {
    const paletted: RasterInfo = {
      bands: 1,
      bits: [8],
      colorTable: true,
      integer: true,
      names: [""],
      stats: [],
    };
    setup({ type: "categorical" }, paletted);
    expect(screen.queryByText("style_editor.no_data")).toBeNull();
  });

  it("color scales default to nearest resampling, images and shading alone to smooth", () => {
    for (const [render, shown] of [
      [{ type: "categorical" }, "nearest"],
      [{ type: "continuous", palette: "goat:elevation" }, "nearest"],
      [{ type: "hillshade", palette: "goat:elevation" }, "nearest"],
      [{ type: "hillshade" }, "linear"],
      [{ type: "image" }, "linear"],
    ] as const) {
      const { unmount } = setup(render, BYTE);
      expect([render, screen.getByRole("combobox", { name: "style_editor.resampling" }).textContent]).toEqual(
        [render, `style_editor.resampling_${shown}`]
      );
      unmount();
    }
  });

  it("smooth cells on a color scale are kept in the style, the default is not", async () => {
    const { store } = setup({ type: "continuous", palette: "goat:elevation" }, BYTE);
    await choose(
      "style_editor.resampling",
      "style_editor.resampling_nearest",
      "style_editor.resampling_linear"
    );
    expect(store.get("resampling")).toBe("linear");
    await choose(
      "style_editor.resampling",
      "style_editor.resampling_linear",
      "style_editor.resampling_nearest"
    );
    expect(store.get("resampling")).toBeUndefined();
  });
});

describe("a raster file that cannot be read", () => {
  const broken = (render: object, error: "unavailable" | "refused") =>
    renderPanel(
      <PopoverProvider>
        <RasterGeneralSection />
        <RasterColorSection />
        <RasterLayerSection />
      </PopoverProvider>,
      {
        document: { version: "1.0.0", kind: "raster", render } as LayerStyle,
        data: { raster: { dataset: "d1", error } },
      }
    );

  it("shows one notice for the panel, and why when its address is refused", () => {
    const { unmount } = broken(
      { type: "continuous", palette: "goat:elevation", domain: [0, 9] },
      "unavailable"
    );
    const alerts = screen.getAllByRole("alert");
    expect(alerts.map((el) => el.textContent)).toEqual(["style_editor.raster_unavailable"]);
    // The colors wait for the file.
    // The section's title and its row are both Colors: the row comes second.
    const colors = within(
      screen.getAllByText("style_editor.colors")[1].parentElement as HTMLElement
    ).getByRole("button") as HTMLButtonElement;
    expect(colors.disabled).toBe(true);
    unmount();
    // An image has no colors section: the notice is there all the same.
    broken({ type: "image" }, "refused");
    expect(screen.getAllByRole("alert").map((el) => el.textContent)).toEqual(["style_editor.raster_refused"]);
  });
});
