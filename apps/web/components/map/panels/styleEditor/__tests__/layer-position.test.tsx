import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MapStateProvider } from "@/components/map/panels/styleEditor/mapState";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { LayerSection } from "@/components/map/panels/styleEditor/sections/LayerSection";

import { choose, renderPanel } from "./renderPanel";

describe("the layer's position", () => {
  it("position writes the layer's map state; without map state (the dev route) there is no row", async () => {
    const onPosition = vi.fn();
    renderPanel(
      <MapStateProvider value={{ position: "top", onPosition }}>
        <PopoverProvider>
          <LayerSection />
        </PopoverProvider>
      </MapStateProvider>
    );
    await choose("position", "style_editor.position_top", "style_editor.position_below_labels");
    expect(onPosition).toHaveBeenCalledWith("below_labels");
  });

  it("is not shown without map state", () => {
    renderPanel(
      <PopoverProvider>
        <LayerSection />
      </PopoverProvider>
    );
    expect(screen.queryByText("position")).toBeNull();
  });
});
