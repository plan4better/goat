import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { LegendSection } from "@/components/map/panels/styleEditor/sections/LegendSection";
import { RasterPopupSection } from "@/components/map/panels/styleEditor/sections/RasterPopupSection";

import { choose, renderPanel } from "./renderPanel";

// The parts' reset reads the dataset's style from core; none here.
vi.mock("@/lib/api/map", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useDatasetStyle: () => ({ style: undefined, error: undefined, isLoading: true }),
}));
// The value tiles' description the map loaded for the style (none: still loading).
const described = vi.hoisted(() => ({ values: undefined as unknown }));
vi.mock("@/lib/api/rasters", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useLoadedRasterValues: () => described.values,
}));
// The datasets a field list asks a sample feature of ("" asks nothing).
const sampled = vi.hoisted(() => [] as string[]);
vi.mock("@/components/map/popover/sampleFeature", () => ({
  useSampleFeature: (layerId: string) => {
    sampled.push(layerId);
    return { feature: undefined };
  },
}));

const INFO = { bands: 4, bits: [8, 8, 8, 8], colorTable: false, integer: true, stats: [] };

function setup(doc: object, data: object = {}) {
  return renderPanel(
    <PopoverProvider>
      <LegendSection />
      <RasterPopupSection />
    </PopoverProvider>,
    {
      document: { version: "1.0.0", kind: "raster", ...doc } as LayerStyle,
      data: { raster: { dataset: "d1", info: INFO }, ...data },
    }
  );
}

/** The legend section alone: the popup section shows the legend's unit too. */
function legendSetup(doc: object) {
  return renderPanel(
    <PopoverProvider>
      <LegendSection />
    </PopoverProvider>,
    {
      document: { version: "1.0.0", kind: "raster", ...doc } as LayerStyle,
      data: { raster: { dataset: "d1", info: INFO } },
    }
  );
}

