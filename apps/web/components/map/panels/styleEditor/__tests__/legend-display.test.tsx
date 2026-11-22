import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { LegendSection } from "@/components/map/panels/styleEditor/sections/LegendSection";

import { choose, renderPanel } from "./renderPanel";

vi.mock("@/lib/api/map", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useDatasetStyle: () => ({ style: undefined, error: undefined, isLoading: true }),
}));

describe("the legend's display", () => {
  it.each(["vector", "raster"])("a %s layer's legend shows its entries or its name only", async (kind) => {
    const { store } = renderPanel(
      <PopoverProvider>
        <LegendSection />
      </PopoverProvider>,
      {
        document: {
          version: "1.0.0",
          kind,
          ...(kind === "raster"
            ? { render: { type: "continuous", palette: "goat:elevation", domain: [0, 9] } }
            : { symbol: { fill: { color: "#cccccc" } } }),
        } as LayerStyle,
      }
    );
    await choose(
      "style_editor.legend_display",
      "style_editor.legend_display_standard",
      "style_editor.legend_display_name_only"
    );
    expect(store.get("legend")).toEqual({ display: "name_only" });
    await choose(
      "style_editor.legend_display",
      "style_editor.legend_display_name_only",
      "style_editor.legend_display_standard"
    );
    expect(store.get("legend")).toBeUndefined();
  });

  it("a display or title chosen for a legend hidden as `legend: false` keeps it hidden", async () => {
    const { store } = renderPanel(
      <PopoverProvider>
        <LegendSection />
      </PopoverProvider>,
      {
        document: {
          version: "1.0.0",
          kind: "raster",
          render: { type: "continuous", palette: "goat:elevation", domain: [0, 9] },
          legend: false,
        } as unknown as LayerStyle,
      }
    );
    await choose(
      "style_editor.legend_display",
      "style_editor.legend_display_standard",
      "style_editor.legend_display_name_only"
    );
    expect(store.get("legend")).toEqual({ show: false, display: "name_only" });
    await userEvent.type(screen.getByRole("textbox", { name: "style_editor.legend_title" }), "DEM");
    expect(store.get("legend")).toEqual({ show: false, display: "name_only", title: "DEM" });
    expect(screen.getByText("style_editor.legend_hidden")).toBeDefined();
  });
});
