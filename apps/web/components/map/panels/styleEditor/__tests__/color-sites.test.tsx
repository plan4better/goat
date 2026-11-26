import { configureStore } from "@reduxjs/toolkit";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";

import { initView, mapReducer } from "@/lib/store/map/slice";
import { shade } from "@/lib/style/colors";
import type { LayerStyle } from "@/lib/style/generated/types";

import { ColorRow } from "@/components/map/panels/styleEditor/editors/ColorRow";
import { PaletteColors } from "@/components/map/panels/styleEditor/editors/PaletteColors";
import { ZoomEditor } from "@/components/map/panels/styleEditor/editors/ZoomEditor";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { H3Section } from "@/components/map/panels/styleEditor/sections/H3Section";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { renderPanel } from "./renderPanel";

// Every place the panel edits a color offers the same picker: the key's choices, None, the transparency; and every
// place that shows a derived color shows the color the map draws.

vi.mock("react-toastify", () => ({ toast: Object.assign(() => 0, { info: () => 0, dismiss: () => 0 }) }));

const doc = (rest: object) => ({ version: "1.0.0", kind: "vector", ...rest }) as LayerStyle;
const choice = (name: string) => screen.queryByRole("button", { name });

describe("a zoom stop of a color", () => {
  const style = doc({
    symbol: {
      fill: { color: "#7f3c8d" },
      outline: {
        color: {
          zoom: [
            [5, "auto"],
            [12, "#000000"],
          ],
        },
      },
    },
  });

  it("draws a stop on Auto in the color the map draws there, never as the word", () => {
    const { container } = renderPanel(
      <PopoverProvider>
        <ZoomEditor path="symbol.outline.color" />
      </PopoverProvider>,
      { document: style, data: { geometry: "polygon" }, mapZoom: 5 }
    );
    const fills = [...container.querySelectorAll("circle[r='7']")].map((c) => c.getAttribute("fill"));
    expect(fills).toEqual([shade("#7f3c8d"), "#000000"]);
  });

  it("draws a None or transparent stop over the shared checkerboard", () => {
    const { container } = renderPanel(
      <PopoverProvider>
        <ZoomEditor path="symbol.fill.color" />
      </PopoverProvider>,
      {
        document: doc({
          symbol: {
            fill: {
              color: {
                zoom: [
                  [5, "#7f3c8d00"],
                  [12, "#7f3c8d80"],
                  [14, "#7f3c8d"],
                ],
              },
            },
          },
        }),
        data: { geometry: "polygon" },
        mapZoom: 5,
      }
    );
    const under = [...container.querySelectorAll("circle[data-checker-under]")];
    expect(under).toHaveLength(2);
    for (const circle of under) {
      const id = circle.getAttribute("fill")?.match(/^url\(#(.+)\)$/)?.[1];
      expect(container.querySelector(`pattern[id="${id}"][data-checker]`)).not.toBeNull();
    }
  });

  it("offers the row's choices in its picker, None among them", async () => {
    const { store } = renderPanel(
      <PopoverProvider>
        <ZoomEditor path="symbol.outline.color" />
      </PopoverProvider>,
      { document: style, data: { geometry: "polygon" }, mapZoom: 5 }
    );
    await userEvent.click(screen.getByRole("button", { name: "style_editor.pick_color" }));
    expect(choice("style_editor.auto")?.getAttribute("aria-pressed")).toBe("true");
    expect(choice("style_editor.same_as_fill")).toBeTruthy();
    await userEvent.click(choice("style_editor.none")!);
    expect(store.get("symbol.outline.color.zoom.0.1")).toBe(`${shade("#7f3c8d")}00`);
  });
});

describe("a palette's step", () => {
  it("offers None, which keeps the step's hue at 0 %", async () => {
    const write = vi.fn();
    renderPanel(
      <PopoverProvider>
        <PaletteColors
          useSource={() => ({ colors: ["#fef0d9", "#b30000"], write })}
          args={undefined}
          pickerKey="test"
        />
      </PopoverProvider>
    );
    await userEvent.click(screen.getAllByRole("button", { name: "style_editor.palette_color" })[1]);
    expect(choice("style_editor.auto")).toBeNull();
    await userEvent.click(choice("style_editor.none")!);
    expect(write).toHaveBeenLastCalledWith(["#fef0d9", "#b3000000"]);
    expect(screen.getByRole("slider", { name: "style_editor.transparency" })).toBeTruthy();
  });
});

describe("the H3 outline", () => {
  it("on Auto reads Auto over the hexagons' shade, and offers Auto and None", async () => {
    const redux = configureStore({ reducer: { map: mapReducer } });
    redux.dispatch(initView({ projectId: "p1", mode: "2d", projection: "mercator" }));
    renderPanel(
      <Provider store={redux}>
        <PopoverProvider>
          <H3Section />
        </PopoverProvider>
      </Provider>,
      {
        document: doc({
          render: { type: "h3", palette: ["#7f3c8d", "#e68310"], outline: { color: "auto" } },
        }),
        data: { geometry: "point" },
      }
    );
    // The color field is in the Outline row's editor.
    await userEvent.click(
      within(screen.getByText("style_editor.part_outline").parentElement!).getByRole("button")
    );
    const field = screen.getByRole("button", { name: "style_editor.pick_color" });
    expect(field.textContent).toBe("style_editor.auto");
    const swatch = getComputedStyle(field.firstElementChild as HTMLElement);
    expect(swatch.backgroundColor).toBe("rgb(161, 92, 11)");
    await userEvent.click(field);
    // The section's own rows say None too (its height); the picker's choices are pressed buttons.
    expect(choice("style_editor.auto")?.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getAllByRole("button", { name: "style_editor.none" }).some((b) => b.hasAttribute("aria-pressed"))
    ).toBe(true);
  });
});

describe("a part's group row", () => {
  const row = (label: string) => screen.getAllByText(label)[0].parentElement as HTMLElement;
  const text = (label: string) => within(row(label)).getAllByRole("button")[0].textContent;

  it("reads Auto before the width its row sums up, and None alone", () => {
    const { unmount } = renderPanel(
      <PopoverProvider>
        <SymbolSection />
      </PopoverProvider>,
      {
        document: doc({ symbol: { fill: { color: "#7f3c8d" }, outline: { color: "auto", width: 1 } } }),
        data: { geometry: "polygon" },
      }
    );
    expect(text("style_editor.part_outline")).toBe("style_editor.auto · 1 px");
    unmount();
    renderPanel(
      <PopoverProvider>
        <SymbolSection />
      </PopoverProvider>,
      {
        document: doc({
          symbol: { fill: { color: "#7f3c8d00" }, outline: { color: "#cc615c00", width: 1 } },
        }),
        data: { geometry: "polygon" },
      }
    );
    expect(text("style_editor.part_outline")).toBe("style_editor.none");
    expect(text("style_editor.part_fill")).toBe("style_editor.none");
  });
});

describe("a scene color", () => {
  const scene = doc({ scene: { sky: { color: "#88aacc80" } } } as object);

  it("offers no None and no transparency, and writes opaque colors", async () => {
    const { store } = renderPanel(
      <PopoverProvider>
        <ColorRow label="sky" path="scene.sky.color" />
      </PopoverProvider>,
      { document: scene }
    );
    await userEvent.click(screen.getByRole("button", { name: "style_editor.pick_color" }));
    expect(choice("style_editor.none")).toBeNull();
    expect(screen.queryByRole("slider", { name: "style_editor.transparency" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "style_editor.transparency_percent" })).toBeNull();
    // A stored transparency is shown as its color, never as white or an empty field.
    expect((screen.getByRole("textbox", { name: "color_value" }) as HTMLInputElement).value).toBe("#88AACC");
    await userEvent.click(screen.getAllByRole("button", { name: "#2BB381" })[0]);
    expect(store.get("scene.sky.color")).toBe("#2bb381");
  });

  it("a style color with its own transparency is offered and written opaque", async () => {
    const { store } = renderPanel(
      <PopoverProvider>
        <ColorRow label="sky" path="scene.sky.color" />
      </PopoverProvider>,
      { document: doc({ scene: { sky: { color: "#88aacc" } }, symbol: { fill: { color: "#145c4280" } } }) }
    );
    await userEvent.click(screen.getByRole("button", { name: "style_editor.pick_color" }));
    await userEvent.click(screen.getByRole("button", { name: "#145C42" }));
    expect(store.get("scene.sky.color")).toBe("#145c42");
  });

  it("in a zoom stop offers no None and no transparency either", async () => {
    renderPanel(
      <PopoverProvider>
        <ZoomEditor path="scene.fog.color" />
      </PopoverProvider>,
      {
        document: doc({
          scene: {
            fog: {
              color: {
                zoom: [
                  [5, "#88aacc"],
                  [12, "#ffffff"],
                ],
              },
            },
          },
        } as object),
        mapZoom: 5,
      }
    );
    await userEvent.click(screen.getByRole("button", { name: "style_editor.pick_color" }));
    expect(choice("style_editor.none")).toBeNull();
    expect(screen.queryByRole("slider", { name: "style_editor.transparency" })).toBeNull();
  });
});