describe("raster legend", () => {
  it("the legend popover offers a unit and end labels for rasters", async () => {
    const { store } = legendSetup({
      render: { type: "continuous", palette: "goat:elevation", domain: [200, 450] },
    });
    await userEvent.click(
      within(screen.getByText("style_editor.contents").parentElement as HTMLElement).getAllByRole("button")[0]
    );
    await userEvent.type(screen.getByRole("textbox", { name: "style_editor.legend_unit" }), "m");
    expect(store.get("legend.unit")).toBe("m");
    await userEvent.type(screen.getByRole("textbox", { name: "style_editor.legend_min_label" }), "Low");
    expect(store.get("legend.min_label")).toBe("Low");
    expect(screen.getByTestId("legend-preview").textContent).toContain("Low");
  });

  it("the legend summary counts a raster's classes", () => {
    legendSetup({
      render: {
        type: "continuous",
        palette: "colorbrewer:BuGn",
        domain: [40, 80],
        classify: { method: "manual", classes: [{ to: 55 }, { from: 55, to: 65 }, { from: 65 }] },
      },
    });
    const row = screen.getByText("style_editor.contents").parentElement as HTMLElement;
    expect(within(row).getByText("style_editor.count_classes")).toBeDefined();
    expect(within(row).queryByText("style_editor.none")).toBeNull();
  });

  it("the legend summary counts a categorical raster's classes", () => {
    legendSetup({
      render: {
        type: "categorical",
        classes: [
          { value: 1, color: "#4a90c2" },
          { value: 2, color: "#7a87c6" },
        ],
      },
    });
    const row = screen.getByText("style_editor.contents").parentElement as HTMLElement;
    expect(within(row).getByText("style_editor.count_classes")).toBeDefined();
  });

  it("a ramp's legend summary reads the ramp with its end values and unit, its end labels where set", () => {
    const summary = () =>
      within(screen.getByText("style_editor.contents").parentElement as HTMLElement).getByRole("button")
        .textContent;
    const ramp = legendSetup({
      render: { type: "continuous", palette: "goat:elevation", domain: [32, 119] },
      legend: { unit: "m" },
    });
    expect(summary()).toBe("style_editor.legend_ramp, 32 style_editor.to 119 m");
    ramp.unmount();
    // Own colors at values are a ramp from the first stop to the last; end labels stand for the numbers.
    const stops = legendSetup({
      render: {
        type: "continuous",
        stops: [
          { value: 0, color: "#000000" },
          { value: 10.5, color: "#ffffff" },
        ],
      },
      legend: { caption: "Source", unit: "m", max_label: "High" },
    });
    expect(summary()).toBe("style_editor.caption · style_editor.legend_ramp, 0 m style_editor.to High");
    stops.unmount();
    // Shading in colors shows its ramp; before the range is known, the word alone.
    const shaded = legendSetup({ render: { type: "hillshade", palette: "goat:elevation", domain: [1, 2] } });
    expect(summary()).toBe("style_editor.legend_ramp, 1 style_editor.to 2");
    shaded.unmount();
    legendSetup({ render: { type: "continuous", palette: "goat:elevation" } });
    expect(summary()).toBe("style_editor.legend_ramp");
  });

  it("shading without colors reads no classes in the legend summary", () => {
    legendSetup({
      render: {
        type: "hillshade",
        classify: { method: "manual", classes: [{ to: 55 }, { from: 55 }] },
      },
    });
    const row = screen.getByText("style_editor.contents").parentElement as HTMLElement;
    expect(within(row).getByText("style_editor.none")).toBeDefined();
  });

  it("end labels are offered for ramps only", async () => {
    const labelsOf = async (render: object) => {
      const view = legendSetup({ render });
      await userEvent.click(
        within(screen.getByText("style_editor.contents").parentElement as HTMLElement).getAllByRole(
          "button"
        )[0]
      );
      const found = {
        unit: screen.queryByRole("textbox", { name: "style_editor.legend_unit" }) !== null,
        min: screen.queryByRole("textbox", { name: "style_editor.legend_min_label" }) !== null,
        max: screen.queryByRole("textbox", { name: "style_editor.legend_max_label" }) !== null,
      };
      view.unmount();
      return found;
    };
    const all = { unit: true, min: true, max: true };
    const unitOnly = { unit: true, min: false, max: false };
    expect(await labelsOf({ type: "continuous", palette: "goat:elevation", domain: [200, 450] })).toEqual(
      all
    );
    expect(
      await labelsOf({
        type: "continuous",
        stops: [
          { value: 0, color: "#000000" },
          { value: 9, color: "#ffffff" },
        ],
      })
    ).toEqual(all);
    expect(
      await labelsOf({
        type: "continuous",
        palette: "colorbrewer:BuGn",
        domain: [40, 80],
        classify: { method: "manual", classes: [{ to: 55 }, { from: 55, to: 65 }, { from: 65 }] },
      })
    ).toEqual(unitOnly);
    expect(await labelsOf({ type: "categorical", classes: [{ value: 1, color: "#4a90c2" }] })).toEqual(
      unitOnly
    );
  });

  it("a raster's classes read with the legend unit", async () => {
    const { store } = legendSetup({
      render: {
        type: "continuous",
        palette: "colorbrewer:BuGn",
        domain: [40, 80],
        classify: { method: "manual", classes: [{ to: 55 }, { from: 55, to: 65 }, { from: 65 }] },
      },
    });
    await userEvent.click(
      within(screen.getByText("style_editor.contents").parentElement as HTMLElement).getAllByRole("button")[0]
    );
    await userEvent.type(screen.getByRole("textbox", { name: "style_editor.legend_unit" }), "dB");
    expect(store.get("legend.unit")).toBe("dB");
    expect(screen.getByTestId("legend-preview").textContent).toContain("dB");
  });

  it("a map service shows its legend image in the legend's popover", async () => {
    renderPanel(
      <PopoverProvider>
        <LegendSection />
      </PopoverProvider>,
      {
        document: { version: "1.0.0", kind: "raster", render: { type: "image" } } as LayerStyle,
        data: {
          service: {
            kind: "wms",
            url: "https://wms",
            layers: 1,
            layerNames: ["a"],
            styles: [],
            legendUrl: "https://wms/legend.png",
          },
        },
      }
    );
    await userEvent.click(
      within(screen.getByText("style_editor.contents").parentElement as HTMLElement).getAllByRole("button")[0]
    );
    expect(screen.getByRole("img").getAttribute("src")).toBe("https://wms/legend.png");
  });
});

