// The raster Layer section's resampling row: codes never blend, so categories and an image drawn with its file's
// color table draw nearest whatever the style says; the row shows that, disabled, with a note.
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";
import type { RasterInfo } from "@/lib/style/raster/metadata";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { RasterLayerSection } from "@/components/map/panels/styleEditor/sections/RasterLayerSection";

import { renderPanel } from "./renderPanel";

vi.mock("@/lib/api/rasters", () => ({ fetchRasterPoint: vi.fn(async () => null) }));

/** One 8 bit band with a color table geoapi describes (`palette`). */
const PALETTED: RasterInfo = {
  bands: 1,
  bits: [8],
  colorTable: true,
  integer: true,
  dtype: "uint8",
  scaled: false,
  names: [""],
  colorInterp: ["palette"],
  palette: { band: 1, colors: { 0: "#ffffff", 1: "#ffffff", 7: "#008000" } },
  stats: [],
};
const BYTE: RasterInfo = { ...PALETTED, colorTable: false, palette: undefined, colorInterp: undefined };

function setup(style: object, info: RasterInfo) {
  return renderPanel(
    <PopoverProvider>
      <RasterLayerSection />
    </PopoverProvider>,
    {
      document: { version: "1.0.0", kind: "raster", ...style } as LayerStyle,
      data: { raster: { dataset: "d1", info } },
    }
  );
}

const row = () => screen.getByRole("combobox", { name: "style_editor.resampling" });

describe("the resampling row of a raster file", () => {
  it("categories and an image drawn with its color table show nearest, disabled, with a note", () => {
    for (const [style, info] of [
      [{ render: { type: "categorical", classes: [{ value: 1, color: "#ff0000" }] } }, BYTE],
      // A stored smooth draws nearest all the same, and stays as written.
      [{ resampling: "linear", render: { type: "categorical" } }, BYTE],
      [{ render: { type: "image" } }, PALETTED],
      [{ resampling: "linear", render: { type: "image" } }, PALETTED],
    ] as const) {
      const { unmount, store } = setup(style, info);
      expect([style, row().textContent]).toEqual([style, "style_editor.resampling_nearest"]);
      expect(row().hasAttribute("disabled")).toBe(true);
      expect(screen.getByText("style_editor.resampling_codes")).toBeDefined();
      expect(store.get("resampling")).toBe(style.resampling);
      unmount();
    }
  });

  it("other images and color scales keep the choice, without the note", () => {
    for (const [style, info] of [
      [{ render: { type: "image" } }, BYTE],
      // Chosen bands are drawn as they are, not with the table.
      [{ render: { type: "image", bands: [1, 1, 1] } }, PALETTED],
      [{ render: { type: "continuous", palette: "goat:elevation" } }, PALETTED],
    ] as const) {
      const { unmount } = setup(style, info);
      expect([style, row().hasAttribute("disabled")]).toEqual([style, false]);
      expect(screen.queryByText("style_editor.resampling_codes")).toBeNull();
      unmount();
    }
  });
});
