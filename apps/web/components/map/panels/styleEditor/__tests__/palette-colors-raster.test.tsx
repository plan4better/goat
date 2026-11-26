import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";
import { paletteColors } from "@/lib/style/palettes";
import type { RasterInfo } from "@/lib/style/raster/metadata";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { RasterColorSection } from "@/components/map/panels/styleEditor/sections/RasterColorSection";

import { renderPanel } from "./renderPanel";

vi.mock("@/lib/api/rasters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/rasters")>()),
  useLoadedRasterValues: () => undefined,
}));

const INFO: RasterInfo = {
  bands: 1,
  bits: [32],
  colorTable: false,
  integer: false,
  names: [""],
  stats: [
    {
      index: 1,
      min: 0,
      max: 100,
      p2: 3,
      p98: 97,
      values: null,
      histogram: {
        counts: Array.from({ length: 50 }, () => 1),
        edges: Array.from({ length: 51 }, (_, i) => i * 2),
      },
      breaks: { quantile: { "3": [33, 66] } },
    },
  ],
};

function setup(render: object) {
  const view = renderPanel(
    <PopoverProvider>
      <RasterColorSection />
    </PopoverProvider>,
    {
      document: { version: "1.0.0", kind: "raster", render } as LayerStyle,
      data: { raster: { dataset: "d1", info: INFO } },
    }
  );
  return view;
}

const openColors = () =>
  userEvent.click(
    within(screen.getAllByText("style_editor.colors").at(-1)!.parentElement as HTMLElement).getAllByRole(
      "button"
    )[0]
  );
const list = () => screen.getByRole("group", { name: "style_editor.palette" });
const rows = () =>
  Array.from(list().querySelectorAll("[data-class-row]")).map((row) => row.getAttribute("title"));
const bars = () =>
  Array.from(
    (
      Array.from(document.querySelectorAll("svg")).find((el) => el.querySelector("rect")) as SVGElement
    ).querySelectorAll("rect")
  ).map((r) => r.getAttribute("fill"));

describe("a raster palette's colors under Palette", () => {
  it("a color range lists its palette's colors as they draw; an edit writes them, Reverse folded in; the bars follow", async () => {
    const { store } = setup({
      type: "continuous",
      palette: "goat:elevation",
      reverse: true,
      domain: [0, 100],
    });
    await openColors();
    const drawn = [...paletteColors("goat:elevation")].reverse();
    expect(rows()).toEqual(drawn.map((c) => c.toUpperCase()));
    // Each row names where its color sits over the range (0 to 100), as the class bounds read.
    const texts = Array.from(list().querySelectorAll("[data-class-row]")).map((row) => row.textContent);
    expect([texts[0], texts[3], texts[6]]).toEqual(["0", "50", "100"]);
    // At the bottom: after the range, the histogram and Outside, in the other product's order.
    const outside = screen.getByText("style_editor.outside");
    expect(outside.compareDocumentPosition(list()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const before = bars();
    await userEvent.click(within(list()).getAllByRole("button", { name: "style_editor.palette_color" })[0]);
    await userEvent.click(screen.getByRole("button", { name: "#D7301F" }));
    expect(store.get("render.palette")).toEqual(["#d7301f", ...drawn.slice(1)]);
    expect(store.get("render.reverse")).toBeUndefined();
    expect(bars()[0]).not.toBe(before[0]);
    // Picking a palette from the catalogue again replaces the list.
    await userEvent.click(
      within(screen.getByText("style_editor.palette").parentElement as HTMLElement).getByRole("button")
    );
    await userEvent.click(screen.getByRole("button", { name: "Blues" }));
    expect(store.get("render.palette")).toBe("colorbrewer:Blues");
  });

  it("classes have no palette list: the class rows are the colors to edit", async () => {
    setup({
      type: "continuous",
      palette: "colorbrewer:Blues",
      classify: { method: "quantile", count: 3, classes: [{ to: 33 }, { from: 33, to: 66 }, { from: 66 }] },
    });
    await openColors();
    expect(screen.queryByRole("group", { name: "style_editor.palette" })).toBeNull();
    expect(document.querySelectorAll("[data-class-row]")).toHaveLength(3);
  });

  it("colors at values keep their own editor", async () => {
    setup({
      type: "continuous",
      stops: [
        { value: 0, color: "#000000" },
        { value: 100, color: "#ffffff" },
      ],
    });
    await openColors();
    expect(screen.queryByRole("group", { name: "style_editor.palette" })).toBeNull();
  });
});