describe("raster popup", () => {
  beforeEach(() => {
    described.values = undefined;
  });
  /** The cell's fields, as the panel's data give them for a file of four bands (useStyleData). */
  const FIELDS = [
    { name: "value", type: "number", label: "style_editor.value" },
    { name: "class", type: "string", label: "style_editor.popup_class" },
    ...[1, 2, 3, 4].map((n) => ({ name: `band_${n}`, type: "number", label: `Band ${n}` })),
  ] as const;
  const ELEVATION = { type: "continuous", palette: "goat:elevation", domain: [200, 450] };
  const popupSetup = (doc: object) => setup(doc, { layerId: "d1", fields: [...FIELDS] });
  const showOnOptions = async () => {
    const row = screen.getByText("style_editor.popup_show_on").parentElement as HTMLElement;
    await userEvent.click(within(row).getByRole("combobox"));
    const options = within(screen.getByRole("listbox"))
      .getAllByRole("option")
      .map((o) => o.textContent ?? "");
    await userEvent.keyboard("{Escape}");
    return options;
  };

  it("Show on offers hover for a colour scale; off, on hover and back to the default click", async () => {
    const { store } = popupSetup({ render: ELEVATION });
    expect(await showOnOptions()).toEqual([
      "style_editor.popup_offstyle_editor.raster_popup_off_sub",
      "style_editor.popup_on_clickstyle_editor.raster_popup_on_click_sub",
      "style_editor.popup_on_hoverstyle_editor.raster_popup_on_hover_sub",
      "style_editor.popup_on_click_and_hoverstyle_editor.raster_popup_on_click_and_hover_sub",
    ]);
    await choose("style_editor.popup_show_on", "style_editor.popup_on_click", "style_editor.popup_off");
    expect(store.get("popup")).toBe(false);
    await choose("style_editor.popup_show_on", "style_editor.popup_off", "style_editor.popup_on_hover");
    expect(store.get("popup")).toEqual({ trigger: "hover" });
    await choose(
      "style_editor.popup_values",
      "style_editor.popup_values_styled",
      "style_editor.popup_values_all"
    );
    expect(store.get("popup")).toEqual({ trigger: "hover", bands: "all" });
    // A written trigger stays written, as a vector layer's.
    await choose("style_editor.popup_show_on", "style_editor.popup_on_hover", "style_editor.popup_on_click");
    expect(store.get("popup")).toEqual({ trigger: "click", bands: "all" });
    await choose(
      "style_editor.popup_values",
      "style_editor.popup_values_all",
      "style_editor.popup_values_styled"
    );
    expect(store.get("popup")).toEqual({ trigger: "click" });
    await choose("style_editor.popup_show_on", "style_editor.popup_on_click", "style_editor.popup_off");
    await choose("style_editor.popup_show_on", "style_editor.popup_off", "style_editor.popup_on_click");
    expect(store.get("popup")).toEqual({ trigger: "click" });
  });

  it("Values styled leave a colour scale's popup at its default", async () => {
    const { store } = popupSetup({ render: ELEVATION });
    await choose(
      "style_editor.popup_values",
      "style_editor.popup_values_styled",
      "style_editor.popup_values_all"
    );
    expect(store.get("popup")).toEqual({ bands: "all" });
    await choose(
      "style_editor.popup_values",
      "style_editor.popup_values_all",
      "style_editor.popup_values_styled"
    );
    expect(store.get("popup")).toBeUndefined();
  });

  it("a colour scale the raster service colors opens on click only", async () => {
    // A float band of unknown range: geoapi colors it, the map draws no value tiles to read on hover.
    described.values = {
      encoding: { redFactor: 8, greenFactor: 1 / 32, blueFactor: 1 / 8192, baseShift: 0 },
      range: null,
      integer: false,
      version: "v1",
    };
    const view = popupSetup({ render: ELEVATION });
    expect(await showOnOptions()).toEqual([
      "style_editor.popup_offstyle_editor.raster_popup_off_sub",
      "style_editor.popup_on_clickstyle_editor.raster_popup_on_click_sub",
    ]);
    view.unmount();
    // A stored hover trigger still shows what is set.
    popupSetup({ render: ELEVATION, popup: { trigger: "hover" } });
    const row = screen.getByText("style_editor.popup_show_on").parentElement as HTMLElement;
    expect(within(row).getByRole("combobox").textContent).toBe("style_editor.popup_on_hover");
  });

  it("a grey file with an alpha band has one band of values: no choice of values", () => {
    const band = { index: 1, min: 0, max: 255, p2: 0, p98: 255, values: null };
    setup(
      { render: { type: "image" }, popup: {} },
      {
        raster: {
          dataset: "d1",
          info: { bands: 2, bits: [8, 8], colorTable: false, integer: true, stats: [band] },
        },
      }
    );
    expect(screen.getByText("style_editor.popup_show_on")).toBeDefined();
    expect(screen.queryByText("style_editor.popup_values")).toBeNull();
  });

  it("an image of 8 bit bands drawn as they are offers hover; a 16 bit one does not", async () => {
    // Its pixels are its values: the map reads them where the pointer is (spec 9.7).
    const rgb = {
      bands: 3,
      bits: [8, 8, 8],
      colorTable: false,
      integer: true,
      stats: [],
      dtype: "uint8",
      scaled: false,
    };
    const view = setup({ render: { type: "image" }, popup: {} }, { raster: { dataset: "d1", info: rgb } });
    expect(await showOnOptions()).toEqual([
      "style_editor.popup_offstyle_editor.raster_popup_off_sub",
      "style_editor.popup_on_clickstyle_editor.raster_popup_on_click_sub",
      "style_editor.popup_on_hoverstyle_editor.raster_popup_on_hover_sub",
      "style_editor.popup_on_click_and_hoverstyle_editor.raster_popup_on_click_and_hover_sub",
    ]);
    view.unmount();
    setup(
      { render: { type: "image" }, popup: {} },
      { raster: { dataset: "d1", info: { ...rgb, bits: [16, 16, 16], dtype: "uint16" } } }
    );
    expect(await showOnOptions()).toHaveLength(2);
  });

  it("an image drawn with its color table offers hover, also where codes share a color", async () => {
    // The map draws its codes (value tiles) in the table's colors, so it reads every cell's code (spec 9.7).
    const table = {
      bands: 1,
      bits: [8],
      colorTable: true,
      integer: true,
      stats: [],
      dtype: "uint8",
      scaled: false,
      colorInterp: ["palette"],
      palette: { band: 1, colors: { 3: "#ff0000", 7: "#008000" } },
    };
    const view = setup({ render: { type: "image" }, popup: {} }, { raster: { dataset: "d1", info: table } });
    expect(await showOnOptions()).toHaveLength(4);
    view.unmount();
    const shared = { ...table, palette: { band: 1, colors: { 3: "#ff0000", 7: "#ff0000" } } };
    const sharing = setup(
      { render: { type: "image" }, popup: {} },
      { raster: { dataset: "d1", info: shared } }
    );
    expect(await showOnOptions()).toHaveLength(4);
    sharing.unmount();
    // A table geoapi does not describe (over 256 entries): click only.
    const { palette: _palette, ...undescribed } = table;
    setup({ render: { type: "image" }, popup: {} }, { raster: { dataset: "d1", info: undescribed } });
    expect(await showOnOptions()).toHaveLength(2);
  });

  it("an 8 bit image's hover shows the bands it draws: no note for those, a note for the others", () => {
    const rgb = {
      bands: 4,
      bits: [8, 8, 8, 8],
      colorTable: false,
      integer: true,
      stats: [],
      dtype: "uint8",
      scaled: false,
    };
    const data = { raster: { dataset: "d1", info: rgb } };
    const view = setup({ render: { type: "image" }, popup: { trigger: "hover" } }, data);
    expect(screen.queryByText("style_editor.popup_bands_on_click")).toBeNull();
    view.unmount();
    const blocks = [{ type: "field_list", attributes: [{ field: "band_4" }] }];
    setup({ render: { type: "image" }, popup: { trigger: "hover", blocks } }, data);
    expect(screen.getByText("style_editor.popup_bands_on_click")).toBeDefined();
  });

  it("an image render opens on click only", async () => {
    // No hover: an image draws no value tiles. Without a popup key it opens none.
    const { store } = popupSetup({ render: { type: "image" } });
    expect(await showOnOptions()).toEqual([
      "style_editor.popup_offstyle_editor.raster_popup_off_sub",
      "style_editor.popup_on_clickstyle_editor.raster_popup_on_click_sub",
    ]);
    await choose("style_editor.popup_show_on", "style_editor.popup_off", "style_editor.popup_on_click");
    expect(store.get("popup")).toEqual({ trigger: "click" });
    await choose(
      "style_editor.popup_values",
      "style_editor.popup_values_styled",
      "style_editor.popup_values_all"
    );
    expect(store.get("popup")).toEqual({ trigger: "click", bands: "all" });
    await choose(
      "style_editor.popup_values",
      "style_editor.popup_values_all",
      "style_editor.popup_values_styled"
    );
    expect(store.get("popup")).toEqual({ trigger: "click" });
    await choose("style_editor.popup_show_on", "style_editor.popup_on_click", "style_editor.popup_off");
    expect(store.get("popup")).toBe(false);
  });

  it("the raster popup panel is the vector popup panel", async () => {
    const { store } = popupSetup({
      render: {
        ...ELEVATION,
        classify: {
          method: "manual",
          classes: [
            { to: 300, name: "Tal" },
            { from: 300, name: "Berg" },
          ],
        },
      },
      popup: { bands: "all" },
    });
    // The default content: the value (and every band) and the named class, as a field list; no badge.
    const content = screen.getByText("style_editor.popup_content").parentElement as HTMLElement;
    expect(content.textContent).toContain("field_list");
    expect(content.textContent).not.toContain("badge_block");
    await userEvent.click(within(content).getByRole("button"));
    const lists = screen.getAllByText("field_list");
    await userEvent.click(lists[lists.length - 1].closest("button") as HTMLElement);
    // The field list holds the cell's fields: the value, the named class and every band.
    expect(screen.getAllByDisplayValue("style_editor.popup_class").length).toBeGreaterThan(0);
    // A file has no features: no sample feature is asked for.
    expect(sampled.filter(Boolean)).toEqual([]);
    // An edit writes the content and keeps the choice of bands.
    await userEvent.click(screen.getByRole("button", { name: "list" }));
    expect(store.get("popup.bands")).toBe("all");
    expect(store.get("popup.blocks.0")).toEqual(
      expect.objectContaining({ type: "field_list", layout: "list" })
    );
    expect(store.get("popup.highlight_active_feature")).toBeUndefined();
  });

  it("the popup's unit note fits the case; own content has no unit row", () => {
    const shading = popupSetup({ render: { type: "hillshade" } });
    // Shading without colors has no legend: the unit stands after the value only.
    expect(screen.getByText("style_editor.popup_unit_note_value")).toBeDefined();
    shading.unmount();
    const shaded = popupSetup({ render: { type: "hillshade", palette: "goat:elevation", domain: [0, 9] } });
    expect(screen.getByText("style_editor.popup_unit_note")).toBeDefined();
    shaded.unmount();
    // Blocks or HTML of one's own: the unit does not reach them.
    const blocks = popupSetup({
      render: ELEVATION,
      popup: { blocks: [{ type: "field_list", attributes: [{ field: "value" }] }] },
    });
    expect(screen.queryByRole("textbox", { name: "style_editor.legend_unit" })).toBeNull();
    blocks.unmount();
    popupSetup({ render: ELEVATION, popup: { mode: "html", html: "<b>{{ value }}</b>" } });
    expect(screen.queryByRole("textbox", { name: "style_editor.legend_unit" })).toBeNull();
  });

  it("the unit is set in the popup too: one stored value, the legend's", async () => {
    const { store, unmount } = popupSetup({ render: ELEVATION, legend: { unit: "m" } });
    const box = screen.getByRole("textbox", { name: "style_editor.legend_unit" }) as HTMLInputElement;
    expect(box.value).toBe("m");
    expect(screen.getByText("style_editor.popup_unit_note")).toBeDefined();
    await userEvent.clear(box);
    await userEvent.type(box, "ft");
    expect(store.get("legend.unit")).toBe("ft");
    expect(store.get("popup")).toBeUndefined();
    // The legend's popover shows the same value.
    await userEvent.click(
      within(screen.getByText("style_editor.contents").parentElement as HTMLElement).getAllByRole("button")[0]
    );
    const both = screen.getAllByRole("textbox", { name: "style_editor.legend_unit" }) as HTMLInputElement[];
    expect(both.map((b) => b.value)).toEqual(["ft", "ft"]);
    // Emptied, the key goes.
    await userEvent.clear(both[0]);
    expect(store.get("legend")).toBeUndefined();
    unmount();
    // No popup, no unit row; an image's popup shows no unit.
    const off = popupSetup({ render: ELEVATION, popup: false });
    expect(screen.queryByRole("textbox", { name: "style_editor.legend_unit" })).toBeNull();
    off.unmount();
    popupSetup({ render: { type: "image" }, popup: { trigger: "click" } });
    expect(screen.getByText("style_editor.popup_content")).toBeDefined();
    expect(screen.queryByRole("textbox", { name: "style_editor.legend_unit" })).toBeNull();
  });

  it("a unit typed for a legend hidden as `legend: false` keeps the legend hidden", async () => {
    const { store } = popupSetup({ render: ELEVATION, legend: false });
    const box = screen.getByRole("textbox", { name: "style_editor.legend_unit" });
    await userEvent.type(box, "m");
    expect(store.get("legend")).toEqual({ show: false, unit: "m" });
    expect(screen.getByText("style_editor.legend_hidden")).toBeDefined();
    await userEvent.clear(box);
    expect(store.get("legend")).toEqual({ show: false });
  });

  it("a raster's field list of one value has no layout and no Show first; a second value brings both", async () => {
    const { store } = popupSetup({ render: ELEVATION });
    const content = screen.getByText("style_editor.popup_content").parentElement as HTMLElement;
    await userEvent.click(within(content).getByRole("button"));
    const lists = screen.getAllByText("field_list");
    await userEvent.click(lists[lists.length - 1].closest("button") as HTMLElement);
    expect(screen.getByText("attributes")).toBeDefined();
    expect(screen.queryByRole("button", { name: "table" })).toBeNull();
    expect(screen.queryByText("collapse_after")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "add_attribute" }));
    await userEvent.click(screen.getByText("Band 2"));
    expect(store.get("popup.blocks.0.attributes")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "table" })).toBeDefined();
    expect(screen.getByText("collapse_after")).toBeDefined();
  });

  it("a raster's popup has no highlight and no preview of a feature", async () => {
    popupSetup({ render: ELEVATION });
    expect(screen.queryByText("style_editor.preview")).toBeNull();
    const appearance = screen.getByText("style_editor.popup_appearance").parentElement as HTMLElement;
    await userEvent.click(within(appearance).getByRole("button"));
    expect(screen.queryByText("style_editor.popup_highlight")).toBeNull();
  });

  it("band values on hover: a note says they show on click only", () => {
    const blocks = [{ type: "field_list", attributes: [{ field: "band_2" }] }];
    const view = popupSetup({ render: ELEVATION, popup: { trigger: "click_and_hover", blocks } });
    expect(screen.getByText("style_editor.popup_bands_on_click")).toBeDefined();
    view.unmount();
    popupSetup({ render: ELEVATION, popup: { blocks } });
    expect(screen.queryByText("style_editor.popup_bands_on_click")).toBeNull();
  });

  it("a map service has no popup section", () => {
    renderPanel(<RasterPopupSection />, {
      document: { version: "1.0.0", kind: "raster", render: { type: "image" } } as LayerStyle,
      data: { service: { kind: "wms", url: "https://wms", layers: 1, layerNames: ["a"], styles: [] } },
    });
    expect(screen.queryByText("style_editor.popup_show_on")).toBeNull();
  });
});
