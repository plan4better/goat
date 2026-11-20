import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { LegendSection } from "@/components/map/panels/styleEditor/sections/LegendSection";
import { RasterPopupSection } from "@/components/map/panels/styleEditor/sections/RasterPopupSection";

import { choose, renderPanel } from "./renderPanel";

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

describe("raster legend", () => {
  it("the legend popover offers a unit and end labels for rasters", async () => {
    const { store } = setup({
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
    setup({
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
    setup({
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

  it("shading without colors reads no classes in the legend summary", () => {
    setup({
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
      const view = setup({ render });
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
    const { store } = setup({
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
  it("Show on writes off, hover and back to the default click; all bands for several bands", async () => {
    const { store } = setup({ render: { type: "image" } });
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
    await choose("style_editor.popup_show_on", "style_editor.popup_on_hover", "style_editor.popup_on_click");
    expect(store.get("popup")).toEqual({ bands: "all" });
  });

  it("a map service has no popup section", () => {
    renderPanel(<RasterPopupSection />, {
      document: { version: "1.0.0", kind: "raster", render: { type: "image" } } as LayerStyle,
      data: { service: { kind: "wms", url: "https://wms", layers: 1, layerNames: ["a"], styles: [] } },
    });
    expect(screen.queryByText("style_editor.popup_show_on")).toBeNull();
  });
});
