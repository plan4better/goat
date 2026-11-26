import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { shade } from "@/lib/style/colors";
import type { LayerStyle } from "@/lib/style/generated/types";

import { ColorRow } from "@/components/map/panels/styleEditor/editors/ColorRow";
import { rowChoices } from "@/components/map/panels/styleEditor/editors/partRows";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";

import { renderPanel } from "./renderPanel";

// A color row reads "Auto" or "Same as …" over the color the map draws, "None" over the checkerboard, or six digits
// and the color's percent (spec 4.6); its picker offers the key's choices, and None writes the row's color at 0 %.

const doc = (rest: object) => ({ version: "1.0.0", kind: "vector", ...rest }) as LayerStyle;
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
const field = () => screen.getByRole("button", { name: "style_editor.pick_color" });
const swatchStyle = () => getComputedStyle(field().firstElementChild as HTMLElement);
const choice = (name: string) => screen.queryByRole("button", { name });

function row(path: string, document: LayerStyle, geometry: "polygon" | "line" | "point", extra: object = {}) {
  return renderPanel(
    <PopoverProvider>
      <ColorRow label="color" path={path} {...extra} />
    </PopoverProvider>,
    { document, data: { geometry, featureCount: 10 } }
  );
}

describe("a color row", () => {
  it("on Auto reads Auto over the color it draws, as every Auto row does", () => {
    row(
      "symbol.outline.color",
      doc({ symbol: { fill: { color: "#7f3c8d" }, outline: { color: "auto" } } }),
      "polygon",
      { sentinels: rowChoices("polygon", "outline.color") }
    );
    expect(field().textContent).toBe("style_editor.auto");
    expect(swatchStyle().backgroundColor).toBe(rgb(shade("#7f3c8d")));
  });

  it("on Auto, None writes the color it draws at 0 %", async () => {
    const { store } = row(
      "symbol.casing.color",
      doc({ symbol: { line: { color: "#7f3c8d" }, casing: { color: "auto" } } }),
      "line"
    );
    await userEvent.click(field());
    expect(choice("style_editor.auto")?.getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(choice("style_editor.none")!);
    expect(store.get("symbol.casing.color")).toBe(`${shade("#7f3c8d")}00`);
    expect(field().textContent).toBe("style_editor.none");
  });

  it("on None reads None over the checkerboard, and a color picked is visible again", async () => {
    const { store } = row("symbol.fill.color", doc({ symbol: { fill: { color: "#cc615c00" } } }), "polygon");
    expect(field().textContent).toBe("style_editor.none");
    expect(swatchStyle().backgroundImage.match(/linear-gradient/g)?.length).toBeGreaterThanOrEqual(2);
    await userEvent.click(field());
    expect(choice("style_editor.none")?.getAttribute("aria-pressed")).toBe("true");
    expect(choice("style_editor.auto")).toBeNull();
    await userEvent.click(screen.getAllByRole("button", { name: "#2BB381" })[0]);
    expect(store.get("symbol.fill.color")).toBe("#2bb381");
  });

  it("with a transparency of its own reads six digits and the percent", () => {
    row("symbol.fill.color", doc({ symbol: { fill: { color: "#cc615c81" } } }), "polygon");
    expect(field().textContent).toBe("#CC615C · 51%");
  });

  it("of a label's text offers Auto and no None", async () => {
    row("symbol.label.color", doc({ symbol: { label: { text: "{name}", color: "#3a3541" } } }), "point");
    await userEvent.click(field());
    expect(choice("style_editor.auto")).toBeTruthy();
    expect(choice("style_editor.none")).toBeNull();
  });

  it("unset under Same as line reads it over the line's hue", () => {
    row("symbol.arrows.color", doc({ symbol: { line: { color: "#7f3c8d80" }, arrows: {} } }), "line", {
      sentinels: rowChoices("line", "arrows.color"),
    });
    expect(field().textContent).toBe("style_editor.same_as_line");
    expect(swatchStyle().backgroundColor).toBe(rgb("#7f3c8d"));
  });

  it("in a class that takes the layer's own pattern color neither reads nor presses Same as fill", async () => {
    row(
      "classify.0.classes.0.fill.pattern_color",
      doc({
        symbol: { fill: { color: "#7f3c8d", pattern: "hatch_45", pattern_color: "#ff0000" } },
        classify: [{ field: "kind", classes: [{ values: ["a"] }] }],
      }),
      "polygon",
      { sentinels: rowChoices("polygon", "fill.pattern_color"), fallback: "#ff0000" }
    );
    expect(field().textContent).toBe("#FF0000");
    await userEvent.click(field());
    expect(choice("style_editor.same_as_fill")?.getAttribute("aria-pressed")).toBe("false");
  });

  it("of an unset icon color in a class follows the layer's hollow marker in that class's color", () => {
    row(
      "classify.0.classes.0.marker.icon_color",
      doc({
        symbol: { marker: { fill: false, color: "#e68310", icon: "goat:park" } },
        classify: [
          {
            field: "kind",
            target: "marker.color",
            classes: [{ values: ["a"], marker: { color: "#7f3c8d" } }],
          },
        ],
      }),
      "point"
    );
    expect(field().textContent).toBe("#7F3C8D");
  });

  it("in a class on Auto keeps, on None, the hue the class draws, not another class's", async () => {
    const { store } = row(
      "classify.0.classes.0.outline.color",
      doc({
        symbol: { fill: { color: "#7f3c8d" }, outline: { color: "#000000", width: 2 } },
        classify: [
          {
            field: "t",
            method: "categories",
            classes: [
              { values: ["a"], outline: { color: "auto" } },
              { values: ["b"], outline: { color: "fill" }, fill: { color: "#11a579" } },
            ],
          },
        ],
      }),
      "polygon",
      { sentinels: rowChoices("polygon", "outline.color") }
    );
    expect(swatchStyle().backgroundColor).toBe(rgb(shade("#7f3c8d")));
    await userEvent.click(field());
    await userEvent.click(choice("style_editor.none")!);
    expect(store.get("classify.0.classes.0.outline.color")).toBe(`${shade("#7f3c8d")}00`);
  });
});
