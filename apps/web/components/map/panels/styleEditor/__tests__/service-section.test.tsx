import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { LegendSection } from "@/components/map/panels/styleEditor/sections/LegendSection";
import { ServiceSection } from "@/components/map/panels/styleEditor/sections/ServiceSection";

import { choose, renderPanel } from "./renderPanel";

const STYLES = [
  { name: "default", title: "Colors" },
  { name: "grey", title: "Grey" },
];
const service = (extra: object = {}) => ({
  kind: "wms" as const,
  url: "https://wms.example/service?LAYERS=aerial&STYLES=&BBOX={bbox-epsg-3857}",
  layers: 1,
  layerNames: ["aerial"],
  styles: STYLES,
  ...extra,
});
const setup = (data: object) =>
  renderPanel(<ServiceSection />, {
    document: { version: 1, kind: "raster", render: { type: "image" } } as LayerStyle,
    data: { service: service(data) },
  });

afterEach(() => vi.unstubAllGlobals());

describe("service section", () => {
  it("one service layer with two styles offers them; the first stays out of the style", async () => {
    const { store } = setup({});
    await choose("style_editor.service_style", "Colors", "Grey");
    expect(store.get("render.service_style")).toBe("grey");
    await choose("style_editor.service_style", "Grey", "Colors");
    expect(store.get("render.service_style")).toBeUndefined();
  });

  it("no style choice for two service layers or XYZ tiles", () => {
    const { unmount } = setup({ layers: 2, layerNames: ["a", "b"] });
    expect(screen.queryByText("style_editor.service_style")).toBeNull();
    unmount();
    setup({ kind: "xyz", layers: 1, styles: [] });
    expect(screen.queryByText("style_editor.service_style")).toBeNull();
  });

  it("a layer added before styles were stored reads them from the service; a refusal shows none", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("CORS");
      })
    );
    setup({ styles: [] });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("style_editor.service_style")).toBeNull();
    expect(screen.getByText("style_editor.draw_as")).toBeDefined();
  });

  it("the legend shows the chosen style's legend image", async () => {
    renderPanel(
      <PopoverProvider>
        <LegendSection />
      </PopoverProvider>,
      {
        document: {
          version: 1,
          kind: "raster",
          render: { type: "image", service_style: "grey" },
        } as LayerStyle,
        data: {
          service: service({
            legendUrl: "https://wms.example/legend-default.png",
            styles: [
              { ...STYLES[0], legendUrl: "https://wms.example/legend-default.png" },
              { ...STYLES[1], legendUrl: "https://wms.example/legend-grey.png" },
            ],
          }),
        },
      }
    );
    await userEvent.click(
      within(screen.getByText("style_editor.contents").parentElement as HTMLElement).getAllByRole("button")[0]
    );
    expect(screen.getByRole("img").getAttribute("src")).toBe("https://wms.example/legend-grey.png");
  });
});
