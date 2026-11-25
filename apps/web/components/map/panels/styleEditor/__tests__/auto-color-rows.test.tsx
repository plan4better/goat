import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { labelPair } from "@/lib/style/colors";
import type { LayerStyle } from "@/lib/style/generated/types";

import { ColorRow } from "@/components/map/panels/styleEditor/editors/ColorRow";
import { LabelEditor } from "@/components/map/panels/styleEditor/editors/LabelEditor";
import { useShapeState } from "@/components/map/panels/styleEditor/editors/ShapeField";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";

import { renderPanel } from "./renderPanel";

// A color on "auto" (a label's text and halo, an icon, a cluster's number, spec 18.10) reads "Auto" in its row, over
// the color the map draws: never the word itself, never a broken swatch.

const doc = (rest: object) => ({ version: "1.0.0", kind: "vector", ...rest }) as LayerStyle;
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
const swatchOfButton = (button: HTMLElement) => getComputedStyle(button.firstElementChild as HTMLElement);

describe("a color row on Auto", () => {
  it("reads Auto over the text color the map draws, for the basemap's tone", () => {
    renderPanel(
      <PopoverProvider>
        <LabelEditor base="symbol.label" />
      </PopoverProvider>,
      {
        document: doc({
          symbol: {
            fill: { color: "#7f3c8d" },
            label: { text: "{name}", color: "auto", halo: { color: "auto" } },
          },
        }),
        data: { geometry: "polygon", featureCount: 10 },
        tone: "light",
      }
    );
    const button = screen.getByRole("button", { name: "style_editor.pick_color" });
    expect(button.textContent).toBe("style_editor.auto");
    expect(swatchOfButton(button).backgroundColor).toBe(rgb(labelPair("#7f3c8d", "light").text));
    // The placement reads its own "auto" (untranslated here); no color shows the word.
    expect(document.body.textContent).not.toContain("AUTO");
  });

  it("reads Auto over the icon color and the cluster's number the map draws", () => {
    const { unmount } = renderPanel(
      <PopoverProvider>
        <ColorRow label="icon" path="symbol.marker.icon_color" />
      </PopoverProvider>,
      {
        document: doc({ symbol: { marker: { color: "#f2b701", icon: "goat:park", icon_color: "auto" } } }),
        data: { geometry: "point", featureCount: 10 },
      }
    );
    let button = screen.getByRole("button", { name: "style_editor.pick_color" });
    expect(button.textContent).toBe("style_editor.auto");
    expect(swatchOfButton(button).backgroundColor).toBe(rgb("#3a3541"));
    unmount();
    renderPanel(
      <PopoverProvider>
        <ColorRow label="number" path="render.symbol.label.color" />
      </PopoverProvider>,
      {
        document: doc({
          render: {
            type: "cluster",
            symbol: { marker: { color: "#f2b701" }, label: { text: "{count}", color: "auto" } },
          },
        }),
        data: { geometry: "point", featureCount: 10 },
      }
    );
    button = screen.getByRole("button", { name: "style_editor.pick_color" });
    expect(button.textContent).toBe("style_editor.auto");
    expect(swatchOfButton(button).backgroundColor).toBe(rgb("#3a3541"));
  });

  it("draws an Auto icon in the shape preview as the map does", () => {
    function Preview() {
      return <span data-testid="icon">{useShapeState("symbol.marker").preview.iconColor}</span>;
    }
    const icon = (marker: object) =>
      doc({
        symbol: {
          marker: { shape: "square", color: "#f2b701", icon: "goat:park", icon_color: "auto", ...marker },
        },
      });
    const { unmount } = renderPanel(<Preview />, {
      document: icon({}),
      data: { geometry: "point", featureCount: 1 },
    });
    expect(screen.getByTestId("icon").textContent).toBe("#3a3541");
    unmount();
    renderPanel(<Preview />, {
      document: icon({ fill: false }),
      data: { geometry: "point", featureCount: 1 },
    });
    expect(screen.getByTestId("icon").textContent).toBe("#f2b701");
  });
});
