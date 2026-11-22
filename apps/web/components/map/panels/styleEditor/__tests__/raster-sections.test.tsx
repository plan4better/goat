import { ThemeProvider, createTheme } from "@mui/material";
import { act, fireEvent, render as render_, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";

import { commonI18n } from "@/i18n/__tests__/commonI18n";

import { EditorStore } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";
import { FORMULA_PRESETS } from "@/lib/style/raster/formula";
import type { RasterInfo } from "@/lib/style/raster/metadata";
import { StyleSaver } from "@/lib/style/save";

import { EMPTY_DATA, StyleEditorProvider } from "@/components/map/panels/styleEditor/context";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { RasterColorSection } from "@/components/map/panels/styleEditor/sections/RasterColorSection";
import { RasterGeneralSection } from "@/components/map/panels/styleEditor/sections/RasterGeneralSection";
import { RasterLayerSection } from "@/components/map/panels/styleEditor/sections/RasterLayerSection";

import { choose, echoTransport, i18n, renderPanel } from "./renderPanel";

const fetchRasterPoint = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
// A formula's values from the info asked for it (its 2nd to 98th percentile), which the panel's info does not have yet.
const loadFormulaSample = vi.fn(
  async (..._args: unknown[]): Promise<unknown> => ({
    min: -3.2,
    max: 7.5,
    values: [],
    formula: true,
  })
);
vi.mock("@/lib/api/rasters", () => ({
  fetchRasterPoint: (...args: unknown[]) => fetchRasterPoint(...args),
  loadFormulaSample: (...args: unknown[]) => loadFormulaSample(...args),
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

/** The General section over a store, with the file's info as it is now: `arrive` is the next info answering. */
function arriving(render: object, first: RasterInfo) {
  const document = { version: "1.0.0", kind: "raster", render } as LayerStyle;
  const store = new EditorStore({
    saver: new StyleSaver({ transport: echoTransport(), document, revision: 1 }),
  });
  const tree = (info: RasterInfo) => (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider theme={createTheme()}>
        <StyleEditorProvider
          store={store}
          data={{ ...EMPTY_DATA, raster: { dataset: "d1", info } }}
          mapZoom={12}
          map={null}>
          <PopoverProvider>
            <RasterGeneralSection />
          </PopoverProvider>
        </StyleEditorProvider>
      </ThemeProvider>
    </I18nextProvider>
  );
  const view = render_(tree(first));
  return { store, arrive: (info: RasterInfo) => act(async () => view.rerender(tree(info))) };
}

/** The menu items that are bands: band math (the presets and Formula) left out. */
const bandItems = (items: string[]) =>
  items.filter((item) => item !== "style_editor.band" && !/preset_|band_formula/.test(item));

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
    expect(bandItems(items)).toEqual(["Rot", "style_editor.band_n", "style_editor.band_n", "NIR"]);
  });

  it("Categories fill one class per code the band holds, in the file's colors", async () => {
    // A paletted file: 8-bit codes with a color table.
    const paletted: RasterInfo = {
      bands: 1,
      bits: [8],
      colorTable: true,
      integer: true,
      names: [""],
      tableColors: { 0: "#000000", 1: "#ff0000", 5: "#00ff00" },
      stats: [{ ...band(1, 0, 5), values: [0, 1, 5] }],
    };
    const { store } = setup({ type: "image" }, paletted);
    await choose(
      "style_editor.draw_as",
      "style_editor.raster_type_image",
      "style_editor.raster_type_categorical"
    );
    expect(store.get("render")).toEqual({
      type: "categorical",
      classes: [
        { value: 0, color: "#000000" },
        { value: 1, color: "#ff0000" },
        { value: 5, color: "#00ff00" },
      ],
    });
  });

  it("the band picker and the combination list the bands of values: an alpha band is none", async () => {
    // An orthophoto: red, green, blue and its transparency; the service gives statistics for bands 1 to 3.
    const rgba: RasterInfo = { ...RGB, stats: [band(1, 0, 255), band(2, 0, 255), band(3, 0, 255)] };
    const { unmount } = setup({ type: "continuous", domain: [0, 255] }, rgba);
    const items = await menuItems("style_editor.band", "style_editor.band_n");
    expect(bandItems(items)).toHaveLength(3);
    unmount();
    setup({ type: "image" }, rgba);
    // False color needs a fourth band of values.
    const combinations = await menuItems("style_editor.bands", "style_editor.bands_true");
    expect(combinations.join("|")).not.toContain("style_editor.bands_false");
  });

  const pickBand = async (n: number) => {
    await userEvent.click(
      within(screen.getByText("style_editor.band").parentElement as HTMLElement).getByRole("combobox")
    );
    await userEvent.click(
      within(screen.getByRole("listbox"))
        .getAllByRole("option")
        .filter((el) => el.classList.contains("MuiMenuItem-root"))[n - 1]
    );
  };

  describe("another band under a computed method", () => {
    /** A file of two bands as its info answers for band `asked`: that band's breaks only. Band 2 has no values to
     * sample. */
    const asked = (band_: number, breaks: number[]): RasterInfo => ({
      ...RGB,
      bands: 2,
      names: ["", ""],
      stats: [band(1, 0, 100), band(2, null, null)].map((stats) =>
        stats.index === band_ ? { ...stats, breaks: { quantile: { "5": breaks } } } : stats
      ),
    });
    const quantiles = {
      type: "continuous",
      palette: "goat:elevation",
      classify: {
        method: "quantile",
        count: 5,
        classes: [{ to: 20 }, { from: 20, to: 40 }, { from: 40, to: 60 }, { from: 60, to: 80 }, { from: 80 }],
      },
    };
    const second = [{ to: 600 }, { from: 600, to: 650 }, { from: 650, to: 700 }, { from: 700, to: 750 }, { from: 750 }];

    it("takes that band's breaks when its info arrives, once, and leaves classes that exist alone", async () => {
      const { store, arrive } = arriving(quantiles, asked(1, [20, 40, 60, 80]));
      await pickBand(2);
      expect(store.get("render.band")).toBe(2);
      // The info shown is still the first band's: no breaks for the second yet.
      expect(store.get("render.classify")).toEqual({ method: "quantile", count: 5, palette: undefined });
      await arrive(asked(2, [600, 650, 700, 750]));
      expect(store.get("render.classify.classes")).toEqual(second);
      expect(store.get("render.classify")).toMatchObject({ method: "quantile", count: 5 });
      expect(store.get("render.domain")).toBeUndefined();
      // A later info does not write over the classes there are.
      const written = store.get("render.classify.classes");
      await arrive(asked(2, [1, 2, 3, 4]));
      expect(store.get("render.classify.classes")).toBe(written);
    });

    it("an undo of the classes it wrote is not written again", async () => {
      const { store, arrive } = arriving(quantiles, asked(1, [20, 40, 60, 80]));
      await pickBand(2);
      // The info answers after the pick's undo step has closed.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 700));
      });
      await arrive(asked(2, [600, 650, 700, 750]));
      expect(store.get("render.classify.classes")).toEqual(second);
      act(() => store.undo());
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(store.get("render.band")).toBe(2);
      expect(store.get("render.classify.classes")).toBeUndefined();
      act(() => store.undo());
      expect(store.get("render")).toEqual(quantiles);
    });

    it("a band picked again later takes its breaks again", async () => {
      const { store, arrive } = arriving(quantiles, asked(1, [20, 40, 60, 80]));
      await pickBand(2);
      await arrive(asked(2, [600, 650, 700, 750]));
      await pickBand(1);
      await arrive(asked(1, [20, 40, 60, 80]));
      expect(store.get("render.classify.classes")).toEqual(quantiles.classify.classes);
      await pickBand(2);
      expect(store.get("render.classify.classes")).toBeUndefined();
      await arrive(asked(2, [600, 650, 700, 750]));
      expect(store.get("render.classify.classes")).toEqual(second);
    });
  });

  it("a hillshade on a file of several bands has a Band row of its bands of values", async () => {
    // Bands 1 to 3 hold values, the fourth is the alpha band.
    const rgba: RasterInfo = { ...RGB, stats: [band(1, 0, 100), band(2, 500, 900), band(3, 0, 255)] };
    const { store, unmount } = setup({ type: "hillshade" }, rgba);
    const items = await menuItems("style_editor.band", "style_editor.band_n");
    expect(bandItems(items)).toHaveLength(3);
    await pickBand(2);
    expect(store.get("render")).toEqual({ type: "hillshade", band: 2 });
    unmount();
    // Shading in colors: the colors start from the new band's values, as a color range's do.
    const colored = setup({ type: "hillshade", palette: "goat:elevation", domain: [0, 100] }, rgba);
    await pickBand(2);
    await waitFor(() => expect(colored.store.get("render.domain")).toEqual([500, 900]));
    expect(colored.store.get("render.band")).toBe(2);
  });

  it("another band of categories takes that band's codes and keeps the other values' color", async () => {
    const two: RasterInfo = {
      ...BYTE,
      bands: 2,
      names: ["", ""],
      tableColors: undefined,
      stats: [
        { ...band(1, 1, 3), values: [1, 2, 3] },
        { ...band(2, 7, 9), values: [7, 9] },
      ],
    };
    const { store } = setup(
      {
        type: "categorical",
        classes: [1, 2, 3].map((value) => ({ value, color: "#111111" })),
        other_color: "#cccccc",
      },
      two
    );
    await pickBand(2);
    expect(store.get("render.band")).toBe(2);
    expect((store.get("render.classes") as Array<{ value: number }>).map((c) => c.value)).toEqual([7, 9]);
    expect(store.get("render.other_color")).toBe("#cccccc");
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

  it("a color range or categories on an image's band say which of its channels the band is", () => {
    const photo: RasterInfo = {
      ...RGB,
      bands: 3,
      bits: [8, 8, 8],
      names: ["", "", ""],
      colorInterp: ["red", "green", "blue"],
    };
    const note = () => screen.queryByText(/^style_editor\.band_channel_/)?.textContent ?? null;
    const ramp = setup({ type: "continuous", band: 1 }, photo);
    expect(note()).toBe("style_editor.band_channel_red");
    ramp.unmount();
    const categories = setup({ type: "categorical", band: 3 }, photo);
    expect(note()).toBe("style_editor.band_channel_blue");
    categories.unmount();
    // Bands the file does not mark as colors say nothing; nor does the image, which draws them as colors.
    const unmarked = setup(
      { type: "continuous", band: 2 },
      { ...photo, colorInterp: ["gray", "undefined", "undefined"] }
    );
    expect(note()).toBeNull();
    unmarked.unmount();
    setup({ type: "image" }, photo);
    expect(note()).toBeNull();
  });

  it("the channel note shows the file's band name as it is, a slash and an ampersand too", () => {
    const photo: RasterInfo = {
      ...RGB,
      bands: 3,
      bits: [8, 8, 8],
      names: ["B4 Red/NIR & co", "", ""],
      colorInterp: ["red", "green", "blue"],
    };
    const english = (ui: ReactNode) => <I18nextProvider i18n={commonI18n("en")}>{ui}</I18nextProvider>;
    const german = (ui: ReactNode) => <I18nextProvider i18n={commonI18n("de")}>{ui}</I18nextProvider>;
    const view = setup({ type: "continuous", band: 1 }, photo, null, {}, english);
    expect(screen.getByText("B4 Red/NIR & co is the image's red channel")).toBeDefined();
    view.unmount();
    setup({ type: "continuous", band: 1 }, photo, null, {}, german);
    expect(screen.getByText("B4 Red/NIR & co ist der Rotkanal des Bilds")).toBeDefined();
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

describe("band math in the Band row", () => {
  // A stack of Sentinel-2's bands B2, B3, B4 and B8 that marks red and near infrared (four codes alone say no
  // sensor); and the same file without names or marks.
  const SENTINEL: RasterInfo = {
    bands: 4,
    bits: [16, 16, 16, 16],
    colorTable: false,
    integer: true,
    names: ["B2", "B3", "B4", "B8"],
    colorInterp: ["blue", "green", "red", "nir"],
    stats: [band(1, 0, 3000), band(2, 0, 3000), band(3, 100, 2800), band(4, 200, 5000)],
  };
  const UNNAMED: RasterInfo = { ...SENTINEL, names: ["", "", "", ""], colorInterp: undefined };
  const NDVI = FORMULA_PRESETS.find((p) => p.id === "ndvi")!;
  const field = (label: string) =>
    within(screen.getByText(label).parentElement as HTMLElement).getByRole("combobox");
  /** Picks the `n`th menu item of the row labeled `label` (the menu's title is an option too: items only). */
  const pickIn = async (label: string, n: number) => {
    await userEvent.click(field(label));
    await userEvent.click(
      within(screen.getByRole("listbox"))
        .getAllByRole("option")
        .filter((el) => el.classList.contains("MuiMenuItem-root"))[n - 1]
    );
  };

  it("offers NDVI, NDMI, NDWI and a formula for a color range and a hillshade, not for categories", async () => {
    const ramp = setup({ type: "continuous", domain: [0, 3000] }, SENTINEL);
    const items = await menuItems("style_editor.band", "B2");
    expect(bandItems(items)).toEqual(["B2", "B3", "B4", "B8"]);
    for (const text of ["NDVI", "NDMI", "NDWI", "style_editor.band_formula"])
      expect(
        items.some((item) => item.startsWith(text)),
        text
      ).toBe(true);
    // Apart from the bands by a plain divider, no heading.
    await userEvent.click(field("style_editor.band"));
    const menu = within(screen.getByRole("listbox"));
    expect(screen.getByRole("listbox").querySelectorAll(".MuiDivider-root")).toHaveLength(1);
    expect(menu.queryByText("style_editor.band_math")).toBeNull();
    await userEvent.keyboard("{Escape}");
    ramp.unmount();
    const shade = setup({ type: "hillshade" }, SENTINEL);
    expect((await menuItems("style_editor.band", "B2")).some((item) => item.startsWith("NDVI"))).toBe(true);
    shade.unmount();
    setup({ type: "categorical" }, SENTINEL);
    const codes = await menuItems("style_editor.band", "B2");
    expect(codes.some((item) => /NDVI|band_formula/.test(item))).toBe(false);
  });

  it("a formula shows as its preset with its bands, else as the formula, never as Band 1", () => {
    const ndvi = setup(
      {
        type: "continuous",
        band: { name: "NDVI", expression: "(b4 - b3) / (b4 + b3)" },
        palette: "goat:green",
        domain: [-1, 1],
      },
      SENTINEL
    );
    expect(field("style_editor.band").textContent).toBe("NDVI (B8, B4)");
    expect(field("style_editor.band_nir").textContent).toBe("B8");
    expect(field("style_editor.band_red").textContent).toBe("B4");
    ndvi.unmount();
    const free = setup(
      { type: "continuous", band: { name: "Ratio", expression: "(b1 - b2) / (b1 + b2)" }, domain: [-1, 1] },
      SENTINEL
    );
    expect(field("style_editor.band").textContent).toBe("(b1 - b2) / (b1 + b2)");
    expect(screen.getByRole("textbox", { name: "style_editor.formula" })).toHaveProperty(
      "value",
      "(b1 - b2) / (b1 + b2)"
    );
    free.unmount();
    // A file of one band shows the formula a style colors.
    setup(
      { type: "continuous", band: { name: "b1 * 2", expression: "b1 * 2" }, domain: [0, 9] },
      FLOAT_VALUES
    );
    expect(field("style_editor.band").textContent).toBe("b1 * 2");
  });

  it("a file of one band offers the band and a formula, no presets; categories and images no Band row", async () => {
    const ramp = setup({ type: "continuous", domain: [10, 90] }, FLOAT_VALUES);
    expect(bandItems(await menuItems("style_editor.band", "style_editor.band_n"))).toEqual([
      "style_editor.band_n",
    ]);
    const items = await menuItems("style_editor.band", "style_editor.band_n");
    expect(items.some((item) => item.startsWith("style_editor.band_formula"))).toBe(true);
    expect(items.some((item) => /NDVI|NDMI|NDWI/.test(item))).toBe(false);
    await choose("style_editor.band", "style_editor.band_n", "style_editor.band_formula");
    expect(screen.getByRole("textbox", { name: "style_editor.formula" })).toBeDefined();
    ramp.unmount();
    const shade = setup({ type: "hillshade" }, FLOAT_VALUES);
    expect(screen.queryByText("style_editor.band")).not.toBeNull();
    shade.unmount();
    const codes = setup({ type: "categorical" }, { ...BYTE, stats: [band(1, 1, 3)] });
    expect(screen.queryByText("style_editor.band")).toBeNull();
    codes.unmount();
    setup({ type: "image" }, FLOAT_VALUES);
    expect(screen.queryByText("style_editor.band")).toBeNull();
  });

  it("NDVI on a file that marks its bands is written at once, as a color range over -1 to 1", async () => {
    const { store } = setup(
      {
        type: "continuous",
        palette: "goat:elevation",
        reverse: true,
        domain: [0, 3000],
        classify: { method: "quantile", count: 3, classes: [{ to: 10 }, { from: 10, to: 20 }, { from: 20 }] },
      },
      SENTINEL
    );
    await choose("style_editor.band", "B2", "NDVI");
    expect(store.get("render")).toEqual({
      type: "continuous",
      band: { name: "NDVI", expression: "(b4 - b3) / (b4 + b3)" },
      palette: NDVI.palette,
      domain: [-1, 1],
    });
    expect(field("style_editor.band").textContent).toBe("NDVI (B8, B4)");
  });

  it("a preset whose bands the file does not name waits until each input band is picked", async () => {
    const { store } = setup({ type: "continuous", palette: "goat:elevation", domain: [0, 3000] }, UNNAMED);
    await choose("style_editor.band", "style_editor.band_n", "NDVI");
    expect(store.get("render.band")).toBeUndefined();
    expect(field("style_editor.band_nir").textContent).toBe("style_editor.band_pick");
    expect(field("style_editor.band_red").textContent).toBe("style_editor.band_pick");
    await pickIn("style_editor.band_nir", 4);
    expect(store.get("render.band")).toBeUndefined();
    await pickIn("style_editor.band_red", 1);
    expect(store.get("render")).toEqual({
      type: "continuous",
      band: { name: "NDVI", expression: "(b4 - b1) / (b4 + b1)" },
      palette: NDVI.palette,
      domain: [-1, 1],
    });
  });

  it("another input band rewrites the preset's formula and keeps its colors", async () => {
    const { store } = setup(
      {
        type: "continuous",
        band: { name: "NDVI", expression: "(b4 - b3) / (b4 + b3)" },
        palette: "goat:green",
        domain: [-0.5, 0.8],
      },
      SENTINEL
    );
    await choose("style_editor.band_red", "B4", "B3");
    expect(store.get("render")).toEqual({
      type: "continuous",
      band: { name: "NDVI", expression: "(b4 - b2) / (b4 + b2)" },
      palette: "goat:green",
      domain: [-0.5, 0.8],
    });
  });

  it("an input given the band the other input holds swaps the two, in one write, and keeps the styling", async () => {
    const styled = {
      type: "continuous",
      band: { name: "NDVI", expression: "(b4 - b3) / (b4 + b3)" },
      palette: "goat:green",
      reverse: true,
      domain: [-0.2, 0.9],
      classify: {
        method: "manual",
        classes: [{ to: 0.2, name: "Bare" }, { from: 0.2, to: 0.5 }, { from: 0.5, name: "Dense" }],
      },
    };
    const { store } = setup(styled, SENTINEL);
    await pickIn("style_editor.band_red", 4);
    const swapped = { ...styled, band: { name: "NDVI", expression: "(b3 - b4) / (b3 + b4)" } };
    expect(store.get("render")).toEqual(swapped);
    expect(field("style_editor.band_nir").textContent).toBe("B4");
    expect(field("style_editor.band_red").textContent).toBe("B8");
    // One write: one step to undo.
    act(() => store.undo());
    expect(store.get("render")).toEqual(styled);
    expect(store.canUndo).toBe(false);
    act(() => store.redo());
    // And back from the other row.
    await pickIn("style_editor.band_nir", 4);
    expect(store.get("render")).toEqual(styled);
  });

  it("a new index whose two inputs are the same band is not written, and the rows say why", async () => {
    const start = { type: "continuous", palette: "goat:elevation", domain: [0, 3000] };
    const { store } = setup(start, UNNAMED);
    await choose("style_editor.band", "style_editor.band_n", "NDVI");
    expect(screen.queryByText("style_editor.band_inputs_same")).toBeNull();
    await pickIn("style_editor.band_nir", 4);
    await pickIn("style_editor.band_red", 4);
    expect(store.get("render")).toEqual(start);
    expect(screen.getByText("style_editor.band_inputs_same")).toBeDefined();
    await pickIn("style_editor.band_red", 1);
    expect(store.get("render.band")).toEqual({ name: "NDVI", expression: "(b4 - b1) / (b4 + b1)" });
    expect(screen.queryByText("style_editor.band_inputs_same")).toBeNull();
  });

  it("a formula is checked as it is typed and written when it is left or Enter is pressed", async () => {
    loadFormulaSample.mockClear();
    const { store } = setup({ type: "continuous", palette: "goat:elevation", domain: [0, 3000] }, SENTINEL);
    await choose("style_editor.band", "B2", "style_editor.band_formula");
    const box = screen.getByRole("textbox", { name: "style_editor.formula" });
    expect(store.get("render.band")).toBeUndefined();
    await userEvent.type(box, "(b1 - b9) / 2");
    expect(screen.getByText("style_editor.formula_no_such_band")).toBeDefined();
    fireEvent.blur(box);
    expect(store.get("render.band")).toBeUndefined();
    await userEvent.clear(box);
    await userEvent.type(box, "(b1 - b2) / (b1 + b2){Enter}");
    expect(store.get("render.band")).toEqual({
      name: "(b1 - b2) / (b1 + b2)",
      expression: "(b1 - b2) / (b1 + b2)",
    });
    // The range starts from the formula's own values, not band 1's.
    await waitFor(() => expect(store.get("render.domain")).toEqual([-4, 8]));
    expect(loadFormulaSample).toHaveBeenCalledWith("d1", "(b1 - b2) / (b1 + b2)");
    expect(field("style_editor.band").textContent).toBe("(b1 - b2) / (b1 + b2)");
  });

  it("a formula's values that arrive late do not replace the range of the band picked after it", async () => {
    loadFormulaSample.mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ min: -3.2, max: 7.5, values: [], formula: true }), 150)
        )
    );
    const { store } = setup({ type: "continuous", palette: "goat:elevation", domain: [0, 3000] }, SENTINEL);
    await choose("style_editor.band", "B2", "style_editor.band_formula");
    await userEvent.type(screen.getByRole("textbox", { name: "style_editor.formula" }), "(b1 - b2) / (b1 + b2)");
    // A band picked from the menu instead: the box is left on the way, which writes the formula first.
    await pickIn("style_editor.band", 3);
    expect(store.get("render.band")).toBe(3);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(store.get("render.band")).toBe(3);
    expect(store.get("render.domain")).toEqual([100, 2800]);
  });

  it("a band replaces a formula only when it is picked; opening the menu keeps the formula", async () => {
    const ndvi = { name: "NDVI", expression: "(b4 - b3) / (b4 + b3)" };
    const { store } = setup(
      { type: "continuous", band: ndvi, palette: NDVI.palette, domain: [-1, 1] },
      SENTINEL
    );
    await userEvent.click(field("style_editor.band"));
    await userEvent.keyboard("{Escape}");
    expect(store.get("render.band")).toEqual(ndvi);
    await pickIn("style_editor.band", 3);
    expect(store.get("render.band")).toBe(3);
    // The range starts from the band's values again.
    await waitFor(() => expect(store.get("render.domain")).toEqual([100, 2800]));
    expect(screen.queryByText("style_editor.band_nir")).toBeNull();
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
    const colors = within(screen.getByText("style_editor.colors").parentElement as HTMLElement).getByRole(
      "button"
    ) as HTMLButtonElement;
    expect(colors.disabled).toBe(true);
    unmount();
    // An image has no colors section: the notice is there all the same.
    broken({ type: "image" }, "refused");
    expect(screen.getAllByRole("alert").map((el) => el.textContent)).toEqual(["style_editor.raster_refused"]);
  });
});
