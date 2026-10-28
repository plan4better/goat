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
  document: { version: 1, kind: "raster", render: { type: "terrain" }, ...style } as LayerStyle,
  data: {
    raster: { dataset: "d1", info: { bands: 1, bits: [32], colorTable: false, integer: false, stats: [] } },
  },
});

describe("a slider moves in whole numbers of what it shows", () => {
  it("every number row of the panel starts and steps on whole numbers, percents as percents", () => {
    const off = Object.entries(SLIDERS).filter(([, s]) => {
      const scale = s.pct ? 100 : 1;
      return !whole(s.min * scale) || !whole(s.step * scale);
    });
    expect(off.map(([key]) => key)).toEqual([]);
  });

  it("hillshade strength shows percent", () => {
    renderPanel(
      <PopoverProvider>
        <RasterColorSection />
      </PopoverProvider>,
      raster({ render: { type: "terrain", exaggeration: 0.35 } })
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
