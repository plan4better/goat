import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RULES } from "@/lib/style/compile/derived";
import type { LayerStyle } from "@/lib/style/generated/types";

import { useBasemapTone } from "@/components/map/panels/styleEditor/context";
import { LabelEditor } from "@/components/map/panels/styleEditor/editors/LabelEditor";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { renderPanel } from "./renderPanel";

// The panel's swatches derive their colors for the basemap's tone the map draws, as the map does.

const DOC = {
  version: "1.0.0",
  kind: "vector",
  symbol: { fill: { color: "#7f3c8d" }, outline: { color: "auto", width: 1 } },
} as LayerStyle;

function Tone() {
  return <span data-testid="tone">{useBasemapTone()}</span>;
}

describe("the basemap's tone in the style panel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is the provider's, light by default", () => {
    expect(renderPanel(<Tone />).getByTestId("tone").textContent).toBe("light");
    expect(renderPanel(<Tone />, { tone: "dark" }).getAllByTestId("tone")[1].textContent).toBe("dark");
  });

  it("reaches the rule of the Outline row's swatch", () => {
    const shade = vi.spyOn(RULES, "shade");
    renderPanel(
      <PopoverProvider>
        <SymbolSection />
      </PopoverProvider>,
      { document: DOC, data: { geometry: "polygon", featureCount: 10 }, tone: "dark" }
    );
    expect(shade).toHaveBeenCalled();
    for (const [, inputs] of shade.mock.calls) expect(inputs).toMatchObject({ tone: "dark" });
  });

  describe("in the label's rows", () => {
    const labelled = (label: object) =>
      ({
        version: "1.0.0",
        kind: "vector",
        symbol: { fill: { color: "#7f3c8d" }, label: { text: "{name}", ...label } },
      }) as LayerStyle;
    const render = (label: object) =>
      renderPanel(
        <PopoverProvider>
          <LabelEditor base="symbol.label" />
        </PopoverProvider>,
        { document: labelled(label), data: { geometry: "polygon", featureCount: 10 }, tone: "dark" }
      );

    it("reaches the rule of the Halo row's swatch", () => {
      const halo = vi.spyOn(RULES, "label_halo");
      render({ color: "auto", halo: { color: "auto", width: 1 } });
      expect(halo).toHaveBeenCalled();
      for (const [, inputs] of halo.mock.calls) expect(inputs).toMatchObject({ tone: "dark" });
    });

    it("reaches the rule of the color the text color's picker starts at", async () => {
      const text = vi.spyOn(RULES, "label_text");
      render({ color: "auto" });
      await userEvent.click(screen.getByRole("button", { name: "style_editor.pick_color" }));
      expect(text).toHaveBeenCalled();
      for (const [, inputs] of text.mock.calls) expect(inputs).toMatchObject({ tone: "dark" });
    });
  });
});
