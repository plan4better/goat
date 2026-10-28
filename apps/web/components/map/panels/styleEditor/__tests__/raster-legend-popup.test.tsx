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
      document: { version: 1, kind: "raster", ...doc } as LayerStyle,
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

  it("a map service shows its legend image in the legend's popover", async () => {
    renderPanel(
      <PopoverProvider>
        <LegendSection />
      </PopoverProvider>,
      {
        document: { version: 1, kind: "raster", render: { type: "image" } } as LayerStyle,
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
      document: { version: 1, kind: "raster", render: { type: "image" } } as LayerStyle,
      data: { service: { kind: "wms", url: "https://wms", layers: 1, layerNames: ["a"], styles: [] } },
    });
    expect(screen.queryByText("style_editor.popup_show_on")).toBeNull();
  });
});
