import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SLIDERS } from "@/lib/style/editor/defaults";
import type { LayerStyle } from "@/lib/style/generated/types";

import {
  AdjustmentsEditor,
  adjustmentsSummary,
} from "@/components/map/panels/styleEditor/editors/AdjustmentsEditor";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { RasterColorSection } from "@/components/map/panels/styleEditor/sections/RasterColorSection";

import { renderPanel } from "./renderPanel";

const whole = (n: number) => Number.isInteger(Number(n.toFixed(6)));

const raster = (style: object) => ({
  document: { version: "1.0.0", kind: "raster", render: { type: "hillshade" }, ...style } as LayerStyle,
  data: {
    raster: { dataset: "d1", info: { bands: 1, bits: [32], colorTable: false, integer: false, stats: [] } },
  },
});

/** The widths of strokes, which draw finely at half a pixel: lines, outlines (of polygons, lines, points and
 * hexagons), casings and label halos. A pattern's line width stays whole: it is drawn into the pattern's image. */
const HALF_PIXEL = ["line.width", "outline.width", "h3.outline.width", "casing.width", "label.halo.width"];

/** Multipliers, shown as the number they are ("1.6"), which step in twentieths. */
const FACTORS = ["heatmap.intensity"];

describe("a slider moves in whole numbers of what it shows", () => {
  it("every number row of the panel starts and steps on whole numbers, percents as percents", () => {
    const off = Object.entries(SLIDERS).filter(([key, s]) => {
      if (HALF_PIXEL.includes(key) || FACTORS.includes(key)) return false;
      const scale = s.pct ? 100 : 1;
      return !whole(s.min * scale) || !whole(s.step * scale);
    });
    expect(off.map(([key]) => key)).toEqual([]);
  });

  it("the widths of strokes and halos step by half a pixel, from a whole number", () => {
    for (const key of HALF_PIXEL) {
      expect(SLIDERS[key], key).toBeDefined();
      expect(SLIDERS[key].step, key).toBe(0.5);
      expect(SLIDERS[key].unit, key).toBe("px");
      expect(whole(SLIDERS[key].min), key).toBe(true);
    }
  });

  it("multipliers show their number, no percent, and step by 0.05", () => {
    for (const key of FACTORS) {
      expect(SLIDERS[key], key).toBeDefined();
      expect(SLIDERS[key].pct, key).toBeUndefined();
      expect(SLIDERS[key].unit, key).toBeUndefined();
      expect(SLIDERS[key].step, key).toBe(0.05);
    }
  });

  it("hillshade strength shows percent", () => {
    renderPanel(
      <PopoverProvider>
        <RasterColorSection />
      </PopoverProvider>,
      raster({ render: { type: "hillshade", exaggeration: 0.35 } })
    );
    expect(
      (screen.getByRole("textbox", { name: "style_editor.hillshade_strength" }) as HTMLInputElement).value
    ).toBe("35");
  });

  it("image adjustments show percent, in the editor and its summary", () => {
    renderPanel(<AdjustmentsEditor />, raster({ brightness: 0.1 }));
    expect((screen.getByRole("textbox", { name: "style_editor.brightness" }) as HTMLInputElement).value).toBe(
      "10"
    );
    expect(adjustmentsSummary({ brightness: 0.1, saturation: -0.25, hue: 30 }, (k) => k)).toBe(
      "style_editor.brightness +10%, style_editor.saturation -25%, style_editor.hue 30°"
    );
  });
});
